import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HermesError, hermesResource, parseHermesSessionKey } from './hermes-client.mjs';

export const TERMINAL_RUNS = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const STATES = new Set([...TERMINAL_RUNS, 'admitting', 'queued', 'running', 'waiting_for_approval', 'stopping', 'unknown', 'unavailable']);
const MAX_BYTES = 16 * 1024 * 1024;
export const runFingerprint = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');

// Adapter correlation only; Hermes owns execution, outcome and approvals.
// Prompt text exists here solely until admission is confirmed, for a deliberate
// recovery with the SAME native idempotency key. Nothing is replayed at boot.
export class HermesRunJournal {
  #filename;
  #records;
  #queue = Promise.resolve();
  constructor(filename, records = []) { this.#filename = filename; this.#records = records; }

  static async open(stateDir) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const filename = path.join(stateDir, 'runs.json');
    try { await writeFile(filename, '{"version":1,"runs":[]}\n', { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > MAX_BYTES) throw new Error('Invalid run journal.');
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let data;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.dev !== entry.dev || info.ino !== entry.ino || info.size > MAX_BYTES) throw new Error('Invalid run journal.');
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const part = await handle.read(bytes, size, bytes.length - size, size);
        if (!part.bytesRead) break;
        size += part.bytesRead;
      }
      if (size > MAX_BYTES) throw new Error('Invalid run journal.');
      data = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    } finally { await handle.close(); }
    if (data?.version !== 1 || !Array.isArray(data.runs) || data.runs.length > 10000) throw new Error('Invalid run journal.');
    const keys = new Set();
    for (const record of data.runs) {
      const owner = parseHermesSessionKey(record.key);
      if (keys.has(record.key) || owner.profile !== record.profile || owner.sessionId !== record.sessionId
        || owner.transport !== record.transport
        || !STATES.has(record.status) || !/^[\x21-\x7e]{1,255}$/.test(record.requestKey || '')
        || !/^[a-f0-9]{64}$/.test(record.fingerprint || '') || !/^[a-f0-9]{64}$/.test(record.credentialBinding || '')
        || !Number.isFinite(record.submittedAt) || !Number.isFinite(new Date(record.submittedAt).getTime()) || !Number.isFinite(record.replayUntil)
        || (record.runId !== null && typeof record.runId !== 'string')
        || (record.runId === null && !TERMINAL_RUNS.has(record.status) && (typeof record.input !== 'string' || record.input.length > 100000))) throw new Error('Invalid run journal.');
      if (record.runId !== null) hermesResource(record.runId);
      keys.add(record.key);
    }
    return new HermesRunJournal(filename, data.runs);
  }

  get(key) { return structuredClone(this.#records.find(item => item.key === key)); }
  list(profile) { return structuredClone(this.#records.filter(item => !profile || item.profile === profile)); }

  async #mutate(change) {
    const work = this.#queue.then(async () => {
      const records = structuredClone(this.#records);
      const result = change(records);
      const encoded = JSON.stringify({ version: 1, runs: records }) + '\n';
      if (JSON.stringify(records) === JSON.stringify(this.#records)) return structuredClone(result);
      if (records.length > 10000 || Buffer.byteLength(encoded) > MAX_BYTES) throw new HermesError(503,
        'The run journal is full. Resolve existing work before submitting a new turn.', 'RUN_JOURNAL_LIMIT');
      if (this.#filename) {
        const temporary = this.#filename + '.' + randomBytes(8).toString('hex') + '.tmp';
        try {
          await writeFile(temporary, encoded, { flag: 'wx', mode: 0o600, flush: true });
          await rename(temporary, this.#filename);
          if (process.platform !== 'win32') {
            const directory = await open(path.dirname(this.#filename), constants.O_RDONLY | (constants.O_DIRECTORY || 0));
            try { await directory.sync(); } finally { await directory.close(); }
          }
        } catch {
          throw new HermesError(503, 'Run state could not be saved. Existing work may still be running; refresh status before retrying.', 'RUN_JOURNAL_UNAVAILABLE');
        } finally { await unlink(temporary).catch(error => {
          if (error.code !== 'ENOENT') throw new HermesError(503, 'Run journal cleanup failed. Refresh status before retrying.', 'RUN_JOURNAL_UNAVAILABLE');
        }); }
      }
      this.#records = records;
      return structuredClone(result);
    });
    this.#queue = work.catch(() => undefined);
    return work;
  }

  reserve(key, { input, requestKey, credentialBinding, retentionSeconds = 0 }) {
    const owner = parseHermesSessionKey(key);
    if (typeof input !== 'string' || !input.trim() || input.length > 100000
      || typeof requestKey !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(requestKey)
      || typeof credentialBinding !== 'string' || !/^[a-f0-9]{64}$/.test(credentialBinding)
      || !Number.isFinite(retentionSeconds) || retentionSeconds < 0) {
      throw new HermesError(400, 'Invalid turn submission.', 'INVALID_REQUEST');
    }
    return this.#mutate(records => {
      const previous = records.find(item => item.key === key);
      if (previous && (!TERMINAL_RUNS.has(previous.status) || previous.requestKey === requestKey)) throw new HermesError(409,
        'A run is active, completed under that request key, or awaiting recovery. Review its status before submitting again.', 'RUN_ACTIVE');
      const submittedAt = Date.now();
      const record = { key, ...owner, requestKey, input, credentialBinding, submittedAt,
        replayUntil: retentionSeconds > 60 ? submittedAt + (retentionSeconds - 60) * 1000 : 0,
        fingerprint: runFingerprint({ input, session_id: owner.sessionId }), runId: null, status: 'admitting' };
      if (previous) records[records.indexOf(previous)] = record; else records.push(record);
      return record;
    });
  }

  update(key, requestKey, patch) {
    return this.#mutate(records => {
      const record = records.find(item => item.key === key);
      if (!record || record.requestKey !== requestKey) return undefined; // late observer of an older turn
      if (TERMINAL_RUNS.has(record.status) && patch.status && !TERMINAL_RUNS.has(patch.status)) return record;
      if (patch.status && !STATES.has(patch.status)) throw new HermesError(502, 'Hermes returned an invalid run state.', 'HERMES_PROTOCOL_ERROR');
      if (patch.runId !== undefined) hermesResource(patch.runId);
      Object.assign(record, patch);
      if (record.runId !== null || TERMINAL_RUNS.has(record.status)) delete record.input;
      return record;
    });
  }
}
