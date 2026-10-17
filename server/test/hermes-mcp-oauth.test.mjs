import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app.mjs';
import { HermesClient, HermesError } from '../hermes-client.mjs';
import { createHermesMcpOAuth, mcpOAuthOrigin } from '../hermes-mcp-oauth.mjs';

const publicUrl = 'https://dashboard.example';
const authorization = (name, state) => `https://provider.example/authorize?${new URLSearchParams({ state,
  redirect_uri: `${publicUrl}/api/mcp/oauth/callback/${encodeURIComponent(name)}` })}`;

async function fixture(t, options = {}) {
  const calls = [], flows = new Map(), keys = new Map([['default', 'synthetic-main'], ['coder', 'synthetic-coder']]);
  let override;
  const native = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const name = decodeURIComponent(url.pathname.split('/')[4] || '');
    const profile = url.searchParams.get('profile');
    calls.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers });
    const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (override && await override(req, res, url, json)) return;
    if (url.pathname === '/api/mcp/servers') return json({ servers: [
      { name: 'docs', transport: 'http', auth: 'oauth', enabled: true, source: 'config' },
      { name: 'local', transport: 'stdio', auth: 'none', source: 'config' },
      { name: 'plugin', transport: 'http', auth: 'oauth', source: 'plugin', plugin: 'example' },
      { name: 'bearer', transport: 'http', auth: 'header', source: 'config' },
    ] });
    if (url.pathname.endsWith('/auth')) {
      const flow_id = randomUUID(), state = randomUUID();
      const value = { flow_id, server_name: name, status: 'authorization_required', authorization_url: authorization(name, state),
        access_token: 'private-native-token', profile, error: 'private-native-error' };
      flows.set(flow_id, value); return json(value);
    }
    if (url.pathname.startsWith('/api/mcp/oauth/flows/')) {
      const value = flows.get(url.pathname.split('/').at(-1));
      if (req.method === 'DELETE') { if (value) value.status = 'error'; return json({ ok: true, status: 'error' }); }
      return json(value);
    }
    if (url.pathname.startsWith('/api/mcp/oauth/callback/')) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'private-native-cookie' });
      return res.end('<script>private-native-script</script>private-native-token');
    }
    json({ ok: true });
  });
  await new Promise(resolve => native.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${native.address().port}`;
  const client = new HermesClient({ runtimeUrl: endpoint, dashboardUrl: endpoint, apiKey: 'synthetic-main', dashboardToken: 'synthetic-settings',
    profileAccess: profile => { if (!keys.has(profile)) throw new HermesError(404, 'Revoked.'); return keys.get(profile); } });
  const app = createApp({ gateway: client, password: 'synthetic-login', publicUrl: options.missingOrigin ? undefined : publicUrl });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const server of [app, native]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  const origin = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: options.missingOrigin ? origin : publicUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-login' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (route, method = 'GET', value, profile = 'coder', headers = {}) => fetch(`${origin}/api/hermes/setup/${route}?profile=${profile}`, {
    method, headers: { Cookie: cookie, Origin: publicUrl, 'Content-Type': 'application/json', ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const callback = (state, extra = '', method = 'GET') => fetch(`${origin}/api/mcp/oauth/callback/docs?${new URLSearchParams({ state, code: 'synthetic-code' })}${extra}`, {
    method, headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  const start = async () => {
    const response = await request('mcp/docs/auth', 'POST', { confirm: true }); assert.equal(response.status, 200);
    const flow = await response.json(); return { flow, state: new URL(flow.authorizationUrl).searchParams.get('state') };
  };
  return { calls, flows, keys, request, callback, start, origin, cookie, override: fn => { override = fn; } };
}

test('MCP OAuth start requires dashboard login, matching origin and explicit confirmation', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('mcp/docs/auth', 'POST', { confirm: true }, 'coder', { Cookie: '' })).status, 401);
  assert.equal((await f.request('mcp/docs/auth', 'POST', { confirm: true }, 'coder', { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await f.request('mcp/docs/auth', 'POST', {})).status, 400);
  assert.equal((await f.request('mcp/docs/auth', 'POST', { confirm: true, redirect_uri: 'https://other.invalid' })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('MCP OAuth attempt is bound to the captured bot and hides native tokens and errors', async t => {
  const f = await fixture(t), { flow } = await f.start();
  assert.equal(flow.serverName, 'docs'); assert.equal(flow.status, 'authorization_required'); assert.equal(flow.canClose, true);
  assert.equal(JSON.stringify(flow).includes('private-'), false);
  const count = f.calls.length;
  assert.equal((await f.request(`mcp/oauth/flows/${flow.id}`, 'GET', undefined, 'default')).status, 404);
  assert.equal((await f.request(`mcp/oauth/flows/${flow.id}`, 'DELETE', {}, 'default')).status, 404);
  assert.equal(f.calls.length, count);
  const recovered = await (await f.request('mcp/oauth/flows')).json();
  assert.equal(recovered.flows[0].id, flow.id);
  assert.equal(f.calls.at(-1).query.get('profile'), 'coder');
  assert.equal((await f.request(`mcp/oauth/flows/${flow.id}`, 'GET', undefined, 'coder', { Cookie: '' })).status, 401);
});

test('provider callback needs no cookie but requires the owned state and delivers only once', async t => {
  const f = await fixture(t), { state } = await f.start();
  const count = f.calls.length;
  assert.equal((await f.callback('wrong-state')).status, 404); assert.equal(f.calls.length, count);
  const response = await f.callback(state);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('content-security-policy').includes("default-src 'none'"));
  assert.equal((await response.text()).includes('private-'), false);
  const call = f.calls.at(-1);
  assert.equal(call.path, '/api/mcp/oauth/callback/docs'); assert.equal(call.query.get('profile'), 'coder');
  assert.equal(call.query.get('code'), 'synthetic-code'); assert.equal(call.headers.cookie, undefined);
  assert.equal(call.headers['x-hermes-session-token'], 'synthetic-settings');
  assert.equal((await f.callback(state)).status, 409); assert.equal(f.calls.at(-1), call);
});

test('callback parameter pollution, profile overrides, mixed errors/codes and wrong methods cannot reach Hermes', async t => {
  const f = await fixture(t), { state } = await f.start(), count = f.calls.length;
  for (const suffix of ['&state=other', '&profile=default', '&code=other', '&error=denied', '&unexpected=value']) {
    assert.equal((await f.callback(state, suffix)).status, 400);
  }
  assert.equal((await f.callback(state, '', 'POST')).status, 405);
  assert.equal(f.calls.length, count);
});

test('revoking or replacing bot credentials fences existing sign-in attempts and callbacks', async t => {
  const f = await fixture(t), { flow, state } = await f.start(), count = f.calls.length;
  f.keys.set('coder', 'synthetic-new-enrollment');
  assert.equal((await f.request(`mcp/oauth/flows/${flow.id}`)).status, 404);
  assert.equal((await f.callback(state)).status, 404);
  f.keys.delete('coder');
  assert.equal((await f.request('mcp/oauth/flows')).status, 404);
  assert.equal(f.calls.length, count);
});

test('closing an MCP attempt cancels its native flow without disconnecting stored credentials', async t => {
  const f = await fixture(t), { flow, state } = await f.start();
  const response = await f.request(`mcp/oauth/flows/${flow.id}`, 'DELETE', {});
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'cancelled');
  const call = f.calls.at(-1);
  assert.equal(call.method, 'DELETE'); assert.ok(call.path.startsWith('/api/mcp/oauth/flows/'));
  assert.equal((await f.callback(state)).status, 404); assert.equal(f.calls.at(-1), call);
  assert.equal((await f.request(`mcp/oauth/flows/${flow.id}`, 'DELETE', {})).status, 200);
  assert.equal(f.calls.at(-1), call);
});

test('changing or removing the MCP endpoint fences an already-issued callback', async t => {
  const f = await fixture(t), { state } = await f.start();
  f.override((req, res, url, json) => {
    if (url.pathname !== '/api/mcp/servers') return false;
    json({ servers: [{ name: 'docs', transport: 'http', auth: 'oauth', enabled: true, source: 'config', url: 'https://different.example/mcp' }] }); return true;
  });
  assert.equal((await f.callback(state)).status, 404);
  assert.equal(f.calls.filter(call => call.path.startsWith('/api/mcp/oauth/callback/')).length, 0);
});

test('spent callback states stay spent even if a native snapshot repeats after completion', async t => {
  const f = await fixture(t), { flow, state } = await f.start();
  assert.equal((await f.callback(state)).status, 200);
  const native = [...f.flows.values()][0];
  native.status = 'approved'; await f.request(`mcp/oauth/flows/${flow.id}`);
  native.status = 'authorization_required'; await f.request(`mcp/oauth/flows/${flow.id}`);
  const before = f.calls.length;
  assert.equal((await f.callback(state)).status, 409); assert.equal(f.calls.length, before);
});

test('simultaneous sign-in starts cannot create duplicate native attempts', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([f.request('mcp/docs/auth', 'POST', { confirm: true }), f.request('mcp/docs/auth', 'POST', { confirm: true })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(f.calls.filter(call => call.path.endsWith('/auth')).length, 1);
});

test('unsafe authorization links and callback origins are refused without exposing native responses', async t => {
  const f = await fixture(t);
  f.override((req, res, url, json) => {
    if (!url.pathname.endsWith('/auth')) return false;
    json({ flow_id: 'unsafe-flow', server_name: 'docs', status: 'authorization_required',
      authorization_url: 'https://provider.example/auth?state=example&redirect_uri=https://attacker.invalid/callback', token: 'private-token' }); return true;
  });
  const response = await f.request('mcp/docs/auth', 'POST', { confirm: true });
  assert.equal(response.status, 502); assert.equal((await response.text()).includes('private-token'), false);
});

test('local, plugin-owned and non-OAuth MCP servers cannot start this account flow', async t => {
  const f = await fixture(t);
  for (const name of ['local', 'plugin', 'bearer', 'missing']) assert.equal((await f.request(`mcp/${name}/auth`, 'POST', { confirm: true })).status, 400);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('missing public origin fails before OAuth discovery, and malformed origins are never inferred from requests', async t => {
  const f = await fixture(t, { missingOrigin: true });
  assert.equal((await f.request('mcp/docs/auth', 'POST', { confirm: true }, 'coder', { Origin: f.origin })).status, 503);
  assert.equal(f.calls.length, 0);
  for (const value of [undefined, '', 'https://name:secret@dashboard.example', 'https://dashboard.example/path', 'https://dashboard.example?query', 'javascript:alert(1)']) assert.equal(mcpOAuthOrigin(value), null);
  assert.equal(mcpOAuthOrigin('https://dashboard.example/'), publicUrl);
});

test('uncertain auth starts are observed and fenced rather than replayed', async t => {
  const f = await fixture(t);
  f.override((req, res, url) => { if (!url.pathname.endsWith('/auth')) return false; res.writeHead(503); res.end(); return true; });
  assert.equal((await f.request('mcp/docs/auth', 'POST', { confirm: true })).status, 502);
  const listed = await (await f.request('mcp/oauth/flows')).json();
  assert.equal(listed.flows[0].status, 'unknown'); assert.equal(listed.flows[0].canClose, false);
  assert.equal((await f.request('mcp/docs/auth', 'POST', { confirm: true })).status, 409);
  assert.equal(f.calls.filter(call => call.path.endsWith('/auth')).length, 1);
});

test('expired flows reject callbacks and polling without touching the native owner', async () => {
  let clock = 1, count = 0;
  const bridge = createHermesMcpOAuth({ credentialBinding: async () => 'binding',
    dashboard: async path => { count++; return path.endsWith('/servers') ? { servers: [{ name: 'docs', auth: 'oauth', transport: 'http' }] }
      : { flow_id: 'native', server_name: 'docs', status: 'authorization_required', authorization_url: authorization('docs', 'owned-state') }; },
  }, { publicUrl, now: () => clock });
  const flow = await bridge.start('docs', 'coder'); clock += 15 * 60 * 1000;
  const before = count;
  await assert.rejects(bridge.poll(flow.id, 'coder'), error => error.status === 404);
  assert.deepEqual(await bridge.list('coder'), { flows: [] }); assert.equal(count, before);
});

test('an in-flight poll cannot reopen a cancelled attempt', async () => {
  let resolvePoll;
  const snapshot = { flow_id: 'native', server_name: 'docs', status: 'authorization_required', authorization_url: authorization('docs', 'owned-state') };
  const bridge = createHermesMcpOAuth({ credentialBinding: async () => 'binding',
    dashboard: async (path, options) => path.endsWith('/servers') ? { servers: [{ name: 'docs', auth: 'oauth', transport: 'http' }] }
      : options.method === 'POST' ? snapshot : options.method === 'DELETE' ? { ok: true } : new Promise(resolve => { resolvePoll = resolve; }),
  }, { publicUrl });
  const flow = await bridge.start('docs', 'coder');
  const pending = bridge.poll(flow.id, 'coder');
  while (!resolvePoll) await new Promise(resolve => setImmediate(resolve));
  await bridge.cancel(flow.id, 'coder'); resolvePoll(snapshot);
  assert.equal((await pending).status, 'cancelled'); assert.equal((await pending).authorizationUrl, undefined);
});
