import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { HobTeamOrchestrator, HOB_OPERATOR } from '../hob-team-orchestrator.mjs';
import { HermesTeam } from '../hermes-team.mjs';
import { HermesExchanges } from '../hermes-exchanges.mjs';
import { createTeamArtifactHandoffs } from '../hermes-team-artifacts.mjs';
import { createHermesBotRelay } from '../hermes-bot-relay.mjs';
import { createHermesWakeups } from '../hermes-wakeups.mjs';
import { hobTeamRoute } from '../hob-team-routes.mjs';
import { parseTeamTask } from '../hermes-team-protocol.mjs';

const assignment = (task = 'task-1', output = 'artifacts/result.json') => `TASK ${task} — Build plan\nOUTCOME: A checked plan\nCONSTRAINTS: No external messages\nOUTPUT: ${output}\nDEADLINE: none\nCORE REFS: none`;
const answer = (task = 'task-1', output = 'artifacts/result.json', promote = 'none') => `TASK ${task} — DONE\nRESULT: Saved plan\nFILES: ${output}\nVERIFICATION: Parsed JSON and checked two steps\nBLOCKERS: none\nPROMOTE: ${promote}`;
const plan = (id = 'task-1', output = 'artifacts/result.json') => ({ requestId: `plan-${id}`, id, owner: 'writer', title: 'Build plan', outcome: 'A checked plan', output, deadline: 'none', steps: ['Build', 'Check'] });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-orchestration-'));
  const stateDir = path.join(root, 'state'), workspaceRoot = path.join(root, 'workspaces');
  const roster = ['default', 'writer', 'editor'].map(name => ({ name, displayName: name, state: 'active' }));
  await mkdir(path.join(workspaceRoot, 'main'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'bots', 'writer', 'artifacts'), { recursive: true });
  const team = new HermesTeam({ stateDir, workspaceRoot, roster: () => roster, architectureDefault: true });
  const exchanges = await HermesExchanges.open(stateDir);
  const artifacts = createTeamArtifactHandoffs({ team, workspaceRoot, roster: () => roster });
  let at = Date.parse('2026-11-08T12:00:00Z'), memory;
  const events = [], options = { stateDir, team, roster: () => roster, exchanges, artifacts, now: () => at, notify: event => events.push(event) };
  memory = new HobTeamOrchestrator(options);
  const f = { root, stateDir, workspaceRoot, roster, team, exchanges, artifacts, events, get memory() { return memory; }, setTime(value) { at = Date.parse(value); },
    async restart() { await memory.close(); memory = new HobTeamOrchestrator(options); },
    preferences(changes = {}) { const current = memory.preferences(); return memory.configure(HOB_OPERATOR, { requestId: crypto.randomUUID(), revision: current.revision, dailyCap: current.dailyCap, timezone: current.timezone, quietStart: current.quietStart, quietEnd: current.quietEnd, neverOffer: current.neverOffer, ...changes, confirm: true }); },
    delegate(id = 'task-1', output = 'artifacts/result.json', attach = true) {
      memory.plan('default', plan(id, output));
      const message = assignment(id, output); memory.checkDelegation(parseTeamTask(message), 'writer');
      const record = exchanges.create({ requestKey: `dispatch-${id}`, from: 'default', fromName: 'Main', to: 'writer', toName: 'Writer', message, teamTask: parseTeamTask(message), teamControlled: true, hobArchitecture: true });
      if (attach) memory.delegated(record); return record;
    } };
  t.after(async () => {
    await memory.close(); await f.beforeClose?.(); exchanges.close(); team.close();
    assert.equal(path.dirname(root), tmpdir()); assert.ok(path.basename(root).startsWith('hob-orchestration-'));
    await rm(root, { recursive: true, force: true });
  });
  return f;
}

test('production migration enables HOB coordination once and preserves explicit opt-out and approved core', async t => {
  const f = await fixture(t);
  assert.equal(f.team.policy().architectureEnabled, true); assert.equal(f.team.policy().coordinatorOnly, true);
  f.team.configure({ ...Object.fromEntries(['revision', 'coordinatorOnly', 'shareDocuments', 'coreBudget', 'sessionWindow'].map(key => [key, f.team.policy()[key]])), architectureEnabled: false, confirm: true });
  const another = new HermesTeam({ stateDir: f.stateDir, workspaceRoot: f.workspaceRoot, roster: () => f.roster, architectureDefault: true });
  assert.equal(another.policy().architectureEnabled, false); another.close();
  // Simulate the exact pre-feature settings shape, not a fresh test default.
  const db = new DatabaseSync(path.join(f.stateDir, 'employee-team.sqlite'));
  const old = f.team.policy(); delete old.architectureEnabled; old.coordinatorOnly = false;
  db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(old)); db.close();
  const migrated = new HermesTeam({ stateDir: f.stateDir, workspaceRoot: f.workspaceRoot, roster: () => f.roster, architectureDefault: true });
  assert.equal(migrated.policy().coordinatorOnly, true); assert.equal(migrated.policy().revision, old.revision + 1);
  assert.deepEqual(migrated.core(), f.team.core()); migrated.close();
});

test('plans and progress enforce ownership, exact revisions, request identities, and one active step', async t => {
  const f = await fixture(t), m = f.memory;
  assert.throws(() => m.checkDelegation(parseTeamTask(assignment()), 'writer'), { code: 'HOB_TEAM_PLAN_REQUIRED' });
  assert.throws(() => m.plan('writer', plan()), { status: 403 });
  assert.throws(() => m.plan('default', plan('secret', 'MEMORY.md')), /private bot state/);
  const first = m.plan('default', plan()); assert.deepEqual(m.plan('default', plan()), first);
  assert.throws(() => m.plan('default', { ...plan(), title: 'Different' }), { code: 'HOB_TEAM_REQUEST_CONFLICT' });
  assert.throws(() => m.task('editor', first.id), { status: 404 });
  assert.throws(() => m.checkDelegation(parseTeamTask(assignment().replace('A checked plan', 'A changed outcome')), 'writer'), { code: 'HOB_TEAM_PLAN_CHANGED' });
  const record = f.exchanges.create({ from: 'default', to: 'writer', requestKey: 'send', message: assignment(), teamTask: parseTeamTask(assignment()), hobArchitecture: true });
  m.delegated(record);
  assert.throws(() => m.progress('writer', { requestId: 'stale', id: first.id, revision: 1, step: 0, status: 'done' }), { code: 'HOB_TEAM_REVISION_CHANGED' });
  assert.throws(() => m.progress('editor', { requestId: 'cross', id: first.id, revision: 2, step: 0, status: 'done' }), { status: 404 });
  assert.throws(() => m.progress('writer', { requestId: 'parallel', id: first.id, revision: 2, step: 1, status: 'in_progress' }), /Finish or pause/);
  const update = { requestId: 'finish-step', id: first.id, revision: 2, step: 0, status: 'done' };
  assert.deepEqual(m.progress('writer', update), m.progress('writer', update));
  assert.equal(m.task('default', first.id).status, 'in_progress');
  f.roster.find(bot => bot.name === 'writer').state = 'revoked';
  assert.throws(() => m.list('writer'), { status: 403 });
});

test('private episodic notes stay scoped; automatic logs omit transcripts and session-only promises', async t => {
  const { memory: m } = await fixture(t);
  m.remember('writer', { requestId: 'lesson', summary: 'Writer lesson', evidence: 'Checked own task at noon' });
  m.observeTurn({ profile: 'writer', admissionId: 'turn-1', output: 'SESSION_TRANSCRIPT_CANARY', sessionId: 'own-session' });
  m.observeTurn({ profile: 'writer', admissionId: 'turn-1', output: 'duplicate' });
  m.observeTurn({ profile: 'writer', admissionId: 'turn-2', input: 'Keep this session-only, do not save.', output: 'I will send the report tomorrow.' });
  assert.equal(m.episodes('writer').length, 3);
  const firstPage = m.episodes('writer', { limit: 1 });
  assert.equal(m.episodes('writer', { limit: 2, before: firstPage[0].createdAt }).length, 2, 'same-clock log entries are not lost at the pagination boundary');
  assert.doesNotMatch(JSON.stringify(m.episodes('writer')), /SESSION_TRANSCRIPT_CANARY/);
  assert.equal(m.episodes('default').length, 0); assert.equal(m.list('default', 'followups').length, 0);
  m.observeTurn({ profile: 'writer', admissionId: 'turn-3', output: 'I will send the report tomorrow.' });
  const drafts = m.list('default', 'followups'); assert.equal(drafts.length, 1); assert.equal(drafts[0].status, 'draft');
  await m.sweep(); assert.deepEqual(m.inbox('writer'), []);
  assert.throws(() => m.decideFollowup('default', { requestId: 'bot-approve', id: drafts[0].id, revision: 1, decision: 'approve', confirm: true, evidence: 'I saw it' }), { status: 403 });
});

test('completed files remain unverified until real snapshot review; stale bytes block delivery and promotions', async t => {
  const f = await fixture(t), row = f.delegate();
  const source = path.join(f.workspaceRoot, 'bots', 'writer', 'artifacts', 'result.json');
  await writeFile(source, '{"steps":["build","check"]}');
  const record = f.exchanges.update(row.id, { status: 'completed', reply: answer('task-1', 'artifacts/result.json', 'The launch uses two phases (evidence: reviewed plan)') });
  await f.memory.sweep(); assert.equal(f.memory.task('default', 'task-1').status, 'review_pending'); assert.deepEqual(f.memory.inbox('default'), []);
  await assert.rejects(f.memory.output(HOB_OPERATOR, 'task-1'), { status: 409 });
  await assert.rejects(f.memory.output('default', 'task-1'), { status: 403 });
  const receipt = await f.artifacts.receive(record);
  assert.equal(JSON.parse(await readFile(path.join(f.workspaceRoot, 'main', receipt.path), 'utf8')).steps.length, 2);
  await f.artifacts.review(record, { requestId: 'actual-review', sha256: receipt.sha256, verdict: 'passed', checks: 'Read and parsed the nominated JSON; checked both steps.' });
  f.preferences({ dailyCap: 0 }); await f.memory.sweep();
  assert.equal(f.memory.task('default', 'task-1').status, 'done'); assert.equal(f.memory.list('default', 'candidates').length, 1);
  const delivered = await f.memory.output(HOB_OPERATOR, 'task-1'); assert.equal(delivered.name, 'result.json'); assert.equal(JSON.parse(delivered.bytes).steps.length, 2);
  let headers, downloaded;
  await hobTeamRoute(f.memory, HOB_OPERATOR, { method: 'GET' }, { writeHead(status, value) { assert.equal(status, 200); headers = value; }, end(bytes) { downloaded = bytes; } }, '/output/task-1', new URL('http://hob.test/api/hermes/team/work/output/task-1'), {});
  assert.equal(headers['Cache-Control'], 'no-store'); assert.equal(headers['X-Content-Type-Options'], 'nosniff'); assert.match(headers['Content-Disposition'], /attachment; filename\*=UTF-8''result.json/);
  assert.deepEqual(downloaded, delivered.bytes);
  await writeFile(path.join(f.workspaceRoot, 'main', receipt.path), 'changed after review');
  f.preferences({ dailyCap: 3 }); await f.memory.sweep();
  assert.equal(f.memory.task('default', 'task-1').status, 'review_pending'); assert.deepEqual(f.memory.inbox('default'), []);
  const staleCandidate = f.memory.list('default', 'candidates')[0];
  await assert.rejects(f.memory.decideCandidate(HOB_OPERATOR, { requestId: 'stale-source', id: staleCandidate.id, revision: staleCandidate.revision, decision: 'stage', base: 0, confirm: true }), { code: 'HOB_TEAM_SOURCE_STALE' });
  await writeFile(path.join(f.workspaceRoot, 'main', receipt.path), '{"steps":["build","check"]}');
  await f.memory.sweep(); await f.memory.sweep();
  assert.equal(f.memory.inbox('default').length, 1); assert.equal(f.team.core().revision, 0);
  await f.restart(); await f.memory.sweep(); assert.equal(f.memory.inbox('default').length, 1);
  await writeFile(path.join(f.workspaceRoot, 'main', receipt.path), 'tampered after inbox delivery');
  await assert.rejects(f.memory.output(HOB_OPERATOR, 'task-1'), { code: 'TEAM_ARTIFACT_CHANGED' });
});

test('restart recovers the exchange-to-task commit gap without another native dispatch', async t => {
  const f = await fixture(t), record = f.delegate('crash-gap', 'none', false);
  assert.throws(() => f.memory.checkDelegation(record.teamTask, record.to), { code: 'HOB_TEAM_ALREADY_DELEGATED' });
  f.exchanges.update(record.id, { status: 'completed', reply: answer('crash-gap', 'none') });
  await f.restart(); await f.memory.sweep();
  const task = f.memory.task('default', 'crash-gap');
  assert.equal(task.exchangeId, record.id); assert.equal(task.status, 'review_pending');
  assert.throws(() => f.memory.reviewText('default', { requestId: 'bypass' }), { status: 403 });
  f.memory.reviewText(HOB_OPERATOR, { requestId: 'attest', id: task.id, revision: task.revision, confirm: true, evidence: 'Read the completed text result and checked its outcome.' });
  await f.memory.sweep(); assert.equal(f.memory.task('default', task.id).verification, 'operator-reviewed'); assert.equal(f.memory.inbox('default').length, 1);
});

test('quiet hours, timezone daily cap, never-offer and fresh checks survive restarts without duplicate delivery', async t => {
  const f = await fixture(t); f.preferences({ dailyCap: 1, timezone: 'Asia/Karachi' }); f.setTime('2026-11-08T18:00:00Z');
  const a = f.memory.followup(HOB_OPERATOR, { requestId: 'a', title: 'Check first', outcome: 'Confirm actual first state' });
  const b = f.memory.followup(HOB_OPERATOR, { requestId: 'b', title: 'Check second', outcome: 'Confirm actual second state' });
  const check = (item, requestId) => f.memory.decideFollowup(HOB_OPERATOR, { requestId, id: item.id, revision: item.revision, decision: 'still-open', confirm: true, evidence: 'Operator checked current state.' });
  check(a, 'check-a'); check(b, 'check-b'); await f.memory.sweep(); assert.equal(f.memory.inbox('default').length, 0, '23:00 local is quiet');
  f.setTime('2026-11-09T05:00:00Z'); await f.memory.sweep(); assert.equal(f.memory.inbox('default').length, 0, 'stale outside-state checks cannot deliver');
  check(f.memory.list(HOB_OPERATOR, 'followups').find(item => item.id === a.id), 'fresh-a');
  check(f.memory.list(HOB_OPERATOR, 'followups').find(item => item.id === b.id), 'fresh-b');
  await f.memory.sweep(); assert.equal(f.memory.inbox('default').length, 1);
  await f.restart(); await f.memory.sweep(); assert.equal(f.memory.inbox('default').length, 1, 'cap does not reset with process');
  const remaining = f.memory.list(HOB_OPERATOR, 'followups').find(item => item.status === 'open');
  f.memory.decideFollowup(HOB_OPERATOR, { requestId: 'decline', id: remaining.id, revision: remaining.revision, decision: 'dismiss', confirm: true });
  assert.ok(f.memory.preferences().neverOffer.includes(remaining.id));
  f.setTime('2026-11-10T05:00:00Z'); await f.memory.sweep(); assert.equal(f.memory.inbox('default').length, 1);
  const notice = f.memory.inbox('default')[0]; f.memory.acknowledge(HOB_OPERATOR, { requestId: 'read-one', id: notice.id });
  await f.restart(); assert.ok(f.memory.inbox('default')[0].acknowledgedAt);
});

test('finished tasks close stale reminders; model assertions cannot certify external state', async t => {
  const f = await fixture(t), row = f.delegate('text', 'none');
  f.preferences({ dailyCap: 0 });
  const reminder = f.memory.followup(HOB_OPERATOR, { requestId: 'task-reminder', title: 'Check plan', outcome: 'See if it finished', source: { kind: 'task', taskId: 'text' } });
  const external = f.memory.followup(HOB_OPERATOR, { requestId: 'external', title: 'Check outside', outcome: 'Unknown external state' });
  f.memory.decideFollowup('default', { requestId: 'assertion', id: external.id, revision: 1, decision: 'still-open', confirm: true, evidence: 'Model says still open' });
  f.exchanges.update(row.id, { status: 'completed', reply: answer('text', 'none') }); await f.memory.sweep();
  const task = f.memory.task('default', 'text');
  f.memory.reviewText(HOB_OPERATOR, { requestId: 'review-text', id: task.id, revision: task.revision, confirm: true, evidence: 'Read the text and checked the outcome.' });
  f.preferences({ dailyCap: 3 });
  await f.memory.sweep();
  assert.equal(f.memory.list(HOB_OPERATOR, 'followups').find(item => item.id === reminder.id).status, 'closed');
  assert.equal(f.memory.inbox('default').filter(item => item.kind === 'reminder').length, 0, 'finished tasks never produce stale nags');
  assert.equal(f.memory.inbox('default').some(item => item.id === external.id), false);
});

test('shared candidates require operator staging and separate exact core approval; bot flags are rejected', async t => {
  const f = await fixture(t), m = f.memory;
  const candidate = m.candidate('writer', { requestId: 'candidate', fact: 'Always ask before spending money', evidence: 'Proposed standing preference for operator review.' });
  assert.equal(candidate.tier, 'tier2');
  assert.throws(() => m.candidate('writer', { requestId: 'bypass', fact: 'Change rules', evidence: 'No', userApproved: true }), /Unsupported/);
  assert.throws(() => m.decideCandidate('default', { requestId: 'approve' }), { status: 403 });
  const input = { requestId: 'stage', id: candidate.id, revision: 1, decision: 'stage', base: 0, confirm: true };
  const staged = m.decideCandidate(HOB_OPERATOR, input); assert.deepEqual(m.decideCandidate(HOB_OPERATOR, input), staged);
  assert.equal(f.team.core().revision, 0);
  const proposal = f.team.proposal(staged.proposalId);
  f.team.decide({ id: proposal.id, base: proposal.base, digest: proposal.digest, confirm: true, decision: 'approve' });
  assert.match(f.team.core().content, /Always ask before spending money/);
});

test('relay enforces a registered plan before native admission and returns Main without awaiting worker inference', async t => {
  const f = await fixture(t), calls = [];
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const bots = { roster: () => f.roster, authenticate: token => f.roster.find(bot => bot.name === (token === 'a'.repeat(64) ? 'default' : 'writer')) };
  const client = { async runtime(route) { calls.push(route); return route === '/api/sessions' ? { id: 'native-worker' } : { run_id: 'native-run' }; }, async *events() { await waiting; yield { event: 'run.completed', output: answer() }; } };
  const relay = createHermesBotRelay({ client, bots, exchanges: f.exchanges, team: f.team, teamArtifacts: f.artifacts, memory: f.memory });
  // Both fixture and relay own teardown; make the shared test store idempotent.
  const closeStore = f.exchanges.close.bind(f.exchanges); let storeClosed = false;
  f.exchanges.close = () => { if (!storeClosed) { storeClosed = true; closeStore(); } };
  f.beforeClose = async () => { release(); await relay.close(); };
  const call = async (tail, input, token = 'a'.repeat(64)) => {
    let value;
    await relay({ method: 'POST', headers: { authorization: `Bearer ${token}` } }, {}, new URL(`http://hob.test/api/hermes/bot-relay${tail}`), { body: async () => input, json: (_res, _status, payload) => { value = payload; } }); return value;
  };
  await assert.rejects(call('/send', { to: 'writer', message: assignment(), requestId: 'missing-plan' }), { code: 'HOB_TEAM_PLAN_REQUIRED' }); assert.equal(calls.length, 0);
  await call('/work/plan', plan());
  const result = await call('/send', { to: 'writer', message: assignment(), requestId: 'dispatch', waitMs: 600000 });
  assert.equal(result.status, 'running'); assert.deepEqual(calls, ['/api/sessions', '/v1/runs']);
  assert.equal((await call('/send', { to: 'writer', message: assignment(), requestId: 'dispatch' })).id, result.id); assert.equal(calls.length, 2);
  await assert.rejects(call('/work/plan', plan('forbidden'), 'b'.repeat(64)), { status: 403 });
  release(); await relay.sweep();
});

test('private review wakeups bind the native conversation exactly and use existing native authority', async t => {
  const f = await fixture(t), row = f.delegate();
  f.exchanges.update(row.id, { status: 'completed', reply: answer(), wakeOnComplete: true });
  assert.equal(f.exchanges.isRelaySession('default', 'review-chat'), false);
  const wakes = f.exchanges.dueWakeups(); assert.match(wakes[0].message, /private coordinator review request/);
  await createHermesWakeups({ bots: { roster: () => f.roster }, exchanges: f.exchanges, bridge: { async rpc(_profile, method, input) {
    assert.equal(method, 'bot_relay.deliver'); return { delivery_id: input.id, session_id: 'review-chat', admission_id: 'review-turn', status: 'queued' };
  } } })();
  assert.equal(f.exchanges.isRelaySession('default', 'review-chat'), true);
  assert.equal(f.exchanges.isRelaySession('writer', 'review-chat'), false); assert.equal(f.exchanges.isRelaySession('default', 'a-user-chat'), false);
});

test('dashboard private logs use operator-selected scope but bot query parameters never change their identity', async t => {
  const { memory } = await fixture(t);
  memory.remember('writer', { requestId: 'private', summary: 'Writer private lesson', evidence: 'Writer task' });
  const call = async actor => {
    let result; const url = new URL('http://hob.test/api/hermes/team/work/episodes?profile=writer');
    await hobTeamRoute(memory, actor, { method: 'GET' }, {}, '/episodes', url, { json: (_res, _status, value) => { result = value; } }); return result;
  };
  assert.equal((await call(HOB_OPERATOR)).items.length, 1); assert.equal((await call('default')).items.length, 0);
});

test('a bot named user cannot impersonate the operator or bypass core and delivery approvals', async t => {
  const f = await fixture(t); f.roster.push({ name: 'user', state: 'active' });
  assert.throws(() => f.memory.plan('user', plan()), { status: 403 });
  assert.throws(() => f.memory.configure('user', { requestId: 'prefs', confirm: true }), { status: 403 });
  assert.throws(() => f.memory.decideCandidate('user', { requestId: 'stage' }), { status: 403 });
  f.memory.remember('user', { requestId: 'own-log', summary: 'User-named bot lesson', evidence: 'Its own task' });
  assert.equal(f.memory.episodes('user').length, 1); assert.equal(f.memory.episodes('default').length, 0);
  assert.deepEqual(f.memory.status('user').tasks, []);
});

test('daily consolidation flags old candidates against current core without publishing or replaying private transcripts', async t => {
  const f = await fixture(t);
  const candidate = f.memory.candidate('writer', { requestId: 'fact-a', fact: 'Launch has two phases', evidence: 'Observed project plan' });
  const repeated = f.memory.candidate('writer', { requestId: 'fact-b', fact: 'Launch has TWO phases', evidence: 'Another observation' });
  assert.equal(repeated.id, candidate.id);
  await f.memory.sweep(); assert.equal(f.memory.status().maintenance.day, '2026-11-08');
  f.setTime('2027-02-09T12:00:00Z'); await f.memory.sweep();
  const status = f.memory.status(); assert.equal(status.maintenance.staleCandidates, 1); assert.equal(status.candidates[0].stale, true);
  assert.equal(f.team.core().revision, 0); assert.equal(status.backgroundModelCalls, false);
  assert.deepEqual(f.memory.episodes('default'), []);
});
