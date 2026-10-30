import assert from 'node:assert/strict';
import test from 'node:test';
import { hermesActivityFeed } from '../hermes-activity.mjs';
import { hermesNativeSessionKey } from '../hermes-client.mjs';

const scheduled = (changes = {}) => ({ sessionId: 'cron-run', title: 'Historical failed run', timestamp: 1793358000, status: 'failed',
  origin: { kind: 'scheduled-job', profile: 'writer', sessionId: 'cron-run', jobId: 'job-1', executionId: 'fire-1', jobState: 'deleted',
    historical: true, observedAt: '2026-10-30T13:40:00Z', inventoryStatus: 'verified', nativeStatus: 'failed', statusSource: 'execution-ledger', ...changes } });
const direct = { id: hermesNativeSessionKey('writer', 'direct-chat'), title: 'Direct chat', timestamp: '2026-10-30T13:41:00Z', status: 'failed' };

test('timeline combines trusted same-bot scheduler provenance and relay/session origins without rewriting failures', async () => {
  const calls = [];
  const client = { async dashboard(...args) { calls.push(args); return { items: [scheduled()], nextOffset: null }; } };
  const feed = await hermesActivityFeed(client, 'writer', [direct], { sessionKind: () => 'relay' });
  assert.deepEqual(calls, [['/api/hob/activity', { profile: 'writer', query: { limit: 100 }, timeoutMs: 5000 }]]);
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items.find(item => item.title === direct.title).origin.kind, 'relay');
  const history = feed.items.find(item => item.title === 'Historical failed run');
  assert.equal(history.status, 'failed');
  assert.equal(history.origin.jobState, 'deleted');
  assert.equal(history.origin.profile, 'writer');
  assert.deepEqual(feed.warnings, []);
});

test('inventory outages, unlinked legacy entries and disabled existing jobs retain distinct provenance', async () => {
  for (const changes of [{ jobState: 'unavailable', inventoryStatus: 'unavailable' }, { jobState: 'unlinked', jobId: null }, { jobState: 'present' }]) {
    const feed = await hermesActivityFeed({ dashboard: async () => ({ items: [scheduled(changes)], nextOffset: null }) }, 'writer', []);
    assert.equal(feed.items[0].status, 'failed');
    assert.equal(feed.items[0].origin.jobState, changes.jobState);
    assert.deepEqual(feed.warnings, []);
  }
});

test('failed/malformed/wrong-bot lookups keep the original entries and expose incomplete history', async () => {
  for (const input of [{}, { items: [scheduled({ profile: 'default' })], nextOffset: null }, { items: [scheduled({ inventoryStatus: 'unavailable' })], nextOffset: null }]) {
    const feed = await hermesActivityFeed({ dashboard: async () => input }, 'writer', [direct]);
    assert.equal(feed.items.length, 1); assert.equal(feed.items[0].status, 'failed');
    assert.match(feed.warnings.join(' '), /unavailable.*incomplete/);
    assert.equal(feed.items[0].origin.jobState, undefined);
  }
  const outage = await hermesActivityFeed({ dashboard: async () => { throw new Error('PRIVATE_PROVIDER_DETAIL'); } }, 'writer', [direct]);
  assert.doesNotMatch(JSON.stringify(outage), /PRIVATE_PROVIDER_DETAIL/);
  await assert.rejects(hermesActivityFeed({}, 'default', [direct]), /another bot/);
});

test('conflicting scheduler completion cannot turn a recorded failure into success or duplicate it', async () => {
  const cron = scheduled(); cron.sessionId = 'direct-chat'; cron.origin.sessionId = 'direct-chat'; cron.status = 'completed';
  const feed = await hermesActivityFeed({ dashboard: async () => ({ items: [cron], nextOffset: 100 }) }, 'writer', [direct]);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].id, direct.id);
  assert.equal(feed.items[0].status, 'failed');
  assert.match(feed.warnings.join(' '), /original failed outcome/);
  assert.equal(feed.nextScheduledOffset, 100);
});
