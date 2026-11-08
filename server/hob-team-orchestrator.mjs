import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HermesError, hermesProfile } from './hermes-client.mjs';
import { containsTeamCredentials } from './hermes-team.mjs';
import { classifyPromotion, detectOpenThreads, findCoreConflicts, inQuietHours, parsePromoteSection } from './hermes-team-memory.mjs';
import { parseTeamTask, parseTeamReply } from './hermes-team-protocol.mjs';

// HOB owns this bookkeeping. Native sessions, inference, tools, MEMORY.md,
// USER.md, approvals and scheduler storage remain owned by Hermes.
export const HOB_OPERATOR = Symbol('HOB operator');
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fail = (message, status = 400, code = 'HOB_TEAM_INVALID') => new HermesError(status, message, code);
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw fail('Use a stable item identifier.'); return value; };
function text(value, max = 4000, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
    || containsTeamCredentials(value)) throw fail('Use bounded, non-sensitive text without credentials.');
  return value.trim();
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('Unsupported team fields.');
}
function deadline(value) {
  if (!value || value === 'none') return null;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw fail('Use a deadline with an explicit timezone.');
  return new Date(value).toISOString();
}
function source(value) {
  fields(value, ['kind', 'taskId', 'key']);
  if (value.kind === 'task') return { kind: 'task', taskId: id(value.taskId) };
  if (['operator', 'thread'].includes(value.kind)) return { kind: value.kind, key: text(value.key, 256, true) };
  throw fail('Use a task, operator, or conversation source.');
}
const dateInZone = (at, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
const defaultPreferences = { revision: 0, dailyCap: 3, timezone: 'UTC', quietStart: '22:00', quietEnd: '08:00', neverOffer: [], delivery: 'hob', maintenance: true };

export class HobTeamOrchestrator {
  #db; #team; #roster; #exchanges; #artifacts; #now; #notify; #timer; #work; #operations = new Set(); #closed = false;
  constructor({ stateDir, workspaceRoot, team, roster, exchanges, artifacts, now = Date.now, notify = () => {} }) {
    if (!team || typeof roster !== 'function') throw new Error('HOB team ownership and enrolled roster are required.');
    this.#team = team; this.#roster = roster; this.#exchanges = exchanges; this.#artifacts = artifacts; this.#now = now; this.#notify = notify;
    let filename = ':memory:';
    if (stateDir) {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 }); filename = path.join(stateDir, 'team-memory.sqlite');
      try { closeSync(openSync(filename, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const info = lstatSync(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Invalid HOB team memory database.');
      chmodSync(filename, 0o600);
    }
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, updated INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS followups(id TEXT PRIMARY KEY, owner TEXT NOT NULL, updated INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, owner TEXT NOT NULL, updated INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS episodes_owner ON episodes(owner,created);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS inbox_owner ON inbox(owner,created);
      CREATE TABLE IF NOT EXISTS requests(actor TEXT NOT NULL, action TEXT NOT NULL, request TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(actor,action,request));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, item TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS maintenance(day TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
    this.#db.prepare('INSERT OR IGNORE INTO settings VALUES(1,?)').run(JSON.stringify(defaultPreferences));
  }
  enabled() { return this.#team.policy().architectureEnabled === true; }
  #active(profile) { hermesProfile(profile); if (!this.#roster().some(bot => bot.name === profile && bot.state === 'active')) throw fail('This bot is no longer active.', 403, 'HOB_TEAM_BOT_INACTIVE'); }
  #coordinator(actor) { if (![HOB_OPERATOR, 'default'].includes(actor)) throw fail('Only the coordinator or operator can manage team commitments.', 403, 'HOB_TEAM_COORDINATOR_REQUIRED'); if (actor === 'default') this.#active(actor); }
  #get(table, key) { const row = this.#db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(key); return row ? JSON.parse(row.payload) : null; }
  #put(table, value) {
    value = { ...value, updatedAt: Math.max(this.#now(), (this.#db.prepare(`SELECT MAX(updated) AS latest FROM ${table}`).get().latest || 0) + 1) };
    this.#db.prepare(`INSERT OR REPLACE INTO ${table}(id,owner,updated,payload) VALUES(?,?,?,?)`).run(value.id, value.owner, value.updatedAt, JSON.stringify(value)); return value;
  }
  #episode(value) {
    value = { ...value, createdAt: Math.max(this.#now(), (this.#db.prepare('SELECT MAX(created) AS latest FROM episodes').get().latest || 0) + 1) };
    this.#db.prepare('INSERT OR IGNORE INTO episodes VALUES(?,?,?,?)').run(value.id, value.owner, value.createdAt, JSON.stringify(value)); return value;
  }
  #scope(actor, value) { if (!value || (actor !== HOB_OPERATOR && actor !== 'default' && value.owner !== actor)) throw fail('Team item not found in this bot scope.', 404, 'NOT_FOUND'); return value; }
  #revision(value, expected) { if (!Number.isSafeInteger(expected) || value.revision !== expected) throw fail('This item changed. Review its current revision.', 409, 'HOB_TEAM_REVISION_CHANGED'); }
  #write(actor, action, input, work) {
    if (this.#closed) throw fail('HOB team bookkeeping is shutting down. No new action was saved.', 503, 'HOB_TEAM_CLOSED');
    if (actor !== HOB_OPERATOR) this.#active(actor);
    const actorKey = actor === HOB_OPERATOR ? 'operator' : `bot:${actor}`;
    const request = id(input.requestId), digest = sha(stable(input));
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.#db.prepare('SELECT digest,result FROM requests WHERE actor=? AND action=? AND request=?').get(actorKey, action, request);
      if (previous) { if (previous.digest !== digest) throw fail('This request identifier already names another action.', 409, 'HOB_TEAM_REQUEST_CONFLICT'); this.#db.exec('COMMIT'); return JSON.parse(previous.result); }
      const result = work();
      this.#db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(actorKey, action, request, digest, JSON.stringify(result));
      this.#db.prepare('INSERT INTO audit(created,actor,action,item,revision) VALUES(?,?,?,?,?)').run(this.#now(), actorKey, action, result.id || 'preferences', result.revision || 0);
      this.#db.exec('COMMIT');
      this.#changed(action, result.id);
      return result;
    } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
  }
  preferences() { return JSON.parse(this.#db.prepare('SELECT payload FROM settings WHERE id=1').get().payload); }
  #changed(action, item) { try { this.#notify({ event: 'team.changed', payload: { action, id: item } }); } catch { /* Notification cannot undo a committed action. */ } }
  configure(actor, input) {
    this.#coordinator(actor);
    fields(input, ['requestId', 'revision', 'dailyCap', 'timezone', 'quietStart', 'quietEnd', 'neverOffer', 'confirm']);
    if (actor !== HOB_OPERATOR || input.confirm !== true) throw fail('The operator must confirm proactive delivery preferences.', 403);
    return this.#write(actor, 'preferences', input, () => {
      const previous = this.preferences(); this.#revision(previous, input.revision);
      if (typeof input.timezone !== 'string' || !input.timezone || input.timezone.length > 100) throw fail('Choose a valid IANA timezone.');
      try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(); } catch { throw fail('Choose a valid IANA timezone.'); }
      if (!Number.isSafeInteger(input.dailyCap) || input.dailyCap < 0 || input.dailyCap > 50 || ![input.quietStart, input.quietEnd].every(value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
        || !Array.isArray(input.neverOffer) || input.neverOffer.length > 5000) throw fail('Use a daily cap from 0–50, valid quiet hours, and at most 5,000 never-offer entries.');
      const next = { ...previous, revision: previous.revision + 1, dailyCap: input.dailyCap, timezone: input.timezone,
        quietStart: input.quietStart, quietEnd: input.quietEnd, neverOffer: input.neverOffer.map(value => text(value, 200)) };
      this.#db.prepare('UPDATE settings SET payload=? WHERE id=1').run(JSON.stringify(next)); return next;
    });
  }
  list(actor, table = 'tasks', { before = Number.MAX_SAFE_INTEGER, limit = 100 } = {}) {
    if (!['tasks', 'followups', 'candidates'].includes(table)) throw fail('Unknown team collection.');
    if (actor !== HOB_OPERATOR) this.#active(actor);
    if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw fail('Invalid history cursor.');
    const all = actor === HOB_OPERATOR || actor === 'default';
    const rows = this.#db.prepare(`SELECT payload FROM ${table} WHERE updated<? ${all ? '' : 'AND owner=?'} ORDER BY updated DESC,id DESC LIMIT ?`)
      .all(...(all ? [before, limit] : [before, actor, limit])).map(row => JSON.parse(row.payload));
    return rows;
  }
  task(actor, key) { return this.#scope(actor, this.#get('tasks', id(key))); }
  plan(actor, input) {
    this.#coordinator(actor);
    fields(input, ['requestId', 'id', 'owner', 'title', 'outcome', 'output', 'deadline', 'steps', 'sourceSession']);
    this.#active(input.owner);
    const title = text(input.title, 200), outcome = text(input.outcome), output = text(input.output || 'none', 4096);
    const due = deadline(input.deadline);
    if (output !== 'none' && (/(?:^|[\\/])(?:\.[^/]*|memories|credentials?|secrets?|auth(?:\.json)?|AGENTS\.md|SOUL\.md|USER\.md|MEMORY\.md|TEAM_CORE\.md|config\.ya?ml|state\.db)(?:[\\/]|$)|\.(?:pem|key|sqlite|db)$/i.test(output) || /[%:]/.test(output))) throw fail('Nominate a deliverable, not private bot state.');
    parseTeamTask(`TASK ${id(input.id)} — ${title}\nOUTCOME: ${outcome.replaceAll('\n', '\n  ')}\nCONSTRAINTS: Keep normal approvals\nOUTPUT: ${output}\nDEADLINE: ${due || 'none'}\nCORE REFS: none`);
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 30) throw fail('Plan the task in 1–30 steps before delegating.');
    const steps = input.steps.map(value => ({ title: text(value, 300), status: 'pending' }));
    return this.#write(actor, 'plan', input, () => {
      if (this.#get('tasks', input.id)) throw fail('This task identifier is already in use.', 409);
      return this.#put('tasks', { id: input.id, owner: input.owner, title, outcome, output, deadline: due, steps, sourceSession: text(input.sourceSession, 1024, true),
        status: 'planned', revision: 1, createdAt: this.#now(), updatedAt: this.#now(), exchangeId: null, verification: 'unproven' });
    });
  }
  checkDelegation(task, receiver) {
    const current = this.#get('tasks', task.id);
    if (!current || current.status !== 'planned' || !current.steps.length) throw fail('Create this task and its step plan with node .hob/work.mjs plan before delegating.', 409, 'HOB_TEAM_PLAN_REQUIRED');
    if (current.owner !== receiver || current.outcome !== task.fields.OUTCOME || current.output !== task.fields.OUTPUT || current.deadline !== deadline(task.fields.DEADLINE)) throw fail('The assignment must match the registered owner, outcome, output and deadline.', 409, 'HOB_TEAM_PLAN_CHANGED');
    if (this.#exchanges?.findTeamTask(task.id, receiver)) throw fail('This task already has a durable exchange. Inspect its status before delegating again.', 409, 'HOB_TEAM_ALREADY_DELEGATED');
    return current;
  }
  delegated(record) {
    if (!this.enabled() || !record.teamTask) return;
    const current = this.#get('tasks', record.teamTask.id);
    if (current?.exchangeId === record.id) return current;
    if (!current || current.status !== 'planned' || current.owner !== record.to) throw fail('This task no longer permits delegation.', 409);
    const next = { ...current, exchangeId: record.id, revision: current.revision + 1, status: 'in_progress', updatedAt: this.#now(),
      steps: current.steps.map((step, index) => ({ ...step, status: index === 0 ? 'in_progress' : step.status })) };
    return this.#put('tasks', next);
  }
  progress(actor, input) {
    fields(input, ['requestId', 'id', 'revision', 'step', 'status', 'note']);
    return this.#write(actor, 'progress', input, () => {
      const current = this.task(actor, input.id); this.#revision(current, input.revision);
      if (!['in_progress', 'waiting', 'blocked'].includes(current.status) || !Number.isInteger(input.step) || input.step < 0 || input.step >= current.steps.length
        || !['done', 'in_progress', 'blocked', 'pending'].includes(input.status)) throw fail('Choose an active task step and its current state.');
      const steps = current.steps.map((step, index) => index === input.step ? { ...step, status: input.status } : step);
      if (steps.filter(step => step.status === 'in_progress').length > 1) throw fail('Finish or pause the current step before starting another.', 409);
      const note = text(input.note, 1000, true), entry = { id: randomUUID(), owner: current.owner, createdAt: this.#now(), summary: `${current.title}: ${steps[input.step].title} — ${input.status}${note ? '. ' + note : ''}`, source: { kind: 'task-progress', taskId: current.id } };
      this.#episode(entry);
      return this.#put('tasks', { ...current, steps, note, revision: current.revision + 1, updatedAt: this.#now(),
        status: input.status === 'blocked' ? 'blocked' : 'in_progress' });
    });
  }
  followup(actor, input) {
    fields(input, ['requestId', 'title', 'owner', 'outcome', 'deadline', 'source', 'kind']);
    const owner = actor === HOB_OPERATOR || actor === 'default' ? hermesProfile(input.owner || 'default') : actor;
    if (actor !== HOB_OPERATOR && actor !== 'default' && input.owner !== undefined && input.owner !== actor) throw fail('Workers can only create their own commitments.', 403);
    this.#active(owner);
    const origin = source(input.source || { kind: 'operator' });
    if (input.kind !== undefined && input.kind !== 'reminder') throw fail('Only reminder commitments can be created directly.');
    if (origin.kind === 'task') this.task(actor, origin.taskId);
    return this.#write(actor, 'followup', input, () => {
      const value = { id: randomUUID(), owner, title: text(input.title, 200), outcome: text(input.outcome), deadline: deadline(input.deadline), source: origin,
        kind: 'reminder', status: actor === HOB_OPERATOR ? 'open' : 'draft', revision: 1, createdAt: this.#now(), updatedAt: this.#now(), approved: actor === HOB_OPERATOR, lastChecked: null };
      return this.#put('followups', value);
    });
  }
  decideFollowup(actor, input) {
    this.#coordinator(actor); fields(input, ['requestId', 'id', 'revision', 'decision', 'confirm', 'evidence']);
    return this.#write(actor, 'followup-decision', input, () => {
      const current = this.#scope(actor, this.#get('followups', id(input.id))); this.#revision(current, input.revision);
      if (!['approve', 'done', 'dismiss', 'still-open'].includes(input.decision) || input.confirm !== true) throw fail('Confirm the current follow-up decision.');
      if (input.decision === 'approve' && actor !== HOB_OPERATOR) throw fail('Only the operator approves an automatically detected commitment.', 403);
      if (['done', 'closed', 'delivered'].includes(current.status)) throw fail('This follow-up is already settled.', 409);
      const evidence = text(input.evidence, 2000, input.decision === 'dismiss');
      const state = input.decision === 'done' ? 'done' : input.decision === 'dismiss' ? 'closed' : 'open';
      const next = { ...current, status: state, approved: current.approved || input.decision === 'approve', revision: current.revision + 1, updatedAt: this.#now(), evidence,
        lastChecked: this.#now(), checkedUntil: this.#now() + 15 * 60000, checkedBy: actor === HOB_OPERATOR ? 'operator' : `bot:${actor}` };
      if (input.decision === 'dismiss') {
        const prefs = this.preferences();
        prefs.neverOffer = [...new Set([...prefs.neverOffer, current.id, current.title])]; prefs.revision++;
        this.#db.prepare('UPDATE settings SET payload=? WHERE id=1').run(JSON.stringify(prefs));
      }
      return this.#put('followups', next);
    });
  }
  episodes(actor, { before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
    // Main never obtains a worker's private episodic log through its credential.
    this.#active(actor);
    if (!Number.isSafeInteger(before) || before < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('Invalid private-log cursor.');
    return this.#db.prepare('SELECT payload FROM episodes WHERE owner=? AND created<? ORDER BY created DESC LIMIT ?').all(actor, before, limit).map(row => JSON.parse(row.payload));
  }
  observeTurn({ profile, admissionId, sessionId, output, input = '' }) {
    if (!this.enabled() || this.#closed) return;
    this.#active(profile);
    const key = sha(stable(['turn', profile, admissionId]));
    if (this.#get('episodes', key)) return;
    if (!admissionId) return;
    const clean = containsTeamCredentials(output) || containsTeamCredentials(input) || /session[- ]only|do not (?:remember|save)|don't (?:remember|save)/i.test(input) ? '' : String(output || '').slice(0, 16000);
    const at = this.#now(), value = { id: key, owner: profile, sessionId: String(sessionId || '').slice(0, 1024), createdAt: at, summary: 'Native turn completed. Its transcript remains in Hermes.', source: { kind: 'admission', id: String(admissionId).slice(0, 256) } };
    this.#episode(value);
    const existing = this.list('default', 'followups', { limit: 200 }).map(row => row.title);
    for (const draft of detectOpenThreads(clean, { source: key, existing }).slice(0, 10)) {
      const draftId = sha(stable([profile, draft.title]));
      if (this.#get('followups', draftId) || containsTeamCredentials(draft.title) || this.preferences().neverOffer.some(entry => entry.toLowerCase() === draft.title.toLowerCase())) continue;
      this.#put('followups', { id: draftId, owner: profile, title: draft.title.slice(0, 200), outcome: String(draft.evidence || draft.title).slice(0, 4000),
        deadline: null, source: { kind: 'thread', key }, kind: 'reminder', status: 'draft', approved: false, revision: 1, createdAt: at, updatedAt: at, lastChecked: null });
    }
  }
  inbox(profile, before = Number.MAX_SAFE_INTEGER) {
    this.#active(profile);
    if (!Number.isSafeInteger(before) || before < 0) throw fail('Invalid inbox cursor.');
    return this.#db.prepare('SELECT payload FROM inbox WHERE owner=? AND created<? ORDER BY created DESC LIMIT 100').all(profile, before).map(row => JSON.parse(row.payload));
  }
  acknowledge(actor, input) {
    if (actor !== HOB_OPERATOR) throw fail('Only the operator marks inbox notices read.', 403);
    fields(input, ['requestId', 'id']);
    return this.#write(actor, 'inbox-read', input, () => {
      const current = this.#get('inbox', id(input.id)); if (!current) throw fail('Inbox notice not found.', 404);
      const next = { ...current, acknowledgedAt: current.acknowledgedAt || this.#now() };
      this.#db.prepare('UPDATE inbox SET payload=? WHERE id=?').run(JSON.stringify(next), next.id); return next;
    });
  }
  async output(actor, key) {
    if (actor !== HOB_OPERATOR) throw fail('Reviewed downloads require dashboard operator authentication.', 403);
    const task = this.task(actor, key), record = this.#exchanges?.get(task.exchangeId);
    if (task.status !== 'done' || task.verification !== 'coordinator-reviewed' || !record || record.teamTask?.id !== task.id || record.to !== task.owner || !this.#artifacts?.readReviewed) throw fail('This task has no currently reviewed file output.', 409);
    const operation = this.#artifacts.readReviewed(record).then(file => {
      const current = this.#exchanges.get(record.id);
      if (!current || current.message !== record.message || current.reply !== record.reply || current.status !== 'completed') throw fail('The task output changed before download. Refresh its review.', 409);
      return file;
    });
    this.#operations.add(operation); void operation.finally(() => this.#operations.delete(operation)).catch(() => {});
    return operation;
  }
  status(actor = HOB_OPERATOR) {
    return { enabled: this.enabled(), preferences: this.preferences(), tasks: this.list(actor), followups: this.list(actor, 'followups'),
      candidates: this.list(actor, 'candidates'), delivery: 'hob', inferenceOwner: 'hermes', backgroundModelCalls: false,
      maintenance: this.#db.prepare('SELECT payload FROM maintenance ORDER BY day DESC LIMIT 1').get()?.payload ? JSON.parse(this.#db.prepare('SELECT payload FROM maintenance ORDER BY day DESC LIMIT 1').get().payload) : null };
  }
  audit() { return this.#db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all(); }
  remember(actor, input) {
    this.#active(actor); fields(input, ['requestId', 'summary', 'evidence']);
    return this.#write(actor, 'remember', input, () => {
      const value = { id: randomUUID(), owner: actor, createdAt: this.#now(), summary: text(input.summary, 4000), evidence: text(input.evidence, 2000), source: { kind: 'explicit-private-note' } };
      return this.#episode(value);
    });
  }
  reviewText(actor, input) {
    if (actor !== HOB_OPERATOR) throw fail('Only the operator can attest a task without a file deliverable.', 403);
    fields(input, ['requestId', 'id', 'revision', 'evidence', 'confirm']);
    return this.#write(actor, 'text-review', input, () => {
      const current = this.task(actor, input.id); this.#revision(current, input.revision);
      const record = this.#exchanges?.get(current.exchangeId);
      if (input.confirm !== true || current.output !== 'none' || record?.status !== 'completed') throw fail('Review the current completed text result first.', 409);
      const reply = parseTeamReply(record.reply, current.id);
      if (reply.title !== 'DONE' || reply.fields.BLOCKERS.toLowerCase() !== 'none') throw fail('Blocked or partial work cannot pass review.', 409);
      return this.#put('tasks', { ...current, textReview: { replySha256: sha(record.reply), evidence: text(input.evidence, 2000), at: this.#now() }, revision: current.revision + 1 });
    });
  }
  candidate(actor, input) {
    this.#active(actor); fields(input, ['requestId', 'fact', 'evidence']);
    return this.#write(actor, 'candidate', input, () => this.#candidate(actor, text(input.fact, 2000), text(input.evidence, 2000), { kind: 'explicit-proposal' }));
  }
  #candidate(owner, fact, evidence, origin) {
    const key = sha(stable([owner, fact.toLowerCase().replace(/\s+/g, ' ').trim()]));
    const existing = this.#get('candidates', key); if (existing) return existing;
    return this.#put('candidates', { id: key, owner, fact, evidence, source: origin, tier: classifyPromotion(fact), conflicts: findCoreConflicts(fact, this.#team.core().content),
      status: 'pending', revision: 1, createdAt: this.#now() });
  }
  decideCandidate(actor, input) {
    if (actor !== HOB_OPERATOR) throw fail('Only the operator reviews shared-memory candidates.', 403);
    fields(input, ['requestId', 'id', 'revision', 'decision', 'base', 'confirm']);
    const act = () => this.#write(actor, 'candidate-decision', input, () => {
      const current = this.#scope(actor, this.#get('candidates', id(input.id))); this.#revision(current, input.revision);
      if (current.status !== 'pending' || input.confirm !== true || !['stage', 'reject'].includes(input.decision)) throw fail('Review this pending candidate first.', 409);
      let proposal = null;
      if (input.decision === 'stage') {
        if (current.source.kind === 'reviewed-task') {
          const task = this.#get('tasks', current.source.taskId);
          if (!task || task.status !== 'done' || task.verification === 'unproven') throw fail('The source task needs a current passing review before its fact can be staged.', 409, 'HOB_TEAM_SOURCE_STALE');
        }
        const core = this.#team.core(); if (input.base !== core.revision) throw fail('The shared core changed. Refresh before staging.', 409);
        const line = `- ${current.fact.replaceAll('\n', '\n  ')}\n`;
        const content = /^# Essential\s*$/m.test(core.content)
          ? core.content.replace(/^# Essential\s*$/m, match => `${match}\n${line}`)
          : `# Essential\n${line}\n${core.content ? '# Reference\n' + core.content : ''}`;
        proposal = this.#team.propose({ author: 'user', content, base: core.revision, evidence: `Candidate ${current.id}: ${current.evidence}`.slice(0, 4000) });
      }
      return this.#put('candidates', { ...current, status: proposal ? 'staged' : 'rejected', proposalId: proposal?.id || null, revision: current.revision + 1 });
    });
    const current = this.#get('candidates', id(input.id));
    if (input.decision === 'stage' && current?.source.kind === 'reviewed-task') {
      const task = this.#get('tasks', current.source.taskId); if (!task) throw fail('The source task is unavailable.', 409, 'HOB_TEAM_SOURCE_STALE');
      const operation = this.#reconcileTask(task).then(act);
      this.#operations.add(operation); void operation.finally(() => this.#operations.delete(operation)).catch(() => {}); return operation;
    }
    return act();
  }
  async #reconcileTask(task) {
    if (!task.exchangeId) {
      const orphan = this.#exchanges?.findTeamTask(task.id, task.owner);
      if (!orphan) return;
      task = this.delegated(orphan);
    }
    const record = this.#exchanges?.get(task.exchangeId); if (!record || record.teamTask?.id !== task.id || record.to !== task.owner) return;
    let status = task.status, verification = 'unproven', review = null, reviewIssue = null;
    let active = true;
    try { this.#active(task.owner); this.#active('default'); } catch { status = 'blocked'; active = false; }
    if (active) {
      if (['running', 'admitting', 'queued'].includes(record.status)) status = task.steps.some(step => step.status === 'blocked') ? 'blocked' : 'in_progress';
      else if (record.status === 'completed') {
        status = 'review_pending';
        try {
          const reply = parseTeamReply(record.reply, task.id);
          if (record.replyTruncated || reply.title !== 'DONE' || reply.fields.BLOCKERS.toLowerCase() !== 'none') status = 'blocked';
          else if (task.output === 'none' && task.textReview?.replySha256 === sha(record.reply)) { status = 'done'; verification = 'operator-reviewed'; review = task.textReview; }
          else if (task.output !== 'none' && this.#artifacts) {
            const receipt = await this.#artifacts.inspect(record);
            const state = this.#artifacts.reviewState(record);
            if (receipt && state?.teamReview?.sha256 === receipt.sha256 && state.teamVerification === 'coordinator-reviewed') {
              status = 'done'; verification = 'coordinator-reviewed'; review = state.teamReview;
            } else if (state?.teamVerification === 'coordinator-rejected') status = 'blocked';
          }
        } catch (error) {
          status = error.code === 'TEAM_TASK_FORMAT' ? 'blocked' : 'review_pending';
          reviewIssue = error.code === 'TEAM_TASK_FORMAT' ? 'The worker reply does not match the required task result format.'
            : error.code === 'TEAM_ARTIFACT_CHANGED' ? 'The reviewed output snapshot changed. A fresh output review is required.' : 'The assigned output does not have a current readable review snapshot.';
        }
      } else if (['failed', 'cancelled', 'interrupted'].includes(record.status)) status = record.status === 'failed' ? 'failed' : 'cancelled';
      else status = 'waiting';
    }
    // Awaiting a file read must never overwrite a concurrent progress revision.
    const latest = this.#get('tasks', task.id), currentRecord = this.#exchanges?.get(task.exchangeId);
    if (!currentRecord || currentRecord.status !== record.status || currentRecord.reply !== record.reply) return;
    if (latest.revision !== task.revision) return;
    const reviewSession = this.#exchanges.wakeups(record.id).find(wake => wake.profile === 'default' && wake.internal)?.sessionKey || null;
    if (status !== task.status || verification !== task.verification || task.nativeStatus !== record.status || task.reviewSession !== reviewSession || task.reviewIssue !== reviewIssue) {
      task = this.#put('tasks', { ...task, status, verification, nativeStatus: record.status,
        reviewSession, reviewIssue, result: !containsTeamCredentials(record.reply || '') ? String(record.reply || '').slice(0, 16000) : '[Sensitive result omitted.]', revision: task.revision + 1,
        steps: status === 'done' ? task.steps.map(step => ({ ...step, status: 'done' })) : task.steps });
      this.#changed('task-state', task.id);
    }
    if (status === 'done') {
      const key = sha(stable(['result', record.id]));
      if (!this.#get('followups', key)) this.#put('followups', { id: key, owner: 'default', title: task.title, outcome: task.outcome, deadline: null,
        source: { kind: 'task', taskId: task.id }, kind: 'result', status: 'open', approved: true, revision: 1, createdAt: this.#now(), review });
      for (const item of parsePromoteSection(record.reply).slice(0, 20)) {
        try { this.#candidate(task.owner, text(item.fact, 2000), text(item.evidence || `Reviewed task ${task.id}`, 2000), { kind: 'reviewed-task', taskId: task.id, exchangeId: record.id }); } catch { /* Malformed proposals are never published. */ }
      }
    }
    if (active && ['completed', 'failed', 'cancelled', 'interrupted'].includes(record.status)) this.observeTurn({ profile: task.owner, admissionId: record.id, sessionId: record.sessionId, output: '' });
  }
  async #sweep() {
    if (!this.enabled() || this.#closed) return;
    // Settled, delivered work is historical. Re-read its snapshot when a fact
    // is staged; do not hash every old artifact every five seconds forever.
    for (const row of this.#db.prepare(`SELECT payload FROM tasks WHERE json_extract(payload,'$.status') NOT IN ('done','failed','cancelled')
      OR EXISTS (SELECT 1 FROM followups WHERE json_extract(followups.payload,'$.source.taskId')=tasks.id AND json_extract(followups.payload,'$.kind')='result' AND json_extract(followups.payload,'$.status')='open')`).all()) {
      if (this.#closed) return;
      await this.#reconcileTask(JSON.parse(row.payload));
    }
    const prefs = this.preferences(), now = this.#now(), today = dateInZone(now, prefs.timezone);
    const quiet = inQuietHours({ quietHours: { start: prefs.quietStart, end: prefs.quietEnd, timezone: prefs.timezone } }, new Date(now));
    let count = this.#db.prepare('SELECT created FROM inbox').all().filter(row => dateInZone(row.created, prefs.timezone) === today).length;
    for (const row of this.#db.prepare("SELECT payload FROM followups WHERE json_extract(payload,'$.status')='open'").all()) {
      const item = JSON.parse(row.payload);
      if (!item.approved) continue;
      try { this.#active(item.owner); } catch { continue; }
      if (prefs.neverOffer.some(entry => [item.id.toLowerCase(), item.title.toLowerCase()].includes(entry.toLowerCase()))) continue;
      const task = item.source.kind === 'task' ? this.#get('tasks', item.source.taskId) : null;
      if (task && item.kind !== 'result' && ['done', 'cancelled'].includes(task.status)) { this.#put('followups', { ...item, status: 'closed', revision: item.revision + 1, lastChecked: now }); continue; }
      const fresh = task ? item.kind === 'result' ? task.status === 'done' && task.verification !== 'unproven' : ['in_progress', 'waiting', 'blocked', 'planned', 'review_pending'].includes(task.status)
        : item.checkedBy === 'operator' && item.checkedUntil >= now;
      if (!fresh || (item.deadline && Date.parse(item.deadline) > now) || quiet || count >= prefs.dailyCap) continue;
      // The delivery and settled marker commit together; polling/restarts cannot duplicate it.
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.#get('followups', item.id);
        if (current.revision !== item.revision || current.status !== 'open') { this.#db.exec('COMMIT'); continue; }
        const notification = { id: item.id, owner: item.owner, createdAt: now, title: item.title, kind: item.kind, taskId: task?.id || null,
          output: item.kind === 'result' ? task.output : null,
          message: item.kind === 'result' ? `Reviewed task completed: ${item.title}. ${task.verification === 'operator-reviewed' ? 'Reviewed by you.' : 'The coordinator reviewed the assigned output snapshot.'}` : `Follow-up: ${item.title}. ${item.outcome}${task ? ` Current task state: ${task.status.replaceAll('_', ' ')}.` : ''}`, verification: task?.verification || 'operator-checked' };
        this.#db.prepare('INSERT OR IGNORE INTO inbox VALUES(?,?,?,?)').run(notification.id, notification.owner, now, JSON.stringify(notification));
        this.#put('followups', { ...current, status: 'delivered', lastChecked: now, deliveredAt: now, revision: current.revision + 1 });
        this.#db.exec('COMMIT'); count++; this.#changed('inbox', item.id);
      } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    }
    if (!this.#db.prepare('SELECT 1 FROM maintenance WHERE day=?').get(today)) {
      const core = this.#team.core();
      for (const row of this.#db.prepare("SELECT payload FROM candidates WHERE json_extract(payload,'$.status')='pending'").all()) {
        const candidate = JSON.parse(row.payload), stale = candidate.createdAt < now - 90 * 86400000;
        const conflicts = findCoreConflicts(candidate.fact, core.content);
        if (candidate.stale !== stale || candidate.checkedCore !== core.revision || stable(candidate.conflicts) !== stable(conflicts)) {
          this.#put('candidates', { ...candidate, stale, checkedCore: core.revision, conflicts, revision: candidate.revision + 1 });
        }
      }
      const summary = { day: today, at: now, kind: 'deterministic-consolidation', candidates: this.#db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count,
        staleCandidates: this.#db.prepare("SELECT COUNT(*) AS count FROM candidates WHERE json_extract(payload,'$.createdAt')<? AND json_extract(payload,'$.status')='pending'").get(now - 90 * 86400000).count,
        note: 'Reviewed proposals deduplicated; no model invocation or automatic core publication.' };
      this.#db.prepare('INSERT OR IGNORE INTO maintenance VALUES(?,?)').run(today, JSON.stringify(summary)); this.#changed('maintenance', today);
    }
  }
  sweep() {
    if (this.#closed) return Promise.resolve();
    if (!this.#work) this.#work = this.#sweep().finally(() => { this.#work = null; });
    return this.#work;
  }
  start() { if (this.#timer || this.#closed) return; this.#timer = setInterval(() => { void this.sweep().catch(() => console.warn('[hob] Team bookkeeping will retry its sweep.')); }, 30000); this.#timer.unref?.(); void this.sweep().catch(() => {}); }
  async close() { if (this.#closed) return; this.#closed = true; clearInterval(this.#timer); try { await Promise.allSettled([...this.#operations, this.#work]); } finally { this.#db.close(); } }
}
