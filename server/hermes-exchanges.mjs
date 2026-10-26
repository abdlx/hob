import { DatabaseSync } from 'node:sqlite';
import { mkdir, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HermesError, parseHermesSessionKey } from './hermes-client.mjs';

/** Durable correlation records. Hermes remains the owner of execution and transcripts. */
export class HermesExchanges {
  #db;
  constructor(filename = ':memory:') {
    this.#db = new DatabaseSync(filename);
    if (this.#db.prepare('PRAGMA user_version').get().user_version > 1) {
      this.#db.close(); throw new Error('The exchange database requires a newer application version.');
    }
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS exchanges (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL, receiver TEXT NOT NULL,
        request_key TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL,
        UNIQUE(sender, request_key));
      CREATE INDEX IF NOT EXISTS exchange_receiver ON exchanges(receiver, created_at);
      CREATE INDEX IF NOT EXISTS exchange_sender ON exchanges(sender, created_at);
      CREATE INDEX IF NOT EXISTS exchange_created ON exchanges(created_at);
      CREATE INDEX IF NOT EXISTS exchange_status ON exchanges(json_extract(payload, '$.status'));
      CREATE TABLE IF NOT EXISTS deliveries (
        exchange_id TEXT NOT NULL REFERENCES exchanges(id), profile TEXT NOT NULL, session_key TEXT NOT NULL,
        PRIMARY KEY(exchange_id, profile)); PRAGMA user_version=1;`);
  }
  static async open(stateDir) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const filename = path.join(stateDir, 'exchanges.sqlite');
    try { const handle = await open(filename, 'wx', 0o600); await handle.close(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Invalid exchange database.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return new HermesExchanges(filename);
  }
  get(id) { const row = this.#db.prepare('SELECT payload FROM exchanges WHERE id=?').get(id); return row ? JSON.parse(row.payload) : null; }
  find(sender, requestKey) {
    const row = this.#db.prepare('SELECT payload FROM exchanges WHERE sender=? AND request_key=?').get(sender, requestKey);
    return row ? JSON.parse(row.payload) : null;
  }
  list(profile, before = Number.MAX_SAFE_INTEGER, limit = 50) {
    return this.#db.prepare("SELECT json_remove(payload, '$.message', '$.reply') AS payload FROM exchanges WHERE (sender=? OR receiver=?) AND created_at<? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(profile, profile, before, limit).map(row => JSON.parse(row.payload));
  }
  parent(profile, sessionId) {
    const row = this.#db.prepare("SELECT payload FROM exchanges WHERE receiver=? AND json_extract(payload, '$.sessionId')=? ORDER BY created_at DESC LIMIT 1").get(profile, sessionId);
    return row ? JSON.parse(row.payload) : null;
  }
  create(input) {
    const last = this.#db.prepare('SELECT MAX(created_at) AS latest FROM exchanges').get().latest || 0;
    const record = { ...input, id: randomUUID(), createdAt: Math.max(Date.now(), last + 1), updatedAt: Date.now(), status: 'admitting', runId: null, sessionId: null, reply: '' };
    this.#db.prepare('INSERT INTO exchanges VALUES (?, ?, ?, ?, ?, ?)').run(record.id, record.from, record.to, record.requestKey, record.createdAt, JSON.stringify(record));
    return record;
  }
  update(id, patch) {
    const record = this.get(id);
    if (!record) throw new HermesError(404, 'Exchange not found.', 'NOT_FOUND');
    const next = { ...record, ...patch, updatedAt: Date.now() };
    this.#db.prepare('UPDATE exchanges SET payload=? WHERE id=?').run(JSON.stringify(next), id);
    return next;
  }
  /** Claim an inbox notice once, keeping it in that conversation across refreshes. */
  timeline(profile, sessionKey) {
    const owner = parseHermesSessionKey(sessionKey);
    if (owner.profile !== profile) throw new HermesError(400, 'Conversation belongs to another bot.', 'INVALID_PROFILE');
    this.#db.prepare(`INSERT OR IGNORE INTO deliveries SELECT id, ?, ? FROM exchanges
      WHERE (sender=? OR receiver=?) AND
        (json_extract(payload, '$.sourceSession') IS NULL OR sender<>? OR json_extract(payload, '$.sourceSession')=?)`)
      .run(profile, sessionKey, profile, profile, profile, owner.sessionId);
    return this.#db.prepare(`SELECT json_remove(e.payload, '$.message', '$.reply') AS payload FROM exchanges e JOIN deliveries d ON e.id=d.exchange_id
      WHERE d.profile=? AND d.session_key=? ORDER BY e.created_at DESC, e.id DESC LIMIT 100`).all(profile, sessionKey).map(row => JSON.parse(row.payload));
  }
  pending() { return this.#db.prepare("SELECT json_remove(payload, '$.message', '$.reply') AS payload FROM exchanges WHERE json_extract(payload, '$.status') IN ('admitting', 'running', 'queued', 'unknown', 'waiting_for_approval')").all().map(row => JSON.parse(row.payload)); }
  close() { this.#db.close(); }
}
