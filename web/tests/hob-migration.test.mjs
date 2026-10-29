import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateHobPreferences } from '../src/services/hob-storage.ts';
import { conversationDate } from '../src/services/conversation-date.ts';

test('existing browser preferences migrate once and preserve canonical choices', t => {
  const previous = globalThis.localStorage;
  const values = new Map([['mused-bots-sidebar-open', 'true'], ['mused-notifications', 'false'], ['mused-contrast', 'high'], ['hob-contrast', 'normal']]);
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  migrateHobPreferences(); migrateHobPreferences();
  assert.deepEqual(Object.fromEntries(values), { 'hob-contrast': 'normal', 'hob-bots-sidebar-open': 'true', 'hob-notifications': 'false' });
  globalThis.localStorage.getItem = () => { throw Error('Storage denied'); };
  assert.doesNotThrow(migrateHobPreferences);
});

test('conversation dates are readable, bounded, and tolerate malformed history', () => {
  assert.equal(conversationDate('invalid'), 'Unknown date');
  assert.doesNotMatch(conversationDate('2026-10-29T08:00:00Z'), /T08:00/);
});
