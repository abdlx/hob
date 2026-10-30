import assert from 'node:assert/strict';
import test from 'node:test';
import { createHermesBotRelay } from '../hermes-bot-relay.mjs';

const BASE = '/api/hermes/bot-relay';
const MAIN = 'a'.repeat(64);
const WRITER = 'b'.repeat(64);
const EDITOR = 'c'.repeat(64);

function fixture(team, output = 'the finished answer') {
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
      if (route === '/api/sessions' && options.method !== 'POST') return { data: [] };
      if (route === '/api/sessions') return { session: { id: `relay-${options.profile}-${++sessionCounter}` } };
      if (route === '/v1/runs') return { run_id: `run-${++runCounter}` };
      throw new Error(`unexpected runtime route ${route}`);
    },
    async *events(runId, { profile }) {
      events.push({ runId, profile });
      yield { event: 'message.delta', delta: 'partial ' };
      yield { event: 'run.completed', output };
    },
  };
  const relay = createHermesBotRelay({ client, bots, team });
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
  return { relay, call, roster, runtime, events };
}

const refuses = (promise, status, code) => assert.rejects(promise,
  error => error.status === status && (code ? error.code === code : true));

const teamAssignment = 'TASK plan-1 — Prepare a plan\nOUTCOME: A checked plan file\nCONSTRAINTS: No external messages\nOUTPUT: artifacts/plan.md\nDEADLINE: none\nCORE REFS: none';

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
  const { call, runtime, relay } = fixture({ policy: () => ({ coordinatorOnly: true }) });
  try {
    await refuses(call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: 'Free-form task' } }), 400, 'TEAM_TASK_FORMAT');
    assert.equal(runtime.length, 0);
    const result = await call('/send', { method: 'POST', token: MAIN, input: { to: 'writer', message: teamAssignment, waitMs: 30 } });
    assert.equal(result.body.teamTask.id, 'plan-1');
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
