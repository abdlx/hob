import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hermesWorkspaceApi } from '../src/services/hermes-workspace.ts';
import { chatApi } from '../src/services/api.ts';

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
