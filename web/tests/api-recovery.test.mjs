import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFetch, chatApi } from '../src/services/api.ts';
import { isConnectionError } from '../src/services/errors.ts';

test('temporary HTML proxy failures retry safe reads and return the recovered data', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => ++calls < 3 ? new Response('<h1>Bad gateway</h1>', { status: 502 }) : Response.json({ restored: true });
  assert.deepEqual(await apiFetch('/api/sessions'), { restored: true });
  assert.equal(calls, 3);
});

test('an uncertain mutation is attempted once and tells the operator to check its status', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('proxy failure', { status: 502 }); };
  await assert.rejects(apiFetch('/api/sessions', { method: 'POST', body: '{}' }), error =>
    isConnectionError(error) && /may have reached the server/.test(error.message) && !/502|Bad Gateway/i.test(error.message));
  assert.equal(calls, 1);
});

test('aborting a read during backoff cancels its remaining attempts', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => { calls++; queueMicrotask(() => controller.abort()); return new Response('', { status: 503 }); };
  await assert.rejects(apiFetch('/api/sessions', { signal: controller.signal }));
  assert.equal(calls, 1);
});

test('confirmed provider and validation failures stay actionable and are never treated as disconnects', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: 'Choose a model before saving.' }, { status: 422 }); };
  await assert.rejects(apiFetch('/api/model', { method: 'POST', body: '{}' }), error => !isConnectionError(error) && /Choose a model/.test(error.message));
  assert.equal(calls, 1);
});

test('losing acknowledgement of a native task never retries its submission', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch'); };
  await assert.rejects(chatApi.forProfile('default').sendMessage('saved-chat', 'Do the approved task'),
    error => isConnectionError(error) && /may have reached the server/.test(error.message));
  assert.equal(calls, 1);
});

test('an application save error preserves its explanation and unsaved-state guidance', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: 'This setting could not be persisted.' }, { status: 502 }); };
  await assert.rejects(apiFetch('/api/config', { method: 'PUT', body: '{}' }), /could not be persisted.*Check its current status/);
  assert.equal(calls, 1);
});
