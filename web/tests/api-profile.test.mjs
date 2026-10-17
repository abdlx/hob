import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatApi } from '../src/services/api.ts';

test('captured bot clients keep requests and credentials scoped after the selector changes', async t => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, profile: new Headers(options.headers).get('X-Hob-Profile'), body: options.body });
    return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; chatApi.setProfile('default'); });
  chatApi.setProfile('default'); const main = chatApi.forProfile();
  chatApi.setProfile('coder'); const coder = chatApi.forProfile();
  await Promise.all([main.getSessions(), coder.getSessions()]);
  chatApi.setProfile('default'); await coder.resolveSecurityApproval('coder-approval', 'approved');
  assert.deepEqual(calls.map(call => call.profile), ['default', 'coder', 'coder']);
  assert.match(calls.at(-1).url, /coder-approval/);
});

test('a conversation submission carries its captured profile and stable request key exactly once', async t => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, profile: new Headers(options.headers).get('X-Hob-Profile'), body: JSON.parse(options.body) });
    return new Response('event: done\ndata: {"message":{"id":"reply","role":"assistant","content":"Done","timestamp":"","status":"complete"}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  t.after(() => { globalThis.fetch = original; chatApi.setProfile('default'); });
  const api = chatApi.forProfile('coder'); chatApi.setProfile('default');
  assert.equal((await api.sendMessage('coder-session', 'Do work', undefined, 'stable-submission')).content, 'Done');
  assert.equal(calls.length, 1); assert.equal(calls[0].profile, 'coder');
  assert.deepEqual(calls[0].body, { content: 'Do work', idempotencyKey: 'stable-submission' });
});
