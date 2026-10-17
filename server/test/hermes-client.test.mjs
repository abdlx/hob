import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HermesClient, hermesSessionKey, hermesNativeSessionKey, parseHermesSessionKey } from '../hermes-client.mjs';

let upstream, origin;
const received = [];
let respond;
before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const call = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    received.push(call);
    if (respond) return respond(req, res, call);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${upstream.address().port}`;
});
after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});
const client = options => new HermesClient({ runtimeUrl: origin, dashboardUrl: origin,
  apiKey: 'synthetic-runtime-key', dashboardToken: 'synthetic-dashboard-token', ...options });

test('dashboard query values are encoded without changing the profile or upstream route', async () => {
  await client().dashboard('/api/skills/content', { profile: 'coder', query: { name: 'notes&profile=default?next=/api/env' } });
  const call = received.at(-1), url = new URL(call.url, origin);
  assert.equal(url.pathname, '/api/skills/content'); assert.equal(url.searchParams.get('profile'), 'coder');
  assert.equal(url.searchParams.get('name'), 'notes&profile=default?next=/api/env');
  const count = received.length;
  await assert.rejects(client().dashboard('/api/skills/content', { query: { profile: 'all' } }), error => error.status === 400);
  assert.equal(received.length, count);
});

test('canonical and API session keys cannot alias even for the same bot and native identifier', () => {
  const canonical = hermesNativeSessionKey('coder', 'same-id');
  assert.notEqual(canonical, hermesSessionKey('coder', 'same-id'));
  assert.deepEqual(parseHermesSessionKey(canonical), { profile: 'coder', sessionId: 'same-id', transport: 'canonical' });
});

test('runtime calls select the exact profile and never send dashboard or browser credentials', async () => {
  respond = undefined;
  await client().runtime('/api/sessions', { profile: 'research' });
  const call = received.at(-1);
  assert.equal(call.url, '/p/research/api/sessions');
  assert.equal(call.headers.authorization, 'Bearer synthetic-runtime-key');
  assert.equal(call.headers['x-hermes-session-token'], undefined);
  assert.equal(call.headers.cookie, undefined);
  await client().runtime('/api/sessions');
  assert.equal(received.at(-1).url, '/api/sessions');
});

test('settings use the dashboard credential and profile query, independently of runtime auth', async () => {
  await client().dashboard('/api/config', { profile: 'coder', method: 'PUT', body: { config: { model: 'test-model' } } });
  const call = received.at(-1);
  assert.equal(call.url, '/api/config?profile=coder');
  assert.equal(call.headers['x-hermes-session-token'], 'synthetic-dashboard-token');
  assert.equal(call.headers.authorization, undefined);
  assert.deepEqual(call.body, { config: { model: 'test-model' } });
});

test('missing settings credential fails before any unauthenticated upstream request', async () => {
  const count = received.length;
  await assert.rejects(client({ dashboardToken: undefined }).dashboard('/api/config'), error => error.status === 503);
  assert.equal(received.length, count);
});

test('runtime credentials cannot appear in serialized client state', () => {
  const serialized = JSON.stringify(client());
  assert.equal(serialized.includes('synthetic-runtime-key'), false);
  assert.equal(serialized.includes('synthetic-dashboard-token'), false);
});

test('remote origins, URL credentials, alternate paths and profile traversal are rejected', async () => {
  for (const runtimeUrl of ['http://example.com', 'http://localhost:8642', 'https://127.0.0.1',
    'http://user:password@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?token=secret']) {
    assert.throws(() => client({ runtimeUrl }));
  }
  const count = received.length;
  for (const profile of ['../default', 'coder/../../default', 'Coder', '', 'a?b', null]) {
    await assert.rejects(client().runtime('/api/sessions', { profile }), error => error.status === 400);
  }
  for (const pathname of ['//example.com', '/api/../env', '/api/%2e%2e/env', '/api/env?reveal=1', '/api\\env']) {
    await assert.rejects(client().runtime(pathname), error => error.status === 400);
  }
  assert.equal(received.length, count);
});

test('conversation identifiers bind profile and session instead of depending on selected bot', () => {
  const coder = hermesSessionKey('coder', 'session-123');
  const researcher = hermesSessionKey('research', 'session-123');
  assert.notEqual(coder, researcher);
  assert.deepEqual(parseHermesSessionKey(coder), { profile: 'coder', sessionId: 'session-123' });
  for (const tuple of [['../default', 'session'], ['coder', '../../state.db'], ['coder', 'a', 'b'], ['coder', null]]) {
    assert.throws(() => parseHermesSessionKey(Buffer.from(JSON.stringify(tuple)).toString('base64url')));
  }
  assert.throws(() => parseHermesSessionKey(coder + '='));
});

test('failed writes are not replayed and error responses cannot disclose upstream secrets', async () => {
  respond = (_req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'private-provider-secret' } }));
  };
  const count = received.length;
  await assert.rejects(client().runtime('/v1/runs', { method: 'POST', body: { input: 'hello' }, idempotencyKey: 'request-1' }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.message.includes('private-provider-secret'), false);
    return true;
  });
  assert.equal(received.length, count + 1);
  assert.equal(received.at(-1).headers['idempotency-key'], 'request-1');
});

test('redirects cannot transfer a server credential to a different listener', async () => {
  let leaked = false;
  const other = http.createServer((_req, res) => { leaked = true; res.end('{}'); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  try {
    respond = (_req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${other.address().port}/secret` }); res.end(); };
    await assert.rejects(client().runtime('/v1/models'), error => error.status === 503);
    assert.equal(leaked, false);
  } finally {
    other.closeAllConnections();
    await new Promise(resolve => other.close(resolve));
  }
});

test('unexpected content, invalid JSON and oversized responses cannot masquerade as valid state', async () => {
  for (const [type, body, code] of [
    ['text/html', '<html>login</html>', 'HERMES_PROTOCOL_ERROR'],
    ['application/json', '{', 'HERMES_PROTOCOL_ERROR'],
    ['application/json', JSON.stringify({ data: 'x'.repeat(100) }), 'HERMES_RESPONSE_LIMIT'],
  ]) {
    respond = (_req, res) => { res.writeHead(200, { 'Content-Type': type }); res.end(body); };
    await assert.rejects(client({ maxResponseBytes: 50 }).runtime('/api/sessions'), error => error.code === code);
  }
});

test('event stream decodes split UTF-8 and CRLF without inventing completion from EOF', async () => {
  const events = [
    { event: 'message.delta', run_id: 'run-1', delta: 'سلام 🐕' },
    { event: 'run.completed', run_id: 'run-1', output: 'سلام 🐕' },
  ];
  respond = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(': keepalive\r\n\r\n' + events.map(event => `event: ${event.event}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
    for (const byte of bytes) res.write(Buffer.from([byte]));
    res.end();
  };
  const actual = [];
  for await (const event of client().events('run-1', { profile: 'coder' })) actual.push(event);
  assert.deepEqual(actual, events);
  assert.equal(received.at(-1).url, '/p/coder/v1/runs/run-1/events');
  respond = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"event":"message.delta","delta":"partial"}\n\n'); };
  const partial = [];
  for await (const event of client().events('run-1')) partial.push(event);
  assert.equal(partial.length, 1);
  assert.equal(partial.some(event => event.event === 'run.completed'), false);
});

test('invalid or oversized event frames and non-SSE responses fail visibly', async () => {
  for (const [type, body, code] of [
    ['text/event-stream', 'data: {\n\n', 'HERMES_PROTOCOL_ERROR'],
    ['text/event-stream', 'data: {"type":"unfinished"}', 'HERMES_PROTOCOL_ERROR'],
    ['text/event-stream', 'data: ' + 'x'.repeat(80), 'HERMES_RESPONSE_LIMIT'],
    ['application/json', '{}', 'HERMES_PROTOCOL_ERROR'],
  ]) {
    respond = (_req, res) => { res.writeHead(200, { 'Content-Type': type }); res.end(body); };
    await assert.rejects(async () => {
      for await (const event of client({ maxResponseBytes: 64 }).events('run-1')) void event;
    }, error => error.code === code);
  }
});

test('readiness requires an authenticated capabilities response and unsupported RPCs fail explicitly', async () => {
  respond = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ features: { run_status: true, run_events_sse: true } })); };
  const transport = client();
  assert.deepEqual(await transport.getStartupStatus(), { ready: true, status: 'started', runtime: 'hermes' });
  assert.throws(() => transport.request('skills.proposals.apply'), error => error.status === 501);
  respond = (_req, res) => { res.writeHead(401); res.end('no'); };
  assert.deepEqual(await transport.getStartupStatus(), { ready: false, status: 'disconnected', runtime: 'hermes' });
});

test('a generic JSON success is not an agent-ready protocol, while setup health remains independent', async () => {
  respond = undefined;
  const transport = client();
  assert.deepEqual(await transport.getStartupStatus(), { ready: false, status: 'disconnected', runtime: 'hermes' });
  assert.deepEqual(await transport.getServiceHealth(), { ready: true, status: 'settings_available', runtime: 'hermes', agentConnected: false });
});

test('a bot is not ready merely because its capabilities or Main listener are available', async () => {
  let sessionsReady = false;
  const urls = [];
  const transport = new HermesClient({ apiKey: 'synthetic-profile-key', fetchImpl: async url => {
    urls.push(String(url));
    if (url.pathname.endsWith('/v1/capabilities')) return Response.json({ features: { run_status: true, run_events_sse: true } });
    return sessionsReady ? Response.json({ data: [] }) : Response.json({ error: 'initializing' }, { status: 503 });
  } });
  transport.connected = true;
  assert.deepEqual(await transport.getProfileStatus('coder'), { ready: false });
  sessionsReady = true;
  assert.deepEqual(await transport.getProfileStatus('coder'), { ready: true });
  assert.ok(urls.every(value => new URL(value).pathname.startsWith('/p/coder/')));
});
