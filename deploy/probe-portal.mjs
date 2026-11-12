// Disposable Linux image acceptance, invoked only by smoke-container.mjs.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { parse } = require('yaml');
const { WebSocket } = require('ws');
if (process.env.HOB_SMOKE_PORTAL !== '1') throw new Error('Requires a disposable Portal smoke fixture');
const origin = 'http://127.0.0.1:' + (process.env.HOB_PORT || 3000);
let cookie;
async function api(route, method = 'GET', value) {
  const response = await fetch(origin + route, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(120000) });
  assert.equal(response.ok, true, `${method} ${route} returned ${response.status}`);
  if (route === '/api/auth/login') cookie = response.headers.get('set-cookie').split(';')[0];
  return response.json();
}
const a = 'portal-smoke-a', b = 'portal-smoke-b';
const computer = (profile, action, value) => api(`/api/hermes/portal/${action}?profile=${profile}`, value === undefined ? 'GET' : 'POST', value);
async function config(profile) {
  return parse(await readFile(path.join(process.env.HERMES_HOME, 'profiles', profile, 'config.yaml'), 'utf8'));
}
async function mcp(profile, name, args = {}) {
  const cfg = (await config(profile)).mcp_servers.portal;
  const response = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.bearer_token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(120000) });
  assert.equal(response.ok, true);
  return (await response.json()).result;
}
const decoded = result => { assert.equal(result.isError, undefined); return JSON.parse(result.content[0].text); };
const digest = token => createHash('sha256').update(token).digest('hex');
await api('/api/auth/login', 'POST', { password: process.env.HOB_PASSWORD });
if (process.argv.includes('--after-restart')) {
  const cfg = await config(a);
  const marker = JSON.parse(await readFile(path.join(cfg.terminal.cwd, 'portal-proof.json'), 'utf8'));
  assert.equal(digest(cfg.mcp_servers.portal.bearer_token), marker.tokenHash);
  assert.equal((await computer(a, 'status')).managed, true);
  assert.equal(decoded(await mcp(a, 'fs_read', { path: 'portal-proof.txt' })).content, 'same HOB files');
  await api('/api/hermes/profiles/' + a, 'DELETE');
  await api('/api/hermes/profiles/' + b, 'DELETE');
  const revoked = await fetch(cfg.mcp_servers.portal.url, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.mcp_servers.portal.bearer_token }, body: '{}' });
  assert.equal(revoked.status, 401);
  console.log('Portal profile, token and shared files survived container recreation; deletion revoked access.');
} else {
  for (const profile of [a, b]) {
    await api('/api/hermes/profiles', 'POST', { name: profile, soul: 'Disposable Portal integration fixture.' });
    assert.equal((await computer(profile, 'status')).assignable, true);
    await computer(profile, 'assign', {});
  }
  const ca = await config(a), cb = await config(b);
  assert.notEqual(ca.mcp_servers.portal.bearer_token, cb.mcp_servers.portal.bearer_token);
  const current = decoded(await mcp(a, 'profile_current'));
  assert.equal(current.workspace, ca.terminal.cwd);
  await mcp(a, 'fs_write', { path: 'portal-proof.txt', content: 'same HOB files' });
  assert.equal(await readFile(path.join(ca.terminal.cwd, 'portal-proof.txt'), 'utf8'), 'same HOB files');
  await writeFile(path.join(ca.terminal.cwd, 'portal-proof.json'), JSON.stringify({ tokenHash: digest(ca.mcp_servers.portal.bearer_token) }));
  assert.equal((await mcp(a, 'fs_write', { profile: b, path: 'denied', content: 'wrong profile' })).isError, true);
  await computer(a, 'wake', { computerId: 'portal' });
  const status = await computer(a, 'status');
  assert.equal(status.computer.state, 'ready');
  assert.equal(status.vncToken, undefined);
  assert.equal(status.origin, undefined);
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(origin.replace('http', 'ws') + `/api/hermes/portal/vnc?profile=${a}&computerId=portal`, ['binary'], { headers: { Cookie: cookie, Origin: origin } });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('No proxied VNC greeting')); }, 15000);
    socket.once('message', bytes => { clearTimeout(timer); assert.match(bytes.toString(), /^RFB /); socket.close(); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  await computer(a, 'control', { mode: 'human' });
  assert.equal((await mcp(a, 'browser_tab_list')).isError, true);
  await computer(a, 'control', { mode: 'agent' });
  assert.notEqual((await mcp(a, 'browser_tab_list')).isError, true);
  await computer(a, 'sleep', { computerId: 'portal' });
  assert.equal((await computer(a, 'status')).computer.state, 'sleeping');
  await computer(b, 'unassign', {});
  assert.equal((await computer(b, 'status')).assignable, true);
  const response = await fetch(cb.mcp_servers.portal.url, { method: 'POST', headers: { Authorization: 'Bearer ' + cb.mcp_servers.portal.bearer_token }, body: '{}' });
  assert.equal(response.status, 401);
  console.log('Portal assignment, shared files, token isolation, Camoufox/Xvnc, VNC proxy, takeover, sleep and revocation passed.');
}

