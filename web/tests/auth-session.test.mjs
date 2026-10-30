import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, chatApi, ApiError } from '../src/services/api.ts';

function fixture(t, status) {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  const calls = [], events = [];
  globalThis.window = { dispatchEvent: event => events.push(event.type) };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/auth/status') {
      if (status instanceof Error) throw status;
      return Response.json({ authenticated: status });
    }
    return Response.json({ error: 'Provider credentials rejected' }, { status: 401 });
  };
  t.after(() => { globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; });
  return { calls, events };
}
const rejected = error => error instanceof ApiError && error.status === 401 && error.message === 'Provider credentials rejected';

test('provider 401s preserve the login and the original error without retrying mutations', async t => {
  const state = fixture(t, true);
  await assert.rejects(apiFetch('/api/provider', { method: 'POST', body: '{}' }), rejected);
  assert.deepEqual(state.calls.map(call => call.url), ['/api/provider', '/api/auth/status']);
  assert.deepEqual(state.events, []);
});

test('a confirmed expired login dispatches unauthorized once for concurrent failures', async t => {
  const state = fixture(t, false);
  const results = await Promise.allSettled([apiFetch('/api/provider'), apiFetch('/api/other-provider')]);
  assert.ok(results.every(result => result.status === 'rejected' && rejected(result.reason)));
  assert.equal(state.calls.filter(call => call.url === '/api/auth/status').length, 1);
  assert.deepEqual(state.events, ['hob:unauthorized']);
});

test('an unreachable status endpoint does not log out the user', async t => {
  const state = fixture(t, new TypeError('Offline'));
  await assert.rejects(apiFetch('/api/provider'), rejected);
  assert.deepEqual(state.events, []);
});

test('wrong login credentials do not trigger a session expiry check', async t => {
  const state = fixture(t, false);
  await assert.rejects(apiFetch('/api/auth/login', { method: 'POST', body: '{}' }), rejected);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.events, []);
});

test('streamed chat submission checks login before treating a provider 401 as expiry', async t => {
  const state = fixture(t, true);
  await assert.rejects(chatApi.forProfile('default').sendMessage('session', 'Hello'), rejected);
  assert.deepEqual(state.calls.map(call => call.url), ['/api/sessions/session/turns', '/api/auth/status']);
  assert.deepEqual(state.events, []);
});
