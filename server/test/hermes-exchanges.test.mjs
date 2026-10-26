import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HermesExchanges } from '../hermes-exchanges.mjs';
import { createHermesBotRelay } from '../hermes-bot-relay.mjs';
import { HermesRunJournal } from '../hermes-run-journal.mjs';
import { hermesSessionKey, hermesNativeSessionKey } from '../hermes-client.mjs';

const request = (to = 'writer', requestId = 'request-1') => ({ to, message: 'Review this document.', requestId, waitMs: 100 });
function fixture(exchanges = new HermesExchanges(), options = {}) {
  const calls = [], journal = new HermesRunJournal();
  const roster = ['default', 'writer', 'editor'].map(name => ({ name, displayName: name, state: 'active' }));
  let sessions = 0, runs = 0;
  const client = {
    async credentialBinding() { return 'a'.repeat(64); },
    async runtime(route, value = {}) {
      calls.push({ route, ...value });
      if (options.failAdmission && route === '/v1/runs') throw new Error('Connection lost after sending admission.');
      if (route === '/api/sessions') return { session: { id: `session-${++sessions}` } };
      if (route === '/v1/runs') return { run_id: `run-${++runs}` };
      if (route.endsWith('/messages')) return { data: [{ role: 'assistant', content: 'Completed natively.', tool_calls: [{ name: 'terminal' }] }] };
      if (route.startsWith('/v1/runs/')) return { run_id: route.split('/').at(-1), status: 'completed', output: 'Recovered reply.' };
      throw new Error(route);
    },
    async *events() { if (!options.noCompletion) yield { event: 'run.completed', output: options.output ?? 'Done.' }; },
  };
  // Use valid credentials on the wire while selecting authenticated identities server-side.
  const tokens = { ['a'.repeat(64)]: 'default', ['b'.repeat(64)]: 'writer', ['c'.repeat(64)]: 'editor' };
  const bots = { roster: () => roster, authenticate: token => roster.find(bot => bot.name === tokens[token]) };
  const actual = createHermesBotRelay({ client, exchanges, journal, bots, bridge: options.bridge });
  const send = async (input, sender = 'default') => {
    let payload;
    const token = Object.keys(tokens).find(token => tokens[token] === sender);
    await actual({ method: 'POST', headers: { authorization: `Bearer ${token}` } }, {}, new URL('http://hob.test/api/hermes/bot-relay/send'),
      { json: (_res, _status, body) => { payload = body; }, body: async () => input });
    return payload;
  };
  return { send, actual, calls, journal, exchanges, dashboard: async (suffix = '') => {
    let payload;
    await actual.dashboard({ method: 'GET' }, {}, new URL(`http://hob.test/api/hermes/exchanges${suffix}`), { json: (_res, _status, body) => { payload = body; } });
    return payload;
  } };
}

test('background sweep observes completion and wakes Main without a dashboard or waiting helper', async () => {
  const wakeups = [];
  const f = fixture(undefined, { noCompletion: true, bridge: { async rpc(profile, method, params) {
    wakeups.push({ profile, method, params });
    return { delivery_id: params.id, session_id: 'main-bot-chat', admission_id: 'native-follow-up', status: 'settled' };
  } } });
  try {
    const admitted = await f.send({ ...request(), waitMs: 0 });
    await f.actual.sweep();
    assert.equal(f.exchanges.get(admitted.id).status, 'completed');
    assert.equal(wakeups.length, 1); assert.equal(wakeups[0].profile, 'default');
    assert.equal(wakeups[0].method, 'bot_relay.deliver');
    assert.match(wakeups[0].params.message, /Recovered reply/);
    assert.equal(f.exchanges.wakeups(admitted.id)[0].status, 'completed');
    await f.actual.sweep(); assert.equal(wakeups.length, 1);
    assert.equal(f.calls.filter(call => call.route === '/v1/runs').length, 1);
  } finally { await f.actual.close(); }
});

test('duplicate concurrent submissions admit once; each distinct exchange has its own native session', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.send(request()), f.send(request())]);
  assert.equal(a.id, b.id);
  assert.equal(f.calls.filter(call => call.route === '/v1/runs').length, 1);
  const c = await f.send(request('writer', 'request-2'));
  assert.notEqual(a.sessionId, c.sessionId);
  assert.equal(f.journal.get(c.sessionKey).runId, c.runId, 'native approval and cancellation controls can find relay runs');
  await assert.rejects(f.send({ ...request(), message: 'Different work' }), error => error.code === 'RELAY_REQUEST_CONFLICT');
});

test('peer handoffs preserve ancestry and refuse circular delegation without admitting a run', async () => {
  const f = fixture();
  const parent = await f.send(request());
  const child = await f.send({ ...request('editor', 'child'), parentExchangeId: parent.id }, 'writer');
  assert.deepEqual(child.ancestry, ['default', 'writer']);
  await assert.rejects(f.send({ ...request('default', 'cycle'), sourceSession: child.sessionId }, 'editor'), error => error.code === 'RELAY_CYCLE');
  await assert.rejects(f.send({ ...request('writer', 'forged'), parentExchangeId: parent.id }, 'editor'), /does not belong/);
  assert.equal(f.calls.filter(call => call.route === '/v1/runs').length, 2);
});

test('notices attach once to a chat, remain on refresh, and do not copy into every new chat', async () => {
  const f = fixture();
  const a = await f.send(request());
  const one = hermesNativeSessionKey('default', 'first'), two = hermesNativeSessionKey('default', 'second');
  const read = session => f.dashboard(`?profile=default&session=${session}`);
  assert.equal((await read(one)).exchanges[0].id, a.id);
  assert.equal((await read(one)).exchanges.length, 1);
  assert.equal((await read(two)).exchanges.length, 0);
  const b = await f.send(request('writer', 'second-exchange'));
  assert.equal((await read(two)).exchanges[0].id, b.id);
  assert.equal((await f.dashboard('?profile=writer')).exchanges.length, 2);
  assert.equal((await f.dashboard('?profile=editor')).exchanges.length, 0);
  await assert.rejects(f.dashboard(`/${a.id}?profile=editor`), error => error.status === 404);
  const transcript = await f.dashboard(`/${a.id}/transcript?profile=default`);
  assert.equal(transcript.messages[0].tool_calls[0].name, 'terminal');
});

test('source session notices return to the originating chat instead of another open conversation', async () => {
  const f = fixture();
  await f.send({ ...request(), sourceSession: 'origin' });
  assert.equal((await f.dashboard(`?session=${hermesNativeSessionKey('default', 'other')}`)).exchanges.length, 0);
  assert.equal((await f.dashboard(`?session=${hermesNativeSessionKey('default', 'origin')}`)).exchanges.length, 1);
});

test('a restarted adapter restores exchanges and reconciles native completion without replaying work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-exchanges-'));
  let store;
  try {
    store = await HermesExchanges.open(root);
    const first = fixture(store, { noCompletion: true });
    const admitted = await first.send({ ...request(), waitMs: 0 });
    const session = hermesSessionKey('default', 'operator');
    store.timeline('default', session);
    store.close(); store = await HermesExchanges.open(root);
    const restarted = fixture(store);
    const recovered = await restarted.dashboard(`/${admitted.id}`);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.reply, 'Recovered reply.');
    assert.equal(store.timeline('default', session)[0].id, admitted.id);
    assert.equal(restarted.calls.some(call => call.method === 'POST'), false);
  } finally {
    store?.close();
    assert.equal(path.dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

test('ambiguous admission is durable and the same request never automatically replays', async () => {
  const f = fixture(undefined, { failAdmission: true });
  await assert.rejects(f.send(request()), /Connection lost/);
  const retried = await f.send(request());
  assert.equal(retried.status, 'unknown');
  assert.equal(f.calls.filter(call => call.route === '/v1/runs').length, 1);
  assert.match(retried.error, /Nothing was replayed/);
});

test('archive cursors do not drop exchanges created within the same millisecond', () => {
  const store = new HermesExchanges();
  for (let i = 0; i < 120; i++) store.create({ ...request('writer', String(i)), requestKey: String(i), from: 'default', to: 'writer' });
  const a = store.list('default'), b = store.list('default', a.at(-1).createdAt), c = store.list('default', b.at(-1).createdAt);
  assert.equal(new Set([...a, ...b, ...c].map(record => record.id)).size, 120);
  store.close();
});


test('large reply previews disclose truncation while the native transcript remains inspectable', async () => {
  const f = fixture(undefined, { output: 'a'.repeat(600000) });
  const result = await f.send(request());
  assert.equal(result.reply.length, 512000);
  assert.equal(result.replyTruncated, true);
  const transcript = await f.dashboard(`/${result.id}/transcript`);
  assert.equal(transcript.messages[0].content, 'Completed natively.');
});
