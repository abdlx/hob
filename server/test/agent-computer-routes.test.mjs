import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { stringify } from 'yaml';
import { WebSocket, WebSocketServer } from 'ws';
import { createAgentComputerRoutes } from '../agent-computer-routes.mjs';

async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'hob-computer-routes-'));
  await mkdir(path.join(home, 'profiles', 'alpha'), { recursive: true });
  const calls = [];
  const routes = createAgentComputerRoutes({ hermesHome: home, env: {},
    authenticated: req => req.headers['x-test-session'] === 'yes',
    assertOrigin: req => { if (req.headers.origin !== 'http://trusted.test') throw new Error('Invalid origin.'); },
    knownBot: name => ['default', 'alpha'].includes(name),
    fetchImpl: async (url, init) => {
      const request = JSON.parse(init.body); calls.push({ url, ...init, request });
      const result = request.params.name === 'computer_list' ? [{ id: 'computer-one', state: 'ready' }] : { id: 'computer-one', state: 'ready' };
      return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    }, ...options });
  const server = http.createServer(async (req, res) => {
    const json = (response, code, value) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    const body = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); };
    try { if (!await routes.route(req, res, new URL(req.url, 'http://test'), { json, body })) json(res, 404, {}); }
    catch (error) { json(res, error.status || 500, { error: error.message }); }
  });
  server.on('upgrade', (req, socket, head) => { if (!routes.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { routes.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = (profile, value) => writeFile(path.join(home, ...(profile === 'default' ? [] : ['profiles', profile]), 'config.yaml'), stringify({ mcp_servers: { agent_computer: value } }));
  const request = (suffix = '/status?profile=default', value) => fetch(origin + '/api/hermes/agent-computer' + suffix, {
    headers: { 'x-test-session': 'yes', Origin: 'http://trusted.test', ...(value ? { 'Content-Type': 'application/json' } : {}) },
    ...(value ? { method: 'POST', body: JSON.stringify(value) } : {}),
  });
  return { routes, home, origin, config, request, calls };
}

test('unconfigured computers never contact a baked-in service or invent a connected identity', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request()).json(), { configured: false, connected: false });
  assert.equal(f.calls.length, 0);
  assert.equal((await fetch(f.origin + '/api/hermes/agent-computer/status')).status, 401);
});

test('named computers use only their own YAML and never inherit Main credentials or environment', async t => {
  const f = await fixture(t, { env: { AGENT_COMPUTER_URL: 'https://environment.test/mcp', AGENT_COMPUTER_TOKEN: 'environment-fixture' } });
  await f.config('default', { url: 'https://main.test/mcp', headers: { Authorization: 'Bearer main-fixture' } });
  await f.config('alpha', { url: 'https://alpha.test/mcp', headers: { Authorization: 'Bearer alpha-fixture' } });
  const alpha = await f.routes.getAgentComputerConfig('alpha');
  assert.equal(alpha.origin, 'https://alpha.test'); assert.equal(alpha.token, 'alpha-fixture');
  await rm(path.join(f.home, 'profiles', 'alpha', 'config.yaml'));
  assert.deepEqual(await f.routes.getAgentComputerConfig('alpha'), { connected: false });
  assert.equal((await f.routes.getAgentComputerConfig('default')).token, 'main-fixture');
  assert.equal((await f.request('/status?profile=missing')).status, 404);
  assert.equal((await f.request('/status?profile=..%2Fdefault')).status, 400);
  assert.equal((await f.request('/status?profile=alpha&profile=default')).status, 400);
});

test('disabled, invalid and unresolved configurations fail closed', async t => {
  const f = await fixture(t);
  await f.config('default', { enabled: false, url: 'https://configured.test/mcp' });
  assert.equal((await f.routes.getAgentComputerConfig()).connected, false);
  for (const url of ['file:///tmp/mcp', 'https://name:password@test.invalid/mcp']) {
    await f.config('default', { url });
    await assert.rejects(f.routes.getAgentComputerConfig(), /HTTP or HTTPS/);
  }
  await f.config('default', { url: 'https://configured.test/mcp', bearer_token: '${UNRESOLVED_KEY}' });
  await assert.rejects(f.routes.getAgentComputerConfig(), /resolved computer credential/);
  await writeFile(path.join(f.home, 'config.yaml'), 'mcp_servers: {}\nmcp_servers: {}\n');
  await assert.rejects(f.routes.getAgentComputerConfig(), /could not be read safely/);
  assert.equal(f.calls.length, 0);
});

test('a bot home aliased to Main cannot read Main computer credentials', async t => {
  const f = await fixture(t);
  await f.config('default', { url: 'https://main.test/mcp', bearer_token: 'main-fixture' });
  const botHome = path.join(f.home, 'profiles', 'alpha');
  await rm(botHome, { recursive: true });
  await symlink(f.home, botHome, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.routes.getAgentComputerConfig('alpha'), /could not be read safely/);
});

test('wake and sleep require explicit identities, never retry and suppress remote error bodies', async t => {
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async (_url, init) => { calls++; assert.equal(init.redirect, 'error'); return new Response('fixture-sensitive-body', { status: 500 }); } });
  await f.config('default', { url: 'https://configured.test/mcp', bearer_token: 'fixture-credential' });
  assert.equal((await f.request('/wake', {})).status, 400);
  assert.equal(calls, 0);
  const response = await f.request('/wake', { computerId: 'computer-one' });
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes('fixture-sensitive-body'), false);
  assert.equal(calls, 1);
});

test('status rejects another computer identity instead of associating its screen with the selected computer', async t => {
  const f = await fixture(t, { fetchImpl: async (_url, init) => {
    const name = JSON.parse(init.body).params.name;
    return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(name === 'computer_list' ? [{ id: 'expected', state: 'ready' }] : { id: 'other-computer', state: 'ready' }) }] } });
  } });
  await f.config('default', { url: 'https://configured.test/mcp', bearer_token: 'fixture-credential' });
  const response = await (await f.request()).json();
  assert.equal(response.connected, false); assert.equal(response.configured, true);
  assert.equal(response.vncToken, undefined);
});

async function refused(url, headers) {
  const socket = new WebSocket(url, { headers, handshakeTimeout: 2000 });
  let opened = false;
  socket.once('open', () => { opened = true; socket.close(); });
  socket.on('error', () => undefined);
  await new Promise(resolve => socket.once('close', resolve));
  assert.equal(opened, false);
}
test('VNC refuses anonymous, cross-origin and unknown-bot sockets before contacting a computer', async t => {
  const f = await fixture(t);
  const url = f.origin.replace('http', 'ws') + '/api/hermes/agent-computer/vnc?profile=default&computerId=computer-one';
  await refused(url, { Origin: 'http://trusted.test' });
  await refused(url, { Origin: 'https://attacker.invalid', 'x-test-session': 'yes' });
  await refused(url.replace('profile=default', 'profile=missing'), { Origin: 'http://trusted.test', 'x-test-session': 'yes' });
  assert.equal(f.calls.length, 0);
});

test('authorized VNC proxy preserves early client frames through the configured profile connection', async t => {
  const remote = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(remote, 'listening');
  t.after(() => { for (const socket of remote.clients) socket.terminate(); remote.close(); });
  remote.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, 'Bearer alpha-fixture');
    socket.on('message', data => socket.send(data));
  });
  const f = await fixture(t);
  await f.config('alpha', { url: `http://127.0.0.1:${remote.address().port}/mcp`, bearer_token: 'alpha-fixture' });
  const socket = new WebSocket(f.origin.replace('http', 'ws') + '/api/hermes/agent-computer/vnc?profile=alpha&computerId=computer-one', ['binary'], {
    headers: { Origin: 'http://trusted.test', 'x-test-session': 'yes' },
  });
  socket.on('error', () => undefined); t.after(() => socket.terminate());
  await once(socket, 'open');
  const message = once(socket, 'message'); socket.send('fixture-vnc-handshake');
  assert.equal((await message)[0].toString(), 'fixture-vnc-handshake');
  socket.close(); await once(socket, 'close');
});
