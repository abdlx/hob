import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HermesBotRegistry, HermesBots } from '../hermes-bots.mjs';
import { HermesClient } from '../hermes-client.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-bot-registry-'));
  const mainApiKey = randomBytes(32).toString('hex');
  const options = { stateDir: root, mainApiKey };
  try { await run({ root, mainApiKey, options, registry: await HermesBotRegistry.open(options) }); }
  finally {
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith('hob-bot-registry-'));
    await rm(root, { recursive: true, force: true });
  }
}

function native() {
  const profiles = [{ name: 'default' }, { name: 'unregistered' }];
  const calls = [];
  let rejectCredentials = false;
  return { profiles, calls, set rejectCredentials(value) { rejectCredentials = value; },
    client: { async dashboard(route, options = {}) {
      calls.push({ route, ...options });
      if (route === '/api/profiles' && options.method === 'POST') {
        profiles.push({ name: options.body.name }); return { ok: true, name: options.body.name };
      }
      if (route === '/api/profiles') return { profiles };
      if (route === '/api/env' && rejectCredentials) throw new Error('synthetic credential failure');
      return { ok: true };
    } },
  };
}

test('fresh roster contains only Main and does not enroll discovered native profiles', async () => fixture(async ({ registry, root }) => {
  const upstream = native();
  const bots = new HermesBots({ registry, client: upstream.client, workspaceRoot: path.join(root, 'work') });
  assert.deepEqual((await bots.list()).profiles.map(item => item.name), ['default']);
  assert.throws(() => registry.token('unregistered'), /not in your dashboard/);
  assert.equal(JSON.stringify(registry), '{}');
  assert.ok(!JSON.stringify(await bots.list()).includes('apiKey'));
}));

test('boot reconciliation binds pre-existing active bots and isolates failures', async () => fixture(async ({ registry, root }) => {
  const profiles = [{ name: 'default' }, { name: 'research' }, { name: 'pending' }];
  const configs = new Map();
  const ensured = [];
  const failing = new Set();
  const client = { async dashboard(route, request = {}) {
    if (route.includes('?')) throw new Error('profile must use the bound selector');
    if (route === '/api/profiles') return { profiles };
    if (route.startsWith('/api/config') && request.method === 'PUT') {
      const previous = configs.get(request.profile) ?? {};
      configs.set(request.profile, {
        ...previous,
        ...request.body.config,
        browser: { ...previous.browser, ...request.body.config.browser },
      });
      return { ok: true };
    }
    if (route.startsWith('/api/config')) {
      // Mirror the real client: the profile is a bound option, never a query
      // embedded in the path (the real client rejects that before sending).
      if (route.includes('?')) throw new Error('profile must use the bound selector');
      const profile = request.profile ?? 'default';
      return configs.get(profile) ?? {};
    }
    return { ok: true };
  } };
  const browser = {
    async record(name) {
      const ports = { default: 32100, research: 32101, pending: 32102 };
      return { gatewayPort: ports[name], gatewayToken: name.padEnd(32, '0') };
    },
    async ensureEndpoint(name) {
      if (failing.has(name)) throw new Error(`synthetic bind failure for ${name}`);
      ensured.push(name);
    },
  };

  // Both bots already existed before this process: one active and bound by hand,
  // one active but never pointed at a managed browser, one still in setup.
  await registry.reserve('research');
  await registry.update('research', { state: 'active', nativeCreated: true });
  await registry.reserve('pending');
  const bots = new HermesBots({ registry, client, workspaceRoot: path.join(root, 'work'), browser });

  failing.add('research');
  const first = await bots.reconcileBrowsers();
  assert.deepEqual(first.configured, ['default']);
  assert.deepEqual(first.failed.map(item => item.name), ['research']);
  assert.equal(configs.has('research'), false, 'a failed bind must not write a partial profile');

  failing.clear();
  const second = await bots.reconcileBrowsers();
  assert.deepEqual(second.configured, ['research']);
  assert.deepEqual(second.unchanged, ['default']);
  assert.deepEqual(second.failed, []);
  assert.deepEqual(configs.get('research').browser, {
    backend: 'off',
    cdp_url: 'http://127.0.0.1:32101/' + 'research'.padEnd(32, '0'),
  });

  // Idempotent after an upgrade: the next boot does not rewrite healthy profiles.
  const third = await bots.reconcileBrowsers();
  assert.deepEqual(third.configured, []);
  assert.deepEqual(third.unchanged.sort(), ['default', 'research']);
  assert.equal(ensured.includes('pending'), false, 'a bot in setup must stay unbound');
  assert.equal(configs.has('pending'), false);
}));

test('configureBrowser binds the named profile through the real dashboard client', async () => fixture(async ({ registry, root, mainApiKey }) => {
  await registry.reserve('research');
  await registry.update('research', { state: 'active', nativeCreated: true });
  const calls = [];
  let stored = {};
  const client = new HermesClient({
    apiKey: mainApiKey,
    dashboardToken: 'synthetic-settings-token',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method, body: options.body });
      if (options.method === 'PUT') {
        stored = JSON.parse(options.body).config;
        return Response.json({ ok: true });
      }
      // `/api/config` answers with the settings object itself, not a
      // `{ config }` envelope. An envelope-shaped fake let the binding read
      // past the real response and report every profile as unbound.
      return Response.json(stored);
    },
  });
  const token = 'a'.repeat(32);
  const browser = {
    async record() { return { gatewayPort: 32101, gatewayToken: token }; },
    async ensureEndpoint() {},
  };
  const bots = new HermesBots({ registry, client, workspaceRoot: path.join(root, 'work'), browser });

  // Before the fix this GET embedded `?profile=` in the path, which the real
  // client rejects before any request is sent. The fake clients in the other
  // tests parsed the query themselves, so they could not catch it.
  assert.equal(await bots.configureBrowser('research'), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/api/config?profile=research');
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].url, 'http://127.0.0.1:8080/api/config?profile=research');
  assert.deepEqual(JSON.parse(calls[1].body), {
    profile: 'research',
    config: { browser: { backend: 'off', cdp_url: `http://127.0.0.1:32101/${token}` } },
  });
  // Reading the profile's own settings is what makes binding idempotent. If the
  // response shape is misread, this second call writes the same profile again.
  assert.equal(await bots.configureBrowser('research'), false);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);

  const bound = await bots.browserBinding('research');
  assert.deepEqual(bound, {
    profile: 'research',
    configured: true,
    backend: 'off',
    configuredPort: 32101,
    expectedPort: 32101,
    envOverride: Boolean(process.env.BROWSER_CDP_URL),
    reason: 'bound',
  });
  assert.ok(!JSON.stringify(bound).includes(token), 'the diagnostic report must not leak the gateway token');

  stored = { browser: { backend: 'browser-use', cdp_url: `http://127.0.0.1:32101/${'b'.repeat(32)}` } };
  const stale = await bots.browserBinding('research');
  assert.equal(stale.configured, false);
  assert.equal(stale.backend, 'browser-use');
  assert.equal(stale.reason, 'backend');
  assert.equal(stale.configuredPort, 32101);
}));

test('operator-created bot gets independent credentials and workspace through native owners before activation', async () => fixture(async ({ registry, root, mainApiKey, options }) => {
  const upstream = native();
  const bots = new HermesBots({ registry, client: upstream.client, workspaceRoot: path.join(root, 'work') });
  assert.deepEqual(await bots.create({ name: 'research', soul: 'Research only.' }), { ok: true, name: 'research', state: 'active' });
  const settings = upstream.calls.find(call => call.route === '/api/config');
  assert.deepEqual(settings.body, { profile: 'research', config: { terminal: { cwd: path.join(root, 'work', 'bots', 'research') }, auth: { adopt_external_logins: false } } });
  const credential = upstream.calls.find(call => call.route === '/api/env');
  assert.equal(credential.profile, 'research');
  assert.equal(credential.body.key, 'API_SERVER_KEY');
  assert.equal(credential.body.value, registry.token('research'));
  assert.notEqual(credential.body.value, mainApiKey);
  assert.equal((await HermesBotRegistry.open(options)).token('research'), registry.token('research'));
  assert.ok(!JSON.stringify(await bots.list()).includes(credential.body.value));
}));

test('a named bot called main cannot reuse the Main bot’s working directory', async () => fixture(async ({ registry, root }) => {
  const upstream = native();
  const bots = new HermesBots({ registry, client: upstream.client, workspaceRoot: path.join(root, 'work') });
  await bots.create({ name: 'main' });
  const config = upstream.calls.find(call => call.route === '/api/config').body.config;
  assert.equal(config.terminal.cwd, path.join(root, 'work', 'bots', 'main'));
  assert.notEqual(config.terminal.cwd, path.join(root, 'work', 'main'));
}));

test('partial native setup stays pending across restart and resumes without recreating a profile', async () => fixture(async ({ registry, root, options }) => {
  const upstream = native(); upstream.rejectCredentials = true;
  let bots = new HermesBots({ registry, client: upstream.client, workspaceRoot: path.join(root, 'work') });
  await assert.rejects(bots.create({ name: 'research' }), /synthetic credential failure/);
  assert.throws(() => registry.token('research'), /Finish this bot/);
  const restored = await HermesBotRegistry.open(options);
  upstream.rejectCredentials = false;
  bots = new HermesBots({ registry: restored, client: upstream.client, workspaceRoot: path.join(root, 'work') });
  await bots.finishSetup('research');
  assert.match(restored.token('research'), /^[a-f0-9]{64}$/);
  assert.equal(upstream.calls.filter(call => call.route === '/api/profiles' && call.method === 'POST').length, 1);
}));

test('unconfirmed creation requires deliberate operator confirmation and never recreates a missing profile', async () => fixture(async ({ registry, root }) => {
  const upstream = native();
  const bots = new HermesBots({ registry, client: upstream.client, workspaceRoot: path.join(root, 'work') });
  await registry.reserve('research');
  await assert.rejects(bots.finishSetup('research'), /Explicitly confirm/);
  await assert.rejects(bots.finishSetup('research', { confirmExisting: true }), /native profile is missing/);
  assert.equal(upstream.calls.some(call => call.method === 'POST'), false);
  upstream.profiles.push({ name: 'research' });
  await bots.finishSetup('research', { confirmExisting: true });
  assert.match(registry.token('research'), /^[a-f0-9]{64}$/);
}));

test('concurrent creation reserves a name once and cannot silently adopt an external profile', async () => fixture(async ({ registry, root }) => {
  const upstream = native();
  const bots = new HermesBots({ registry, client: upstream.client, workspaceRoot: path.join(root, 'work') });
  await assert.rejects(bots.create({ name: 'unregistered' }), /already uses that name/);
  const results = await Promise.allSettled([bots.create({ name: 'research' }), bots.create({ name: 'research' })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(upstream.calls.filter(call => call.route === '/api/profiles' && call.method === 'POST').length, 1);
}));

test('revocation persists before native deletion and blocks subsequent setup and transport', async () => fixture(async ({ registry, root, options }) => {
  const upstream = native();
  const bots = new HermesBots({ registry, client: upstream.client, workspaceRoot: path.join(root, 'work') });
  await bots.create({ name: 'research' });
  await bots.remove('research');
  await bots.remove('research');
  assert.throws(() => registry.token('research'), /not in your dashboard/);
  await assert.rejects(bots.finishSetup('research'), /not in your dashboard/);
  assert.throws(() => (registry.setup('research')), /not in your dashboard/);
  assert.equal(registry.list().some(item => item.name === 'research'), false);
  const restored = await HermesBotRegistry.open(options);
  assert.throws(() => restored.token('research'), /not in your dashboard/);
  await assert.rejects(bots.remove('default'), /cannot be deleted/);
}));

test('corrupt registry is preserved and cannot fall back to native discovery or new authority', async () => fixture(async ({ root, options }) => {
  const filename = path.join(root, 'bots.json');
  await writeFile(filename, '{broken');
  await assert.rejects(HermesBotRegistry.open(options));
  assert.equal(await readFile(filename, 'utf8'), '{broken');
}));

test('revocation while setup is in flight prevents credential provisioning and reactivation', async () => fixture(async ({ registry, root }) => {
  const upstream = native();
  let reachedConfig, releaseConfig;
  const waiting = new Promise(resolve => { reachedConfig = resolve; });
  const blocked = new Promise(resolve => { releaseConfig = resolve; });
  const dashboard = upstream.client.dashboard;
  upstream.client.dashboard = async (route, options) => {
    const result = await dashboard(route, options);
    if (route === '/api/config') { reachedConfig(); await blocked; }
    return result;
  };
  const bots = new HermesBots({ registry, client: upstream.client, workspaceRoot: path.join(root, 'work') });
  const setup = bots.create({ name: 'research' });
  await waiting;
  await bots.remove('research');
  releaseConfig();
  await assert.rejects(setup, /not in your dashboard/);
  assert.equal(upstream.calls.some(call => call.route === '/api/env'), false);
  assert.throws(() => registry.token('research'), /not in your dashboard/);
}));

test('transport binds each enrolled profile credential and refuses unknown profiles before network access', async () => fixture(async ({ registry, mainApiKey }) => {
  await registry.reserve('research'); await registry.update('research', { state: 'active', nativeCreated: true });
  const calls = [];
  const client = new HermesClient({ apiKey: mainApiKey, dashboardToken: 'synthetic-settings-token',
    profileAccess: profile => registry.token(profile), fetchImpl: async (url, options) => {
      calls.push({ url, ...options }); return Response.json({ ok: true });
    } });
  await client.runtime('/api/sessions', { profile: 'research' });
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + registry.token('research'));
  assert.notEqual(calls[0].headers.Authorization, 'Bearer ' + mainApiKey);
  await assert.rejects(client.runtime('/api/sessions', { profile: 'unknown' }), /not in your dashboard/);
  await assert.rejects(client.dashboard('/api/config', { profile: 'unknown' }), /not in your dashboard/);
  assert.equal(calls.length, 1);
}));
