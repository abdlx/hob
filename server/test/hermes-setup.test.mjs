import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHermesSetupRoutes } from '../hermes-setup.mjs';
import { HermesError } from '../hermes-client.mjs';

let server, origin, respond;
const calls = [], revoked = new Set();
const channelCatalog = { platforms: [
  { id: 'api_server', name: 'Managed listener', env_vars: [] }, { id: 'webhook', name: 'Managed webhook', env_vars: [] },
  { id: 'telegram', name: 'Telegram', enabled: false, configured: true, state: 'disabled', env_vars: [
    { key: 'TELEGRAM_BOT_TOKEN', is_password: true, is_set: true, redacted_value: 'private-prefix', value: 'private-token' },
    { key: 'TELEGRAM_ALLOWED_USERS', is_password: false, is_list: true, value: '12345' },
    { key: 'API_SERVER_KEY', value: 'managed-private-key' },
  ] },
] };
const accountCatalog = { providers: [
  { id: 'nous', name: 'Nous', flow: 'device_code', disconnectable: true, status: { logged_in: true, token_preview: 'private-token-tail', access_token: 'private-access-token' }, disconnect_command: 'shell logout' },
  { id: 'anthropic', name: 'Anthropic', flow: 'external', status: { logged_in: false } },
] };
before(async () => {
  const handler = createHermesSetupRoutes({
    credentialBinding(profile) { if (revoked.has(profile)) throw new HermesError(404, 'Revoked bot.'); return 'bound'; },
    async dashboard(path, options) {
      calls.push({ path, ...options }); if (respond) return respond(path, options);
      if (path === '/api/messaging/platforms') return channelCatalog;
      if (path === '/api/providers/oauth') return accountCatalog;
      if (path.endsWith('/config')) return { providers: [{ name: 'Browser', post_setup: 'native-browser' }] };
      return { ok: true };
    },
  });
  server = http.createServer(async (req, res) => {
    const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const body = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); };
    try { await handler(req, res, new URL(req.url, 'http://local'), { json, body }); }
    catch (error) { json(res, error.status || 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
const request = (route, method = 'GET', value) => fetch(`${origin}/api/hermes/setup/${route}${route.includes('?') ? '&' : '?'}profile=coder`, {
  method, ...(value ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}),
});

test('voice transcription validates consent and bytes, stays scoped, and exposes only the transcript', async () => {
  const dataUrl = 'data:audio/webm;base64,' + Buffer.from('synthetic-audio-fixture').toString('base64');
  const before = calls.length;
  for (const change of [{ confirm: false }, { dataUrl: 'data:text/plain;base64,aGVsbG8=' }, { dataUrl: 'data:audio/webm;base64,abc' }, { profile: 'default' }]) {
    assert.equal((await request('audio/transcribe', 'POST', { dataUrl, confirm: true, ...change })).status, 400);
  }
  assert.equal(calls.length, before);
  respond = () => ({ ok: true, transcript: 'A test transcript', provider: 'private-provider-metadata', secret: 'must-not-leave-native' });
  try {
    for (let index = 0; index < 20; index++) {
      const response = await request('audio/transcribe', 'POST', { dataUrl, confirm: true });
      assert.deepEqual(await response.json(), { transcript: 'A test transcript' });
      assert.equal(calls.at(-1).profile, 'coder');
      assert.equal(calls.at(-1).path, '/api/audio/transcribe');
    }
  } finally { respond = undefined; }
});

test('bot preferences preserve existing prompt hints and write native language, timezone and limits explicitly', async () => {
  let saved = { agent: { environment_hint: 'Keep the operator mount instructions.' }, auxiliary: {}, timezone: '' };
  respond = (_path, options) => {
    if (options.method === 'PUT') { saved = { ...saved, ...options.body.config }; return { ok: true }; }
    return saved;
  };
  try {
    const body = { language: 'ur-Latn', timezone: 'Asia/Karachi', maxTurns: 20, runBudgetSeconds: 600, confirm: true };
    assert.equal((await request('preferences', 'PUT', body)).status, 200);
    assert.match(saved.agent.environment_hint, /Keep the operator mount instructions/);
    assert.match(saved.agent.environment_hint, /Roman Urdu/);
    assert.equal(saved.agent.max_turns, 20); assert.equal(saved.agent.run_budget_seconds, 600);
    assert.equal(saved.auxiliary.title_generation.language, 'Roman Urdu (Urdu written in Latin script)');
    assert.equal((await request('preferences', 'PUT', { ...body, timezone: 'not/a/timezone' })).status, 400);
    assert.equal((await request('preferences', 'PUT', { ...body, maxTurns: -1 })).status, 400);
    assert.equal((await request('preferences', 'PUT', { ...body, confirm: false })).status, 400);
  } finally { respond = undefined; }
});

test('native model catalog includes setup skeletons and excludes ambient account adoption without a write', async () => {
  assert.equal((await request('models')).status, 200);
  assert.deepEqual(calls.at(-1), { path: '/api/model/options', profile: 'coder', query: { include_unconfigured: true, explicit_only: true, refresh: false } });
  assert.equal((await request('models?refresh=true')).status, 200); assert.equal(calls.at(-1).query.refresh, true);
  const count = calls.length; assert.equal((await request('models?refresh=garbage')).status, 400); assert.equal(calls.length, count);
});
test('tool enable requires explicit confirmation and disable remains a native profile-scoped write', async () => {
  const count = calls.length;
  assert.equal((await request('tools/browser', 'PUT', { enabled: true })).status, 400);
  assert.equal((await request('tools/browser', 'PUT', { enabled: 'true', confirm: true })).status, 400);
  assert.equal(calls.length, count);
  for (const enabled of [true, false]) {
    assert.equal((await request('tools/browser', 'PUT', { enabled, ...(enabled ? { confirm: true } : {}) })).status, 200);
    assert.deepEqual(calls.at(-1).body, { enabled, profile: 'coder' });
  }
});
test('tool credentials reject managed environment values, placeholders and profile overrides', async () => {
  const count = calls.length;
  for (const env of [{ API_SERVER_KEY: 'secret' }, { PATH: 'other' }, { HERMES_HOME: 'other' }, { TAVILY_API_KEY: '[stored credential]' }, { TAVILY_API_KEY: 123 }]) assert.equal((await request('tools/web/credentials', 'PUT', { env })).status, 400);
  assert.equal((await request('tools/web/credentials', 'PUT', { profile: 'default', env: { TAVILY_API_KEY: 'synthetic' } })).status, 400);
  assert.equal(calls.length, count);
  assert.equal((await request('tools/web/credentials', 'PUT', { env: { TAVILY_API_KEY: 'synthetic' } })).status, 200);
  assert.deepEqual(calls.at(-1), { path: '/api/tools/toolsets/web/env', profile: 'coder', method: 'PUT', body: { env: { TAVILY_API_KEY: 'synthetic' }, profile: 'coder' } });
});
test('native tool provider and per-capability settings preserve the selected owner', async () => {
  assert.equal((await request('tools/web/provider', 'PUT', { provider: 'Free Search', capability: 'search' })).status, 200);
  assert.deepEqual(calls.at(-1).body, { provider: 'Free Search', capability: 'search', profile: 'coder' });
  assert.equal((await request('tools/web/provider', 'PUT', { provider: 'Free Search', capability: 'shell' })).status, 400);
});
test('dependency setup requires confirmation and a key belonging to that toolset', async () => {
  const count = calls.length;
  assert.equal((await request('tools/browser/install', 'POST', { key: 'native-browser' })).status, 400);
  assert.equal(calls.length, count);
  assert.equal((await request('tools/browser/install', 'POST', { key: 'other-tool', confirm: true })).status, 400);
  assert.equal((await request('tools/browser/install', 'POST', { key: 'native-browser', confirm: true })).status, 202);
  assert.equal(calls.at(-1).path, '/api/tools/toolsets/browser/post-setup');
});
test('channel forms expose status and allowed IDs while excluding secrets, prefixes and managed listeners', async () => {
  const result = await (await request('channels')).json();
  assert.equal(result.platforms.length, 1); assert.equal(result.platforms[0].id, 'telegram');
  assert.equal(result.platforms[0].env_vars.length, 2);
  assert.equal(result.platforms[0].env_vars[1].value, '12345');
  assert.equal(JSON.stringify(result).includes('private'), false);
  const count = calls.length;
  for (const id of ['api_server', 'webhook']) assert.equal((await request(`channels/${id}`, 'PUT', { enabled: true, confirm: true })).status, 404);
  assert.equal(calls.length, count);
});
test('channel field saving does not enable a channel and enabling requires a separate confirmed action', async () => {
  assert.equal((await request('channels/telegram', 'PUT', { env: { TELEGRAM_BOT_TOKEN: 'synthetic' } })).status, 200);
  assert.deepEqual(calls.at(-1).body, { env: { TELEGRAM_BOT_TOKEN: 'synthetic' }, profile: 'coder' });
  const count = calls.length;
  assert.equal((await request('channels/telegram', 'PUT', { enabled: true })).status, 400);
  assert.equal((await request('channels/telegram', 'PUT', { clear_env: ['TELEGRAM_BOT_TOKEN'] })).status, 400);
  assert.equal(calls.length, count);
  assert.equal((await request('channels/telegram', 'PUT', { enabled: true, confirm: true })).status, 200);
  assert.deepEqual(calls.at(-1).body, { enabled: true, profile: 'coder' });
});
test('account catalogs never expose token fragments or commands', async () => {
  const result = await (await request('accounts')).json();
  assert.equal(result.providers[0].status.logged_in, true);
  assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(JSON.stringify(result).includes('shell'), false);
});
test('model catalog projects choices without inline credentials or arbitrary provider metadata', async () => {
  respond = () => ({ provider: 'custom:local', model: 'test', providers: [{ slug: 'custom:local', name: 'Local', api_key: 'private-key', key_env: 'LOCAL_KEY', models: [{ id: 'test', name: 'Test', token: 'private-token' }] }] });
  try {
    const result = await (await request('models')).json();
    assert.deepEqual(result.providers[0], { slug: 'custom:local', name: 'Local', key_env: 'LOCAL_KEY', models: [{ id: 'test', name: 'Test' }] });
    assert.equal(JSON.stringify(result).includes('private'), false);
  } finally { respond = undefined; }
});
test('device login must be confirmed and external CLI login cannot be started through this adapter', async () => {
  const count = calls.length;
  assert.equal((await request('accounts/nous/start', 'POST', {})).status, 400); assert.equal(calls.length, count);
  assert.equal((await request('accounts/anthropic/start', 'POST', { confirm: true })).status, 400);
  respond = path => path === '/api/providers/oauth' ? accountCatalog : { session_id: 'session-one', flow: 'device_code', user_code: 'TEST-CODE', verification_url: 'https://provider.example/device', device_code: 'private-device-code', access_token: 'private-access-token' };
  try {
    const result = await (await request('accounts/nous/start', 'POST', { confirm: true })).json();
    assert.equal(result.user_code, 'TEST-CODE'); assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(calls.at(-1).profile, 'coder');
  } finally { respond = undefined; }
});
test('OAuth polling, cancellation and confirmed disconnect retain native profile ownership with no replay', async () => {
  respond = () => ({ session_id: 'session-one', status: 'approved', token: 'private-token' });
  try {
    const result = await (await request('accounts/nous/poll/session-one')).json();
    assert.deepEqual(result, { session_id: 'session-one', status: 'approved' }); assert.equal(calls.at(-1).profile, 'coder');
    assert.equal((await request('accounts/sessions/session-one', 'DELETE')).status, 200);
    assert.equal(calls.at(-1).path, '/api/providers/oauth/sessions/session-one');
    const count = calls.length; assert.equal((await request('accounts/nous', 'DELETE', {})).status, 400); assert.equal(calls.length, count);
    assert.equal((await request('accounts/nous', 'DELETE', { confirm: true })).status, 200);
  } finally { respond = undefined; }
});
test('MCP inventory hides endpoint credentials, arguments and environment value previews', async () => {
  respond = () => ({ servers: [{ name: 'docs', transport: 'http', auth: 'header', enabled: true, source: 'config',
    url: 'https://service.invalid/private-token', command: 'private-command', args: ['private-argument'], env: { TOKEN: 'private-tail' } }] });
  try {
    const result = await (await request('mcp')).json();
    assert.deepEqual(result, { servers: [{ name: 'docs', transport: 'http', auth: 'header', enabled: true, source: 'config', envKeys: ['TOKEN'], argumentCount: 1 }] });
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(calls.at(-1).path, '/api/mcp/servers'); assert.equal(calls.at(-1).profile, 'coder');
  } finally { respond = undefined; }
});

test('MCP creation requires explicit authorization and preserves native profile and credential ownership', async () => {
  const count = calls.length;
  assert.equal((await request('mcp', 'POST', { name: 'docs', url: 'https://service.invalid/mcp' })).status, 400);
  assert.equal(calls.length, count);
  const create = { name: 'docs', url: 'https://service.invalid/mcp', auth: 'header', bearer_token: 'synthetic-mcp-credential', confirm: true };
  assert.equal((await request('mcp', 'POST', create)).status, 201);
  assert.deepEqual(calls.at(-1), { path: '/api/mcp/servers', profile: 'coder', method: 'POST', body: { name: 'docs', url: create.url, auth: 'header', bearer_token: create.bearer_token, profile: 'coder' } });
  const local = { name: 'local', command: 'npx', args: ['-y', 'example-mcp'], env: { MCP_KEY: 'synthetic-key' }, confirm: true };
  assert.equal((await request('mcp', 'POST', local)).status, 201);
  assert.deepEqual(calls.at(-1).body, { name: 'local', command: 'npx', args: local.args, env: local.env, auth: 'none', profile: 'coder' });
});

test('MCP malformed transports, unsafe URL schemes and profile or deployment overrides fail before native writes', async () => {
  const count = calls.length;
  for (const value of [
    {}, { url: 'javascript:alert(1)' }, { url: 'https://user:password@example.invalid/mcp' }, { url: 'https://example.invalid/#fragment' },
    { url: 'https://example.invalid/', command: 'npx' }, { command: 'npx', args: 'not-a-list' },
    { command: 'npx', env: { API_SERVER_KEY: 'managed' } }, { command: 'npx', env: { PATH: 'managed' } },
    { command: 'npx', auth: 'header', bearer_token: 'secret' }, { url: 'https://example.invalid/', auth: 'header', bearer_token: '[stored credential]' },
    { url: 'https://example.invalid/', env: { TOKEN: 'secret' } }, { url: 'https://example.invalid/', profile: 'default' },
    { url: 'https://example.invalid/', extra: true },
  ]) assert.equal((await request('mcp', 'POST', { name: 'docs', confirm: true, ...value })).status, 400);
  assert.equal(calls.length, count);
});

test('MCP enable, probe and removal are deliberate native operations without broad configuration replacement', async () => {
  const count = calls.length;
  assert.equal((await request('mcp/docs/enabled', 'PUT', { enabled: true })).status, 400);
  assert.equal((await request('mcp/docs/test', 'POST', {})).status, 400);
  assert.equal((await request('mcp/docs', 'DELETE', {})).status, 400);
  assert.equal(calls.length, count);
  assert.equal((await request('mcp/docs/enabled', 'PUT', { enabled: false })).status, 200);
  assert.deepEqual(calls.at(-1).body, { enabled: false, profile: 'coder' });
  assert.equal((await request('mcp/docs/enabled', 'PUT', { enabled: true, confirm: true })).status, 200);
  respond = () => ({ ok: false, error: 'private-credential-from-server', tools: [] });
  try {
    const probe = await (await request('mcp/docs/test', 'POST', { confirm: true })).json();
    assert.equal(probe.ok, false); assert.equal(JSON.stringify(probe).includes('private-credential'), false);
    assert.equal(calls.at(-1).path, '/api/mcp/servers/docs/test');
  } finally { respond = undefined; }
  assert.equal((await request('mcp/docs', 'DELETE', { confirm: true })).status, 200);
  assert.equal(calls.at(-1).path, '/api/mcp/servers/docs'); assert.equal(calls.at(-1).method, 'DELETE');
});

test('existing MCP names are encoded exactly once and cannot become paths or native query overrides', async () => {
  const name = 'docs.api@team?profile=default';
  assert.equal((await request(`mcp/${encodeURIComponent(name)}/enabled`, 'PUT', { enabled: false })).status, 200);
  assert.equal(calls.at(-1).path, `/api/mcp/servers/${encodeURIComponent(name)}/enabled`);
  assert.equal(calls.at(-1).profile, 'coder');
  const count = calls.length;
  assert.equal((await request('mcp/docs%2Fother/enabled', 'PUT', { enabled: false })).status, 400);
  assert.equal(calls.length, count);
});

test('revocation prevents setup reads and writes before native state is accessed', async () => {
  revoked.add('coder'); const count = calls.length;
  try { for (const route of ['models', 'tools', 'channels', 'accounts', 'mcp']) assert.equal((await request(route)).status, 404); }
  finally { revoked.delete('coder'); }
  assert.equal(calls.length, count);
});
