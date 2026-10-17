import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hermesSetupApi, setupLink } from '../src/services/hermes-setup.ts';
import { chatApi } from '../src/services/api.ts';

test('provider links cannot execute scripts or disclose embedded credentials', () => {
  assert.equal(setupLink('javascript:alert(1)'), undefined); assert.equal(setupLink('data:text/html,proof'), undefined);
  assert.equal(setupLink('https://name:password@provider.example/device'), undefined);
  assert.equal(setupLink('https://provider.example/device?user_code=TEST'), 'https://provider.example/device?user_code=TEST');
});
test('setup forms keep writes on their captured profile even after switching bots', async t => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: new URL(url, 'http://local'), options }); return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); };
  t.after(() => { globalThis.fetch = original; chatApi.setProfile('default'); });
  const api = hermesSetupApi('coder'); chatApi.setProfile('default');
  await api('tools/web/credentials', { method: 'PUT', body: JSON.stringify({ env: { TAVILY_API_KEY: 'synthetic' } }) });
  assert.equal(calls[0].url.searchParams.get('profile'), 'coder'); assert.equal(new Headers(calls[0].options.headers).get('X-Hob-Profile'), 'coder');
  assert.throws(() => hermesSetupApi('all'));
});
