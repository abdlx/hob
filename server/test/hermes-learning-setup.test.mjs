import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHermesSetupRoutes } from '../hermes-setup.mjs';
import { HermesError } from '../hermes-client.mjs';

let server, origin, respond, revoked;
const calls = [];
const defaults = { memory: { memory_enabled: true, user_profile_enabled: true, write_approval: false },
  skills: { write_approval: false }, auxiliary: { background_review: { enabled: true } } };
before(async () => {
  const route = createHermesSetupRoutes({
    credentialBinding() { if (revoked) throw new HermesError(404, 'Revoked bot.'); return 'binding'; },
    async dashboard(path, options) { calls.push({ path, ...options }); return respond(path, options); },
  });
  server = http.createServer(async (req, res) => {
    const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const body = async req => { const chunks = []; for await (const part of req) chunks.push(part); return JSON.parse(Buffer.concat(chunks).toString()); };
    try { await route(req, res, new URL(req.url, 'http://local'), { json, body }); }
    catch (error) { json(res, error.status || 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  calls.length = 0; revoked = false;
  respond = (_path, options) => options.query ? {} : defaults;
});
const request = (method = 'GET', value) => fetch(origin + '/api/hermes/setup/learning?profile=coder', {
  method, ...(value === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
});
const writes = () => calls.filter(call => call.method);

test('learning status uses native effective values, distinguishes missing saved values and never writes on read', async () => {
  const data = await (await request()).json();
  assert.deepEqual(data.controls.memoryEnabled, { value: true, source: 'default' });
  assert.deepEqual(data.controls.skillApproval, { value: false, source: 'default' });
  assert.deepEqual(calls, [{ path: '/api/config', profile: 'coder' }, { path: '/api/config', profile: 'coder', query: { include_defaults: false } }]);
  assert.equal(writes().length, 0);
});

test('all five independent native choices remain explicit booleans without inventing a combined learning mode', async () => {
  assert.equal((await request('PUT', { confirm: true, changes: { memoryEnabled: false, userProfileEnabled: true,
    memoryApproval: true, skillApproval: false, backgroundReview: false } })).status, 200);
  assert.deepEqual(writes(), [{ path: '/api/config', profile: 'coder', method: 'PUT', body: { profile: 'coder', config: {
    memory: { memory_enabled: false, user_profile_enabled: true, write_approval: true }, skills: { write_approval: false }, auxiliary: { background_review: { enabled: false } },
  } } }]);
});

test('a single learning change sends a minimal patch and no other permissions or provider fields', async () => {
  assert.equal((await request('PUT', { changes: { skillApproval: true }, confirm: true })).status, 200);
  assert.deepEqual(writes()[0].body, { profile: 'coder', config: { skills: { write_approval: true } } });
});

test('saved false remains false and malformed or missing effective values are never silently enabled', async () => {
  respond = (_path, options) => options.query ? { memory: { memory_enabled: false, write_approval: 'false' }, skills: { write_approval: 'unexpected' } }
    : { memory: { memory_enabled: false, write_approval: false }, skills: { write_approval: false } };
  const data = await (await request()).json();
  assert.deepEqual(data.controls.memoryEnabled, { value: false, source: 'saved' });
  for (const key of ['memoryApproval', 'skillApproval', 'backgroundReview', 'userProfileEnabled']) assert.deepEqual(data.controls[key], { value: null, source: 'invalid' });
  assert.equal(writes().length, 0);
});

test('settings responses project only known values, never native credentials or unrelated metadata', async () => {
  respond = (_path, options) => ({ ...defaults, model: 'private-model', api_key: 'private-key',
    memory: { ...defaults.memory, provider: 'private-provider', note: 'private-note' } });
  assert.equal(JSON.stringify(await (await request()).json()).includes('private'), false);
});

test('malformed saved parent sections are not misreported as inherited defaults', async () => {
  respond = (_path, options) => options.query ? { memory: null, auxiliary: { background_review: 'broken' } } : defaults;
  const result = await (await request()).json();
  for (const key of ['memoryEnabled', 'userProfileEnabled', 'memoryApproval', 'backgroundReview']) assert.deepEqual(result.controls[key], { value: null, source: 'invalid' });
  assert.deepEqual(result.controls.skillApproval, { value: false, source: 'default' });
});

test('unconfirmed, ambiguous, unknown and profile-confused writes are refused before native calls', async () => {
  for (const value of [
    { changes: { skillApproval: false } }, { confirm: 'true', changes: { skillApproval: false } }, { confirm: true, changes: {} },
    { confirm: true, changes: null }, { confirm: true, changes: [] }, { confirm: true, changes: { skillApproval: 'false' } },
    { confirm: true, changes: { autonomousMode: 'auto' } }, { confirm: true, changes: { 'skills.write_approval': false } },
    { confirm: true, changes: { skillApproval: false }, profile: 'default' },
    { confirm: true, changes: { skillApproval: false }, command: '/skills approval off' },
    JSON.parse('{"confirm":true,"changes":{"__proto__":true}}'),
  ]) assert.equal((await request('PUT', value)).status, 400);
  assert.equal(calls.length, 0);
});

test('native refusal is not retried, reset to defaults or reported as a successful save', async () => {
  respond = () => { throw new HermesError(409, 'Conflict.', 'HERMES_REQUEST_FAILED'); };
  assert.equal((await request('PUT', { changes: { memoryApproval: true }, confirm: true })).status, 409);
  assert.equal(writes().length, 1); assert.equal(calls.length, 1);
});

test('revoked enrollment blocks learning reads and writes before native access', async () => {
  revoked = true;
  assert.equal((await request()).status, 404);
  assert.equal((await request('PUT', { changes: { backgroundReview: true }, confirm: true })).status, 404);
  assert.equal(calls.length, 0);
});

test('malformed native config documents fail visibly without supplying application defaults', async () => {
  for (const result of [null, [], 'not config']) {
    respond = () => result;
    assert.equal((await request()).status, 502);
  }
  assert.equal(writes().length, 0);
});
