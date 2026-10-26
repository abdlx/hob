import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../app.mjs';
import { HermesClient, hermesSessionKey, hermesNativeSessionKey } from '../hermes-client.mjs';

let upstream, app, origin, cookie, client;
let mode = 'complete';
let runStatus = 'running';
let admissions = 0;
let runtimeReady = true;
const calls = [];
before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    calls.push({ url: req.url, method: req.method, body: raw ? JSON.parse(raw) : undefined, headers: req.headers });
    const pathname = new URL(req.url, 'http://fixture.local').pathname.replace(/^\/p\/[^/]+/, '');
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (pathname === '/api/profiles') return json({ profiles: [{ name: 'default', model: 'main-model' }, { name: 'coder', model: 'code-model' }] });
    if (pathname === '/v1/capabilities') return runtimeReady ? json({ features: { run_status: true, run_events_sse: true } }) : json({ error: 'runtime unavailable' }, 503);
    if (pathname === '/api/health') return json({ ok: true });
    if (pathname === '/api/config') return json({ model: '', gateway: { multiplex_profiles: true } });
    if (pathname === '/api/sessions') {
      const session = { id: 'session-1', title: 'My work', started_at: 1700000000, input_tokens: 12, output_tokens: 8 };
      return req.method === 'POST' ? json({ object: 'hermes.session', session }, 201) : json({ object: 'list', data: [session] });
    }
    if (pathname.endsWith('/messages')) return json({ object: 'list', data: [{ id: 1, role: 'user', content: 'Hello', timestamp: 1700000000 }] });
    if (pathname === '/v1/runs' && req.method === 'POST') {
      admissions++;
      if (mode === 'uncertain') { req.socket.destroy(); return; }
      return json({ run_id: 'run-1', status: 'started' }, 202);
    }
    if (pathname === '/v1/runs/run-1') return json({ run_id: 'run-1', status: runStatus,
      ...(runStatus === 'waiting_for_approval' ? { approval: { request_id: 'request-1', command: 'touch example' } } : {}) });
    if (pathname === '/v1/runs/run-1/approval' || pathname === '/v1/runs/run-1/stop') return json({ accepted: true });
    if (pathname.endsWith('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"event":"message.delta","run_id":"run-1","delta":"Working"}\n\n');
      if (mode === 'complete') res.write('data: {"event":"run.completed","run_id":"run-1","output":"Finished","timestamp":1700000001}\n\n');
      if (mode === 'failed') res.write('data: {"event":"run.failed","run_id":"run-1","error":"private-error"}\n\n');
      if (mode === 'approval') res.write('data: {"event":"approval.request","run_id":"run-1","request_id":"request-1","command":"touch example"}\n\n');
      res.end(); return;
    }
    json({ error: 'unknown fixture route' }, 404);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${upstream.address().port}`;
  client = new HermesClient({ runtimeUrl: url, dashboardUrl: url, apiKey: 'runtime-test', dashboardToken: 'settings-test' });
  client.connected = true;
  app = createApp({ gateway: client, password: 'synthetic-login' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${app.address().port}`;
  const result = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'synthetic-login' }) });
  cookie = result.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  client.stop();
  for (const server of [app, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
const request = (path, method = 'GET', data, profile = 'default') => fetch(`${origin}${path}`, {
  method, headers: { Cookie: cookie, 'X-Hob-Profile': profile, ...(data ? { 'Content-Type': 'application/json', Origin: origin } : {}) },
  ...(data ? { body: JSON.stringify(data) } : {}),
});
const turn = (session, profile = 'default') => request(`/api/sessions/${encodeURIComponent(session)}/turns`, 'POST', { content: 'Hello', idempotencyKey: `request-${admissions}` }, profile);

test('a canonical conversation never falls back to HTTP when its native bridge is missing', async () => {
  const before = calls.length;
  const response = await request(`/api/sessions/${hermesNativeSessionKey('coder', 'session-1')}/messages`);
  assert.equal(response.status, 503); assert.equal(calls.length, before);
});

test('stale dashboard operations cannot fall through into OpenClaw RPC on Hermes', async () => {
  const before = calls.length;
  let rpcCalls = 0;
  const original = client.request;
  client.request = () => { rpcCalls++; throw new Error('Unexpected legacy RPC.'); };
  try {
    for (const [route, method, data] of [
      ['/api/settings/schema', 'GET'], ['/api/library', 'GET'], ['/api/browser/tabs', 'GET'],
      ['/api/settings', 'PATCH', { baseHash: 'synthetic', patch: {} }],
      ['/api/settings/rpc', 'POST', { method: 'skills.proposals.apply' }],
      ['/api/agent', 'PATCH', { name: 'Old client' }],
    ]) {
      const response = await request(route, method, data);
      assert.equal(response.status, 409, `${method} ${route}`);
      assert.equal((await response.json()).code, 'DASHBOARD_RUNTIME_MISMATCH');
    }
    assert.equal(rpcCalls, 0);
    assert.equal(calls.length, before);
  } finally { client.request = original; }
});

test('the app declares Hermes and translates the canonical session creation envelope', async () => {
  assert.deepEqual(await (await request('/api/runtime')).json(), { runtime: 'hermes' });
  const response = await request('/api/sessions', 'POST', { title: 'Task' }, 'coder');
  assert.equal(response.status, 201);
  const session = await response.json();
  assert.equal(session.id, hermesSessionKey('coder', 'session-1'));
  assert.equal(session.agentId, 'coder');
  assert.equal(calls.at(-1).url, '/p/coder/api/sessions');
});

test('setup remains authenticated and healthy before the agent listener is ready', async () => {
  runtimeReady = false;
  client.connected = false;
  try {
    assert.equal((await request('/healthz')).status, 200);
    assert.equal((await (await request('/api/readiness')).json()).ready, false);
    assert.equal((await request('/api/hermes/config')).status, 200);
    assert.equal((await fetch(`${origin}/api/hermes/config`)).status, 401);
  } finally { runtimeReady = true; client.connected = true; }
});

test('session history stays with its original bot even when the selected profile changes', async () => {
  const response = await request(`/api/sessions/${hermesSessionKey('coder', 'session-1')}/messages`, 'GET', undefined, 'default');
  assert.equal(response.status, 200);
  assert.equal(calls.at(-1).url, '/p/coder/api/sessions/session-1/messages');
  assert.equal((await response.json())[0].content, 'Hello');
});

test('chat uses actual Hermes event names and only the terminal event establishes success', async () => {
  mode = 'complete';
  const response = await turn(hermesSessionKey('coder', 'session-1'));
  const stream = await response.text();
  assert.match(stream, /event: accepted/);
  assert.match(stream, /event: delta/);
  assert.match(stream, /event: done/);
  assert.match(stream, /Finished/);
  const admission = calls.findLast(call => call.method === 'POST' && call.url === '/p/coder/v1/runs');
  assert.deepEqual(admission.body, { input: 'Hello', session_id: 'session-1' });
  assert.equal(calls.at(-1).url, '/p/coder/v1/runs/run-1/events');
});

test('failed runs never become successful messages or expose raw private error text', async () => {
  mode = 'failed';
  const stream = await (await turn(hermesSessionKey('default', 'failed-session'))).text();
  assert.match(stream, /event: error/);
  assert.doesNotMatch(stream, /event: done/);
  assert.doesNotMatch(stream, /private-error/);
});

test('a dropped stream retains cancellation and duplicate protection until canonical status settles', async () => {
  mode = 'partial'; runStatus = 'running';
  const key = hermesSessionKey('coder', 'partial-session');
  const stream = await (await turn(key)).text();
  assert.match(stream, /before completion/);
  assert.doesNotMatch(stream, /event: done/);
  assert.equal((await turn(key)).status, 409);
  assert.equal((await request(`/api/sessions/${key}/abort`, 'POST', {})).status, 200);
  assert.equal(calls.at(-1).url, '/p/coder/v1/runs/run-1/stop');
  runStatus = 'completed'; mode = 'complete';
  assert.match(await (await turn(key)).text(), /event: done/);
});

test('uncertain admission does not silently allow a second run or retry the write', async () => {
  mode = 'uncertain';
  const key = hermesSessionKey('default', 'uncertain-session');
  const count = admissions;
  assert.equal((await turn(key)).status, 503);
  assert.equal((await turn(key)).status, 409);
  assert.equal(admissions, count + 1);
  mode = 'complete';
});

test('approval presentation is profile-scoped and decisions bind the exact native request', async () => {
  mode = 'approval'; runStatus = 'waiting_for_approval';
  const key = hermesSessionKey('coder', 'approval-session');
  await (await turn(key)).text();
  const pending = await (await request('/api/security/approvals', 'GET', undefined, 'coder')).json();
  assert.equal(pending.length, 1);
  const exchangeApprovals = await (await request(`/api/sessions/${key}/approvals`)).json();
  assert.equal(exchangeApprovals.approvals.length, 1, 'exchange inspector can inspect the exact run approval across selected bots');
  assert.deepEqual(await (await request('/api/security/approvals')).json(), []);
  assert.equal((await request(`/api/security/approvals/${pending[0].id}`, 'POST', { decision: 'approved' })).status, 404);
  assert.equal((await request(`/api/security/approvals/${pending[0].id}`, 'POST', { decision: 'approved' }, 'coder')).status, 200);
  assert.deepEqual(calls.at(-1).body, { choice: 'once', request_id: 'request-1' });
  runStatus = 'completed'; mode = 'complete';
  await request('/api/tasks', 'GET', undefined, 'coder');
});
