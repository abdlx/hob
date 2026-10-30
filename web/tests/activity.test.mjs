import assert from 'node:assert/strict';
import test from 'node:test';
import { activityFeed, activityNeedsAttention, activityOriginLabel } from '../src/services/activity.ts';

const item = (changes = {}) => ({ id: 'historical-run', title: 'Old failure', timestamp: '', status: 'failed',
  origin: { kind: 'scheduled-job', profile: 'writer', sessionId: 'run-1', jobId: 'job-1', historical: true, jobState: 'deleted', inventoryStatus: 'verified', ...changes } });

test('verified deleted historical jobs retain failed status and leave current attention', () => {
  const history = item();
  assert.equal(activityNeedsAttention(history), false);
  assert.equal(history.status, 'failed');
  assert.equal(activityOriginLabel(history), 'Historical run · Job deleted');
  assert.equal(activityNeedsAttention(item({ historical: false })), true);
  assert.equal(activityNeedsAttention(item({ inventoryStatus: 'unavailable' })), true);
  assert.equal(activityNeedsAttention(item({ jobId: null })), true);
});

test('unavailable, unlinked and present failures remain discoverable with honest labels', () => {
  for (const [changes, label] of [[{ jobState: 'unavailable' }, 'Job status unavailable'], [{ jobState: 'unlinked', jobId: null }, 'Unlinked historical entry'], [{ jobState: 'present' }, 'Job exists']]) {
    assert.equal(activityNeedsAttention(item(changes)), true);
    assert.ok(activityOriginLabel(item(changes)).includes(label));
  }
  assert.equal(activityNeedsAttention({ ...item(), status: 'completed' }), false);
});

test('legacy arrays stay compatible and malformed feeds cannot silently erase Activity', () => {
  const rows = [item()];
  assert.deepEqual(activityFeed(rows), { items: rows, warnings: [] });
  assert.throws(() => activityFeed({ items: [], warnings: [{}] }), /invalid feed/);
  const feed = { items: rows, warnings: ['Scheduler unavailable'] };
  assert.equal(activityFeed(feed), feed);
});
