// Image-level proof with the owned synthetic model. This is deliberately opt-in
// on fresh disposable smoke homes; it must never be pointed at a user's data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SMOKE_MODEL, SMOKE_RELAY_PROMPT, SMOKE_RELAY_REPLY, SMOKE_WORKER_REPLY, SMOKE_WORKER_ID,
  SMOKE_WAKE_REPLY, SMOKE_HEARTBEAT_PROMPT, SMOKE_HEARTBEAT_REPLY } from './smoke-model.mjs';

export async function proactiveFirstBoot({ api, request, workspace, retry, check, modelUrl }) {
  // The worker has its own native profile and listener/relay credentials.
  const worker = await api('/api/hermes/profiles', 'POST', { name: SMOKE_WORKER_ID, soul: 'Disposable proactive smoke worker. Return the synthetic task result.' });
  assert.equal(worker.state, 'active');
  const endpoint = await api(`/api/hermes/custom-endpoints?profile=${SMOKE_WORKER_ID}`, 'POST', { name: 'Isolated proactive worker', model: SMOKE_MODEL, base_url: modelUrl, api_key: 'synthetic-local-smoke-key', make_default: false }, SMOKE_WORKER_ID);
  assert.equal(typeof endpoint.id, 'string');
  const model = await api(`/api/hermes/model?profile=${SMOKE_WORKER_ID}`, 'POST', { scope: 'main', provider: endpoint.id, model: SMOKE_MODEL, base_url: modelUrl }, SMOKE_WORKER_ID);
  check('the relay worker uses the isolated synthetic provider', model.ok === true && model.base_url === modelUrl);
  await retry('the native relay worker authority', async () => { assert.equal((await api('/api/readiness', 'GET', undefined, SMOKE_WORKER_ID)).ready, true); });
  const conversation = await api('/api/sessions', 'POST', { title: 'Proactive container proof', agentId: 'default' });
  const before = new Set((await api('/api/hermes/exchanges?profile=default')).exchanges.map(row => row.id));
  const response = await request(`/api/sessions/${conversation.id}/turns`, 'POST', { content: SMOKE_RELAY_PROMPT, idempotencyKey: randomUUID() });
  check('the real Hermes terminal admits an asynchronous relay request', response.ok);
  const stream = await response.text();
  check('the helper sends without a listener key in its terminal environment', stream.includes(SMOKE_RELAY_REPLY) && stream.includes('event: done') && !stream.includes('event: error'), stream.slice(-1600));
  const exchange = await retry('the background exchange and coordinator follow-up', async () => {
    const row = (await api('/api/hermes/exchanges?profile=default')).exchanges.find(item => !before.has(item.id) && item.to === SMOKE_WORKER_ID);
    assert.ok(row);
    const detail = await api(`/api/hermes/exchanges/${row.id}?profile=default`);
    assert.equal(detail.status, 'completed'); assert.ok(detail.reply.includes(SMOKE_WORKER_REPLY));
    assert.equal(detail.wakeups.length, 1); assert.equal(detail.wakeups[0].status, 'completed');
    return detail;
  });
  const wake = exchange.wakeups[0];
  const history = await api(`/api/sessions/${wake.sessionKey}/messages`);
  check('Main actually executes the native Bot Chat follow-up', history.some(row => row.role === 'assistant' && row.content.includes(SMOKE_WAKE_REPLY)));
  check('the exchange produces one coordinator notification', history.filter(row => row.role === 'user' && row.content.includes(`[HOB background result; exchange ${exchange.id}]`)).length === 1);

  await workspace('autonomy', 'POST', { sessionKey: conversation.id, kind: 'heartbeat', action: 'set', prompt: SMOKE_HEARTBEAT_PROMPT, intervalSeconds: 60 });
  await retry('a real native heartbeat turn', async () => {
    const { control } = await workspace('autonomy', 'GET', undefined, 'default', { sessionKey: conversation.id });
    assert.ok(control.heartbeat?.fire_count >= 1);
    const messages = await api(`/api/sessions/${conversation.id}/messages`);
    assert.ok(messages.some(row => row.role === 'assistant' && row.content.includes(SMOKE_HEARTBEAT_REPLY)));
  }, 180000);
  const paused = await workspace('autonomy', 'POST', { sessionKey: conversation.id, kind: 'heartbeat', action: 'pause' });
  check('a real native heartbeat fires and can be paused', paused.control.heartbeat.status === 'paused');
  return { exchangeId: exchange.id, wakeId: wake.id, wakeSession: wake.sessionKey, conversation: conversation.id, fireCount: paused.control.heartbeat.fire_count };
}

export async function proactiveAfterRestart({ saved, api, workspace, check }) {
  const exchange = await api(`/api/hermes/exchanges/${saved.exchangeId}?profile=default`);
  check('the completed follow-up remains settled after recreation', exchange.status === 'completed' && exchange.wakeups.length === 1 && exchange.wakeups[0].id === saved.wakeId && exchange.wakeups[0].status === 'completed');
  const history = await api(`/api/sessions/${saved.wakeSession}/messages`);
  check('recreation does not duplicate coordinator notifications', history.filter(row => row.role === 'user' && row.content.includes(`[HOB background result; exchange ${saved.exchangeId}]`)).length === 1);
  const { control } = await workspace('autonomy', 'GET', undefined, 'default', { sessionKey: saved.conversation });
  check('paused native heartbeat state survives recreation', control.heartbeat?.status === 'paused' && control.heartbeat.fire_count === saved.fireCount);
}
