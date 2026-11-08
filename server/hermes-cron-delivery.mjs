import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hermesProfile } from './hermes-client.mjs';

/**
 * Bridges completed background cron jobs / scheduled goals into the user's active chat session.
 * Deduplicates delivered runs so each execution is delivered exactly once.
 */
export class HermesCronDelivery {
  #client;
  #bots;
  #stateDir;
  #hermesHome;
  #onDelivered;
  #pollIntervalMs;
  #timer;
  #db;
  #running = false;
  #scanning = false;

  constructor({
    client,
    bots,
    stateDir = process.env.HOB_STATE_DIR,
    hermesHome = process.env.HERMES_HOME,
    onDelivered,
    pollIntervalMs = 10000,
    autoStart = true,
  } = {}) {
    this.#client = client;
    this.#bots = bots;
    this.#stateDir = stateDir;
    this.#hermesHome = hermesHome;
    this.#onDelivered = onDelivered;
    this.#pollIntervalMs = pollIntervalMs;

    this.#initDb();
    if (autoStart) {
      this.start();
    }
  }

  #initDb() {
    let filename = ':memory:';
    if (this.#stateDir) {
      fs.mkdirSync(this.#stateDir, { recursive: true, mode: 0o700 });
      filename = path.join(this.#stateDir, 'cron-delivery.sqlite');
    }
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS delivered_cron_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        profile TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        delivered_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_delivered_cron_runs_profile ON delivered_cron_runs(profile);
    `);
  }

  isDelivered(executionId) {
    if (!executionId || typeof executionId !== 'string') return false;
    const row = this.#db.prepare('SELECT 1 FROM delivered_cron_runs WHERE id = ?').get(executionId);
    return Boolean(row);
  }

  markDelivered(executionId, jobId, profile, targetSessionId, deliveredAt = Date.now()) {
    if (!executionId || !jobId || !profile || !targetSessionId) return;
    this.#db.prepare(`
      INSERT OR REPLACE INTO delivered_cron_runs (id, job_id, profile, target_session_id, delivered_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(executionId, jobId, profile, targetSessionId, deliveredAt);
  }

  scanProfile(profile) {
    try {
      profile = hermesProfile(profile);
    } catch {
      return [];
    }

    const homeDir = profile === 'default'
      ? this.#hermesHome
      : path.join(this.#hermesHome, 'profiles', profile);
    if (!homeDir || !fs.existsSync(homeDir)) return [];

    const stateDbPath = path.join(homeDir, 'state.db');
    if (!fs.existsSync(stateDbPath)) return [];

    // 1. Read configured jobs from jobs.json
    const jobsMap = new Map();
    const jobsJsonPath = path.join(homeDir, 'cron', 'jobs.json');
    if (fs.existsSync(jobsJsonPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(jobsJsonPath, 'utf8'));
        if (Array.isArray(raw?.jobs)) {
          for (const j of raw.jobs) {
            if (j.id) {
              jobsMap.set(j.id, {
                id: j.id,
                name: j.name || 'Scheduled Goal',
                originChatId: j.origin?.chat_id || null,
                latestExecution: j.latest_execution || null,
                canonicalCompletions: Array.isArray(j.canonical_completions) ? j.canonical_completions : [],
              });
            }
          }
        }
      } catch (err) {
        console.warn(`[cron-delivery] Failed to read jobs.json for ${profile}:`, err.message);
      }
    }

    // 2. Open profile state.db
    let stateDb;
    try {
      stateDb = new DatabaseSync(stateDbPath, { readOnly: false });
      stateDb.exec('PRAGMA busy_timeout = 5000;');
    } catch (err) {
      console.warn(`[cron-delivery] Could not open state.db for ${profile}:`, err.message);
      return [];
    }

    const delivered = [];

    try {
      // Find candidate terminal cron admissions
      let rows = [];
      try {
        rows = stateDb.prepare(`
          SELECT admission_id, target_session_id, request_id, status, updated_at
          FROM session_admissions
          WHERE request_id LIKE 'cron:%' AND status = 'terminal'
          ORDER BY updated_at ASC
        `).all();
      } catch {
        // Table may not exist in some environments
      }

      // Also check executions.db if it exists
      const executionsDbPath = path.join(homeDir, 'cron', 'executions.db');
      const executionRows = new Map();
      if (fs.existsSync(executionsDbPath)) {
        try {
          const execDb = new DatabaseSync(executionsDbPath, { readOnly: true });
          const exRows = execDb.prepare(`
            SELECT id, job_id, status, finished_at, error
            FROM executions
            WHERE status = 'completed'
            ORDER BY finished_at ASC
          `).all();
          for (const r of exRows) {
            executionRows.set(r.id, r);
          }
          execDb.close();
        } catch {}
      }

      // Collect all candidates
      const candidates = [];
      const seenExecutions = new Set();

      for (const row of rows) {
        const parts = row.request_id.split(':');
        if (parts.length >= 3 && parts[0] === 'cron') {
          const jobId = parts[1];
          const execId = parts[2];
          if (!this.isDelivered(execId) && !seenExecutions.has(execId)) {
            seenExecutions.add(execId);
            candidates.push({
              jobId,
              executionId: execId,
              cronSessionId: row.target_session_id,
              admissionId: row.admission_id,
            });
          }
        }
      }

      // Also check latest_execution and canonicalCompletions from jobs.json
      for (const [jobId, job] of jobsMap) {
        const toCheck = [...job.canonicalCompletions];
        if (job.latestExecution?.id && job.latestExecution.status === 'completed') {
          toCheck.push(job.latestExecution.id);
        }
        for (const execId of toCheck) {
          if (!this.isDelivered(execId) && !seenExecutions.has(execId)) {
            seenExecutions.add(execId);
            candidates.push({
              jobId,
              executionId: execId,
              cronSessionId: null,
              admissionId: null,
            });
          }
        }
      }

      // Also check executions.db
      for (const [execId, exec] of executionRows) {
        if (!this.isDelivered(execId) && !seenExecutions.has(execId)) {
          seenExecutions.add(execId);
          candidates.push({
            jobId: exec.job_id,
            executionId: execId,
            cronSessionId: null,
            admissionId: null,
          });
        }
      }

      // Process each undelivered candidate
      for (const candidate of candidates) {
        const { jobId, executionId, cronSessionId } = candidate;
        const jobInfo = jobsMap.get(jobId);
        const jobName = jobInfo?.name || 'Scheduled Goal';

        // Extract deliverable content
        let content = '';

        // Try candidate cronSessionId in state.db first
        if (cronSessionId) {
          try {
            const msg = stateDb.prepare(`
              SELECT content FROM messages
              WHERE session_id = ? AND role = 'assistant' AND content IS NOT NULL AND content != ''
              ORDER BY id DESC LIMIT 1
            `).get(cronSessionId);
            if (msg?.content) {
              content = msg.content;
            }
          } catch {}
        }

        // If not found, try searching state.db for any cron session with this job/execution
        if (!content) {
          try {
            const cronSess = stateDb.prepare(`
              SELECT s.id FROM sessions s
              JOIN session_admissions a ON a.target_session_id = s.id
              WHERE a.request_id = ?
              LIMIT 1
            `).get(`cron:${jobId}:${executionId}`);
            if (cronSess?.id) {
              const msg = stateDb.prepare(`
                SELECT content FROM messages
                WHERE session_id = ? AND role = 'assistant' AND content IS NOT NULL AND content != ''
                ORDER BY id DESC LIMIT 1
              `).get(cronSess.id);
              if (msg?.content) {
                content = msg.content;
              }
            }
          } catch {}
        }

        // If still not found, check disk files under cron/output/
        if (!content) {
          const outputDir = path.join(homeDir, 'cron', 'output');
          const jobOutputDir = path.join(outputDir, jobId);
          if (fs.existsSync(jobOutputDir)) {
            try {
              const files = fs.readdirSync(jobOutputDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'))
                .sort().reverse();
              if (files.length > 0) {
                content = fs.readFileSync(path.join(jobOutputDir, files[0]), 'utf8');
              }
            } catch {}
          }
          if (!content && fs.existsSync(outputDir)) {
            try {
              const files = fs.readdirSync(outputDir)
                .filter(f => f.startsWith(`${jobId}_`) && f.endsWith('.txt'))
                .sort().reverse();
              if (files.length > 0) {
                content = fs.readFileSync(path.join(outputDir, files[0]), 'utf8');
              }
            } catch {}
          }
        }

        if (content && (content.trim() === '[SILENT]' || content.trim().startsWith('[SILENT]'))) {
          this.markDelivered(executionId, jobId, profile, 'suppressed', Date.now());
          continue;
        }

        if (!content) {
          content = `Goal "${jobName}" completed its scheduled execution.`;
        }

        // Determine destination chat session in state.db
        let targetSessionId = null;

        // 1. origin.chat_id from job definition
        if (jobInfo?.originChatId) {
          try {
            const existing = stateDb.prepare('SELECT id FROM sessions WHERE id = ?').get(jobInfo.originChatId);
            if (existing?.id) {
              targetSessionId = existing.id;
            }
          } catch {}
        }

        // 2. Most recent user/canonical conversation for this bot
        if (!targetSessionId) {
          try {
            const latest = stateDb.prepare(`
              SELECT id FROM sessions
              WHERE source NOT IN ('cron', 'subagent', 'oneshot')
              ORDER BY last_activity_at DESC LIMIT 1
            `).get();
            if (latest?.id) {
              targetSessionId = latest.id;
            }
          } catch {}
        }

        // 3. Fallback: create a new session in state.db
        if (!targetSessionId) {
          targetSessionId = `local-${randomBytes(16).toString('hex')}`;
          const nowSec = Date.now() / 1000;
          try {
            stateDb.prepare(`
              INSERT INTO sessions (id, runtime_revision, runtime_generation, source, started_at, last_activity_at, title)
              VALUES (?, 1, 1, 'local', ?, ?, ?)
            `).run(targetSessionId, nowSec, nowSec, `Goals & Reports`);
          } catch (err) {
            console.warn(`[cron-delivery] Failed to create fallback session for ${profile}:`, err.message);
            continue;
          }
        }

        // Format delivered message
        const formattedMessage = content.startsWith('🎯 **Scheduled Goal Report:')
          ? content
          : `🎯 **Scheduled Goal Report: ${jobName}**\n\n${content}`;

        const timestampSec = Date.now() / 1000;

        // Insert message into targetSessionId
        try {
          stateDb.prepare(`
            INSERT INTO messages (
              session_id, role, content, timestamp, token_count, active, _compressed_summary
            ) VALUES (?, 'assistant', ?, ?, 0, 1, 0)
          `).run(targetSessionId, formattedMessage, timestampSec);

          stateDb.prepare(`
            UPDATE sessions
            SET message_count = message_count + 1,
                last_activity_at = ?
            WHERE id = ?
          `).run(timestampSec, targetSessionId);

          try {
            stateDb.prepare(`
              INSERT INTO conversation_generations (source, session_key, generation)
              VALUES ('local', ?, 1)
              ON CONFLICT(source, session_key) DO UPDATE
              SET generation = conversation_generations.generation + 1
            `).run(`agent:${profile}:local:dm:${targetSessionId}`);
          } catch {}
        } catch (err) {
          console.warn(`[cron-delivery] Failed to insert message into ${targetSessionId} for ${profile}:`, err.message);
          continue;
        }

        // Mark delivered in tracking DB
        this.markDelivered(executionId, jobId, profile, targetSessionId, Date.now());

        // Notify UI via client events
        try {
          this.#client?.emit?.('event', {
            event: 'sessions.changed',
            payload: { profile, sessionId: targetSessionId },
          });
        } catch {}

        // Trigger onDelivered callback (e.g. mobile notification and Library artifact publishing)
        try {
          this.#onDelivered?.({
            profile,
            sessionId: targetSessionId,
            admissionId: executionId,
            createdAt: Date.now(),
            output: content,
            jobName,
          });
        } catch (err) {
          console.warn(`[cron-delivery] onDelivered error for ${profile}:`, err.message);
        }

        delivered.push({
          jobId,
          executionId,
          profile,
          targetSessionId,
          jobName,
        });
      }
    } finally {
      stateDb.close();
    }

    return delivered;
  }

  async scanAll() {
    if (this.#scanning) return [];
    this.#scanning = true;
    const allDelivered = [];
    try {
      const roster = this.#bots?.roster?.() || [];
      const profiles = new Set(roster.map(b => b.name));
      profiles.add('default');
      for (const profile of profiles) {
        try {
          const res = this.scanProfile(profile);
          if (Array.isArray(res) && res.length > 0) {
            allDelivered.push(...res);
          }
        } catch (err) {
          console.warn(`[cron-delivery] Scan error for ${profile}:`, err.message);
        }
      }
    } finally {
      this.#scanning = false;
    }
    return allDelivered;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    queueMicrotask(() => { void this.scanAll(); });
    this.#timer = setInterval(() => {
      void this.scanAll();
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  stop() {
    this.#running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    try {
      this.#db?.close();
    } catch {}
  }

  close() {
    this.stop();
  }
}

export function createHermesCronDelivery(options) {
  return new HermesCronDelivery(options);
}
