import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HermesError, hermesProfile } from './hermes-client.mjs';
import { readObservedFile } from './bounded-file.mjs';

export const CORE_START = '<!-- HOB:TEAM-CORE:START -->';
export const CORE_END = '<!-- HOB:TEAM-CORE:END -->';
const NOTICE = '> Synced copy of the shared docs. Edit the source via Main.\n\n';
const MAX_FILE = 2 * 1024 * 1024;
const MAX_COPY = MAX_FILE + Buffer.byteLength(NOTICE);
const MAX_TOTAL = 16 * 1024 * 1024;
const sensitive = /(?:^|[\\/])(?:\.[^\\/]*|node_modules|credentials?|secrets?|auth(?:\.json)?|config\.ya?ml)(?:[\\/]|$)|(?:token|credential|secret|\.pem$|\.key$)/i;
const secretContent = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*["']?[^\s"']{8,}/i;
export const containsTeamCredentials = value => secretContent.test(String(value || ''));
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400, code = 'INVALID_TEAM_REQUEST') => new HermesError(status, message, code);
const defaults = { revision: 0, coordinatorOnly: false, shareDocuments: false, coreBudget: 4000, sessionWindow: 20, ordinaryPromotions: 'user', nativeContext: false };

// Native privacy/context qualification is deliberately separate from these controls.
// An operator enabling document distribution is not an attestation that the team is live.
export function coreBlock(core) {
  if (!core.revision) return '';
  const full = core.content.replace(/\r\n/g, '\n');
  const section = full.match(/^# Essential\s*\n([\s\S]*?)(?=^# Reference\s*$|(?![\s\S]))/m);
  const essential = section ? section[1].trim() : full.trim();
  if (!essential) throw fail('The core Essential section cannot be empty.');
  return `${CORE_START}\n## Shared team core\nPublished revision: ${core.revision}\n\n${essential}\n${CORE_END}`;
}

/** Pin each directory component. Production Linux operations use directory FDs. */
export async function teamDirectory(root, parts, { create = false, mode = 0o700 } = {}) {
  const handles = [];
  try {
    let physical = await realpath(root), target = physical;
    if (process.platform === 'linux') {
      const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(handle); target = `/proc/self/fd/${handle.fd}`;
    }
    for (const part of parts) {
      if (!part || part === '.' || part === '..' || /[\\/\x00-\x1f]/.test(part)) throw fail('Invalid team directory.');
      const next = path.join(target, part); physical = path.join(physical, part);
      if (create) await mkdir(next, { mode }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const entry = await lstat(next);
      if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(next) !== physical) throw fail('Linked team directories are refused.');
      if (process.platform === 'linux') {
        const handle = await open(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const current = await handle.stat();
        if (current.dev !== entry.dev || current.ino !== entry.ino) { await handle.close(); throw fail('Team directory changed.'); }
        handles.push(handle); target = `/proc/self/fd/${handle.fd}`;
      } else target = next;
    }
    return { target, close: () => Promise.all(handles.map(handle => handle.close())) };
  } catch (error) { await Promise.all(handles.map(handle => handle.close())); throw error; }
}

async function readFile(filename, max = MAX_FILE) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max) throw fail('Team files must be independent regular files within the size limit.');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (current.dev !== info.dev || current.ino !== info.ino || current.nlink !== 1 || current.size !== info.size) throw fail('Team file changed before read.');
    const bytes = await readObservedFile(handle, info.size), after = await handle.stat();
    if (bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== current.mtimeMs) throw fail('Team file changed during read.');
    return bytes;
  } finally { await handle.close(); }
}

async function replaceFile(filename, bytes) {
  try {
    if ((await readFile(filename, MAX_COPY)).equals(Buffer.from(bytes))) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o640, flush: true }); await rename(temporary, filename); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function validateCore(content, budget, revision) {
  if (typeof content !== 'string' || !content.trim() || !content.isWellFormed() || Buffer.byteLength(content) > 64000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content) || /<!--\s*HOB:/i.test(content)) throw fail('Enter valid core text under 64 KB without control characters or managed block delimiters.');
  if (secretContent.test(content)) throw fail('Potential credentials cannot be published in team core.');
  if (Array.from(coreBlock({ content, revision })).length > budget) throw fail('The complete injected core exceeds its budget. Reduce Essential; keep retrieval-only details under # Reference.');
}

/** Approved revisions are immutable. Raw workspace edits can only become proposals. */
export class HermesTeam {
  #db; #root; #home; #roster; #now; #draftError = '';
  constructor({ stateDir, workspaceRoot, roster, nativeHome = process.env.HERMES_HOME, now = Date.now }) {
    if (!workspaceRoot || typeof roster !== 'function') throw new Error('Team workspaces and enrolled roster are required.');
    let filename = ':memory:';
    if (stateDir) {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      filename = path.join(stateDir, 'employee-team.sqlite');
      try { closeSync(openSync(filename, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const entry = lstatSync(filename);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('Invalid employee team database.');
      chmodSync(filename, 0o600);
    }
    this.#db = new DatabaseSync(filename); this.#root = workspaceRoot; this.#home = nativeHome; this.#roster = roster; this.#now = now;
    try {
      this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, base INTEGER NOT NULL, content TEXT NOT NULL, digest TEXT NOT NULL, author TEXT NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS core_versions (revision INTEGER PRIMARY KEY, content TEXT NOT NULL, digest TEXT NOT NULL, proposal TEXT NOT NULL, committed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_state (profile TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS document_manifests (profile TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_profiles (profile TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_sessions (profile TEXT NOT NULL, session TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('user','relay')), assignment TEXT NOT NULL, PRIMARY KEY(profile,session));
      CREATE TABLE IF NOT EXISTS artifact_handoffs (exchange TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_reviews (request TEXT PRIMARY KEY, exchange TEXT NOT NULL, value TEXT NOT NULL, created INTEGER NOT NULL);`);
      this.#db.prepare('INSERT OR IGNORE INTO settings VALUES (1,?)').run(JSON.stringify(defaults));
    } catch (error) { this.#db.close(); throw error; }
  }
  policy() { return { ...defaults, ...JSON.parse(this.#db.prepare('SELECT value FROM settings WHERE id=1').get().value) }; }
  refreshRuntimeProfiles() {
    if (!this.#home) return;
    const active = this.#roster().filter(bot => bot.state === 'active');
    // Public team roles require their own operator mapping. A bot description is
    // not permission to publish its private role notes into a group context.
    const roster = active.map(bot => ({ id: hermesProfile(bot.name), name: bot.displayName || bot.display_name || bot.name, role: '' }));
    if (containsTeamCredentials(JSON.stringify(roster))) {
      if (this.policy().nativeContext) throw fail('Potential credentials in the public bot roster must be removed before native team context can be published.');
      this.#db.exec('DELETE FROM runtime_profiles'); return;
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.exec('DELETE FROM runtime_profiles');
      const insert = this.#db.prepare('INSERT INTO runtime_profiles VALUES (?,?)');
      for (const bot of roster) insert.run(bot.id, JSON.stringify({ ...bot, roster,
        home: path.resolve(this.#home, ...(bot.id === 'default' ? [] : ['profiles', bot.id])),
        workspace: path.resolve(this.#root, ...(bot.id === 'default' ? ['main'] : ['bots', bot.id])) }));
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  registerSession(profile, session, kind = 'user', assignment = '') {
    this.#active(profile);
    if (typeof session !== 'string' || !session || session.length > 512 || !['user', 'relay'].includes(kind) || typeof assignment !== 'string' || assignment.length > 64000) throw fail('Invalid native team session binding.');
    this.refreshRuntimeProfiles();
    const previous = this.#db.prepare('SELECT kind,assignment FROM runtime_sessions WHERE profile=? AND session=?').get(profile, session);
    if (previous) {
      if (kind === 'user') return; // Operator follow-up cannot turn an exchange into a different context.
      if (previous.kind !== kind || previous.assignment !== assignment) throw fail('Native session already has another team context.', 409);
      return;
    }
    this.#db.prepare('INSERT INTO runtime_sessions VALUES (?,?,?,?)').run(profile, session, kind, assignment);
  }
  sessionKind(profile, session) {
    this.#active(profile);
    return this.#db.prepare('SELECT kind FROM runtime_sessions WHERE profile=? AND session=?').get(profile, session)?.kind === 'relay' ? 'relay' : 'session';
  }
  artifactHandoff(exchange) { return JSON.parse(this.#db.prepare('SELECT value FROM artifact_handoffs WHERE exchange=?').get(exchange)?.value || 'null'); }
  saveArtifactHandoff(exchange, receipt) {
    this.#db.prepare('INSERT OR IGNORE INTO artifact_handoffs VALUES (?,?)').run(exchange, JSON.stringify(receipt));
    return this.artifactHandoff(exchange);
  }
  artifactReviews(exchange) { return this.#db.prepare('SELECT value FROM artifact_reviews WHERE exchange=? ORDER BY created DESC,rowid DESC LIMIT 30').all(exchange).map(row => JSON.parse(row.value)); }
  saveArtifactReview(exchange, review) {
    const previous = this.#db.prepare('SELECT value,exchange FROM artifact_reviews WHERE request=?').get(review.requestId);
    if (previous) {
      const stored = JSON.parse(previous.value);
      if (previous.exchange !== exchange || ['sha256', 'verdict', 'checks'].some(key => stored[key] !== review[key])) throw fail('This review request already has another decision.', 409);
      return stored;
    }
    if (this.artifactHandoff(exchange)?.sha256 !== review.sha256) throw fail('The reviewed output snapshot changed.', 409);
    const value = { ...review, author: 'default', at: new Date(this.#now()).toISOString() };
    this.#db.prepare('INSERT INTO artifact_reviews VALUES (?,?,?,?)').run(review.requestId, exchange, JSON.stringify(value), this.#now());
    return value;
  }
  core() { return this.#db.prepare('SELECT revision,content,digest,committed FROM core_versions ORDER BY revision DESC LIMIT 1').get() || { revision: 0, content: '', digest: hash('') }; }
  history() { return this.#db.prepare('SELECT revision,content,digest,committed FROM core_versions ORDER BY revision DESC LIMIT 50').all(); }
  #active(profile) {
    if (!this.#roster().some(bot => bot.name === profile && bot.state === 'active')) throw fail('This bot is not active.', 403, 'TEAM_BOT_INACTIVE');
  }
  configure(value) {
    const previous = this.policy();
    if (value.confirm !== true || value.revision !== previous.revision) throw fail('Review current team settings and confirm the exact revision.', 409);
    const keys = ['revision', 'confirm', 'coordinatorOnly', 'shareDocuments', 'coreBudget', 'sessionWindow'];
    if (Object.keys(value).some(key => !keys.includes(key)) || typeof value.coordinatorOnly !== 'boolean' || typeof value.shareDocuments !== 'boolean'
      || !Number.isInteger(value.coreBudget) || value.coreBudget < 500 || value.coreBudget > 16000 || !Number.isInteger(value.sessionWindow) || value.sessionWindow < 1 || value.sessionWindow > 100) throw fail('Use explicit team settings within their limits.');
    const core = this.core(); if (core.revision) validateCore(core.content, value.coreBudget, core.revision);
    const next = { ...previous, ...value, revision: previous.revision + 1 }; delete next.confirm;
    this.#db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(next)); return next;
  }
  propose({ author, content, base, evidence = '' }) {
    if (author !== 'user') { this.#active(author); if (author !== 'default') throw fail('Workers propose promotions to the coordinator in their relay reply.', 403); }
    if (base !== this.core().revision) throw fail('Core changed. Review the new revision before proposing.', 409, 'TEAM_CORE_CONFLICT');
    validateCore(content, this.policy().coreBudget, base + 1);
    if (typeof evidence !== 'string' || evidence.length > 4000 || secretContent.test(evidence)) throw fail('Use short non-sensitive evidence.');
    const digest = hash(content);
    if (this.#db.prepare("SELECT id FROM proposals WHERE digest=? AND base=? AND evidence=? AND status='rejected'").get(digest, base, evidence)) throw fail('A rejected promotion needs new evidence before it can be proposed again.', 409);
    const existing = this.#db.prepare("SELECT id FROM proposals WHERE digest=? AND base=? AND status='pending'").get(digest, base);
    if (existing) return this.proposal(existing.id);
    const id = randomUUID();
    this.#db.prepare('INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?)').run(id, base, content, digest, author, evidence, 'pending', this.#now());
    return this.proposal(id);
  }
  proposal(id) { return this.#db.prepare('SELECT * FROM proposals WHERE id=?').get(id) || null; }
  decide({ id, base, digest, decision, confirm }) {
    const proposal = this.proposal(id);
    if (confirm !== true || !proposal || proposal.status !== 'pending' || proposal.base !== base || proposal.digest !== digest || decision === 'approve' && base !== this.core().revision) throw fail('The reviewed proposal is stale or already decided.', 409, 'TEAM_CORE_CONFLICT');
    if (!['approve', 'reject'].includes(decision)) throw fail('Choose approve or reject.');
    if (decision === 'approve') validateCore(proposal.content, this.policy().coreBudget, base + 1);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (decision === 'approve') this.#db.prepare('INSERT INTO core_versions VALUES (?,?,?,?,?)').run(base + 1, proposal.content, proposal.digest, id, this.#now());
      this.#db.prepare('UPDATE proposals SET status=? WHERE id=?').run(decision === 'approve' ? 'approved' : 'rejected', id);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    return this.core();
  }
  async draft() {
    this.#active('default');
    let directory;
    try { directory = await teamDirectory(this.#root, ['main']); return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path.join(directory.target, 'TEAM_CORE.md'), 64000)); }
    catch (error) { if (error.code === 'ENOENT') return this.core().content; throw error; }
    finally { await directory?.close(); }
  }
  async discoverDraft() {
    try {
      const content = await this.draft(), core = this.core();
      this.#draftError = '';
      if (!content.trim() || hash(content) === core.digest) return;
      // A previously rejected identical draft is not re-proposed without new evidence.
      if (this.#db.prepare('SELECT id FROM proposals WHERE digest=? AND base=?').get(hash(content), core.revision)) return;
      this.propose({ author: 'default', content, base: core.revision, evidence: 'Draft edited in the coordinator workspace; not approved or distributed.' });
    } catch { this.#draftError = 'The coordinator core draft could not be staged safely. Repair its format, size or content, then reconcile again. Approved core remains unchanged.'; }
  }
  status() {
    const active = this.#roster().filter(bot => bot.state === 'active');
    return { policy: this.policy(), core: this.core(), draftError: this.#draftError, proposals: this.#db.prepare("SELECT * FROM proposals WHERE status='pending' ORDER BY created DESC LIMIT 50").all(),
      bots: active.map(bot => ({ id: bot.name, name: bot.displayName || bot.display_name || bot.name, ...(JSON.parse(this.#db.prepare('SELECT value FROM sync_state WHERE profile=?').get(bot.name)?.value || '{}')) })),
      qualification: { live: false, pending: ['native-context-order-and-refresh', 'session-only-memory-enforcement', 'native-filesystem-and-tool-isolation', 'artifact-handoff-verification', 'paid-lane-restrictions', 'activity-job-provenance', 'phase-2-media-and-phone-acceptance'] } };
  }
  recordSync(profile, value) {
    const previous = JSON.parse(this.#db.prepare('SELECT value FROM sync_state WHERE profile=?').get(profile)?.value || '{}');
    if (value.status !== 'synced') { value = { ...value, requestedRevision: value.revision }; delete value.revision; delete value.digest; }
    else { delete previous.error; delete previous.requestedRevision; }
    this.#db.prepare('INSERT OR REPLACE INTO sync_state VALUES (?,?)').run(profile, JSON.stringify({ ...previous, ...value, at: this.#now() }));
  }
  async snapshot() {
    this.refreshRuntimeProfiles();
    const policy = this.policy(), core = this.core(), files = new Map(), skipped = [];
    if (!policy.revision && !core.revision) return undefined;
    if (policy.shareDocuments) {
      this.#active('default');
      let visited = 0, total = 0;
      const walk = async parts => {
        const directory = await teamDirectory(this.#root, ['main', 'shared', ...parts]);
        try {
          const entries = await readdir(directory.target, { withFileTypes: true });
          if (entries.length > 256 || parts.length > 8) throw fail('Shared document folder exceeds its bounds.');
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (++visited > 1024) throw fail('Shared document traversal exceeds 1,024 entries.');
            const relative = [...parts, entry.name].join('/');
            if (relative === 'team-core.md') continue; // Service-generated projection, never a second source.
            if (sensitive.test(relative)) { skipped.push({ path: '[sensitive path]', reason: 'sensitive-path' }); continue; }
            if (/[\x00-\x1f\x7f%:]/.test(relative)) { skipped.push({ path: '[invalid path]', reason: 'invalid-path' }); continue; }
            if (entry.isDirectory()) { await walk([...parts, entry.name]); continue; }
            if (!entry.isFile() || !/\.(md|txt|json|csv|tsv|pdf|docx|xlsx|pptx)$/i.test(entry.name)) { skipped.push({ path: relative, reason: 'unsupported-or-linked-file' }); continue; }
            const filename = path.join(directory.target, entry.name), info = await lstat(filename);
            if (info.size > MAX_FILE) { skipped.push({ path: relative, reason: 'over-2-MiB' }); continue; }
            const bytes = await readFile(filename);
            // Opaque binary documents need an explicit content-admission implementation.
            if (/\.(pdf|docx|xlsx|pptx)$/i.test(entry.name)) { skipped.push({ path: relative, reason: 'binary-content-review-required' }); continue; }
            let text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
            catch { skipped.push({ path: relative, reason: 'text-format-review-required' }); continue; }
            if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) { skipped.push({ path: relative, reason: 'text-format-review-required' }); continue; }
            if (secretContent.test(text)) { skipped.push({ path: '[sensitive content]', reason: 'potential-credentials' }); continue; }
            if (files.size >= 128) throw fail('Shared docs support at most 128 eligible files.');
            const copy = /\.md$/i.test(relative) ? Buffer.concat([Buffer.from(NOTICE), bytes]) : bytes;
            total += copy.length;
            if (total > MAX_TOTAL) throw fail('Shared documents exceed 16 MiB.');
            files.set(relative, copy);
          }
        } finally { await directory.close(); }
      };
      try { await walk([]); } catch (error) { if (error.code === 'ENOENT') throw fail('Create the coordinator shared/ folder before enabling document sync.', 409); throw error; }
    }
    if (core.revision) files.set('team-core.md', Buffer.from(NOTICE + core.content));
    if ([...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) > MAX_TOTAL) throw fail('Shared documents exceed 16 MiB.');
    const digest = hash(JSON.stringify([policy, core.digest, [...files].map(([name, bytes]) => [name, hash(bytes)])]));
    return { policy, core, files, skipped, digest };
  }
  async copyDocuments(profile, workspace, snapshot) {
    this.#active(profile);
    if (profile === 'default') {
      const core = snapshot.core;
      if (core.revision) {
        const filename = path.join(workspace, 'TEAM_CORE.md');
        let current;
        try { current = await readFile(filename, 64000); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const previous = this.#db.prepare('SELECT digest FROM core_versions WHERE revision<? ORDER BY revision DESC LIMIT 1').get(core.revision)?.digest;
        // Preserve a newer concurrently authored draft instead of replacing it with approved bytes.
        if (!current || [core.digest, previous].includes(hash(current))) await replaceFile(filename, Buffer.from(core.content));
      }
      snapshot = { ...snapshot, files: new Map([...snapshot.files].filter(([name]) => name === 'team-core.md')) };
    }
    const old = JSON.parse(this.#db.prepare('SELECT value FROM document_manifests WHERE profile=?').get(profile)?.value || '[]');
    if (!snapshot.files.size && !old.length) return;
    let shared;
    const directories = [], plan = [];
    try {
      shared = await teamDirectory(workspace, ['shared'], { create: true });
      // First sync never adopts somebody else's files as disposable managed copies.
      if (profile !== 'default' && !old.length && (await readdir(shared.target)).length) throw fail('The worker shared/ folder contains unmanaged files. Move them before synchronizing.', 409);
      for (const relative of new Set([...old, ...snapshot.files.keys()])) {
        const parts = relative.split('/');
        let directory;
        try {
          directory = await teamDirectory(workspace, ['shared', ...parts.slice(0, -1)], { create: snapshot.files.has(relative) });
        } catch (error) { if (!snapshot.files.has(relative) && error.code === 'ENOENT') continue; throw error; }
        directories.push(directory);
        const filename = path.join(directory.target, parts.at(-1));
        let before = null;
        try { before = await readFile(filename, MAX_COPY); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (before && !old.includes(relative)) throw fail('A new shared document would overwrite an unmanaged worker file.', 409);
        plan.push({ filename, before, after: snapshot.files.get(relative) });
      }
      this.#active(profile);
      const manifest = this.#db.prepare('INSERT OR REPLACE INTO document_manifests VALUES (?,?)');
      // Journal the complete owned set before mutation, so an interrupted pass is repairable.
      manifest.run(profile, JSON.stringify([...new Set([...old, ...snapshot.files.keys()])]));
      try {
        for (const item of plan) {
          if (item.after) await replaceFile(item.filename, item.after);
          else await unlink(item.filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        this.#active(profile);
        manifest.run(profile, JSON.stringify([...snapshot.files.keys()]));
      } catch (error) {
        let restored = true;
        for (const item of plan) {
          try {
            if (item.before) await replaceFile(item.filename, item.before);
            else await unlink(item.filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
          } catch { restored = false; }
        }
        if (restored) manifest.run(profile, JSON.stringify(old));
        throw error;
      }
    } finally { await Promise.all(directories.map(directory => directory.close())); await shared?.close(); }
  }
  close() { this.#db.close(); }
}
