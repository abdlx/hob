import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { createHermesWorkspaceRoutes } from '../hermes-workspace.mjs';
import { HermesError, hermesNativeSessionKey, hermesSessionKey } from '../hermes-client.mjs';

const calls = [], controls = [];
let server, origin, root, reply, linkedPaths = false;
const revoked = new Set();
const jobs = { default: [{ id: 'main-job', name: 'Main goal' }], coder: [{ id: 'coder-job', name: 'Coder goal' }] };
const client = {
  credentialBinding(profile) { if (revoked.has(profile)) throw new HermesError(404, 'Bot revoked.'); return 'bound-private-key'; },
  async dashboard(route, options) {
    calls.push({ route, ...options });
    if (reply) return reply(route, options);
    if (route === '/api/hob/schedule-preview') return { valid: true, nextRun: '2099-12-01T09:00:00+05:00', timezone: 'Asia/Karachi' };
    if (route === '/api/cron/jobs' && !options.method) return jobs[options.profile] || [];
    return { ok: true };
  },
};
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'hob-workspace-test-'));
  await mkdir(path.join(root, 'main')); await mkdir(path.join(root, 'bots', 'coder'), { recursive: true });
  await writeFile(path.join(root, 'main', 'report.txt'), 'synthetic report');
  let workspaceRoot = root;
  try {
    await symlink(root, path.join(root, 'root-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(path.join(root, 'main'), path.join(root, 'bots', 'coder', 'other-bot-link'), process.platform === 'win32' ? 'junction' : 'dir');
    workspaceRoot = path.join(root, 'root-alias'); linkedPaths = true;
  } catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; }
  const handler = createHermesWorkspaceRoutes({ client, workspaceRoot, bridge: {
    async rpc(profile, method, params) { controls.push({ profile, method, params }); return { type: 'exec', output: 'Native pending result.' }; },
  } });
  server = http.createServer(async (req, res) => {
    const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const body = async req => { const chunks = []; for await (const part of req) chunks.push(part); return JSON.parse(Buffer.concat(chunks).toString()); };
    try { await handler(req, res, new URL(req.url, 'http://local'), { json, body }); }
    catch (error) { json(res, error.status || 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(root).startsWith('hob-workspace-test-'));
  await rm(root, { recursive: true, force: true });
});
const request = (route, method = 'GET', value, profile = 'coder') => fetch(`${origin}/api/hermes/workspace/${route}`, {
  method, headers: { 'X-Hob-Profile': profile, ...(value ? { 'Content-Type': 'application/json' } : {}) },
  ...(value ? { body: JSON.stringify(value) } : {}),
});

test('goals list and create use profile-scoped native scheduling, with no implicit external delivery', async () => {
  assert.deepEqual(await (await request('jobs')).json(), jobs.coder);
  assert.equal((await request('jobs', 'POST', { name: 'Read news', prompt: 'Summarize news', schedule: '0 9 * * *' })).status, 201);
  assert.deepEqual(calls.at(-1), { route: '/api/cron/jobs', profile: 'coder', method: 'POST', body: { name: 'Read news', prompt: 'Summarize news', schedule: '0 9 * * *', deliver: 'local' } });
});
test('job edits, pause/resume, run, history and delete reject other bot IDs before native owner fallback', async () => {
  for (const [suffix, method] of [['', 'PUT'], ['/pause', 'POST'], ['/resume', 'POST'], ['/trigger', 'POST'], ['/runs', 'GET'], ['', 'DELETE']]) {
    const before = calls.length;
    assert.equal((await request('jobs/main-job' + suffix, method, method === 'PUT' ? { name: 'Wrong owner' } : undefined)).status, 404);
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).route, '/api/cron/jobs');
    assert.equal((await request('jobs/coder-job' + suffix, method, method === 'PUT' ? { name: 'Updated goal' } : undefined)).status, 200);
    assert.equal(calls.at(-1).profile, 'coder');
    if (method === 'PUT') assert.deepEqual(calls.at(-1).body, { updates: { name: 'Updated goal' } });
  }
});
test('workspace mutation allowlist rejects execution scripts, profile overrides and malformed settings', async () => {
  const before = calls.length;
  for (const value of [{ name: 'x', prompt: 'x', schedule: 'x', script: 'shell' }, { profile: 'default', name: 'x', prompt: 'x', schedule: 'x' }, { name: 'x', prompt: 'x', schedule: 'x', paused: 'false' }]) {
    assert.equal((await request('jobs', 'POST', value)).status, 400);
  }
  assert.equal((await request('jobs?profile=all')).status, 400);
  assert.equal((await request('jobs?profile=coder&profile=default')).status, 400);
  assert.equal(calls.length, before);
});
test('skill list/content/toggle/create/edit use native profile owners and distinct human write paths', async () => {
  assert.equal((await request('skills')).status, 200);
  assert.equal((await request('skill?name=research%20notes')).status, 200);
  assert.deepEqual(calls.at(-1).query, { name: 'research notes' });
  for (const method of ['POST', 'PUT']) {
    assert.equal((await request('skill', method, { name: 'notes', content: '# Notes' })).status, method === 'POST' ? 201 : 200);
    assert.equal(calls.at(-1).body.profile, 'coder');
    assert.equal(calls.at(-1).route, method === 'POST' ? '/api/skills' : '/api/skills/content');
  }
  assert.equal((await request('skill/toggle', 'PUT', { name: 'notes', enabled: false })).status, 200);
  assert.equal(calls.at(-1).body.enabled, false);
  assert.equal((await request('skill/toggle', 'PUT', { name: 'notes', enabled: 'true' })).status, 400);
});
test('memory editing requires fingerprinted native entry IDs and preserves exact bot ownership', async () => {
  const id = 'memory:profile:0:0123456789ab';
  assert.equal((await request('learning/node?id=' + encodeURIComponent(id))).status, 200);
  assert.deepEqual(calls.at(-1).query, { id });
  assert.equal((await request('learning/node', 'PUT', { id, content: 'Updated preference.' })).status, 200);
  assert.deepEqual(calls.at(-1).body, { id, content: 'Updated preference.', profile: 'coder' });
  assert.equal((await request('learning/node', 'DELETE', { id })).status, 200);
  const before = calls.length;
  for (const stale of ['memory:profile:0', 'memory:profile:0:invalid', 'skill-name']) assert.equal((await request('learning/node?id=' + stale)).status, 400);
  assert.equal(calls.length, before);
});
test('legacy review reads retain ownership but decisions require the versioned queue', async () => {
  const sessionKey = hermesNativeSessionKey('coder', 'session-one');
  assert.equal((await request('skill-review', 'POST', { sessionKey, action: 'pending' })).status, 200);
  assert.deepEqual(controls.at(-1), { profile: 'coder', method: 'command.dispatch', params: { session_id: 'session-one', name: 'skills', arg: 'pending' } });
  assert.equal((await request('skill-review', 'POST', { sessionKey, action: 'diff', id: 'proposal-1' })).status, 200);
  const before = controls.length;
  for (const value of [
    { sessionKey: hermesNativeSessionKey('default', 'session-one'), action: 'pending' },
    { sessionKey: hermesSessionKey('coder', 'session-one'), action: 'pending' },
    { sessionKey, action: 'approve', id: 'all', confirm: true },
    { sessionKey, action: 'approve', id: 'proposal-1; shell', confirm: true }, { sessionKey, action: 'approval', id: 'off' },
  ]) assert.equal((await request('skill-review', 'POST', value)).status, 400);
  assert.equal(controls.length, before);
  for (const action of ['approve', 'reject']) for (const confirm of [true, false]) assert.equal((await request('skill-review', 'POST', { sessionKey, action, id: 'proposal-1', confirm })).status, 409);
  assert.equal(controls.length, before);
});
test('personality uses the selected native SOUL owner without renaming a profile or its directories', async () => {
  assert.equal((await request('soul')).status, 200);
  assert.equal((await request('soul', 'PUT', { content: 'Careful researcher.' })).status, 200);
  assert.deepEqual(calls.at(-1), { route: '/api/profiles/coder/soul', profile: 'coder', method: 'PUT', body: { content: 'Careful researcher.' } });
});
test('file library blocks traversal, credentials and other bot paths before any native read', async () => {
  const before = calls.length;
  for (const relative of ['../main/report.txt', '../../main/report.txt', '.env', 'credentials.json', 'sub/.env', 'secret-token.txt', 'C:/private.txt', 'nested%2f.env']) {
    assert.equal((await request('file?path=' + encodeURIComponent(relative))).status, 400);
  }
  assert.equal(calls.length, before);
  reply = (route, options) => route === '/api/files' ? { entries: [
    { name: 'report.txt', path: path.join(root, 'main', 'report.txt'), is_directory: false, size: 16 },
    { name: '.env', path: path.join(root, 'main', '.env'), is_directory: false },
    { name: 'other.txt', path: path.join(root, 'bots', 'coder', 'other.txt'), is_directory: false },
  ] } : { name: 'report.txt', mime_type: 'text/plain', data_url: 'data:text/plain;base64,cHJvb2Y=', size: 5 };
  try {
    const listing = await (await request('files', 'GET', undefined, 'default')).json();
    assert.deepEqual(listing.entries, [{ name: 'report.txt', path: 'report.txt', directory: false, size: 16 }]);
    assert.equal((await request('file?path=report.txt', 'GET', undefined, 'default')).status, 200);
    assert.equal(calls.at(-1).route, '/api/files/read');
    assert.equal(calls.at(-1).query.path, path.join(root, 'main', 'report.txt'));
  } finally { reply = undefined; }
});
test('revoked bots cannot read or mutate workspace resources', async () => {
  revoked.add('coder'); const before = calls.length;
  try { for (const route of ['jobs', 'skills', 'learning', 'memory', 'soul', 'files']) assert.equal((await request(route)).status, 404); }
  finally { revoked.delete('coder'); }
  assert.equal(calls.length, before);
});
test('canonical deployment aliases are accepted while a bot symlink into another bot is refused', async t => {
  if (!linkedPaths) return t.skip('This platform does not permit test junctions or symlinks.');
  const before = calls.length;
  assert.equal((await request('file?path=other-bot-link/report.txt')).status, 400);
  assert.equal(calls.length, before);
  reply = () => ({ name: 'report.txt', mime_type: 'text/plain', data_url: 'data:text/plain;base64,cHJvb2Y=', size: 5 });
  try { assert.equal((await request('file?path=report.txt', 'GET', undefined, 'default')).status, 200); }
  finally { reply = undefined; }
});
test('native failure never causes retry or fallback to another operation', async () => {
  const before = calls.length; reply = () => { throw new HermesError(503, 'Native service unavailable.'); };
  try { assert.equal((await request('skill', 'POST', { name: 'notes', content: '# Notes' })).status, 503); }
  finally { reply = undefined; }
  assert.equal(calls.length, before + 1);
});

test('invalid schedules never reach native writes, and preview uses the native owner', async () => {
  for (const schedule of ['not a schedule', '99 88 * * *', 'every 0h', '2020-01-01T00:00:00Z']) {
    const before = calls.length;
    assert.equal((await request('jobs', 'POST', { name: 'Invalid', prompt: 'Do work', schedule })).status, 400);
    assert.equal(calls.length, before);
  }
  const result = await request('schedule-preview', 'POST', { schedule: '0 9 * * *' });
  assert.equal((await result.json()).timezone, 'Asia/Karachi');
  assert.equal(calls.at(-1).profile, 'coder');
  assert.equal((await request('schedule-preview', 'POST', { schedule: '0 9 * * *', after: '2027-03-13T09:01:00-05:00' })).status, 200);
  assert.deepEqual(calls.at(-1).body, { schedule: '0 9 * * *', after: '2027-03-13T09:01:00-05:00' });
  for (const after of ['tomorrow', '2027-03-13T09:00:00', '2027-99-99T00:00:00Z']) {
    const before = calls.length;
    assert.equal((await request('schedule-preview', 'POST', { schedule: '0 9 * * *', after })).status, 400);
    assert.equal(calls.length, before);
  }
  reply = route => { if (route === '/api/hob/schedule-preview') return { valid: false }; throw new Error('Invalid preview must not create a job'); };
  try { assert.equal((await request('jobs', 'POST', { name: 'Refused', prompt: 'Do work', schedule: '0 9 * * *' })).status, 400); }
  finally { reply = undefined; }
});

test('versioned review requests bind exact revisions to a single bot and refuse forged decisions', async () => {
  reply = () => ({ items: [], nextOffset: null });
  try {
    assert.equal((await request('reviews/memory')).status, 200);
    assert.equal(calls.at(-1).route, '/api/hob/reviews/memory');
    assert.equal(calls.at(-1).profile, 'coder');
    const body = { id: 'abc12345', revision: 'a'.repeat(64), action: 'approve', requestId: 'b'.repeat(32), confirm: true };
    for (const change of [{ revision: '' }, { id: 'all' }, { id: '../other' }, { confirm: false }, { profile: 'default' }]) {
      const before = calls.length;
      assert.equal((await request('reviews/memory', 'POST', { ...body, ...change })).status, 400);
      assert.equal(calls.length, before);
    }
    assert.equal((await request('reviews/memory', 'POST', body)).status, 200);
    assert.deepEqual(calls.at(-1), { route: '/api/hob/reviews/memory', profile: 'coder', method: 'POST', body });
  } finally { reply = undefined; }
});

test('downloads preserve workspace scope and serve independent binary files without native content execution', async () => {
  const result = await request('download?path=report.txt', 'GET', undefined, 'default');
  assert.equal(result.status, 200); assert.equal(await result.text(), 'synthetic report');
  assert.match(result.headers.get('content-disposition'), /^attachment/);
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await request('download?path=../main/report.txt')).status, 400);
});
