import assert from 'node:assert/strict';
import test from 'node:test';
import { createHermesBotRelay } from '../hermes-bot-relay.mjs';
import { HermesExchanges } from '../hermes-exchanges.mjs';
import { HermesError } from '../hermes-client.mjs';

const BASE = '/api/hermes/bot-relay';
const MAIN = 'a'.repeat(64);
const WRITER = 'b'.repeat(64);
const EDITOR = 'c'.repeat(64);

function fixture(team, output = 'the finished answer', teamArtifacts, behavior = {}) {
  const roster = [
    { name: 'default', displayName: 'Main', display_name: 'Main', state: 'active' },
    { name: 'writer', displayName: 'Scribe', display_name: 'Scribe', state: 'active', description: 'Writes docs.' },
    { name: 'editor', displayName: 'Editor', display_name: 'Editor', state: 'active' },
    { name: 'retired', displayName: 'Retired', display_name: 'Retired', state: 'revoked' },
  ];
  const identities = new Map([[MAIN, 'default'], [WRITER, 'writer'], [EDITOR, 'editor']]);
  const bots = {
    async authenticate(token) {
      const name = identities.get(token);
      return name ? roster.find(bot => bot.name === name) : null;
    },
    roster: () => roster,
  };
  const runtime = [];
  const events = [];
  let sessionCounter = 0, runCounter = 0;
  const client = {
    async runtime(route, options = {}) {
      runtime.push({ route, ...options });
      if (behavior.admissionError) throw behavior.admissionError;
      if (route === '/api/sessions' && options.method !== 'POST') return { data: [] };
      if (route === '/api/sessions') return { session: { id: `relay-${options.profile}-${++sessionCounter}` } };
      if (route === '/v1/runs') return { run_id: `run-${++runCounter}` };
      if (/^\/v1\/runs\/[^/]+$/.test(route)) {
        if (!behavior.run) throw new Error(`unexpected runtime route ${route}`);
        return typeof behavior.run === 'function' ? behavior.run(route) : behavior.run;
      }
      throw new Error(`unexpected runtime route ${route}`);
    },
    async *events(runId, { profile }) {
      events.push({ runId, profile });
      for (const event of behavior.events ?? [
        { event: 'message.delta', delta: 'partial ' },
        { event: 'run.completed', output },
      ]) yield event;
    },
  };
  const exchanges = new HermesExchanges();
  const relay = createHermesBotRelay({ client, bots, exchanges, team, teamArtifacts });
  const call = async (path, { method = 'GET', token, input } = {}) => {
    let status, payload;
    const req = { method, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = { writeHead() {}, end() {} };
    await relay(req, res, new URL(`http://hob.test${BASE}${path}`), {
      json: (_res, code, value) => { status = code; payload = value; },
      body: async () => input,
    });
    return { status, body: payload };
  };
  const dashboard = async (path = '?profile=writer') => {
    let status, payload;
    const req = { method: 'GET', headers: {} };
    const res = { writeHead() {}, end() {} };
    await relay.dashboard(req, res, new URL(`http://hob.test/api/hermes/exchanges${path}`), {
      json: (_res, code, value) => { status = code; payload = value; },
    });
    return { status, body: payload };
  };
  return { relay, call, dashboard, roster, runtime, events, exchanges };
}

const refuses = (promise, status, code) => assert.rejects(promise,
  error => error.status === status && (code ? error.code === code : true));

const teamAssignment = 'TASK plan-1 — Prepare a plan\nOUTCOME: A checked plan file\nCONSTRAINTS: No external messages\nOUTPUT: artifacts/plan.md\nDEADLINE: none\nCORE REFS: none';

test('only the authenticated coordinator can receive and review the original assigned output', async () => {
  const calls = [], digest = 'f'.repeat(64);
  const reply = 'TASK plan-1 — DONE\nRESULT: Saved the plan\nFILES: artifacts/plan.md\nVERIFICATION: Read the file\nBLOCKERS: none\nPROMOTE: none';
  const { call, relay } = fixture({ policy: () => ({ coordinatorOnly: true }) }, reply, {
    async receive(record) { calls.push(['receive', record.id, record.teamTask.fields.OUTPUT]); return { sha256: digest, bytes: 20, path: '.hob/team-inbox/private-main-copy', receivedAt: '2026-10-30T12:00:00Z' }; },
    async inspect() { return null; },
    async review(record, value) { calls.push(['review', record.id]); return { ...value, author: 'default', at: '2026-10-30T12:01:00Z' }; },
  });
  try {
    const response = await call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: teamAssignment, waitMs: 30 } });
    const id = response.body.id, route = `/team/artifacts/${id}`;
    await refuses(call(route, { method: 'POST', token: WRITER, input: {} }), 403);
    await refuses(call(route + '/reviews', { method: 'POST', token: WRITER, input: {} }), 403);
    await refuses(call(route, { method: 'POST', token: MAIN, input: { path: 'MEMORY.md' } }), 400);
    assert.equal(calls.length, 0);
    const received = await call(route, { method: 'POST', token: MAIN, input: {} });
    assert.equal(received.body.artifact.sha256, digest);
    assert.equal((await call('/exchanges/' + id, { token: MAIN })).body.teamVerification, 'self-reported');
    assert.equal((await call('/exchanges/' + id, { token: MAIN })).body.completed, false);
    const decision = await call(route + '/reviews', { method: 'POST', token: MAIN, input: { requestId: 'review-1', sha256: digest, verdict: 'passed', checks: 'PRIVATE_MAIN_CHECK_DETAILS' } });
    assert.equal(decision.body.review.author, 'default');
    const workerView = (await call('/exchanges/' + id, { token: WRITER })).body;
    assert.equal(workerView.teamVerification, 'coordinator-reviewed');
    assert.equal(workerView.status, 'completed');
    assert.equal(workerView.nativeCompleted, true);
    assert.equal(workerView.completed, true);
    assert.doesNotMatch(JSON.stringify(workerView), /private-main-copy|PRIVATE_MAIN_CHECK_DETAILS/);
    assert.deepEqual(calls, [['receive', id, 'artifacts/plan.md'], ['review', id]]);
  } finally { await relay.close(); }
});

test('employee-team mode denies worker-to-worker aliases before any native admission', async () => {
  const { call, runtime, relay } = fixture({ policy: () => ({ coordinatorOnly: true }) });
  try {
    for (const to of ['editor', 'Editor']) await refuses(call('/send', { method: 'POST', token: WRITER, input: { to, message: 'Bypass coordinator' } }), 403, 'TEAM_COORDINATOR_REQUIRED');
    assert.equal(runtime.length, 0);
    const request = await call('/send', { method: 'POST', token: WRITER, input: { to: 'default', message: 'Need a coordination decision', waitMs: 20 } });
    assert.equal(request.status, 200);
  } finally { await relay.close(); }
});

test('team assignments require the exact fields and native completion alone does not verify results', async () => {
  const bindings = [];
  const { call, runtime, relay } = fixture({ policy: () => ({ coordinatorOnly: true }), registerSession(...args) {
    assert.equal(runtime.at(-1).route, '/api/sessions'); // Bound before native execution can begin.
    bindings.push(args);
  } });
  try {
    await refuses(call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: 'Free-form task' } }), 400, 'TEAM_TASK_FORMAT');
    assert.equal(runtime.length, 0);
    const result = await call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: teamAssignment, waitMs: 30 } });
    assert.equal(result.body.teamTask.id, 'plan-1');
    assert.deepEqual(bindings, [['writer', 'relay-writer-1', 'relay', teamAssignment]]);
    assert.equal(result.body.status, 'completed');
    assert.equal(result.body.teamVerification, 'unproven');
    assert.match(result.body.teamResultError, /pinned TASK reply/);
    assert.doesNotMatch(runtime.find(item => item.route === '/v1/runs').body.input, /If you delegate further/);
  } finally { await relay.close(); }
});

test('team relay blocks credential canaries and withholds sensitive output instead of sharing it', async () => {
  const { call, runtime, relay } = fixture({ policy: () => ({ coordinatorOnly: true }) }, 'api_key=synthetic-secret-value-0123456789');
  try {
    await refuses(call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: teamAssignment.replace('No external messages', 'api_key=synthetic-secret-value-0123456789') } }), 400);
    assert.equal(runtime.length, 0);
    const result = await call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: teamAssignment, waitMs: 20 } });
    assert.match(result.body.reply, /Result withheld/); assert.doesNotMatch(result.body.reply, /synthetic-secret-value/);
    assert.equal(result.body.teamVerification, 'unproven');
  } finally { await relay.close(); }
});

test('relay roster exposes the active display names and marks Main', async () => {
  const { call } = fixture();
  const { status, body } = await call('/roster', { token: WRITER });
  assert.equal(status, 200);
  assert.equal(body.self, 'writer');
  assert.deepEqual(body.bots.map(bot => [bot.id, bot.name, bot.main]), [
    ['default', 'Main', true],
    ['writer', 'Scribe', false],
    ['editor', 'Editor', false],
  ]);
  assert.equal(body.bots[1].description, 'Writes docs.');
  assert.ok(body.bots.every(bot => bot.available));
});

test('Main can relay work to a worker by display name and receives the reply', async () => {
  const { call, runtime, events } = fixture();
  const { status, body } = await call('/send', {
    method: 'POST', token: MAIN, input: { to: 'scribe', message: 'Write the release notes.', waitMs: 500 },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.from, 'default');
  assert.equal(body.fromName, 'Main');
  assert.equal(body.to, 'writer');
  assert.equal(body.toName, 'Scribe');
  assert.equal(body.completed, true);
  assert.equal(body.reply, 'the finished answer');

  const create = runtime.find(item => item.route === '/api/sessions' && item.method === 'POST');
  assert.equal(create.profile, 'writer');
  assert.match(create.body.title, /^Main .* Scribe/);
  const run = runtime.find(item => item.route === '/v1/runs');
  assert.equal(run.profile, 'writer');
  assert.equal(run.body.session_id, 'relay-writer-1');
  assert.match(run.body.input, /^\[HOB relay from Main \(default\)\]/);
  assert.match(run.body.input, /Write the release notes\./);
  assert.match(run.idempotencyKey, /^[a-f0-9-]{36}$/);
  assert.deepEqual(events, [{ runId: 'run-1', profile: 'writer' }]);
});

test('relay preserves the native failure reason and partial output', async () => {
  const { call, relay } = fixture(undefined, undefined, undefined, { events: [
    { event: 'message.delta', delta: 'observed ' },
    { event: 'run.failed', error: 'max_iterations_reached(60/60)', turn_exit_reason: 'max_iterations_reached(60/60)',
      partial: true, completed: false, interrupted: false, output: 'partial answer from event' },
  ] });
  try {
    const { status, body } = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Inspect the repository.', waitMs: 500 },
    });
    assert.equal(status, 200);
    assert.equal(body.status, 'failed');
    assert.equal(body.completed, false);
    assert.equal(body.reply, 'partial answer from event');
    assert.equal(body.error, 'max_iterations_reached(60/60)');
    assert.deepEqual(body.failure, {
      status: 'failed', event: 'run.failed', error: 'max_iterations_reached(60/60)',
      turnExitReason: 'max_iterations_reached(60/60)', partial: true, completed: false, interrupted: false,
    });
  } finally { await relay.close(); }
});

test('relay keeps streamed text when a completed event has no output', async () => {
  const { call, relay } = fixture(undefined, undefined, undefined, { events: [
    { event: 'message.delta', delta: 'streamed ' },
    { event: 'message.delta', delta: 'answer' },
    { event: 'run.completed' },
  ] });
  try {
    const { body } = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Answer this.', waitMs: 500 },
    });
    assert.equal(body.status, 'completed');
    assert.equal(body.reply, 'streamed answer');
    assert.equal(body.failure, undefined);
  } finally { await relay.close(); }
});

test('relay explains an iteration-budget failure when Hermes omits an error', async () => {
  const { call, relay } = fixture(undefined, undefined, undefined, { events: [
    { event: 'run.failed', turn_exit_reason: 'max_iterations_reached(60/60)',
      partial: true, completed: false, interrupted: false },
  ] });
  try {
    const { body } = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Keep working.', waitMs: 500 },
    });
    assert.equal(body.status, 'failed');
    assert.match(body.error, /max_iterations_reached\(60\/60\)/);
    assert.equal(body.failure.error, undefined);
    assert.equal(body.failure.turnExitReason, 'max_iterations_reached(60/60)');
  } finally { await relay.close(); }
});

test('relay distinguishes a cancelled native run and keeps its flags', async () => {
  const { call, relay } = fixture(undefined, undefined, undefined, { events: [
    { event: 'run.cancelled', completed: false, partial: false, interrupted: true },
  ] });
  try {
    const { body } = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Stop this.', waitMs: 500 },
    });
    assert.equal(body.status, 'cancelled');
    assert.match(body.error, /was cancelled before completing the exchange/);
    assert.equal(body.failure.status, 'cancelled');
    assert.equal(body.failure.interrupted, true);
  } finally { await relay.close(); }
});

test('relay reports the gateway shutdown reason for an interrupted run', async () => {
  const { call, relay } = fixture(undefined, undefined, undefined, { events: [
    { event: 'run.interrupted', error: 'Gateway shutdown interrupted the run.',
      completed: false, partial: false, interrupted: true },
  ] });
  try {
    const { body } = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Start this.', waitMs: 500 },
    });
    assert.equal(body.status, 'interrupted');
    assert.equal(body.error, 'Gateway shutdown interrupted the run.');
    assert.equal(body.failure.event, 'run.interrupted');
    assert.equal(body.failure.interrupted, true);
  } finally { await relay.close(); }
});

test('exchange detail polls a missed native terminal status and keeps its reason', async () => {
  const { call, relay } = fixture(undefined, undefined, undefined, {
    events: [],
    run: { run_id: 'run-1', status: 'failed', error: 'provider unavailable',
      turn_exit_reason: 'provider_error', partial: true, completed: false, interrupted: false,
      last_event: 'run.failed' },
  });
  try {
    const sent = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Try it.', waitMs: 0 },
    });
    assert.equal(sent.body.status, 'running');
    const detail = await call('/exchanges/' + sent.body.id, { token: MAIN });
    assert.equal(detail.body.status, 'failed');
    assert.equal(detail.body.error, 'provider unavailable');
    assert.equal(detail.body.failure.turnExitReason, 'provider_error');
    assert.equal(detail.body.failure.event, 'run.failed');
  } finally { await relay.close(); }
});

test('opening an older failed exchange recovers the native reason from run status', async () => {
  const { call, relay, exchanges } = fixture(undefined, undefined, undefined, {
    run: { run_id: 'run-1', status: 'failed', error: 'provider auth expired',
      turn_exit_reason: 'provider_error', completed: false, partial: false, interrupted: false,
      last_event: 'run.failed' },
  });
  try {
    const record = exchanges.create({ requestKey: 'legacy-1', from: 'default', fromName: 'Main',
      to: 'writer', toName: 'Scribe', message: 'Old request' });
    exchanges.update(record.id, { status: 'failed', runId: 'run-1',
      error: 'The native run ended before completing the exchange.' });
    const detail = await call('/exchanges/' + record.id, { token: MAIN });
    assert.equal(detail.body.status, 'failed');
    assert.equal(detail.body.error, 'provider auth expired');
    assert.equal(detail.body.failure.turnExitReason, 'provider_error');
    assert.equal(detail.body.failure.event, 'run.failed');
  } finally { await relay.close(); }
});

test('relay returns an inspectable failed exchange when admission is rejected', async () => {
  const { call, relay, runtime } = fixture(undefined, undefined, undefined, {
    admissionError: new HermesError(422, 'provider profile is invalid', 'HERMES_REQUEST_FAILED'),
  });
  try {
    const { status, body } = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Do it.', waitMs: 500 },
    });
    assert.equal(status, 200);
    assert.ok(body.id);
    assert.equal(body.status, 'failed');
    assert.equal(body.completed, false);
    assert.equal(body.failure.phase, 'admission');
    assert.equal(body.failure.code, 'HERMES_REQUEST_FAILED');
    assert.equal(body.failure.retryable, false);
    assert.match(body.error, /could not start/);
    assert.equal(runtime.filter(item => item.route === '/v1/runs').length, 0);
  } finally { await relay.close(); }
});

test('relay parks an uncertain admission without replaying the request', async () => {
  const { call, relay, runtime } = fixture(undefined, undefined, undefined, {
    admissionError: new HermesError(503, 'gateway restarting', 'HERMES_UNAVAILABLE'),
  });
  const input = { to: 'writer', message: 'Do it.', waitMs: 0, requestId: 'uncertain-admission' };
  try {
    const first = await call('/send', { method: 'POST', token: MAIN, input });
    assert.equal(first.body.status, 'unknown');
    assert.equal(first.body.failure.phase, 'admission');
    assert.equal(first.body.failure.retryable, true);
    assert.match(first.body.error, /may still have been accepted/);
    const retried = await call('/send', { method: 'POST', token: MAIN, input });
    assert.equal(retried.body.id, first.body.id);
    assert.equal(retried.body.status, 'unknown');
    assert.equal(runtime.filter(item => item.route === '/api/sessions').length, 1);
    assert.equal(runtime.filter(item => item.route === '/v1/runs').length, 0);
  } finally { await relay.close(); }
});

test('parked unknown exchanges do not permanently consume handoff capacity', async () => {
  const { call, relay, exchanges } = fixture();
  try {
    for (let i = 0; i < 8; i++) {
      const parked = exchanges.create({ requestKey: `parked-${i}`, from: 'default', fromName: 'Main',
        to: 'writer', toName: 'Scribe', message: 'Parked work.' });
      exchanges.update(parked.id, { status: 'unknown', error: 'Admission outcome was never confirmed.' });
    }
    const { status, body } = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Fresh work.', waitMs: 500 },
    });
    assert.equal(status, 200);
    assert.equal(body.status, 'completed');
    assert.equal(body.reply, 'the finished answer');
  } finally { await relay.close(); }
});

test('history reads do not serialize native status checks for every row', async () => {
  const { dashboard, relay, exchanges, runtime } = fixture(undefined, undefined, undefined, { events: [] });
  try {
    for (const id of ['one', 'two', 'three']) {
      const record = exchanges.create({ requestKey: `history-${id}`, from: 'default', fromName: 'Main',
        to: 'writer', toName: 'Scribe', message: `Request ${id}.` });
      exchanges.update(record.id, { status: 'running', runId: `run-${id}` });
    }
    const response = await dashboard('?profile=writer');
    assert.equal(response.status, 200);
    assert.equal(response.body.exchanges.length, 3);
    assert.deepEqual(response.body.exchanges.map(record => record.status), ['running', 'running', 'running']);
    assert.equal(runtime.length, 0, 'a history read returns durable state without waiting on Hermes');
  } finally { await relay.close(); }
});

test('observer EOF checks the run status immediately instead of waiting for a sweep', async () => {
  const { call, relay, runtime } = fixture(undefined, undefined, undefined, {
    events: [],
    run: { run_id: 'run-1', status: 'completed', output: 'finished without a live stream', last_event: 'run.completed' },
  });
  try {
    const { body } = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Finish this.', waitMs: 500 },
    });
    assert.equal(body.status, 'completed');
    assert.equal(body.reply, 'finished without a live stream');
    assert.equal(runtime.filter(item => item.route === '/v1/runs/run-1').length, 1);
  } finally { await relay.close(); }
});

test('transient status failures back off instead of hammering Hermes', async () => {
  let statusChecks = 0;
  const { call, relay } = fixture(undefined, undefined, undefined, {
    events: [],
    run: () => { statusChecks++; throw new HermesError(503, 'gateway unavailable', 'HERMES_UNAVAILABLE'); },
  });
  try {
    const sent = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Try this.', waitMs: 500 },
    });
    assert.equal(sent.body.status, 'running');
    assert.match(sent.body.observationError, /could not reach Hermes/);
    await call('/exchanges/' + sent.body.id, { token: MAIN });
    await call('/exchanges/' + sent.body.id, { token: MAIN });
    assert.equal(statusChecks, 1, 'a failed status read is not repeated until the backoff expires');
  } finally { await relay.close(); }
});

test('a native unknown outcome is parked instead of polled every sweep', async () => {
  let statusChecks = 0;
  const { call, relay } = fixture(undefined, undefined, undefined, {
    events: [],
    run: () => { statusChecks++; return { run_id: 'run-1', status: 'unknown', last_event: 'run.unknown' }; },
  });
  try {
    const sent = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Check this.', waitMs: 500 },
    });
    assert.equal(sent.body.status, 'unknown');
    assert.match(sent.body.error, /outcome is unknown/);
    await call('/exchanges/' + sent.body.id, { token: MAIN });
    await call('/exchanges/' + sent.body.id, { token: MAIN });
    assert.equal(statusChecks, 1, 'a parked unknown outcome is checked on a slower cadence');
  } finally { await relay.close(); }
});

test('an expired native run status becomes unknown once and stops polling', async () => {
  let statusChecks = 0;
  const { call, relay } = fixture(undefined, undefined, undefined, {
    events: [],
    run: () => { statusChecks++; throw new HermesError(404, 'run status expired', 'HERMES_REQUEST_FAILED'); },
  });
  try {
    const sent = await call('/send', {
      method: 'POST', token: MAIN, input: { to: 'writer', message: 'Old work.', waitMs: 500 },
    });
    assert.equal(sent.body.status, 'unknown');
    assert.equal(sent.body.failure.phase, 'observation');
    assert.equal(sent.body.failure.retryable, false);
    await call('/exchanges/' + sent.body.id, { token: MAIN });
    assert.equal(statusChecks, 1);
  } finally { await relay.close(); }
});

test('a worker can ask Main and contact another worker directly', async () => {
  const { call, runtime } = fixture();
  const toMain = await call('/send', {
    method: 'POST', token: WRITER, input: { to: 'default', message: 'Need a decision.', waitMs: 10 },
  });
  assert.equal(toMain.status, 200);
  assert.equal(toMain.body.to, 'default');
  assert.match(runtime.find(item => item.route === '/v1/runs').body.input, /^\[HOB relay from Scribe \(writer\)\]/);

  const direct = await call('/send', {
    method: 'POST', token: WRITER, input: { to: 'editor', message: 'Skip Main.', waitMs: 10 },
  }).catch(error => error);
  assert.equal(direct.status, 200);
  assert.equal(direct.body.to, 'editor');
  assert.equal(runtime.filter(item => item.route === '/v1/runs').length, 2);
});

test('relay creates an independent native conversation for every exchange', async () => {
  const { call, runtime } = fixture();
  await Promise.all([
    call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: 'First.', waitMs: 100 } }),
    call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: 'Second.', waitMs: 100 } }),
  ]);
  assert.equal(runtime.filter(item => item.route === '/api/sessions' && item.method === 'POST').length, 2,
    'every exchange gets a fresh conversation');
  assert.equal(runtime.filter(item => item.route === '/v1/runs').length, 2);
});

test('relay waits zero returns admission without claiming a reply', async () => {
  const { call } = fixture();
  const { status, body } = await call('/send', {
    method: 'POST', token: MAIN, input: { to: 'writer', message: 'Fire and forget.', waitMs: 0 },
  });
  assert.equal(status, 200);
  assert.equal(body.completed, false);
  assert.equal(body.reply, '');
  assert.equal(body.runId, 'run-1');
});

test('relay authenticates with the bot credential and validates every request field', async () => {
  const { call } = fixture();
  await refuses(call('/roster'), 401, 'RELAY_UNAUTHORIZED');
  await refuses(call('/roster', { token: 'f'.repeat(64) }), 401, 'RELAY_UNAUTHORIZED');
  await refuses(call('/send', { method: 'POST', token: MAIN, input: { to: 'ghost', message: 'Hi', waitMs: 10 } }),
    404, 'BOT_NOT_FOUND');
  await refuses(call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: '', waitMs: 10 } }),
    400, 'INVALID_REQUEST');
  await refuses(call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: 'x'.repeat(64001), waitMs: 10 } }),
    400, 'INVALID_REQUEST');
  await refuses(call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: 'Hi', waitMs: 600001 } }),
    400, 'INVALID_REQUEST');
  await refuses(call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: 'Hi', extra: true } }),
    400, 'INVALID_REQUEST');
  await refuses(call('/send', { method: 'POST', token: WRITER, input: { to: 'writer', message: 'Hi', waitMs: 10 } }),
    400, 'INVALID_REQUEST');
  await refuses(call('/send', { method: 'POST', token: MAIN, input: { to: 'Retired', message: 'Hi', waitMs: 10 } }),
    404, 'BOT_NOT_FOUND');
  await refuses(call('/missing', { token: MAIN }), 404, 'NOT_FOUND');
});
