import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { HermesError, hermesNativeSessionKey, hermesProfile } from './hermes-client.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const invalid = message => new HermesError(400, message, 'INVALID_MOBILE_REQUEST');
const PUSH = 'https://exp.host/--/api/v2/push/';
const expoToken = value => typeof value === 'string' && /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,180}\]$/.test(value);

/** Private mobile sessions and a durable, generic-content notification outbox. */
export class MobileDevices {
  #db; #fingerprint; #now; #fetch; #accessToken; #closed = false; #sending = false;
  constructor({ stateDir, fingerprint, now = Date.now, fetchImpl = fetch, accessToken = process.env.HOB_EXPO_ACCESS_TOKEN } = {}) {
    let filename = ':memory:';
    if (stateDir) {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      filename = path.join(stateDir, 'mobile.sqlite');
      try { closeSync(openSync(filename, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const info = lstatSync(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Invalid mobile database.');
      chmodSync(filename, 0o600);
    }
    this.#db = new DatabaseSync(filename); this.#fingerprint = fingerprint; this.#now = now; this.#fetch = fetchImpl; this.#accessToken = accessToken;
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
        name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, push_token TEXT, last_push TEXT);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_queue (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, event_id TEXT NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        ticket TEXT, UNIQUE(device_id,event_id));`);
    this.#db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('instanceId', randomUUID());
    this.instanceId = this.#db.prepare('SELECT value FROM metadata WHERE key=?').get('instanceId').value;
  }
  login(name = 'Mobile device') {
    if (typeof name !== 'string' || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw invalid('Enter a short device name.');
    this.#db.prepare('DELETE FROM devices WHERE expires_at<=? OR fingerprint<>?').run(this.#now(), this.#fingerprint);
    if (this.#db.prepare('SELECT count(*) AS n FROM devices').get().n >= 1000) throw new HermesError(503, 'The mobile device limit has been reached.', 'MOBILE_LIMIT');
    const token = 'hobm_' + randomBytes(32).toString('hex'), id = randomUUID(), expiresAt = this.#now() + 30 * 86400_000;
    this.#db.prepare('INSERT INTO devices (id,token_hash,fingerprint,name,created_at,expires_at) VALUES (?,?,?,?,?,?)')
      .run(id, digest(token), this.#fingerprint, name || 'Mobile device', this.#now(), expiresAt);
    return { token, deviceId: id, expiresAt, instanceId: this.instanceId };
  }
  authenticate(authorization) {
    if (typeof authorization !== 'string' || !/^Bearer hobm_[a-f0-9]{64}$/.test(authorization)) return null;
    return this.#db.prepare('SELECT id FROM devices WHERE token_hash=? AND fingerprint=? AND expires_at>?')
      .get(digest(authorization.slice(7)), this.#fingerprint, this.#now())?.id || null;
  }
  active(id) { return Boolean(this.#db.prepare('SELECT id FROM devices WHERE id=? AND fingerprint=? AND expires_at>?').get(id, this.#fingerprint, this.#now())); }
  status(id) {
    const row = this.#db.prepare('SELECT id,name,expires_at,push_token,last_push FROM devices WHERE id=?').get(id);
    return { deviceId: row.id, name: row.name, expiresAt: row.expires_at, pushEnabled: Boolean(row.push_token), lastPush: row.last_push, instanceId: this.instanceId };
  }
  register(id, token) {
    if (token !== null && !expoToken(token)) throw invalid('A valid Expo push token is required.');
    if (this.#db.prepare('SELECT push_token FROM devices WHERE id=?').get(id)?.push_token === token) return this.status(id);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (token) {
        for (const previous of this.#db.prepare('SELECT id FROM devices WHERE push_token=? AND id<>?').all(token, id)) this.#db.prepare('DELETE FROM push_queue WHERE device_id=?').run(previous.id);
        this.#db.prepare('UPDATE devices SET push_token=NULL WHERE push_token=? AND id<>?').run(token, id);
      }
      this.#db.prepare('UPDATE devices SET push_token=?,last_push=NULL WHERE id=?').run(token, id);
      this.#db.prepare('DELETE FROM push_queue WHERE device_id=?').run(id);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    return this.status(id);
  }
  revoke(id) {
    this.#db.prepare('DELETE FROM push_queue WHERE device_id=?').run(id);
    this.#db.prepare('DELETE FROM devices WHERE id=?').run(id);
  }
  completed({ profile, sessionId, admissionId, createdAt = this.#now() }) {
    if (this.#closed || !admissionId || !sessionId || !Number.isFinite(createdAt) || createdAt < this.#now() - 7 * 86400_000) return;
    hermesProfile(profile);
    const eventId = digest(JSON.stringify([profile, sessionId, admissionId]));
    const payload = { title: 'hob', body: `${profile === 'default' ? 'Main' : profile} has a new reply.`,
      data: { kind: 'reply', instanceId: this.instanceId, profile, sessionKey: hermesNativeSessionKey(profile, sessionId), eventId } };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.#db.prepare('INSERT OR IGNORE INTO events VALUES (?,?)').run(eventId, createdAt).changes;
      if (inserted) for (const device of this.#db.prepare('SELECT id FROM devices WHERE push_token IS NOT NULL AND fingerprint=? AND expires_at>? AND created_at<=?')
        .all(this.#fingerprint, this.#now(), createdAt)) this.#db.prepare('INSERT OR IGNORE INTO push_queue (id,device_id,event_id,payload,status,next_at) VALUES (?,?,?,?,?,?)')
          .run(randomUUID(), device.id, eventId, JSON.stringify(payload), 'pending', this.#now());
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  test(id) {
    const device = this.#db.prepare('SELECT push_token FROM devices WHERE id=?').get(id);
    if (!device?.push_token) throw invalid('Enable notifications for this device first.');
    const recent = this.#db.prepare("SELECT max(json_extract(payload,'$.data.createdAt')) AS created_at FROM push_queue WHERE device_id=? AND event_id LIKE ?").get(id, 'test:%');
    if (recent?.created_at > this.#now() - 60_000) throw new HermesError(429, 'Wait a minute before sending another test.', 'MOBILE_RATE_LIMIT');
    const eventId = 'test:' + randomUUID();
    this.#db.prepare('INSERT INTO push_queue (id,device_id,event_id,payload,status,next_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), id, eventId,
      JSON.stringify({ title: 'hob', body: 'Notifications are connected to your hob instance.', data: { kind: 'test', instanceId: this.instanceId, createdAt: this.#now() } }), 'pending', this.#now());
    return { queued: true };
  }
  async #post(endpoint, payload) {
    const response = await this.#fetch(PUSH + endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', ...(this.#accessToken ? { Authorization: `Bearer ${this.#accessToken}` } : {}) }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error('Push transport unavailable.');
    const raw = await response.text(); if (raw.length > 256_000) throw new Error('Invalid push response.');
    return JSON.parse(raw).data;
  }
  #outcome(row, result, receipt = false) {
    // A disconnect or token rotation can happen while the provider is answering.
    // Its old response must not modify the replacement registration.
    if (!this.#db.prepare('SELECT q.id FROM push_queue q JOIN devices d ON d.id=q.device_id WHERE q.id=? AND d.push_token=?').get(row.id, row.push_token)) return;
    if (receipt && !result) {
      this.#db.prepare('UPDATE push_queue SET status=?,attempts=attempts+1,next_at=? WHERE id=?').run(row.attempts < 5 ? 'receipt' : 'failed', this.#now() + 15 * 60_000, row.id);
      return;
    }
    if (result?.status === 'ok' && (!receipt && typeof result.id === 'string')) {
      this.#db.prepare('UPDATE push_queue SET status=?,ticket=?,next_at=? WHERE id=?').run('receipt', result.id, this.#now() + 15 * 60_000, row.id); return;
    }
    const code = result?.details?.error;
    if (code === 'DeviceNotRegistered') this.#db.prepare('UPDATE devices SET push_token=NULL WHERE id=?').run(row.device_id);
    const ok = receipt && result?.status === 'ok';
    const retry = !ok && !['DeviceNotRegistered', 'MessageTooBig', 'InvalidCredentials', 'MismatchSenderId'].includes(code) && row.attempts < 5;
    const status = ok ? 'delivered' : retry ? 'pending' : 'failed';
    this.#db.prepare('UPDATE push_queue SET status=?,attempts=attempts+1,next_at=? WHERE id=?').run(status, this.#now() + Math.min(300_000, 1000 * 2 ** row.attempts), row.id);
    this.#db.prepare('UPDATE devices SET last_push=? WHERE id=?').run(ok ? 'delivered-to-provider' : retry ? 'retrying' : 'failed', row.device_id);
  }
  async flush() {
    if (this.#closed || this.#sending) return;
    this.#sending = true;
    try {
      const rows = this.#db.prepare(`SELECT q.*,d.push_token FROM push_queue q JOIN devices d ON d.id=q.device_id
        WHERE q.status IN ('pending','receipt') AND q.next_at<=? AND d.push_token IS NOT NULL AND d.fingerprint=? AND d.expires_at>? LIMIT 50`)
        .all(this.#now(), this.#fingerprint, this.#now());
      for (const row of rows) {
        if (this.#closed) break;
        if (!this.active(row.device_id) || !this.#db.prepare('SELECT q.id FROM push_queue q JOIN devices d ON d.id=q.device_id WHERE q.id=? AND d.push_token=?').get(row.id, row.push_token)) continue;
        try {
          if (row.status === 'receipt') {
            const results = await this.#post('getReceipts', { ids: [row.ticket] });
            if (!this.#closed) this.#outcome(row, results?.[row.ticket], true);
          } else {
            const results = await this.#post('send', [{ ...JSON.parse(row.payload), to: row.push_token, sound: 'default', channelId: 'hob-messages' }]);
            if (!this.#closed) this.#outcome(row, results?.[0]);
          }
        } catch { if (!this.#closed) this.#outcome(row, null, row.status === 'receipt'); }
      }
      if (!this.#closed) this.#db.prepare("DELETE FROM push_queue WHERE status IN ('delivered','failed') AND next_at<?").run(this.#now() - 7 * 86400_000);
    } finally { this.#sending = false; }
  }
  close() { this.#closed = true; this.#db.close(); }
}
