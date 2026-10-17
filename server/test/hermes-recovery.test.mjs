import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../app.mjs';
import { HermesClient, hermesSessionKey } from '../hermes-client.mjs';
import { HermesRunJournal } from '../hermes-run-journal.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-hermes-recovery-'));
  const calls = [], nativeRuns = new Map(), keys = new Map();
  let app, client, origin, cookie, nextId = 0;
  let mode = 'partial', loseAcceptance = false, durable = true, retentionSeconds = 86400;
  const native = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(req.url, 'http://fixture');
    const match = /^\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
    const profile = match?.[1] || 'default';
    const pathname = match?.[2] || url.pathname;
    calls.push({ pathname, profile, method: req.method, key: req.headers['idempotency-key'], body });
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (pathname === '/v1/capabilities') return json({ features: { run_status: true, run_events_sse: true,
      runs_idempotency: { supported: true, durable, retention_seconds: retentionSeconds } } });
    if (pathname === '/api/health') return json({ ok: true });
    if (pathname === '/api/profiles') return json({ profiles: [{ name: 'default' }, { name: 'coder' }] });
    if (pathname === '/api/sessions') return json({ data: [{ id: 'session-1', title: 'Persisted conversation' }] });
    if (pathname.endsWith('/messages')) return json({ data: [{ id: 'message-1', role: 'assistant', content: 'Persisted partial answer' }] });
    if (pathname === '/v1/runs' && req.method === 'POST') {
      const scope = profile + ':' + req.headers.authorization + ':' + req.headers['idempotency-key'];
      let id = keys.get(scope);
      if (!id) {
        id = 'run-' + (++nextId); keys.set(scope, id);
        nativeRuns.set(id, { run_id: id, status: mode === 'approval' ? 'waiting_for_approval' : mode === 'unknown' ? 'unknown' : 'running',
          session_id: body.session_id, execution_generation: 42, admission_id: 'admission-' + id,
          pending_controls: mode === 'approval' ? [{ kind: 'approval', prompt_id: 'prompt-' + id, execution_generation: 42, command: 'echo proof', description: 'Approve proof command', choices: ['once', 'deny'] }]
            : mode === 'question' ? [{ kind: 'clarify', prompt_id: 'question-' + id, execution_generation: 42, question: 'Which result should I produce?', choices: ['Report', 'Chart'], multi_select: true }] : [] });
      }
      if (loseAcceptance) { loseAcceptance = false; req.socket.destroy(); return; }
      return json({ run_id: id, status: 'started' }, 202);
    }
    const target = /^\/v1\/runs\/([^/]+)(?:\/(events|stop|approval|clarify|resolve-unknown))?$/.exec(pathname);
    if (target) {
      const state = nativeRuns.get(target[1]);
      if (!state) return json({ error: 'not found' }, 404);
      if (!target[2]) return json(state);
      if (target[2] === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ event: 'message.delta', run_id: state.run_id, delta: 'Partial' }) + '\n\n');
        if (mode === 'approval') res.write('data: ' + JSON.stringify({ event: 'approval.request', run_id: state.run_id, ...state.pending_controls[0] }) + '\n\n');
        if (mode === 'unknown') res.write('data: ' + JSON.stringify({ event: 'run.unknown', run_id: state.run_id }) + '\n\n');
        res.end(); return;
      }
      if (target[2] === 'approval') {
        const prompt = state.pending_controls[0];
        if (!prompt || body.request_id !== prompt.prompt_id || body.execution_generation !== prompt.execution_generation) return json({ error: 'stale generation' }, 409);
        state.pending_controls = []; state.status = 'running'; return json({ run_id: state.run_id, resolved: 1 });
      }
      if (target[2] === 'clarify') {
        const question = state.pending_controls[0];
        if (!question || body.request_id !== question.prompt_id || body.execution_generation !== question.execution_generation || typeof body.answer !== 'string') return json({ error: 'stale generation' }, 409);
        state.pending_controls = []; return json({ run_id: state.run_id, status: 'resolved' });
      }
      if (target[2] === 'resolve-unknown') {
        if (body.admission_id !== state.admission_id || body.execution_generation !== state.execution_generation) return json({ error: 'stale generation' }, 409);
        state.status = 'cancelled'; return json({ run_id: state.run_id, status: 'cancelled' });
      }
      state.status = 'stopping'; return json({ run_id: state.run_id, status: 'stopping' });
    }
    json({ error: 'fixture route absent' }, 404);
  });
  const close = async server => { if (!server) return; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  await new Promise(resolve => native.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${native.address().port}`;
  const restart = async (apiKey = 'synthetic-runtime-credential') => {
    client?.stop(); await close(app);
    client = new HermesClient({ runtimeUrl: upstream, dashboardUrl: upstream, apiKey, dashboardToken: 'synthetic-settings' });
    app = createApp({ gateway: client, password: 'synthetic-login', runJournal: await HermesRunJournal.open(root) });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.address().port}`;
    const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'synthetic-login' }) });
    cookie = response.headers.get('set-cookie').split(';')[0];
  };
  const request = (url, method = 'GET', body, profile = 'coder') => fetch(origin + url, { method,
    headers: { Cookie: cookie, 'X-Hob-Profile': profile, ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const key = hermesSessionKey('coder', 'session-1');
  const session = '/api/sessions/' + key;
  try {
    await restart();
    await run({ root, calls, nativeRuns, restart, request, session, key,
      set mode(value) { mode = value; }, set loseAcceptance(value) { loseAcceptance = value; },
      set durable(value) { durable = value; }, set retentionSeconds(value) { retentionSeconds = value; },
      get dispatches() { return nextId; } });
  } finally {
    client?.stop(); await close(app); await close(native);
    assert.equal(path.dirname(root), tmpdir()); assert.ok(path.basename(root).startsWith('hob-hermes-recovery-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('dashboard restart preserves active run identity, cancellation and duplicate protection without dispatching work', async () => fixture(async f => {
  await (await f.request(f.session + '/turns', 'POST', { content: 'One task' })).text();
  await f.restart();
  const state = await (await f.request(f.session + '/run')).json();
  assert.equal(state.run.runId, 'run-1'); assert.equal(state.run.status, 'running');
  assert.equal((await f.request(f.session + '/turns', 'POST', { content: 'Duplicate' })).status, 409);
  assert.equal(f.dispatches, 1);
  assert.equal((await f.request(f.session + '/abort', 'POST', { expectedRunId: 'other' })).status, 409);
  assert.equal((await f.request(f.session + '/abort', 'POST', { expectedRunId: 'run-1' })).status, 200);
  assert.equal(f.calls.at(-1).pathname, '/v1/runs/run-1/stop');
}));

test('lost admission survives restart and explicit recovery uses the same native key and creates no duplicate execution', async () => fixture(async f => {
  f.loseAcceptance = true;
  assert.equal((await f.request(f.session + '/turns', 'POST', { content: 'Original task', idempotencyKey: 'stable-intent' })).status, 503);
  await f.restart();
  const state = await (await f.request(f.session + '/run')).json();
  assert.equal(state.run.status, 'unknown'); assert.equal(state.run.canRecover, true);
  assert.equal((await f.request(f.session + '/recover', 'POST', {})).status, 400);
  assert.equal((await f.request(f.session + '/recover', 'POST', { confirmDispatch: true, expectedRevision: 'stale' })).status, 409);
  assert.equal(f.calls.filter(call => call.pathname === '/v1/runs').length, 1);
  const recovered = await f.request(f.session + '/recover', 'POST', { confirmDispatch: true, expectedRevision: state.run.revision });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).run.runId, 'run-1');
  const submissions = f.calls.filter(call => call.pathname === '/v1/runs');
  assert.equal(submissions.length, 2); assert.equal(f.dispatches, 1);
  assert.deepEqual(submissions[0].body, submissions[1].body); assert.equal(submissions[1].key, 'stable-intent');
}));

test('credential changes cannot replay a lost submission in a different native authority scope', async () => fixture(async f => {
  f.loseAcceptance = true;
  await f.request(f.session + '/turns', 'POST', { content: 'Original task' });
  await f.restart('different-synthetic-credential');
  const state = await (await f.request(f.session + '/run')).json();
  assert.equal((await f.request(f.session + '/recover', 'POST', { confirmDispatch: true, expectedRevision: state.run.revision })).status, 409);
  assert.equal(f.calls.filter(call => call.pathname === '/v1/runs').length, 1);
}));

test('native approval prompts recover after restart and bind the exact execution generation', async () => fixture(async f => {
  f.mode = 'approval';
  await (await f.request(f.session + '/turns', 'POST', { content: 'Approval task' })).text();
  await f.restart();
  const pending = await (await f.request('/api/security/approvals')).json();
  assert.equal(pending.length, 1);
  assert.equal((await f.request('/api/security/approvals/' + pending[0].id, 'POST', { decision: 'approved' }, 'default')).status, 404);
  assert.equal((await f.request('/api/security/approvals/' + pending[0].id, 'POST', { decision: 'approved' })).status, 200);
  assert.deepEqual(f.calls.at(-1).body, { choice: 'once', request_id: 'prompt-run-1', execution_generation: 42 });
}));

test('stale approval IDs cannot authorize a newer native execution generation', async () => fixture(async f => {
  f.mode = 'approval';
  await (await f.request(f.session + '/turns', 'POST', { content: 'Approval task' })).text();
  const pending = await (await f.request('/api/security/approvals')).json();
  f.nativeRuns.get('run-1').pending_controls[0].execution_generation = 43;
  f.nativeRuns.get('run-1').execution_generation = 43;
  assert.equal((await f.request('/api/security/approvals/' + pending[0].id, 'POST', { decision: 'approved' })).status, 404);
  assert.equal(f.calls.some(call => call.pathname.endsWith('/approval')), false);
}));

test('unknown native work remains fenced until explicit resolution of its current admission and generation', async () => fixture(async f => {
  f.mode = 'unknown';
  const stream = await (await f.request(f.session + '/turns', 'POST', { content: 'Interrupted task' })).text();
  assert.equal(stream.includes('event: done'), false);
  await f.restart();
  const state = await (await f.request(f.session + '/run')).json();
  assert.equal(state.run.canResolveUnknown, true);
  assert.equal((await f.request(f.session + '/turns', 'POST', { content: 'Duplicate' })).status, 409);
  f.nativeRuns.get('run-1').execution_generation = 43;
  assert.equal((await f.request(f.session + '/resolve-unknown', 'POST', { confirmReviewed: true, expectedRevision: state.run.revision })).status, 409);
  const fresh = await (await f.request(f.session + '/run')).json();
  const resolved = await f.request(f.session + '/resolve-unknown', 'POST', { confirmReviewed: true, expectedRevision: fresh.run.revision });
  assert.equal(resolved.status, 200); assert.equal((await resolved.json()).run.status, 'cancelled');
  assert.deepEqual(f.calls.find(call => call.pathname.endsWith('/resolve-unknown')).body, { admission_id: 'admission-run-1', execution_generation: 43 });
}));

test('pending questions recover from native status after restart and answers bind the current prompt and epoch', async () => fixture(async f => {
  f.mode = 'question';
  await (await f.request(f.session + '/turns', 'POST', { content: 'Ask a question' })).text();
  await f.restart();
  const state = await (await f.request(f.session + '/run')).json();
  assert.equal(state.run.questions.length, 1);
  assert.deepEqual(state.run.questions[0].choices, ['Report', 'Chart']);
  assert.equal(state.run.questions[0].multiSelect, true);
  assert.equal((await f.request(f.session + '/clarify', 'POST', { promptId: state.run.questions[0].id, expectedRevision: 'stale', answer: 'Report' })).status, 409);
  assert.equal(f.calls.some(call => call.pathname.endsWith('/clarify')), false);
  const response = await f.request(f.session + '/clarify', 'POST', { promptId: state.run.questions[0].id, expectedRevision: state.run.revision, answer: 'Report, Chart' });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls.at(-1).body, { request_id: 'question-run-1', execution_generation: 42, answer: 'Report, Chart' });
  assert.deepEqual((await (await f.request(f.session + '/run')).json()).run.questions, []);
}));

test('persistence failure prevents dispatch and does not disclose private journal paths', async () => fixture(async f => {
  await rename(path.join(f.root, 'runs.json'), path.join(f.root, 'held-runs.json'));
  await mkdir(path.join(f.root, 'runs.json'));
  const response = await f.request(f.session + '/turns', 'POST', { content: 'Must never dispatch' });
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes(f.root), false);
  assert.equal(f.dispatches, 0);
}));

test('lost submissions cannot replay without a valid retained durable idempotency contract', async () => fixture(async f => {
  f.loseAcceptance = true;
  await f.request(f.session + '/turns', 'POST', { content: 'Original task' });
  const state = await (await f.request(f.session + '/run')).json();
  f.durable = false;
  assert.equal((await f.request(f.session + '/recover', 'POST', { confirmDispatch: true, expectedRevision: state.run.revision })).status, 409);
  assert.equal(f.calls.filter(call => call.pathname === '/v1/runs').length, 1);
}));

test('short or unavailable retention windows never authorize unknown-admission replay', async () => fixture(async f => {
  f.retentionSeconds = 30; f.loseAcceptance = true;
  await f.request(f.session + '/turns', 'POST', { content: 'Original task' });
  const state = await (await f.request(f.session + '/run')).json();
  assert.equal(state.run.canRecover, false);
  assert.equal((await f.request(f.session + '/recover', 'POST', { confirmDispatch: true, expectedRevision: state.run.revision })).status, 409);
  assert.equal(f.calls.filter(call => call.pathname === '/v1/runs').length, 1);
}));
