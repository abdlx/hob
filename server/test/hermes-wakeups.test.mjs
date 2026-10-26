import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HermesExchanges } from '../hermes-exchanges.mjs';
import { createHermesWakeups } from '../hermes-wakeups.mjs';

const roster = ['default', 'research', 'writer'].map(name => ({ name, state: 'active' }));
const bots = { roster: () => roster };
const complete = (store, input = {}) => {
  const row = store.create({ requestKey: crypto.randomUUID(), from: 'default', fromName: 'Main', to: 'research', toName: 'Research', message: 'Find the answer.', wakeOnComplete: true, ...input });
  return store.update(row.id, { status: 'completed', reply: 'Verified result.' });
};

test('terminal outcome atomically creates one bounded wake per caller and coordinator, without retroactive work', () => {
  const store = new HermesExchanges();
  try {
    const row = complete(store);
    store.update(row.id, { status: 'completed', reply: 'Do not create another wake.' });
    const wakes = store.wakeups(row.id);
    assert.equal(wakes.length, 1); assert.equal(wakes[0].profile, 'default');
    assert.match(wakes[0].id, /^[a-f0-9]{64}$/);
    assert.equal('message' in wakes[0], false, 'metadata never copies task text into the UI');
    assert.match(store.dueWakeups()[0].message, /Verified result/);
    assert.doesNotMatch(store.dueWakeups()[0].message, /Do not create another wake/);
    const peer = complete(store, { from: 'writer' });
    assert.deepEqual(new Set(store.wakeups(peer.id).map(w => w.profile)), new Set(['default', 'writer']));
    const legacy = complete(store, { wakeOnComplete: false });
    assert.deepEqual(store.wakeups(legacy.id), []);
    const large = complete(store, { message: '😀'.repeat(64000) });
    store.update(large.id, { reply: '😀'.repeat(512000) });
    assert.ok(Buffer.byteLength(store.dueWakeups().find(w => w.exchangeId === large.id).message) < 200000);
  } finally { store.close(); }
});

test('lost wake acknowledgement and restart reuse the same durable delivery without another inference identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-wakeups-'));
  let store = await HermesExchanges.open(root);
  try {
    const row = complete(store), ids = [], executions = new Set(), watched = [];
    let lost = true, settled = false;
    const bridge = { async rpc(profile, method, params) {
      assert.equal(profile, 'default'); assert.equal(method, 'bot_relay.deliver');
      ids.push(params.id); executions.add(params.id);
      if (lost) { lost = false; throw new Error('Acknowledgement lost after native commit'); }
      return { delivery_id: params.id, session_id: 'coordinator', admission_id: 'native-once', status: settled ? 'settled' : 'queued' };
    } };
    let run = createHermesWakeups({ bridge, bots, exchanges: store });
    await run();
    const first = store.wakeups(row.id)[0];
    assert.equal(first.status, 'pending'); assert.equal(first.attempts, 1); assert.match(first.error, /Acknowledgement lost/);
    store.close(); store = await HermesExchanges.open(root);
    store.updateWakeup(first.id, { nextAt: 0 });
    run = createHermesWakeups({ bridge, bots, exchanges: store, onAdmission: key => watched.push(key) });
    await run();
    assert.equal(store.wakeups(row.id)[0].status, 'admitted');
    settled = true; store.updateWakeup(first.id, { nextAt: 0 }); await run();
    assert.equal(store.wakeups(row.id)[0].status, 'completed');
    assert.equal(executions.size, 1); assert.equal(new Set(ids).size, 1);
    assert.equal(watched.length, 2);
    assert.equal(store.dueWakeups(Number.MAX_SAFE_INTEGER).length, 0);
  } finally {
    store.close(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true });
  }
});

test('unknown execution and revocation stop retries instead of inventing a new delivery', async () => {
  const store = new HermesExchanges();
  try {
    const row = complete(store);
    const run = createHermesWakeups({ exchanges: store, bots, bridge: { async rpc() { throw Object.assign(new Error('Inspect the canonical receipt'), { code: 'unknown_execution' }); } } });
    await run(); assert.equal(store.wakeups(row.id)[0].status, 'unknown');
    assert.equal(store.dueWakeups(Number.MAX_SAFE_INTEGER).length, 0);
    const revoked = complete(store, { from: 'retired', to: 'default' });
    await run(); assert.equal(store.wakeups(revoked.id)[0].status, 'cancelled');
  } finally { store.close(); }
});
