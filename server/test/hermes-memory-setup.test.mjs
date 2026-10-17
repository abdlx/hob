import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHermesSetupRoutes } from '../hermes-setup.mjs';
import { HermesError } from '../hermes-client.mjs';

let server, origin, respond, revoked;
const calls = [];
const schemaFields = [
  { key: 'api_key', label: 'API key', kind: 'secret', value: 'private-secret', is_set: true, placeholder: 'private-placeholder', options: [{ value: 'private-option', label: 'private-label' }] },
  { key: 'project', label: 'Project', kind: 'text', value: 'original-project' },
  { key: 'enabled', label: 'Enabled', kind: 'bool', value: true },
  { key: 'limit', label: 'Limit', kind: 'number', value: 8 },
  { key: 'filters', label: 'Filters', kind: 'json', value: '{}' },
];
function native(path, options) {
  if (path === '/api/memory') return { active: 'example', providers: [{ name: 'example', description: 'Test provider',
    available: true, configured: true, status: 'ready', api_key: 'private-key', setup: {
      pip_dependencies: ['example-package'], python_dependencies_declared: true, dependencies_installed: true,
      external_dependencies: [{ name: 'Example CLI', install: 'private-install', check: 'private-check' }], required_env: ['EXAMPLE_API_KEY'],
    } }], builtin_files: { memory: 200, user: 100, path: 'private-path' } };
  if (path.endsWith('/config')) return { label: 'Example', fields: schemaFields };
  if (path.endsWith('/setup')) return { ok: false, results: [{ kind: 'external_install', name: 'Example CLI', status: 'failed', returncode: 1,
    command: 'private-command', stdout: 'private-stdout', stderr: 'private-stderr' }] };
  return { ok: true };
}
before(async () => {
  const handler = createHermesSetupRoutes({
    credentialBinding(profile) { if (revoked) throw new HermesError(404, 'Revoked bot.'); return profile; },
    async dashboard(path, options) { calls.push({ path, ...options }); return (respond || native)(path, options); },
  });
  server = http.createServer(async (req, res) => {
    const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const body = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); };
    try { await handler(req, res, new URL(req.url, 'http://local'), { json, body }); }
    catch (error) { json(res, error.status || 500, { error: error.message, code: error.code }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => { calls.length = 0; respond = undefined; revoked = false; });
const request = (route = '', method = 'GET', value) => fetch(`${origin}/api/hermes/setup/memory${route}?profile=coder`, {
  method, ...(value === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
});
const writes = () => calls.filter(call => call.method && call.method !== 'GET');
const save = values => request('/providers/example', 'PUT', { surface: 'declared', values, confirm: true });

test('memory reads bind one enrolled bot, expose byte sizes and hide commands and credentials without activation', async () => {
  const result = await (await request()).json();
  assert.equal(result.active, 'example'); assert.deepEqual(result.builtinFiles, { memory: 200, user: 100 });
  assert.deepEqual(result.providers[0].setup.externalDependencies, [{ name: 'Example CLI', hasInstall: true }]);
  assert.equal(JSON.stringify(result).includes('private'), false);
  const schema = await (await request('/providers/example')).json();
  assert.equal(schema.surface, 'declared'); assert.equal(schema.fields[0].isSet, true); assert.equal(schema.fields[0].value, '');
  assert.equal(schema.fields[2].kind, 'boolean'); assert.equal(JSON.stringify(schema).includes('private'), false);
  assert.ok(calls.every(call => call.profile === 'coder')); assert.equal(writes().length, 0);
});

test('legacy forms are loaded only when the native declared schema is empty', async () => {
  respond = (path, options) => path.endsWith('/config') && options.query ? { fields: [] } : native(path, options);
  const result = await (await request('/providers/example')).json();
  assert.equal(result.surface, 'native'); assert.equal(calls.length, 2);
  assert.equal(calls[1].query, undefined);
  const saved = await request('/providers/example', 'PUT', { surface: 'native', values: { project: 'new' }, confirm: true });
  assert.equal(saved.status, 200); assert.equal(writes()[0].query, undefined);
});

test('undeclared secret fields and nested JSON or URL credentials never reach the form', async () => {
  respond = () => ({ fields: [
    { key: 'endpoint', kind: 'text', value: 'https://user:private-pass@example.test/' },
    { key: 'config', kind: 'json', value: '{"headers":{"Authorization":"private-bearer"}}' },
    { key: 'connection', kind: 'text', value: 'https://example.test/?api_key=private-key' },
    { key: 'credential_hint', kind: 'text', value: 'private-token' },
    { key: 'connection_json', kind: 'json', value: '{"endpoint":"https://user:private-pass@example.test/"}' },
  ] });
  const result = await (await request('/providers/example')).json();
  assert.ok(result.fields.every(field => field.kind === 'secret' && field.value === '' && field.isSet));
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('every selection, config save and dependency setup requires deliberate confirmation before native calls', async () => {
  for (const [route, method, body] of [
    ['/provider', 'PUT', { provider: '' }], ['/provider', 'PUT', { provider: 'example', confirm: 'true' }],
    ['/providers/example', 'PUT', { surface: 'declared', values: { project: 'changed' } }],
    ['/providers/example/setup', 'POST', {}],
  ]) assert.equal((await request(route, method, body)).status, 400);
  assert.equal(calls.length, 0);
});

test('save forwards only explicitly edited values to the native owner and preserves false, zero and clears', async () => {
  assert.equal((await save({ project: '', enabled: false, limit: 0, api_key: '', filters: '' })).status, 200);
  assert.deepEqual(writes(), [{ path: '/api/memory/providers/example/config', profile: 'coder', method: 'PUT',
    body: { values: { project: '', enabled: false, limit: 0, filters: '' } }, query: { surface: 'declared' } }]);
  assert.equal((await save({ api_key: 'new-synthetic-key' })).status, 200);
  assert.deepEqual(writes()[1].body, { values: { api_key: 'new-synthetic-key' } });
});

test('invalid edits, placeholder replays and changed form surfaces fail before any native write', async () => {
  for (const values of [
    { unknown: 'value' }, { project: { nested: 'object' } }, { project: ['array'] }, { api_key: '[stored credential]' },
    { filters: '{"authorization":"[stored credential]"}' }, { filters: 'invalid JSON' }, { filters: '123' }, { project: 'a'.repeat(64001) },
  ]) assert.equal((await save(values)).status, 400);
  assert.equal((await request('/providers/example', 'PUT', { surface: 'native', values: {}, confirm: true })).status, 409);
  assert.equal(writes().length, 0);
});

test('body/query profile overrides, native commands and traversal cannot escape the bot or provider boundary', async () => {
  for (const [route, method, body] of [
    ['/provider', 'PUT', { provider: 'example', profile: 'default', confirm: true }],
    ['/provider', 'PUT', { provider: '../example', confirm: true }],
    ['/providers/a%2Fb', 'PUT', { surface: 'declared', values: {}, confirm: true }],
    ['/providers/%ZZ', 'GET', undefined],
    ['/providers/example/setup', 'POST', { confirm: true, command: 'anything' }],
    ['/providers/example/setup', 'POST', { confirm: true, values: { api_key: 'unsaved' } }],
  ]) assert.equal((await request(route, method, body)).status, 400);
  assert.equal((await fetch(`${origin}/api/hermes/setup/memory?profile=coder&profile=default`)).status, 400);
  assert.equal(calls.length, 0);
});

test('selecting built-in or an existing provider uses the native selection owner without deleting data', async () => {
  for (const provider of ['', 'example']) {
    assert.equal((await request('/provider', 'PUT', { provider, confirm: true })).status, 200);
    assert.deepEqual(writes().at(-1), { path: '/api/memory/provider', profile: 'coder', method: 'PUT', body: { provider } });
  }
  assert.equal(writes().length, 2);
});

test('setup runs only the selected provider native operation, gives it time and strips output even on failure', async () => {
  const response = await request('/providers/example/setup', 'POST', { confirm: true });
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(result.results, [{ kind: 'external_install', name: 'Example CLI', status: 'failed', returncode: 1 }]);
  assert.deepEqual(writes(), [{ path: '/api/memory/providers/example/setup', profile: 'coder', method: 'POST', body: { values: {} }, timeoutMs: 300000 }]);
});

test('partial native save refusal is returned without activation retries or an invented success', async () => {
  respond = (path, options) => {
    if (options.method === 'PUT') throw new HermesError(400, 'Provider not ready.', 'HERMES_REQUEST_FAILED');
    return native(path, options);
  };
  assert.equal((await save({ project: 'new' })).status, 400); assert.equal(writes().length, 1);
  assert.equal(calls.some(call => call.path === '/api/memory/provider'), false);
});

test('revoked enrollment refuses memory reads, writes and setup before native access', async () => {
  revoked = true;
  assert.equal((await request()).status, 404);
  assert.equal((await save({ project: 'new' })).status, 404);
  assert.equal((await request('/providers/example/setup', 'POST', { confirm: true })).status, 404);
  assert.equal(calls.length, 0);
});

test('malformed or ambiguous native schemas return a protocol error without mutation', async () => {
  for (const fields of [null, [null], [{ key: 'x', kind: 'unknown' }], [{ key: 'x', kind: 'text', value: {} }],
    [{ key: 'x', kind: 'text' }, { key: 'x', kind: 'text' }]]) {
    respond = () => ({ fields });
    assert.equal((await request('/providers/example')).status, 502);
  }
  assert.equal(writes().length, 0);
});
