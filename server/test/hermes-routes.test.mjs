import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createApp } from '../app.mjs';
import { HermesClient } from '../hermes-client.mjs';

let app, upstream, origin, cookie;
const calls = [];
let upstreamStatus = 200;
before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    if (req.url.endsWith('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"event":"run.completed","run_id":"run-1","output":"Hello"}\n\n');
    } else {
      res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(upstreamStatus === 200 ? { ok: true } : { error: { message: 'synthetic-private-secret' } }));
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${upstream.address().port}`;
  const hermes = new HermesClient({ runtimeUrl: url, dashboardUrl: url, apiKey: 'runtime-only-secret', dashboardToken: 'settings-only-secret' });
  const gateway = new EventEmitter();
  gateway.connected = false;
  gateway.request = () => { throw new Error('Hermes routes must not call OpenClaw RPC.'); };
  app = createApp({ gateway, hermes, password: 'synthetic-hob-login' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'synthetic-hob-login' }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  for (const server of [app, upstream]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
const request = (route, method = 'GET', data, extra = {}) => fetch(`${origin}/api/hermes/${route}`, {
  method, headers: { Cookie: cookie, ...(data ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...extra },
  ...(data ? { body: JSON.stringify(data) } : {}),
});

test('native Hermes endpoints retain application authentication and origin checks', async () => {
  const count = calls.length;
  assert.equal((await fetch(`${origin}/api/hermes/profiles`)).status, 401);
  assert.equal((await request('profiles', 'POST', { name: 'research' }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal(calls.length, count);
});

test('workspace actions use the same authenticated boundary and refuse cross-origin writes before upstream calls', async () => {
  const count = calls.length;
  assert.equal((await fetch(`${origin}/api/hermes/workspace/skills`)).status, 401);
  assert.equal((await request('workspace/skill', 'POST', { name: 'notes', content: '# Notes' }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal(calls.length, count);
  assert.equal((await request('workspace/skills?profile=coder')).status, 200);
  assert.equal(calls.at(-1).url, '/api/skills?profile=coder');
  assert.equal(calls.at(-1).headers['x-hermes-session-token'], 'settings-only-secret');
  assert.equal(calls.at(-1).headers.cookie, undefined);
});

test('setup actions require app authentication and reject cross-origin provider sign-in', async () => {
  const count = calls.length;
  assert.equal((await fetch(`${origin}/api/hermes/setup/models`)).status, 401);
  assert.equal((await request('setup/accounts/nous/start', 'POST', { confirm: true }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal(calls.length, count);
  assert.equal((await request('setup/models?profile=coder')).status, 200);
  assert.match(calls.at(-1).url, /profile=coder/);
  assert.equal(calls.at(-1).headers['x-hermes-session-token'], 'settings-only-secret');
});

test('group controls share app authentication and origin enforcement before native coordination', async () => {
  const count = calls.length;
  assert.equal((await fetch(`${origin}/api/hermes/groups`)).status, 401);
  assert.equal((await request('groups', 'POST', { name: 'Shared' }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal(calls.length, count);
});

test('settings and runtime operations reach separate authenticated upstream surfaces', async () => {
  assert.equal((await request('config?profile=research')).status, 200);
  assert.equal(calls.at(-1).url, '/api/config?profile=research');
  assert.equal(calls.at(-1).headers.authorization, undefined);
  assert.equal(calls.at(-1).headers['x-hermes-session-token'], 'settings-only-secret');
  assert.equal((await request('capabilities?profile=research')).status, 200);
  assert.equal(calls.at(-1).url, '/p/research/v1/capabilities');
  assert.equal(calls.at(-1).headers.authorization, 'Bearer runtime-only-secret');
  assert.equal(calls.at(-1).headers['x-hermes-session-token'], undefined);
  assert.equal(calls.at(-1).headers.cookie, undefined);
});

test('fresh bot creation never clones another bot memory or channel credentials', async () => {
  assert.equal((await request('profiles', 'POST', { name: 'coder', soul: 'Help with code.' })).status, 201);
  assert.deepEqual(calls.at(-1).body, { name: 'coder', soul: 'Help with code.' });
  const count = calls.length;
  assert.equal((await request('profiles', 'POST', { name: 'other', clone_all: true })).status, 400);
  assert.equal((await request('profiles', 'POST', { name: 'default' })).status, 400);
  assert.equal((await request('profiles/default', 'DELETE')).status, 400);
  assert.equal(calls.length, count);
});

test('config writes cannot redirect the selected profile using a body override', async () => {
  const count = calls.length;
  assert.equal((await request('config?profile=coder', 'PUT', { profile: 'default', config: { model: 'test' } })).status, 400);
  assert.equal(calls.length, count);
  assert.equal((await request('config?profile=coder', 'PUT', { config: { model: 'test' } })).status, 200);
  assert.equal(calls.at(-1).url, '/api/config?profile=coder');
  assert.deepEqual(calls.at(-1).body, { profile: 'coder', config: { model: 'test' } });
});

test('provider credentials can be configured without changing managed transport credentials', async () => {
  assert.equal((await request('credentials?profile=coder', 'PUT', { key: 'ANTHROPIC_API_KEY', value: 'new-provider-secret' })).status, 200);
  assert.deepEqual(calls.at(-1).body, { key: 'ANTHROPIC_API_KEY', value: 'new-provider-secret', profile: 'coder' });
  const count = calls.length;
  for (const key of ['API_SERVER_KEY', 'HERMES_DASHBOARD_SESSION_TOKEN', 'HERMES_HOME', 'MUSE_PASSWORD', 'PATH', 'NODE_OPTIONS',
    'GATEWAY_MULTIPLEX_PROFILES', 'HERMES_EXECUTABLE', 'HERMES_INSTALL_ROOT', 'HERMES_PYTHON',
    'HERMES_GATEWAY_EXTERNAL_SUPERVISOR', 'HERMES_GATEWAY_NO_SUPERVISE']) {
    assert.equal((await request('credentials', 'PUT', { key, value: 'do-not-write' })).status, 400);
  }
  assert.equal(calls.length, count);
});

test('session creation and messages preserve the selected runtime profile', async () => {
  assert.equal((await request('sessions?profile=coder', 'POST', { title: 'Coding task' })).status, 201);
  assert.equal(calls.at(-1).url, '/p/coder/api/sessions');
  assert.deepEqual(calls.at(-1).body, { title: 'Coding task' });
  assert.equal((await request('sessions/session-1/messages?profile=research')).status, 200);
  assert.equal(calls.at(-1).url, '/p/research/api/sessions/session-1/messages');
});

test('custom endpoints use the native named-provider owner without implicit model activation', async () => {
  assert.equal((await request('custom-endpoints?profile=coder', 'POST', {
    name: 'Local research', base_url: 'http://127.0.0.1:9000/v1', model: 'shared-model', api_key: 'synthetic-endpoint-key',
  })).status, 200);
  assert.equal(calls.at(-1).url, '/api/providers/custom-endpoints?profile=coder');
  assert.equal(calls.at(-1).body.make_default, false);
  assert.equal(calls.at(-1).body.profile, 'coder');
  const count = calls.length;
  assert.equal((await request('custom-endpoints', 'POST', { make_default: true })).status, 400);
  assert.equal((await request('custom-endpoints', 'POST', { api_key: '[stored credential]' })).status, 400);
  assert.equal(calls.length, count);
});

test('run admission forwards idempotency once and exposes approval, steering and cancellation', async () => {
  assert.equal((await request('runs?profile=coder', 'POST', { input: 'hello', session_id: 'session-1' }, { 'Idempotency-Key': 'stable-request-1' })).status, 202);
  assert.equal(calls.at(-1).headers['idempotency-key'], 'stable-request-1');
  for (const [operation, input] of [['approval', { choice: 'once', request_id: 'approval-1' }],
    ['clarify', { request_id: 'question-1', execution_generation: 42, answer: 'Report' }], ['steer', { input: 'Use Python' }], ['stop', {}]]) {
    assert.equal((await request(`runs/run-1/${operation}?profile=coder`, 'POST', input)).status, 200);
    assert.equal(calls.at(-1).url, `/p/coder/v1/runs/run-1/${operation}`);
    assert.deepEqual(calls.at(-1).body, input);
  }
});

test('run events stay authenticated and reach the browser without transport credentials', async () => {
  const response = await request('runs/run-1/events?profile=coder');
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /event: hermes/);
  assert.match(stream, /run.completed/);
  assert.equal(stream.includes('runtime-only-secret'), false);
  assert.equal(stream.includes('settings-only-secret'), false);
  assert.equal(calls.at(-1).url, '/p/coder/v1/runs/run-1/events');
});

test('arbitrary proxy routes, secret reveals, profile confusion and encoded traversal fail before upstream access', async () => {
  const count = calls.length;
  for (const route of ['credentials/reveal', 'admin/api/env/reveal', 'http://attacker.invalid', 'config?profile=coder&profile=default',
    'sessions/a%2Fb/messages', 'runs/%ZZ/stop']) {
    const result = await request(route);
    assert.ok([400, 404].includes(result.status), `${route}: ${result.status}`);
  }
  assert.equal(calls.length, count);
});

test('upstream failures remain errors without leaking private error bodies or retrying', async () => {
  upstreamStatus = 409;
  try {
    const count = calls.length;
    const response = await request('runs', 'POST', { input: 'hello' });
    assert.equal(response.status, 409);
    assert.equal((await response.text()).includes('synthetic-private-secret'), false);
    assert.equal(calls.length, count + 1);
  } finally { upstreamStatus = 200; }
});
