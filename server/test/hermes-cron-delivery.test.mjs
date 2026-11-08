import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HermesCronDelivery, createHermesCronDelivery } from '../hermes-cron-delivery.mjs';

function createMockStateDb(dbPath, { withCronRun = true, withOrigin = true, jobId = 'job-abc', execId = 'exec-xyz' } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      runtime_revision INTEGER DEFAULT 1,
      runtime_generation INTEGER DEFAULT 1,
      source TEXT,
      started_at REAL,
      last_activity_at REAL,
      title TEXT,
      message_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_admissions (
      admission_id TEXT PRIMARY KEY,
      target_session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at REAL,
      updated_at REAL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp REAL,
      token_count INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      _compressed_summary INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS conversation_generations (
      source TEXT,
      session_key TEXT PRIMARY KEY,
      generation INTEGER DEFAULT 1
    );
  `);

  const userSessionId = 'local-user-chat-123';
  db.prepare(`
    INSERT INTO sessions (id, source, started_at, last_activity_at, title, message_count)
    VALUES (?, 'local', 1000, 1000, 'User Chat', 1)
  `).run(userSessionId);

  db.prepare(`
    INSERT INTO messages (session_id, role, content, timestamp)
    VALUES (?, 'user', 'Hello bot', 1000)
  `).run(userSessionId);

  if (withCronRun) {
    const cronSessionId = 'local-cron-run-456';
    db.prepare(`
      INSERT INTO sessions (id, source, started_at, last_activity_at, title, message_count)
      VALUES (?, 'cron', 1010, 1020, 'Scheduled Run', 2)
    `).run(cronSessionId);

    db.prepare(`
      INSERT INTO session_admissions (admission_id, target_session_id, request_id, principal_id, status, created_at, updated_at)
      VALUES ('adm-1', ?, 'cron:' || ? || ':' || ?, 'cron-owner', 'terminal', 1010, 1020)
    `).run(cronSessionId, jobId, execId);

    db.prepare(`
      INSERT INTO messages (session_id, role, content, timestamp)
      VALUES (?, 'assistant', 'Here is the completed research report.', 1020)
    `).run(cronSessionId);
  }

  db.close();
  return { userSessionId };
}

test('HermesCronDelivery records and checks delivered executions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cron-delivery-test-'));

  const delivery = createHermesCronDelivery({
    stateDir: root,
    hermesHome: root,
    autoStart: false,
  });
  t.after(async () => {
    delivery.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(delivery.isDelivered('exec-1'), false);
  delivery.markDelivered('exec-1', 'job-1', 'theo', 'local-chat');
  assert.equal(delivery.isDelivered('exec-1'), true);
  assert.equal(delivery.isDelivered('exec-2'), false);
});

test('scanProfile bridges completed cron deliverable into active user conversation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cron-delivery-scan-'));

  const profileDir = path.join(root, 'profiles', 'theo');
  fs.mkdirSync(path.join(profileDir, 'cron'), { recursive: true });

  const stateDbPath = path.join(profileDir, 'state.db');
  const { userSessionId } = createMockStateDb(stateDbPath, { withCronRun: true });

  fs.writeFileSync(path.join(profileDir, 'cron', 'jobs.json'), JSON.stringify({
    jobs: [{
      id: 'job-abc',
      name: 'Daily Market Feasibility',
      origin: { chat_id: userSessionId },
    }],
  }));

  const events = [];
  const completedCalls = [];
  const mockClient = {
    emit(type, data) { events.push({ type, data }); },
  };

  const delivery = createHermesCronDelivery({
    client: mockClient,
    stateDir: root,
    hermesHome: root,
    autoStart: false,
    onDelivered(payload) { completedCalls.push(payload); },
  });
  t.after(async () => {
    delivery.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });

  const delivered = delivery.scanProfile('theo');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].jobId, 'job-abc');
  assert.equal(delivered[0].executionId, 'exec-xyz');
  assert.equal(delivered[0].targetSessionId, userSessionId);

  // Check state.db messages in user session
  const verifyDb = new DatabaseSync(stateDbPath, { readOnly: true });
  const msgs = verifyDb.prepare('SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY id ASC').all(userSessionId);
  verifyDb.close();

  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  assert.ok(msgs[1].content.includes('Scheduled Goal Report: Daily Market Feasibility'));
  assert.ok(msgs[1].content.includes('Here is the completed research report.'));

  // Verify client event emitted
  assert.equal(events.some(e => e.type === 'event' && e.data.event === 'sessions.changed'), true);

  // Verify onDelivered called
  assert.equal(completedCalls.length, 1);
  assert.equal(completedCalls[0].profile, 'theo');
  assert.equal(completedCalls[0].sessionId, userSessionId);

  // Subsequent scan should be deduplicated
  const secondScan = delivery.scanProfile('theo');
  assert.equal(secondScan.length, 0);
});

test('scanProfile creates a fallback conversation if none exists', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cron-delivery-fallback-'));

  const profileDir = path.join(root, 'profiles', 'theo');
  fs.mkdirSync(path.join(profileDir, 'cron'), { recursive: true });

  const stateDbPath = path.join(profileDir, 'state.db');
  const db = new DatabaseSync(stateDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, runtime_revision INTEGER, runtime_generation INTEGER, source TEXT, started_at REAL, last_activity_at REAL, title TEXT, message_count INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS session_admissions (admission_id TEXT PRIMARY KEY, target_session_id TEXT NOT NULL, request_id TEXT NOT NULL, principal_id TEXT NOT NULL, status TEXT NOT NULL, created_at REAL, updated_at REAL);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL, token_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1, _compressed_summary INTEGER DEFAULT 0);
  `);

  const cronSessionId = 'local-cron-run-789';
  db.prepare(`INSERT INTO sessions (id, source, started_at, last_activity_at, title) VALUES (?, 'cron', 1010, 1020, 'Cron')`).run(cronSessionId);
  db.prepare(`INSERT INTO session_admissions VALUES ('adm-2', ?, 'cron:job-new:exec-new', 'cron-owner', 'terminal', 1010, 1020)`).run(cronSessionId);
  db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', 'Standalone deliverable report.', 1020)`).run(cronSessionId);
  db.close();

  const delivery = createHermesCronDelivery({
    stateDir: root,
    hermesHome: root,
    autoStart: false,
  });
  t.after(async () => {
    delivery.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });

  const delivered = delivery.scanProfile('theo');
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0].targetSessionId.startsWith('local-'));

  const verifyDb = new DatabaseSync(stateDbPath, { readOnly: true });
  const sessionRow = verifyDb.prepare('SELECT id, source, title FROM sessions WHERE id = ?').get(delivered[0].targetSessionId);
  const msgRow = verifyDb.prepare('SELECT role, content FROM messages WHERE session_id = ?').get(delivered[0].targetSessionId);
  verifyDb.close();

  assert.equal(sessionRow.source, 'local');
  assert.equal(msgRow.role, 'assistant');
  assert.ok(msgRow.content.includes('Standalone deliverable report.'));
});

test('scanProfile recovers output from cron/output directory when not in messages table', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cron-delivery-output-'));

  const profileDir = path.join(root, 'profiles', 'theo');
  fs.mkdirSync(path.join(profileDir, 'cron', 'output', 'job-file'), { recursive: true });

  const stateDbPath = path.join(profileDir, 'state.db');
  createMockStateDb(stateDbPath, { withCronRun: false });

  // Add an admission with no assistant message
  const db = new DatabaseSync(stateDbPath);
  db.prepare(`INSERT INTO session_admissions VALUES ('adm-3', 'local-cron-file', 'cron:job-file:exec-file', 'cron-owner', 'terminal', 1010, 1020)`).run();
  db.close();

  // Create output file
  fs.writeFileSync(path.join(profileDir, 'cron', 'output', 'job-file', '2026-11-08_12-00-00.md'), 'Delivered from file system output.');

  const delivery = createHermesCronDelivery({
    stateDir: root,
    hermesHome: root,
    autoStart: false,
  });
  t.after(async () => {
    delivery.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });

  const delivered = delivery.scanProfile('theo');
  assert.equal(delivered.length, 1);

  const verifyDb = new DatabaseSync(stateDbPath, { readOnly: true });
  const msgRow = verifyDb.prepare("SELECT role, content FROM messages WHERE session_id = ? AND role = 'assistant'").get(delivered[0].targetSessionId);
  verifyDb.close();

  assert.ok(msgRow.content.includes('Delivered from file system output.'));
});

test('scanAll iterates roster and delivers across multiple profiles', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cron-delivery-all-'));

  for (const botName of ['theo', 'leo']) {
    const profileDir = path.join(root, 'profiles', botName);
    fs.mkdirSync(path.join(profileDir, 'cron'), { recursive: true });
    const stateDbPath = path.join(profileDir, 'state.db');
    const { userSessionId } = createMockStateDb(stateDbPath, { withCronRun: true, jobId: `job-${botName}`, execId: `exec-${botName}` });
    fs.writeFileSync(path.join(profileDir, 'cron', 'jobs.json'), JSON.stringify({
      jobs: [{ id: `job-${botName}`, name: `Task for ${botName}`, origin: { chat_id: userSessionId } }],
    }));
  }

  const mockBots = {
    roster() {
      return [{ name: 'theo' }, { name: 'leo' }];
    },
  };

  const delivery = createHermesCronDelivery({
    bots: mockBots,
    stateDir: root,
    hermesHome: root,
    autoStart: false,
  });
  t.after(async () => {
    delivery.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });

  const allDelivered = await delivery.scanAll();
  assert.equal(allDelivered.length, 2);
  assert.deepEqual(allDelivered.map(d => d.profile).sort(), ['leo', 'theo']);
});

test('scanProfile suppresses delivery when report is [SILENT]', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cron-delivery-silent-'));

  const profileDir = path.join(root, 'profiles', 'theo');
  fs.mkdirSync(path.join(profileDir, 'cron'), { recursive: true });

  const stateDbPath = path.join(profileDir, 'state.db');
  createMockStateDb(stateDbPath, { withCronRun: false });

  const db = new DatabaseSync(stateDbPath);
  const cronSessionId = 'local-cron-silent';
  db.prepare(`INSERT INTO sessions (id, source, started_at, last_activity_at, title) VALUES (?, 'cron', 1010, 1020, 'Cron')`).run(cronSessionId);
  db.prepare(`INSERT INTO session_admissions VALUES ('adm-silent', ?, 'cron:job-silent:exec-silent', 'cron-owner', 'terminal', 1010, 1020)`).run(cronSessionId);
  db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', '[SILENT]', 1020)`).run(cronSessionId);
  db.close();

  const delivery = createHermesCronDelivery({
    stateDir: root,
    hermesHome: root,
    autoStart: false,
  });
  t.after(async () => {
    delivery.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });

  const delivered = delivery.scanProfile('theo');
  assert.equal(delivered.length, 0);
  assert.equal(delivery.isDelivered('exec-silent'), true);

  const verifyDb = new DatabaseSync(stateDbPath, { readOnly: true });
  const messages = verifyDb.prepare("SELECT * FROM messages WHERE session_id = 'local-user-chat-123'").all();
  verifyDb.close();
  assert.equal(messages.length, 1);
});

