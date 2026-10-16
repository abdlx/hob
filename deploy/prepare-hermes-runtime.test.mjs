import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareHermesRuntime } from './prepare-hermes-runtime.mjs';

const options = { dashboardUrl: 'http://127.0.0.1:8080', dashboardToken: 'synthetic-dashboard-token',
  apiKey: 'synthetic-runtime-api-key-with-enough-entropy', pollMs: 1 };

test('runtime provisioning waits for settings then uses its authenticated native credential lifecycle', async () => {
  const requests = [];
  await prepareHermesRuntime({ ...options, fetchImpl: async (url, request) => {
    requests.push({ url: String(url), ...request });
    if (requests.length === 1) throw new TypeError('not listening yet');
    return Response.json({ ok: true });
  } });
  assert.equal(requests.length, 3);
  assert.equal(new URL(requests[2].url).pathname, '/api/env');
  assert.equal(requests[2].method, 'PUT');
  assert.equal(requests[2].headers['X-Hermes-Session-Token'], options.dashboardToken);
  assert.deepEqual(JSON.parse(requests[2].body), { key: 'API_SERVER_KEY', value: options.apiKey, profile: 'default' });
});

test('rejected provisioning is never retried and prevents runtime launch', async () => {
  let writes = 0;
  await assert.rejects(prepareHermesRuntime({ ...options, fetchImpl: async (_url, request) => {
    if (request.method !== 'PUT') return Response.json({ ok: true });
    writes++;
    return Response.json({ error: 'synthetic rejection' }, { status: 403 });
  } }), /rejected the request/);
  assert.equal(writes, 1);
});

test('cancellation stops settings polling before any credential write', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(prepareHermesRuntime({ ...options, signal: controller.signal, fetchImpl: async () => {
    calls++; controller.abort(); throw new TypeError('cancelled');
  } }));
  assert.equal(calls, 1);
});
