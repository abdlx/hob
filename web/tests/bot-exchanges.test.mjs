import assert from 'node:assert/strict';
import test from 'node:test';
import { exchangeMessages, exchangeThreads } from '../src/services/bot-exchanges.ts';

test('one link per bot pair follows the newest exchange in either direction', () => {
  const forward = { id: 'first', from: 'default', to: 'writer', createdAt: 1 };
  const reverse = { id: 'reverse', from: 'writer', to: 'default', createdAt: 3 };
  const other = { id: 'other', from: 'default', to: 'editor', createdAt: 2 };
  assert.deepEqual(exchangeThreads([reverse, forward, other], 'default'), [reverse, other]);
  assert.deepEqual(exchangeThreads([forward, reverse], 'writer'), [reverse]);
});

test('overlapping handoffs read as one chronological conversation', () => {
  const rows = [{ id: 'a', createdAt: 1, replyAt: 4, updatedAt: 10 }, { id: 'b', createdAt: 2, replyAt: 3 }];
  assert.deepEqual(exchangeMessages(rows).map(row => `${row.record.id}-${row.part}`), ['a-request', 'b-request', 'b-reply', 'a-reply']);
});
