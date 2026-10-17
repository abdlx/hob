import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createHermesGroups } from '../hermes-groups.mjs';

const calls = [], configWrites = [], rooms = new Map();
const activeBots = new Set(['default', 'coder']);
let groups, server, origin, home, pending = [], roomDriver = true, holdSend, releaseSend;
const nativeRoom = (id, members = ['default', 'coder']) => ({ room_id: id, name: 'Shared project', authority_epoch: 1, revision: 1,
  members: members.map(name => ({ member_id: name, profile: name, handle: name })), updated_at: 1 });
const bridge = {
  async rpc(profile, method, params) {
    calls.push({ profile, method, params });
    assert.equal(profile, 'default');
    if (method === 'groups.capabilities') return { protocol_version: 2, driver: roomDriver };
    if (method === 'groups.list') return { rooms: [...rooms.values()], next_offset: null };
    if (method === 'groups.create') { const room = rooms.get(params.room_id) || { ...nativeRoom(params.room_id), ...params }; rooms.set(room.room_id, room); return { room }; }
    if (method === 'groups.state') return { room: rooms.get(params.room_id), driver_status: { running: true, pending_actions: pending } };
    if (method === 'groups.send') { if (holdSend) await holdSend; return { accepted: true }; }
    if (method === 'groups.disband') { rooms.get(params.room_id).disbanded_at = 1; return { tombstone: { room_id: params.room_id } }; }
    if (method === 'groups.log') return { cursor: 2, has_more: false, events: [
      { event_id: 'user-1', seq: 1, kind: 'message.user', actor: { kind: 'user' }, payload: { text: 'Shared question', private_context: 'must-not-project' } },
      { event_id: 'failure-1', seq: 2, kind: 'turn.failed', actor: { kind: 'gateway' }, payload: { error: 'must-not-project' } },
    ] };
    return { ok: true };
  },
};
before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'hob-group-test-')); await mkdir(path.join(home, 'profiles', 'coder'), { recursive: true });
  groups = createHermesGroups({ bridge, home, client: { credentialBinding: () => 'main-bound',
    async dashboard(path, options) { if (options?.method === 'PUT') configWrites.push(options.body); return {}; } },
  bots: { async list() { return { profiles: [...activeBots].map(name => ({ name, state: 'active' })) }; } } });
  server = http.createServer(async (req, res) => {
    const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const body = async req => { const chunks = []; for await (const part of req) chunks.push(part); return JSON.parse(Buffer.concat(chunks).toString()); };
    try { await groups.route(req, res, new URL(req.url, 'http://local'), { json, body }); }
    catch (error) { json(res, error.status || 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.match(path.basename(home), /^hob-group-test-/); await rm(home, { recursive: true, force: true }); });
const request = (route = '', method = 'GET', value) => fetch(`${origin}/api/hermes/groups${route}`, { method,
  ...(value ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}) });
const id = () => 'hob_group_' + randomUUID().replaceAll('-', '');

test('groups start empty and creation requires explicit membership of two to six active bots', async () => {
  assert.deepEqual(await (await request()).json(), { groups: [] });
  const before = calls.length;
  for (const members of [[], ['default'], ['default', 'default'], ['default', 'not-enrolled']]) assert.equal((await request('', 'POST', { requestId: randomUUID(), name: 'Group', members, confirm: true })).status, 400);
  assert.equal((await request('', 'POST', { requestId: randomUUID(), name: 'Group', members: ['default', 'coder'] })).status, 400);
  assert.equal(calls.length, before);
});
test('creation uses the native coordinator and only maps explicitly selected enrolled profile homes', async () => {
  const requestId = randomUUID();
  const result = await (await request('', 'POST', { requestId, name: 'Project', members: ['default', 'coder'], confirm: true })).json();
  assert.equal(result.group.id, 'hob_group_' + requestId.replaceAll('-', ''));
  assert.deepEqual(configWrites.at(-1).config.hosted_rooms.profiles, { coder: path.join(home, 'profiles', 'coder') });
  const created = calls.at(-1); assert.equal(created.method, 'groups.create');
  assert.deepEqual(created.params.members.map(member => member.profile), ['default', 'coder']);
  assert.equal(JSON.stringify(created.params).includes('session_id'), false);
  const repeated = await (await request('', 'POST', { requestId, name: 'Project', members: ['default', 'coder'], confirm: true })).json();
  assert.equal(repeated.group.id, result.group.id);
});
test('no alternate worker or private-conversation fallback is started when the native driver is unavailable', async () => {
  roomDriver = false; const before = calls.length;
  try { assert.equal((await request('', 'POST', { requestId: randomUUID(), name: 'Unavailable', members: ['default', 'coder'], confirm: true })).status, 503); }
  finally { roomDriver = true; }
  assert.deepEqual(calls.slice(before).map(call => call.method), ['groups.capabilities']);
});
test('group send carries only the shared text and stable native event identity', async () => {
  const roomId = id(); rooms.set(roomId, nativeRoom(roomId)); const requestId = randomUUID();
  assert.equal((await request(`/${roomId}/messages`, 'POST', { text: '@coder check the shared plan', requestId })).status, 202);
  assert.deepEqual(calls.at(-1), { profile: 'default', method: 'groups.send', params: { room_id: roomId, event_id: requestId, payload: { text: '@coder check the shared plan', thread_id: requestId } } });
  const before = calls.length;
  assert.equal((await request(`/${roomId}/messages`, 'POST', { text: 'Shared', requestId, session_id: 'private-session' })).status, 400);
  assert.equal(calls.slice(before).some(call => call.method === 'groups.send'), false);
});
test('revoked or disbanded group members cannot silently receive newly admitted work', async () => {
  const roomId = id(); rooms.set(roomId, nativeRoom(roomId)); activeBots.delete('coder');
  try { assert.equal((await request(`/${roomId}/messages`, 'POST', { text: 'Do work', requestId: randomUUID() })).status, 409); }
  finally { activeBots.add('coder'); }
  rooms.get(roomId).disbanded_at = 1;
  assert.equal((await request(`/${roomId}/messages`, 'POST', { text: 'Do work', requestId: randomUUID() })).status, 409);
  assert.equal((await request(`/${roomId}`)).status, 200);
});
test('room history projects shared messages without raw task errors, private payloads or session IDs', async () => {
  const roomId = id(); rooms.set(roomId, nativeRoom(roomId));
  const result = await (await request(`/${roomId}/events?since=0`)).json();
  assert.equal(result.events[0].text, 'Shared question'); assert.equal(JSON.stringify(result).includes('must-not-project'), false);
  assert.equal((await request(`/${roomId}/events?since=-1`)).status, 400);
  assert.equal((await request('/foreign-room/events')).status, 404);
});
test('group approval is bound to the exact current task, generation and prompt and permits once or deny only', async () => {
  const roomId = id(); rooms.set(roomId, nativeRoom(roomId));
  pending = [{ kind: 'approval', member_id: 'coder', task_id: 'task-one', execution_generation: 3, request_id: 'prompt-one', approval: { description: 'Run approved command?', command: 'sudo -n true' } }];
  try {
    const view = await (await request(`/${roomId}`)).json(), actionId = view.actions[0].id;
    assert.equal(view.actions[0].command, 'sudo -n true');
    assert.equal((await request(`/${roomId}/actions`, 'POST', { id: actionId, choice: 'always', confirm: true })).status, 400);
    assert.equal((await request(`/${roomId}/actions`, 'POST', { id: actionId, choice: 'once' })).status, 400);
    assert.equal((await request(`/${roomId}/actions`, 'POST', { id: actionId, choice: 'once', confirm: true })).status, 200);
    assert.deepEqual(calls.at(-1).params, { room_id: roomId, member_id: 'coder', task_id: 'task-one', execution_generation: 3, request_id: 'prompt-one', choice: 'once' });
    pending[0].execution_generation = 4;
    assert.equal((await request(`/${roomId}/actions`, 'POST', { id: actionId, choice: 'once', confirm: true })).status, 409);
  } finally { pending = []; }
});
test('disband requires confirmation and keeps native history available', async () => {
  const roomId = id(); rooms.set(roomId, nativeRoom(roomId));
  assert.equal((await request(`/${roomId}/disband`, 'POST', {})).status, 400);
  assert.equal((await request(`/${roomId}/disband`, 'POST', { confirm: true })).status, 200);
  assert.equal((await (await request(`/${roomId}`)).json()).group.disbanded, true);
  assert.equal((await request(`/${roomId}/events`)).status, 200);
});
test('bot removal holds the admission queue through acknowledged native cancellation and registry revocation', async () => {
  const roomId = id(); rooms.set(roomId, nativeRoom(roomId));
  holdSend = new Promise(resolve => { releaseSend = resolve; });
  const first = request(`/${roomId}/messages`, 'POST', { text: 'First task', requestId: randomUUID() });
  while (!calls.some(call => call.method === 'groups.send' && call.params.room_id === roomId)) await new Promise(resolve => setTimeout(resolve, 5));
  const removed = groups.removeBot('coder', async () => { activeBots.delete('coder'); return { ok: true }; });
  releaseSend(); holdSend = undefined; assert.equal((await first).status, 202); await removed;
  assert.equal(rooms.get(roomId).disbanded_at, 1);
  assert.equal((await request(`/${roomId}/messages`, 'POST', { text: 'Late task', requestId: randomUUID() })).status, 409);
  activeBots.add('coder');
});
