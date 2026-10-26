import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHermesSetupRoutes } from '../hermes-setup.mjs';

const sha = 'a'.repeat(40);
let server, origin, catalog, hub, reply, calls;
before(async () => {
  const handler = createHermesSetupRoutes({
    credentialBinding: async () => 'bound',
    async dashboard(path, options) {
      calls.push({ path, ...options });
      if (path.endsWith('/catalog')) return catalog;
      if (path.endsWith('/hub')) return hub;
      return typeof reply === 'function' ? reply(path, options) : reply;
    },
  });
  server = http.createServer(async (req, res) => {
    const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    const body = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); };
    try { await handler(req, res, new URL(req.url, 'http://localhost'), { json, body }); }
    catch (error) { json(res, error.status || 500, { error: error.message, code: error.code }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  calls = []; reply = { ok: true };
  catalog = { entries: [{ name: 'example', description: 'Example', sha, tier: 'community', repo: 'https://github.com/example/plugin', installed: false,
    capabilities: { provides_tools: ['example_tool'], requires_env: ['EXAMPLE_KEY'] }, private: 'private' }], removed: [] };
  hub = { plugins: [{ name: 'example', runtime_status: 'disabled', can_remove: true, can_update_git: true, path: '/private/path', auth_command: 'private' }] };
});
const request = (route = '', value, profile = 'default') => fetch(`${origin}/api/hermes/setup/plugins${route}?profile=${profile}`, {
  method: value === undefined ? 'GET' : 'POST', ...(value === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
});
const install = { confirm: true, expectedSha: sha };

test('plugin operations refuse named profiles before reading or writing the launch home', async () => {
  for (const [route, body] of [['', undefined], ['/example/install', install], ['/example/enable', { confirm: true }]]) {
    assert.equal((await request(route, body, 'research')).status, 409);
  }
  assert.equal(calls.length, 0);
});

test('plugin inventory projects metadata without paths, commands or private extension fields', async () => {
  const response = await request(); assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.scope, 'default'); assert.equal(result.entries[0].sha, sha);
  assert.deepEqual(result.entries[0].capabilities.requires_env, ['EXAMPLE_KEY']);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.ok(calls.every(call => call.profile === 'default'));
});

test('only catalog names and confirmed reviewed pins reach the native installer', async () => {
  for (const body of [{}, { ...install, identifier: 'https://untrusted.invalid/plugin' }, { ...install, force: true }, { ...install, profile: 'research' }, { confirm: true, expectedSha: 'b'.repeat(40) }]) {
    assert.ok((await request('/example/install', body)).status >= 400);
  }
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  assert.equal((await request('/example/install', install)).status, 200);
  assert.deepEqual(calls.at(-1), { path: '/api/dashboard/agent-plugins/install', profile: 'default', method: 'POST', timeoutMs: 300000,
    body: { identifier: '', catalog_name: 'example', ref: sha, force: false, enable: false } });
});

test('removed, unpinned and already installed entries cannot be installed', async () => {
  catalog.removed.push({ name: 'example', reason: 'Removed by upstream' });
  assert.equal((await request('/example/install', install)).status, 400);
  catalog.removed = []; catalog.entries[0].sha = 'branch-tip';
  assert.equal((await request('/example/install', install)).status, 400);
  catalog.entries[0].sha = sha; catalog.entries[0].installed = true;
  assert.equal((await request('/example/install', install)).status, 409);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});

test('native failure never reports saved state or retries a mutation', async () => {
  reply = { ok: false, error: 'private internal failure' };
  const response = await request('/example/install', install);
  assert.equal(response.status, 502); assert.equal(JSON.stringify(await response.json()).includes('private'), false);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('installed inventory controls lifecycle operations and protects built-ins', async () => {
  hub.plugins[0].can_remove = false;
  assert.equal((await request('/example/remove', { confirm: true })).status, 400);
  assert.equal((await request('/missing/enable', { confirm: true })).status, 404);
  for (const operation of ['enable', 'disable']) {
    assert.equal((await request(`/example/${operation}`, { confirm: true })).status, 200);
    assert.equal(calls.at(-1).path, `/api/dashboard/agent-plugins/example/${operation}`);
    assert.equal(calls.at(-1).profile, 'default');
  }
  hub.plugins[0].can_remove = true;
  assert.equal((await request('/example/remove', { confirm: true })).status, 200);
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('updates preserve native additional-capability consent without implicit acceptance', async () => {
  catalog.entries[0].installed = true;
  reply = { consent_required: true, delta_lines: ['Adds a tool'], output: 'private shell output' };
  let response = await request('/example/update', { confirm: true });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.consent_required, true); assert.deepEqual(result.delta_lines, ['Adds a tool']);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(calls.at(-1).body, { accept_capabilities: false });
  reply = { ok: true, restart_required: true };
  response = await request('/example/update', { confirm: true, acceptCapabilities: true });
  assert.equal(response.status, 200); assert.equal((await response.json()).restart_required, true);
  assert.deepEqual(calls.at(-1).body, { accept_capabilities: true });
});

test('concurrent mutations are fenced while inventory remains readable', async () => {
  let release, admitted;
  const started = new Promise(resolve => { admitted = resolve; });
  reply = async () => { admitted(); return new Promise(resolve => { release = resolve; }); };
  const first = request('/example/install', install);
  await started;
  try {
    assert.equal((await request('/example/install', install)).status, 409);
    assert.equal((await request()).status, 200);
  } finally { release({ ok: true }); }
  assert.equal((await first).status, 200);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});
