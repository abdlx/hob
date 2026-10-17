import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { HermesError, hermesProfile } from './hermes-client.mjs';

const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');
const groupId = value => {
  if (typeof value !== 'string' || !/^hob_group_[a-f0-9]{32}$/.test(value)) throw invalid('Invalid group identifier.');
  return value;
};
const uuid = value => {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(value)) throw invalid('A stable request identifier is required.');
  return value;
};
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid('Enter text within the group limit.');
  return value;
};
const actionId = (room, action) => createHash('sha256').update(JSON.stringify([room.room_id, room.authority_epoch,
  action.kind, action.member_id, action.task_id, action.execution_generation, action.request_id])).digest('hex');
const roomView = room => ({ id: room.room_id, name: room.name, revision: room.revision, disbanded: room.disbanded_at != null,
  members: room.members.map(member => ({ id: member.member_id, profile: member.profile, name: member.display_name || member.profile, handle: member.handle })),
  updatedAt: room.updated_at });

/** One native coordinator owns room histories, FIFO work, bounded discussion and approvals. */
export function createHermesGroups({ client, bridge, bots, home }) {
  let queue = Promise.resolve();
  const exclusive = work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; };
  const rpc = (method, params = {}) => {
    if (!bridge) throw new HermesError(503, 'Hermes native group coordination is unavailable.', 'GROUPS_UNAVAILABLE');
    return bridge.rpc('default', method, params);
  };
  const roster = async () => {
    const result = await (bots ? bots.list() : client.dashboard('/api/profiles'));
    return new Map((result.profiles || []).filter(item => !item.state || item.state === 'active').map(item => [item.name, item]));
  };
  const all = async () => {
    const result = []; let offset = 0;
    do {
      const page = await rpc('groups.list', { limit: 500, offset, include_disbanded: true });
      if (!Array.isArray(page.rooms)) throw new HermesError(502, 'Hermes returned an invalid room list.', 'HERMES_PROTOCOL_ERROR');
      result.push(...page.rooms.filter(room => /^hob_group_[a-f0-9]{32}$/.test(room.room_id)));
      if (page.next_offset == null) return result;
      if (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset || page.next_offset > 1000) throw new HermesError(502, 'Hermes returned an invalid room cursor.', 'HERMES_PROTOCOL_ERROR');
      offset = page.next_offset;
    } while (true);
  };
  const state = async id => {
    const result = await rpc('groups.state', { room_id: groupId(id), include_disbanded: true });
    if (result.room?.room_id !== id || !Array.isArray(result.room.members)) throw new HermesError(502, 'Hermes returned another room.', 'HERMES_PROTOCOL_ERROR');
    return result;
  };
  const active = async room => {
    if (room.disbanded_at != null) throw new HermesError(409, 'This group has been disbanded. Its retained history is read-only.', 'GROUP_DISBANDED');
    const members = await roster();
    if (room.members.some(member => !members.has(member.profile))) throw new HermesError(409, 'A group member is unavailable or revoked. Stop this group before changing its membership.', 'GROUP_MEMBER_UNAVAILABLE');
  };
  const driver = async () => {
    const capabilities = await rpc('groups.capabilities');
    if (capabilities.protocol_version !== 2 || capabilities.driver !== true) throw new HermesError(503, 'Hermes’s native group worker is not ready. No alternate worker was started.', 'GROUPS_UNAVAILABLE');
    return capabilities;
  };
  const removeBot = (name, remove) => exclusive(async () => {
    // Tombstoning waits for acknowledged cancellation in the native coordinator.
    // Hold the same app queue through registry revocation so no new group send
    // can enter between cancellation and removal.
    for (const room of await all()) if (room.disbanded_at == null && room.members.some(member => member.profile === name)) {
      await rpc('groups.disband', { room_id: room.room_id, cancel_id: randomUUID() });
    }
    return remove();
  });
  const route = async (req, res, url, { json, body }) => {
    const method = req.method, resource = url.pathname.slice('/api/hermes/groups'.length);
    await client.credentialBinding('default');
    const input = async fields => {
      const value = await body(req);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw invalid('Unsupported group fields.');
      return value;
    };
    if (resource === '/capabilities' && method === 'GET') return json(res, 200, await rpc('groups.capabilities'));
    if (!resource && method === 'GET') return json(res, 200, { groups: (await all()).map(roomView) });
    if (!resource && method === 'POST') return exclusive(async () => {
      const value = await input(['requestId', 'name', 'members', 'confirm']); uuid(value.requestId); text(value.name, 200);
      if (value.confirm !== true || !Array.isArray(value.members) || value.members.length < 2 || value.members.length > 6 || new Set(value.members).size !== value.members.length) throw invalid('Explicitly select two to six distinct bots for collaboration.');
      const available = await roster();
      for (const name of value.members) if (!available.has(hermesProfile(name))) throw invalid('Select only active bots from your dashboard.');
      await driver();
      if (!home) throw new HermesError(503, 'The native profile home is unavailable.', 'GROUPS_UNAVAILABLE');
      const root = await realpath(home);
      const profiles = {};
      for (const name of value.members.filter(name => name !== 'default')) {
        const expected = path.join(root, 'profiles', name), resolved = await realpath(expected);
        if (resolved !== expected) throw invalid('Group membership cannot follow a linked profile directory.');
        profiles[name] = resolved;
      }
      if (Object.keys(profiles).length) {
        const config = await client.dashboard('/api/config', { profile: 'default' });
        const existing = config.hosted_rooms?.profiles || {};
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new HermesError(409, 'Repair the native hosted-room profile mapping before creating a group.', 'GROUP_MAPPING_CONFLICT');
        for (const [name, target] of Object.entries(profiles)) if (existing[name] !== undefined && existing[name] !== target) throw new HermesError(409, 'A native group profile mapping conflicts with this bot. It was not overwritten.', 'GROUP_MAPPING_CONFLICT');
        await client.dashboard('/api/config', { profile: 'default', method: 'PUT', body: { profile: 'default', config: { hosted_rooms: { profiles } } } });
      }
      const result = await rpc('groups.create', { room_id: 'hob_group_' + value.requestId.replaceAll('-', ''), name: value.name.trim(),
        members: value.members.map(name => ({ member_id: name, profile: name, handle: name, display_name: available.get(name).display_name || (name === 'default' ? 'Main' : name), target: { kind: 'local', profile: name } })) });
      return json(res, 201, { group: roomView(result.room) });
    });
    const match = /^\/(hob_group_[a-f0-9]{32})(?:\/(events|messages|stop|rename|actions|disband))?$/.exec(resource);
    if (!match) throw new HermesError(404, 'Unknown group operation.', 'NOT_FOUND');
    const id = groupId(match[1]), operation = match[2];
    if (!operation && method === 'GET') {
      const result = await state(id), room = result.room;
      const available = await roster(), missing = room.members.filter(member => !available.has(member.profile)).map(member => member.profile);
      const pending = result.driver_status?.pending_actions || [];
      return json(res, 200, { group: roomView(room), unavailableMembers: missing,
        driver: { running: result.driver_status?.running === true, working: result.driver_status?.working === true, blocked: result.driver_status?.blocked === true, counts: result.driver_status?.counts || {} },
        actions: pending.filter(action => ['approval', 'retry', 'discard'].includes(action.kind)).map(action => ({ id: actionId(room, action), kind: action.kind,
          member: action.member_id, description: action.kind === 'approval' ? String(action.approval?.description || action.approval?.message || 'A group member needs tool approval.').slice(0, 4000) : 'This member needs an explicit recovery decision.',
          ...(action.kind === 'approval' && typeof action.approval?.command === 'string' ? { command: action.approval.command } : {}) })) });
    }
    if (operation === 'events' && method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      if (!Number.isSafeInteger(since) || since < 0) throw invalid('Invalid room history cursor.');
      const result = await rpc('groups.log', { room_id: id, since_seq: since, limit: 100, include_disbanded: true });
      return json(res, 200, { cursor: result.cursor, hasMore: result.has_more, events: result.events.map(event => ({ id: event.event_id, seq: event.seq, kind: event.kind,
        member: event.actor?.profile || (event.actor?.kind === 'user' ? 'You' : event.actor?.id), timestamp: event.created_at,
        text: ['message.user', 'message.member'].includes(event.kind) ? String(event.payload?.text || '') : event.kind === 'turn.failed' ? 'A member turn failed. Inspect group status before retrying.' : '' })) });
    }
    if (method !== 'POST') throw new HermesError(404, 'Unknown group operation.', 'NOT_FOUND');
    return exclusive(async () => {
      const current = await state(id), room = current.room;
      if (operation === 'messages') {
        const value = await input(['text', 'requestId']); text(value.text, 64000); uuid(value.requestId); await active(room); await driver();
        const result = await rpc('groups.send', { room_id: id, event_id: value.requestId, payload: { text: value.text, thread_id: value.requestId } });
        if (result.accepted !== true) throw new HermesError(502, 'Hermes did not confirm group admission. Refresh before resending.', 'HERMES_PROTOCOL_ERROR');
        return json(res, 202, { accepted: true });
      }
      if (operation === 'stop') { await input([]); return json(res, 200, await rpc('groups.stop', { room_id: id, cancel_id: randomUUID() })); }
      if (operation === 'rename') {
        const value = await input(['name', 'requestId']); text(value.name, 200); uuid(value.requestId); await active(room);
        await rpc('groups.rename', { room_id: id, event_id: value.requestId, name: value.name.trim() }); return json(res, 200, { ok: true });
      }
      if (operation === 'disband') {
        const value = await input(['confirm']); if (value.confirm !== true) throw invalid('Confirm disbanding this group and cancelling its work.');
        await rpc('groups.disband', { room_id: id, cancel_id: randomUUID() }); return json(res, 200, { ok: true });
      }
      if (operation === 'actions') {
        const value = await input(['id', 'choice', 'confirm']); if (value.confirm !== true) throw invalid('Confirm the group decision.'); await active(room);
        const action = current.driver_status?.pending_actions?.find(action => actionId(room, action) === value.id);
        if (!action) throw new HermesError(409, 'This group action is no longer current. Refresh the group.', 'STALE_GROUP_ACTION');
        if (action.kind === 'approval') {
          if (!['once', 'deny'].includes(value.choice)) throw invalid('Choose approve once or deny.');
          await rpc('groups.approve', { room_id: id, member_id: action.member_id, task_id: action.task_id, execution_generation: action.execution_generation, request_id: action.request_id, choice: value.choice });
        } else if (['retry', 'discard'].includes(action.kind) && value.choice === action.kind) {
          await rpc(`groups.${action.kind}`, { room_id: id, member_id: action.member_id, task_id: action.task_id, execution_generation: action.execution_generation });
        } else throw invalid('Unsupported recovery decision.');
        return json(res, 200, { ok: true });
      }
      throw new HermesError(404, 'Unknown group operation.', 'NOT_FOUND');
    });
  };
  return { route, removeBot };
}
