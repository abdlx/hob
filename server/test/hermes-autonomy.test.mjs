import assert from 'node:assert/strict';
import test from 'node:test';
import { createHermesWorkspaceRoutes } from '../hermes-workspace.mjs';
import { hermesNativeSessionKey, hermesSessionKey } from '../hermes-client.mjs';

function fixture() {
  const calls = [], control = { revision: 'native-state', goal: null, heartbeat: null };
  let refuse = false, lost = false;
  const route = createHermesWorkspaceRoutes({ client: { credentialBinding: () => 'bound' }, bridge: { async rpc(profile, method, params) {
    calls.push({ profile, method, params });
    if (lost && method === 'command.dispatch') throw new Error('Native outcome unknown');
    if (method === 'command.dispatch' && !refuse) {
      if (params.name === 'heartbeat') { const [, interval, prompt] = /^every (\d+)s ([\s\S]*)$/.exec(params.arg); control.heartbeat = { status: 'active', interval_seconds: Number(interval), prompt }; }
      if (params.name === 'goal') control.goal = { status: 'active', title: params.arg.slice(3), turns_used: 0, max_turns: 40 };
    }
    if (method === 'session.control') control.heartbeat.status = params.action.split('.')[1] === 'pause' ? 'paused' : 'active';
    return { control: structuredClone(control) };
  } } });
  const call = async (value, method = 'POST') => {
    let result;
    const query = new URLSearchParams({ profile: 'research', sessionKey: value.sessionKey });
    await route({ method, headers: {} }, {}, new URL(`http://app/api/hermes/workspace/autonomy?${query}`), { json: (_, status, body) => { result = { status, body }; }, body: async () => value });
    return result;
  };
  return { call, calls, refuse: () => { refuse = true; }, lose: () => { lost = true; } };
}
const sessionKey = hermesNativeSessionKey('research', 'owned');

test('heartbeat uses native commands and verifies the persisted state, with scoped pause/resume', async () => {
  const f = fixture();
  const result = await f.call({ sessionKey, kind: 'heartbeat', action: 'set', prompt: 'Review overdue dependencies.', intervalSeconds: 900 });
  assert.equal(result.body.control.heartbeat.interval_seconds, 900);
  assert.deepEqual(f.calls.map(c => c.method), ['session.resume', 'command.dispatch', 'session.control.read']);
  assert.ok(f.calls.every(c => c.profile === 'research' && c.params.session_id === 'owned'));
  assert.equal(f.calls[1].params.arg, 'every 900s Review overdue dependencies.');
  const pause = await f.call({ sessionKey, kind: 'heartbeat', action: 'pause' });
  assert.equal(pause.body.control.heartbeat.status, 'paused');
  const read = await f.call({ sessionKey }, 'GET'); assert.equal(read.body.control.heartbeat.status, 'paused');
});

test('goal descriptions remain literal even when beginning with a native control word', async () => {
  const f = fixture();
  const result = await f.call({ sessionKey, kind: 'goal', action: 'set', prompt: 'pause the obsolete schedule after reviewing it' });
  assert.equal(f.calls[1].params.arg, '-- pause the obsolete schedule after reviewing it');
  assert.equal(result.body.control.goal.status, 'active');
  const multiline = await f.call({ sessionKey, kind: 'goal', action: 'set', prompt: 'Review the release\nList outstanding risks' });
  assert.equal(multiline.body.control.goal.title, 'Review the release List outstanding risks');
});

test('autonomy refuses other owners, legacy conversations, invalid intervals and unconfirmed native writes', async () => {
  const f = fixture(), base = { sessionKey, kind: 'heartbeat', action: 'set', prompt: 'Check approved tasks.', intervalSeconds: 900 };
  for (const wrong of [hermesNativeSessionKey('default', 'other'), hermesSessionKey('research', 'legacy')]) await assert.rejects(f.call({ ...base, sessionKey: wrong }), { status: 400 });
  assert.equal(f.calls.length, 0);
  for (const intervalSeconds of [0, 59, 60.5, 604801, '900']) await assert.rejects(f.call({ ...base, intervalSeconds }), { status: 400 });
  assert.equal(f.calls.filter(c => c.method === 'command.dispatch').length, 0);
  f.refuse(); await assert.rejects(f.call(base), { code: 'AUTOMATION_NOT_CONFIRMED' });
  f.lose(); await assert.rejects(f.call(base), /outcome unknown/);
  assert.equal(f.calls.filter(c => c.method === 'command.dispatch').length, 2, 'no automatic replay after uncertain mutation');
});
