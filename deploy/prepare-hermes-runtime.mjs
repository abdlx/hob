import { setTimeout as delay } from 'node:timers/promises';
import { HermesClient } from '../server/hermes-client.mjs';

// Multiplexed Hermes reads credentials from the selected profile's secret
// scope. A process environment export alone cannot enable its API listener.
// Let the upstream credential lifecycle own persistence and cache invalidation.
export async function prepareHermesRuntime({ dashboardUrl, dashboardToken, apiKey, signal,
  timeoutMs = 120000, pollMs = 500, fetchImpl = globalThis.fetch }) {
  const client = new HermesClient({ dashboardUrl, dashboardToken, apiKey, fetchImpl, timeoutMs: 5000 });
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const health = await client.dashboard('/api/health', { signal });
      if (health?.ok === true) { ready = true; break; }
    } catch (error) {
      signal?.throwIfAborted();
      if (error.status !== 503) throw error;
    }
    await delay(pollMs, undefined, { signal });
  }
  if (!ready) throw new Error('Hermes settings did not become ready to provision the local runtime.');
  await client.dashboard('/api/env', { method: 'PUT', profile: 'default', signal,
    body: { key: 'API_SERVER_KEY', value: apiKey, profile: 'default' } });
}
