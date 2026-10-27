import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSavedProviders } from '../hermes-saved-providers.mjs';
import { MANAGED_ENV } from '../hermes-routes.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'hob-provider-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'profiles', 'writer'), { recursive: true });
  await writeFile(path.join(home, '.env'), 'native-owned-test-state');
  const secret = 'private-synthetic-provider-key', calls = [], active = new Set(['default', 'writer']);
  const env = { default: { OPENROUTER_API_KEY: { is_set: true, redacted_value: 'private-prefix', provider: 'openrouter', provider_label: 'OpenRouter', is_password: true }, HOB_SECRET: { is_set: true }, SEARCH_API_KEY: { is_set: true } }, writer: {} };
  const state = { probe: { ok: true, reachable: true, message: secret }, fail: '', revealKey: 'OPENROUTER_API_KEY' };
  const client = {
    async credentialBinding(profile) { if (!active.has(profile)) throw Object.assign(new Error('Removed bot'), { status: 404 }); },
    async dashboard(route, options = {}) {
      const { profile = 'default', method = 'GET', body } = options;
      calls.push({ route, ...options });
      if (state.fail === `${profile}:${route}`) throw new Error(secret);
      if (route === '/api/env' && method === 'GET') return env[profile];
      if (route === '/api/model/options') return { providers: [
        { slug: 'openrouter', name: 'OpenRouter', ...(profile === 'writer' ? { key_env: 'OPENROUTER_API_KEY' } : {}), authenticated: profile === 'default' },
        { slug: 'managed', key_env: 'HOB_SECRET' }, { slug: 'oauth', authenticated: true },
      ] };
      if (route === '/api/env/reveal') { await state.onReveal?.(); return { key: state.revealKey, value: secret }; }
      if (route === '/api/providers/validate') return state.probe;
      if (route === '/api/env' && method === 'PUT') { env[profile][body.key] = { is_set: true }; return { ok: true, value: secret }; }
      throw new Error(`Unexpected route ${route}`);
    },
  };
  const bots = { roster: () => [...active].map(name => ({ name, state: 'active' })) };
  const service = createSavedProviders(client, bots, { home, managedEnv: MANAGED_ENV });
  const row = async () => (await service.list('writer')).connections[0];
  return { home, env, state, active, calls, service, secret, row };
}

test('saved provider cards project metadata only and connect through native key ownership without model changes', async t => {
  const f = await fixture(t), row = await f.row();
  assert.equal(row.name, 'OpenRouter'); assert.equal(row.configured, false); assert.equal(row.verifiedAt, null);
  assert.equal(JSON.stringify(row).includes('private-'), false);
  assert.equal(f.calls.some(call => call.route === '/api/env/reveal'), false);
  assert.equal((await f.service.list('default')).connections[0].configured, true);
  const result = await f.service.operate('writer', { id: row.id, action: 'connect' });
  assert.deepEqual(result, { ok: true, connected: true }); assert.equal(JSON.stringify(result).includes(f.secret), false);
  const writes = f.calls.filter(call => call.method === 'PUT');
  assert.deepEqual(writes, [{ route: '/api/env', profile: 'writer', method: 'PUT', body: { key: 'OPENROUTER_API_KEY', value: f.secret, profile: 'writer' } }]);
  assert.equal(f.calls.some(call => /model\/set|\/api\/config/.test(call.route)), false);
  assert.equal((await f.row()).configured, true);
  const reveals = f.calls.filter(call => call.route === '/api/env/reveal').length;
  await assert.rejects(f.service.operate('writer', { id: row.id, action: 'connect' }), error => error.status === 409);
  assert.equal(f.calls.filter(call => call.route === '/api/env/reveal').length, reveals);
});

test('only actual provider acceptance verifies; edits and unavailable probes invalidate proof without exposing native messages', async t => {
  const f = await fixture(t), row = await f.row();
  const result = await f.service.operate('writer', { id: row.id, action: 'verify' });
  assert.equal(result.status, 'verified'); assert.equal(JSON.stringify(result).includes(f.secret), false);
  assert.ok((await f.row()).verifiedAt);
  await writeFile(path.join(f.home, '.env'), 'changed-native-credential-state');
  assert.equal((await f.row()).verifiedAt, null);
  for (const [probe, status] of [[{ ok: true, reachable: false }, 'unverified'], [{ ok: false, reachable: true }, 'rejected'], [{ ok: false, reachable: false }, 'unverified']]) {
    f.state.probe = { ...probe, message: f.secret };
    const response = await f.service.operate('writer', { id: row.id, action: 'verify' });
    assert.equal(response.status, status); assert.equal(JSON.stringify(response).includes(f.secret), false);
    assert.equal((await f.row()).verifiedAt, null);
  }
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

test('forged references, removed sources, managed keys and caller-supplied secrets cannot become saved connections', async t => {
  const f = await fixture(t), row = await f.row();
  for (const input of [{ id: row.id, action: 'connect', value: f.secret }, { id: 'HOB_SECRET', action: 'connect' }, { id: row.id, action: 'delete' }]) {
    await assert.rejects(f.service.operate('writer', input), error => error.status === 400);
  }
  assert.equal((await f.service.list('writer')).connections.length, 1);
  f.active.delete('default');
  await assert.rejects(f.service.operate('writer', { id: row.id, action: 'connect' }), error => error.status === 404);
  assert.equal(f.calls.filter(call => call.route === '/api/env/reveal').length, 0);
});

test('partial discovery reports unavailable bots and mismatched native reveal never writes a target key', async t => {
  const f = await fixture(t), row = await f.row();
  f.state.fail = 'default:/api/model/options';
  assert.deepEqual((await f.service.list('writer')).unavailableProfiles, ['Main']);
  f.state.fail = ''; f.state.revealKey = 'HOB_SECRET';
  await assert.rejects(f.service.operate('writer', { id: row.id, action: 'connect' }), error => error.status === 502);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

test('revocation during a native read and concurrent credential writes cannot overwrite the target', async t => {
  const f = await fixture(t), row = await f.row();
  let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  f.state.onReveal = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const connecting = f.service.operate('writer', { id: row.id, action: 'connect' });
  await reading;
  await assert.rejects(f.service.exclusive('writer', () => { throw new Error('Must not run'); }), error => error.status === 409);
  f.active.delete('writer'); release();
  await assert.rejects(connecting, error => error.status === 404);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});
