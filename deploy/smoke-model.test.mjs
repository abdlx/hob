import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSmokeModel, SMOKE_SKILL_PROMPT, SMOKE_SKILL_REPLY, SMOKE_SKILL_NAME, SMOKE_RELAY_PROMPT, SMOKE_RELAY_REPLY,
  SMOKE_WORKER_PROMPT, SMOKE_WORKER_REPLY, SMOKE_WAKE_REPLY, SMOKE_HEARTBEAT_PROMPT, SMOKE_HEARTBEAT_REPLY } from './smoke-model.mjs';

test('the learning probe issues a real skill tool call and only reports staging for an actual pending receipt', async t => {
  const server = createSmokeModel();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const call = async messages => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST',
      body: JSON.stringify({ messages, tools: [{ type: 'function', function: { name: 'skill_manage' } }] }) });
    assert.equal(response.status, 200); return (await response.json()).choices[0].message;
  };
  const messages = [{ role: 'user', content: SMOKE_SKILL_PROMPT }];
  const initial = await call(messages);
  assert.equal(initial.tool_calls[0].function.name, 'skill_manage');
  assert.equal(JSON.parse(initial.tool_calls[0].function.arguments).operations[0].name, SMOKE_SKILL_NAME);
  for (const content of ['{}', '{"success":true}', '{"staged":true,"pending_id":"malformed"}', 'not-json']) {
    assert.equal((await call([...messages, { role: 'tool', tool_call_id: 'hob-smoke-skill', content }])).content, 'HOB_CONTAINER_SKILL_NOT_STAGED');
  }
  const completed = await call([...messages, { role: 'tool', tool_call_id: 'hob-smoke-skill', content: '{"staged":true,"pending_id":"0123abcd"}' }]);
  assert.equal(completed.content, SMOKE_SKILL_REPLY + ':0123abcd');
  const metadata = await call([...messages, { role: 'user', content: 'A different metadata request.' }]);
  assert.equal(metadata.content, 'Synthetic smoke metadata.');
});

test('proactive fixture issues a real relay tool and distinguishes worker, coordinator and heartbeat turns', async t => {
  const server = createSmokeModel(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const call = async messages => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages, tools: [{ function: { name: 'terminal' } }] }) });
    return (await response.json()).choices[0].message;
  };
  const prompt = [{ role: 'user', content: SMOKE_RELAY_PROMPT }];
  const initial = await call(prompt);
  assert.equal(initial.tool_calls[0].function.name, 'terminal');
  assert.match(JSON.parse(initial.tool_calls[0].function.arguments).command, /env -u API_SERVER_KEY -u HOB_TALK_TOKEN/);
  assert.equal((await call([...prompt, { role: 'tool', tool_call_id: 'hob-smoke-relay', content: 'The relay failed' }])).content, 'HOB_PROACTIVE_RELAY_NOT_CONFIRMED');
  assert.equal((await call([...prompt, { role: 'tool', tool_call_id: 'hob-smoke-relay', content: 'Exchange: 00000000-0000-4000-8000-000000000000 (running)' }])).content, SMOKE_RELAY_REPLY);
  assert.equal((await call([{ role: 'user', content: SMOKE_WORKER_PROMPT }])).content, SMOKE_WORKER_REPLY);
  assert.equal((await call([{ role: 'user', content: `[HOB background result; exchange 123]\n${SMOKE_WORKER_PROMPT}` }])).content, SMOKE_WAKE_REPLY);
  assert.equal((await call([{ role: 'user', content: SMOKE_HEARTBEAT_PROMPT }])).content, SMOKE_HEARTBEAT_REPLY);
});
