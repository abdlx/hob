import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, hashToken } from '../../portal/src/store.mjs';
import { provisionHobBot } from '../../portal/src/hob.mjs';
import { toolByName } from '../../portal/src/tools.mjs';
import { NativePortal } from '../native-portal.mjs';
import { createAgentComputerRoutes } from '../agent-computer-routes.mjs';
import { HermesBotNetwork } from '../hermes-bot-network.mjs';
import { CredentialVault } from '../../portal/src/credential-vault.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-native-portal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'private', 'portal');
  const workspaceRoot = path.join(root, 'workspaces');
  const store = new Store(home, { workspaceRoot, mainWorkspace: path.join(root, 'custom-main') });
  return { root, home, store, workspaceRoot };
}
const value = result => JSON.parse(result.content[0].text);

test('vault routes list assigned bots and store encrypted credentials under only the selected bot', async t => {
  const { root, home, store } = await fixture(t);
  const alpha = provisionHobBot(store, 'alpha').profile;
  const beta = provisionHobBot(store, 'beta').profile;
  const vault = new CredentialVault(store);
  const hermesHome = path.join(root, 'hermes');
  for (const profile of ['alpha', 'beta']) {
    await mkdir(path.join(hermesHome, 'profiles', profile), { recursive: true });
    await writeFile(path.join(hermesHome, 'profiles', profile, 'config.yaml'), JSON.stringify({ mcp_servers: {
      portal: { url: 'http://127.0.0.1:9879/mcp', bearer_token: 'test-bot-key', enabled: profile === 'alpha' },
    } }));
  }
  const owner = (await readFile(path.join(home, 'owner-token.txt'), 'utf8')).trim();
  let calls = 0;
  const portal = new NativePortal({ home, hermesHome, url: 'http://127.0.0.1:9879', client: {}, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(init.headers.Authorization, 'Bearer ' + owner);
    const parts = new URL(url).pathname.split('/');
    const selected = store.profileBySlug(parts[4]);
    if (init.method === 'POST') return Response.json({ item: { ...vault.add(selected, JSON.parse(init.body)), password: 'must-never-return' } });
    if (init.method === 'DELETE') {
      try { return Response.json(vault.remove(selected, parts[5])); }
      catch { return Response.json({ error: 'private service details' }, { status: 400 }); }
    }
    return Response.json({ items: vault.list(selected).map(item => ({ ...item, password: 'must-never-return' })) });
  } });
  const routes = createAgentComputerRoutes({ hermesHome, env: {}, nativePortal: portal,
    knownBot: profile => ['default', 'alpha', 'beta'].includes(profile), authenticated: req => req.signedIn,
    roster: () => [{ name: 'alpha', displayName: 'Developer', state: 'active' }, { name: 'beta', state: 'active' }],
    assertOrigin: req => { if (!req.trusted) throw new Error('Bad origin'); },
  });
  t.after(() => routes.close());
  const request = async (suffix, method = 'GET', payload, profile = 'alpha', extra = {}) => {
    let result;
    await routes.route({ method, signedIn: true, trusted: true, ...extra }, {}, new URL('http://hob/api/hermes/portal/vault/' + suffix + '?profile=' + profile), {
      body: async () => payload, json: (_res, status, body) => { result = { status, body }; },
    });
    return result;
  };
  assert.deepEqual((await request('bots')).body.bots, [{ name: 'alpha', displayName: 'Developer' }]);
  const login = { name: 'Work login', origin: 'https://example.com/login', username: 'bot@example.com', password: 'test-secret-DO-NOT-RETURN' };
  await assert.rejects(request('items', 'POST', login, 'alpha', { signedIn: false }), { status: 401 });
  await assert.rejects(request('items', 'POST', login, 'alpha', { trusted: false }), /Bad origin/);
  await assert.rejects(request('items', 'POST', login, 'beta'), { status: 409 });
  await assert.rejects(request('items', 'POST', { ...login, profile: 'beta' }), { status: 400 });
  await assert.rejects(request('items', 'POST', { ...login, origin: 'http://example.com' }), { status: 400 });
  assert.equal(calls, 0);
  const created = await request('items', 'POST', login);
  assert.equal(created.status, 201);
  const id = created.body.item.id;
  assert.equal(created.body.item.origin, 'https://example.com');
  assert.equal(JSON.stringify(created).includes('password'), false);
  assert.equal(JSON.stringify(await request('items')).includes('must-never-return'), false);
  assert.deepEqual(vault.getLogin(alpha, id, 'https://example.com/login'), { username: login.username, password: login.password });
  assert.deepEqual(vault.list(beta), []);
  const encrypted = await readFile(path.join(home, 'credential-vault', alpha.id + '.enc'), 'utf8');
  assert.equal(encrypted.includes(login.password), false);
  assert.equal(encrypted.includes(login.username), false);
  await request('items/' + id, 'DELETE');
  assert.deepEqual(vault.list(alpha), []);
});

test('vault supports full-length Hermes bot identities and refuses another profile credential', async t => {
  const { store } = await fixture(t);
  const first = provisionHobBot(store, 'a'.repeat(64)).profile;
  const second = provisionHobBot(store, 'b'.repeat(64)).profile;
  const vault = new CredentialVault(store);
  const item = vault.add(first, { name: 'Login', origin: 'https://example.com', username: 'user', password: 'secret' });
  assert.equal(vault.list(first)[0].id, item.id);
  assert.throws(() => vault.remove(second, item.id), /not found in this profile/);
  assert.throws(() => vault.getLogin(second, item.id, 'https://example.com'), /not found in this profile/);
  assert.equal(vault.list(first).length, 1);
});

test('Portal tools read and write the exact HOB directories, with no second workspace', async t => {
  const { root, store, workspaceRoot } = await fixture(t);
  const alpha = provisionHobBot(store, 'alpha');
  const beta = provisionHobBot(store, 'beta');
  assert.equal(store.profileWorkspace('default'), path.join(root, 'custom-main'));
  assert.equal(alpha.workspace, path.join(workspaceRoot, 'bots', 'alpha'));
  const ctx = { store, token: store.tokenByHash(hashToken(alpha.plaintext)) };
  await toolByName.get('fs_write').run(ctx, { path: 'shared.txt', content: 'from Portal' });
  assert.equal(await readFile(path.join(alpha.workspace, 'shared.txt'), 'utf8'), 'from Portal');
  await writeFile(path.join(alpha.workspace, 'shared.txt'), 'from HOB');
  assert.equal(value(await toolByName.get('fs_read').run(ctx, { path: 'shared.txt' })).content, 'from HOB');
  assert.equal(store.profileDownloads('alpha'), path.join(alpha.workspace, 'downloads'));
  await assert.rejects(access(path.join(store.profileHome('alpha'), 'workspace')), { code: 'ENOENT' });
  await assert.rejects(toolByName.get('fs_read').run(ctx, { path: '../beta/shared.txt' }), /escapes/);
  await assert.rejects(toolByName.get('fs_write').run(ctx, { profile: 'beta', path: 'x', content: 'wrong bot' }), /bound to profile/);
  await assert.rejects(access(path.join(beta.workspace, 'x')), { code: 'ENOENT' });
});

test('provisioning survives retries and restart without rotating tokens, cookies or files', async t => {
  const { home, store, workspaceRoot } = await fixture(t);
  const slug = 'b'.repeat(64);
  const first = provisionHobBot(store, slug);
  const again = provisionHobBot(store, slug);
  assert.equal(first.plaintext, again.plaintext);
  assert.equal(first.profile.id, again.profile.id);
  await writeFile(path.join(store.browserProfileDir(slug), '..', 'cookie-marker'), 'preserved');
  const restarted = new Store(home, { workspaceRoot });
  const after = provisionHobBot(restarted, slug);
  assert.equal(after.plaintext, first.plaintext);
  assert.equal(await readFile(path.join(restarted.profileHome(slug), 'cookie-marker'), 'utf8'), 'preserved');
  restarted.revokeToken(restarted.tokenByHash(hashToken(first.plaintext)).id);
  const reassigned = provisionHobBot(restarted, slug);
  assert.notEqual(reassigned.plaintext, first.plaintext);
  assert.equal(reassigned.profile.id, first.profile.id);
  assert.throws(() => provisionHobBot(store, '../alpha'), /Invalid HOB profile/);
});

test('corrupt Portal state is preserved and refused', async t => {
  const { home, store, workspaceRoot } = await fixture(t);
  await writeFile(store.storeFile, '{broken');
  assert.throws(() => new Store(home, { workspaceRoot }), /unreadable/);
  assert.equal(await readFile(store.storeFile, 'utf8'), '{broken');
});

test('wake and sleep manage only the token-bound profile and report real browser state', async t => {
  const { store } = await fixture(t);
  const { plaintext } = provisionHobBot(store, 'alpha');
  const calls = []; let started = false;
  const ctx = { store, token: store.tokenByHash(hashToken(plaintext)), browser: {
    status: async profile => { calls.push(['status', profile.slug]); return { started }; },
    ensureHeaded: async profile => { calls.push(['wake', profile.slug]); started = true; },
    close: async profile => { calls.push(['sleep', profile.slug]); started = false; },
  } };
  assert.equal(value(await toolByName.get('computer_list').run(ctx))[0].state, 'sleeping');
  await toolByName.get('computer_wake').run(ctx, { computer: 'portal' });
  assert.equal(value(await toolByName.get('computer_status').run(ctx, {})).state, 'ready');
  await toolByName.get('computer_sleep').run(ctx, {});
  assert.equal(value(await toolByName.get('computer_status').run(ctx, {})).state, 'sleeping');
  assert.ok(calls.every(call => call[1] === 'alpha'));
  await assert.rejects(toolByName.get('computer_wake').run(ctx, { profile: 'default' }), /bound to profile/);
});

test('native assignment writes only the selected MCP binding; unassign revokes before disabling', async t => {
  const { root, home, store } = await fixture(t);
  const hermesHome = path.join(root, 'hermes');
  await mkdir(path.join(hermesHome, 'profiles', 'alpha'), { recursive: true });
  const filename = path.join(hermesHome, 'profiles', 'alpha', 'config.yaml');
  const existing = { mcp_servers: { other: { url: 'https://other.test/mcp' } }, terminal: { cwd: store.profileWorkspace('alpha') } };
  await writeFile(filename, JSON.stringify(existing));
  const writes = [], calls = [];
  const portal = new NativePortal({ home, url: 'http://127.0.0.1:9879', hermesHome,
    client: { dashboard: async (route, options) => { writes.push({ route, ...options });
      await writeFile(filename, JSON.stringify({ ...existing, mcp_servers: { ...existing.mcp_servers, ...options.body.config.mcp_servers } })); } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.headers.Authorization, 'Bearer ' + (await readFile(path.join(home, 'owner-token.txt'), 'utf8')).trim());
      if (options.method === 'PUT') return Response.json(provisionHobBot(store, 'alpha'));
      for (const tok of store.tokensForProfile(store.profileBySlug('alpha').id)) store.revokeToken(tok.id);
      return Response.json({ ok: true });
    },
  });
  await Promise.all([portal.assign('alpha'), portal.assign('alpha')]);
  assert.equal(writes[0].profile, 'alpha');
  assert.deepEqual(Object.keys(writes[0].body.config.mcp_servers), ['portal']);
  const key = writes[0].body.config.mcp_servers.portal.bearer_token;
  assert.equal(writes[1].body.config.mcp_servers.portal.bearer_token, key);
  await portal.unassign('alpha');
  assert.equal(store.tokenByHash(hashToken(key)).revoked, true);
  assert.equal(writes.at(-1).body.config.mcp_servers.portal.enabled, false);
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(JSON.stringify(await portal.assign('alpha')).includes('portal_'), false);
});

test('assignment routes enforce login, origin, bot scope and refuse custom filesystem paths', async t => {
  const assigned = [];
  const routes = createAgentComputerRoutes({ authenticated: req => req.signedIn,
    knownBot: profile => profile === 'alpha',
    assertOrigin: req => { if (!req.trusted) throw new Error('Untrusted origin'); },
    nativePortal: { assign: async profile => { assigned.push(profile); return { ok: true }; } },
  });
  t.after(() => routes.close());
  const request = async (req, payload, query = 'alpha') => {
    let result;
    await routes.route({ method: 'POST', ...req }, {}, new URL('http://hob/api/hermes/portal/assign?profile=' + query),
      { json: (_res, status, body) => { result = { status, body }; }, body: async () => payload });
    return result;
  };
  await assert.rejects(request({}, {}), { status: 401 });
  await assert.rejects(request({ signedIn: true }, {}), /Untrusted/);
  await assert.rejects(request({ signedIn: true, trusted: true }, {}, 'missing'), { status: 404 });
  await assert.rejects(request({ signedIn: true, trusted: true }, { workspace: '/tmp/other' }), { status: 400 });
  assert.deepEqual(await request({ signedIn: true, trusted: true }, {}), { status: 200, body: { ok: true } });
  assert.deepEqual(assigned, ['alpha']);
});

test('managed status keeps credentials server-side and lifecycle calls carry explicit owner-selected profile', async t => {
  const { root } = await fixture(t);
  const home = path.join(root, 'hermes');
  await mkdir(path.join(home, 'profiles', 'alpha'), { recursive: true });
  await writeFile(path.join(home, 'profiles', 'alpha', 'config.yaml'), JSON.stringify({ mcp_servers: {
    portal: { url: 'http://127.0.0.1:9879/mcp', bearer_token: 'scoped-bot-key' },
  } }));
  const calls = [];
  const routes = createAgentComputerRoutes({ hermesHome: home, env: {}, authenticated: () => true,
    assertOrigin: () => {}, knownBot: profile => profile === 'alpha', nativePortal: {
      managed: cfg => cfg.mcpUrl === 'http://127.0.0.1:9879/mcp',
      viewer: async profile => { assert.equal(profile, 'alpha'); return { mode: 'agent' }; },
      vncConfig: async profile => ({ origin: 'http://127.0.0.1:9879', token: 'owner-key', profile }),
    }, fetchImpl: async (_url, options) => {
      const msg = JSON.parse(options.body); calls.push({ options, msg });
      return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(msg.params.name === 'computer_list' ? [{ id: 'portal', state: 'sleeping' }] : { id: 'portal', state: 'sleeping' }) }] } });
    },
  });
  t.after(() => routes.close());
  let result;
  const helpers = { json: (_res, _code, body) => { result = body; }, body: async () => ({ computerId: 'portal' }) };
  await routes.route({ method: 'GET' }, {}, new URL('http://hob/api/hermes/portal/status?profile=alpha'), helpers);
  assert.equal(result.managed, true);
  assert.equal(result.controlMode, 'agent');
  assert.equal(result.vncToken, undefined);
  assert.equal(result.origin, undefined);
  assert.equal(JSON.stringify(result).includes('key'), false);
  await routes.route({ method: 'POST' }, {}, new URL('http://hob/api/hermes/portal/wake?profile=alpha'), helpers);
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer owner-key');
  assert.deepEqual(calls.at(-1).msg.params.arguments, { computer: 'portal', profile: 'alpha' });
});

test('assignment guidance follows the native binding without overwriting authored bot instructions', async t => {
  const { root, home, workspaceRoot } = await fixture(t);
  const hermesHome = path.join(root, 'hermes');
  await mkdir(path.join(hermesHome, 'profiles', 'alpha'), { recursive: true });
  const filename = path.join(hermesHome, 'profiles', 'alpha', 'config.yaml');
  await writeFile(filename, JSON.stringify({ mcp_servers: { portal: { url: 'http://127.0.0.1:9879/mcp', enabled: true } } }));
  const portal = new NativePortal({ home, hermesHome, url: 'http://127.0.0.1:9879', client: {} });
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: [{ name: 'alpha', state: 'active' }] }),
    workspaceRoot, relayUrl: 'http://127.0.0.1:3000/api/hermes/bot-relay', credential: () => 'a'.repeat(64),
    computerContext: profile => portal.instructions(profile),
  });
  await mkdir(network.workspace('alpha'), { recursive: true });
  const agents = path.join(network.workspace('alpha'), 'AGENTS.md');
  await writeFile(agents, '# Authored role\nKeep these instructions.\n');
  assert.deepEqual((await network.sync()).failed, []);
  assert.deepEqual((await network.sync()).failed, []);
  const assigned = await readFile(agents, 'utf8');
  assert.equal(assigned.split('## Assigned computer').length, 2);
  assert.ok(assigned.includes('Keep these instructions.'));
  await writeFile(filename, JSON.stringify({ mcp_servers: { portal: { url: 'http://127.0.0.1:9879/mcp', enabled: false } } }));
  assert.deepEqual((await network.sync()).failed, []);
  const unassigned = await readFile(agents, 'utf8');
  assert.equal(unassigned.includes('## Assigned computer'), false);
  assert.ok(unassigned.includes('Keep these instructions.'));
});
