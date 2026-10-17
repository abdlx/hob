import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsStoredSecret, redactHermesSettings, STORED_SECRET } from '../hermes-settings.mjs';

test('inline credentials are masked recursively without exposing credential prefixes', () => {
  const settings = {
    model: { provider: 'custom', api_key: 'synthetic-model-key' },
    custom_providers: [{ name: 'local', apiKey: 'synthetic-provider-key' }],
    memory: { provider: 'builtin' }, token_budget: 2048,
    proxy: { credential_source: 'env', password: 'synthetic-password' },
  };
  const publicSettings = redactHermesSettings(settings);
  assert.deepEqual(publicSettings, {
    model: { provider: 'custom', api_key: STORED_SECRET },
    custom_providers: [{ name: 'local', apiKey: STORED_SECRET }],
    memory: { provider: 'builtin' }, token_budget: 2048,
    proxy: { credential_source: 'env', password: STORED_SECRET },
  });
  assert.equal(settings.model.api_key, 'synthetic-model-key');
  assert.equal(JSON.stringify(publicSettings).includes('synthetic-'), false);
  assert.equal(redactHermesSettings({ api_key_preview: 'synthetic-prefix-preview' }).api_key_preview, STORED_SECRET);
});

test('a stored-secret placeholder can never become an actual saved credential', () => {
  for (const value of [STORED_SECRET, { model: { api_key: STORED_SECRET } }, [{ token: STORED_SECRET }]]) {
    assert.equal(containsStoredSecret(value), true);
  }
  for (const value of [null, {}, [], { token: 'new-explicit-value' }, { enabled: false }]) {
    assert.equal(Boolean(containsStoredSecret(value)), false);
  }
});

test('credential arrays and authorization headers cannot leak through the configuration editor', () => {
  const settings = { api_keys: ['secret-a', 'secret-b'],
    custom_providers: [{ extra_headers: { Authorization: 'Bearer header-secret', 'X-API-Key': 'header-key' } }],
    mcp_servers: { service: { env: { SERVICE_TOKEN: 'mcp-secret' } } }, max_tokens: 2048 };
  const publicSettings = redactHermesSettings(settings);
  assert.equal(publicSettings.api_keys, STORED_SECRET);
  assert.equal(publicSettings.custom_providers[0].extra_headers.Authorization, STORED_SECRET);
  assert.equal(publicSettings.custom_providers[0].extra_headers['X-API-Key'], STORED_SECRET);
  assert.equal(publicSettings.mcp_servers.service.env.SERVICE_TOKEN, STORED_SECRET);
  assert.equal(publicSettings.max_tokens, 2048);
  for (const value of ['secret-a', 'secret-b', 'header-secret', 'header-key', 'mcp-secret']) {
    assert.equal(JSON.stringify(publicSettings).includes(value), false);
  }
});
