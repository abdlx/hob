import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHermesChatPreviews } from '../hermes-chat-previews.mjs';

test('unopened bot previews read the last visible message by activity, keeping bot histories separate', async () => {
  const calls = [];
  const preview = createHermesChatPreviews({ async runtime(route, options) {
    calls.push({ route, ...options });
    if (route === '/api/sessions') return { data: [
      { id: 'new-but-quiet', source: 'gui', started_at: 20, last_active: 20, message_count: 1 },
      { id: 'tool-worker', source: 'tool', last_active: 99, message_count: 10 },
      { id: 'hidden', source: 'gui', hidden: true, last_active: 99, message_count: 10 },
      { id: 'empty', source: 'gui', last_active: 99, message_count: 0 },
      { id: 'older-active', source: 'gui', started_at: 10, last_active: 30, message_count: 4 },
    ] };
    assert.equal(route, '/api/sessions/older-active/messages');
    assert.deepEqual(options.query, { limit: 500, order: 'latest' });
    return { data: [
      { role: 'user', content: 'Please check this.' },
      { role: 'assistant', content: [{ type: 'text', text: `${options.profile} finished the report successfully.` }] },
      { role: 'tool', content: 'Private tool output must not replace the reply.' },
      { role: 'assistant', content: '' },
    ] };
  } });
  assert.equal(await preview('writer'), 'writer finished the report successfully.');
  assert.equal(await preview('default'), 'default finished the report successfully.');
  assert.equal(await preview('writer'), 'writer finished the report successfully.');
  assert.equal(calls.filter(call => call.route.endsWith('/messages')).length, 2);
  assert.ok(calls.every(call => !call.method || call.method === 'GET'));
});

test('empty chats have no preview and a failed read can be retried', async () => {
  let failing = true;
  const preview = createHermesChatPreviews({ async runtime() {
    if (failing) throw new Error('Offline');
    return { data: [] };
  } });
  await assert.rejects(preview('writer'), /Offline/);
  failing = false;
  assert.equal(await preview('writer'), '');
});
