import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hermesWorkspaceApi } from '../src/services/hermes-workspace.ts';
import { chatApi } from '../src/services/api.ts';
import { schedulePreviewTime } from '../src/services/schedule-time.ts';

test('schedule previews show the bot timezone across a DST transition and preserve fallback offsets', () => {
  assert.match(schedulePreviewTime('2027-03-14T13:00:00Z', 'America/New_York', 'en-GB'), /09:00:00/);
  assert.match(schedulePreviewTime('2027-11-07T14:00:00Z', 'America/New_York', 'en-GB'), /09:00:00/);
  assert.equal(schedulePreviewTime('2027-03-14T09:00:00-04:00', 'server local timezone'), '2027-03-14T09:00:00-04:00');
  assert.equal(schedulePreviewTime('invalid', 'UTC'), 'Unavailable');
});

test('workspace actions keep their captured bot after switching and cannot override it through query or headers', async t => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: new URL(url, 'http://local'), options }); return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); };
  t.after(() => { globalThis.fetch = original; chatApi.setProfile('default'); });
  const api = hermesWorkspaceApi('coder'); chatApi.setProfile('default');
  await api('jobs', { headers: { 'X-Hob-Profile': 'default' } }, { profile: 'default', name: 'a&profile=default' });
  assert.equal(calls[0].url.pathname, '/api/hermes/workspace/jobs');
  assert.equal(calls[0].url.searchParams.get('profile'), 'coder');
  assert.equal(calls[0].url.searchParams.get('name'), 'a&profile=default');
  assert.equal(new Headers(calls[0].options.headers).get('X-Hob-Profile'), 'coder');
  assert.throws(() => hermesWorkspaceApi('all/../default'));
});
