import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createMcpOAuthFixture } from './smoke-mcp.mjs';

test('the isolated MCP peer requires a real single-use authorization code and matching PKCE proof', async t => {
  const handler = createMcpOAuthFixture();
  const server = createServer((req, res) => void handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const before = await fetch(origin + '/mcp'); assert.equal(before.status, 401);
  assert.ok(before.headers.get('www-authenticate').includes('/.well-known/oauth-protected-resource'));
  const registration = await fetch(origin + '/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://dashboard.example/callback'] }) });
  const { client_id } = await registration.json();
  const verifier = 'synthetic-pkce-verifier-with-enough-characters-for-a-real-flow';
  const authorize = async () => {
    const p = new URLSearchParams({ client_id, redirect_uri: 'https://dashboard.example/callback', response_type: 'code', state: 'synthetic-state',
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const response = await fetch(origin + '/oauth/authorize?' + p, { redirect: 'manual' });
    assert.equal(response.status, 302); return new URL(response.headers.get('location')).searchParams.get('code');
  };
  const exchange = (code, code_verifier) => fetch(origin + '/oauth/token', { method: 'POST', body: new URLSearchParams({
    code, code_verifier, client_id, grant_type: 'authorization_code', redirect_uri: 'https://dashboard.example/callback',
  }) });
  assert.equal((await exchange(await authorize(), 'wrong-proof')).status, 400);
  const code = await authorize(), exchanged = await exchange(code, verifier);
  assert.equal(exchanged.status, 200);
  const { access_token } = await exchanged.json();
  assert.equal((await exchange(code, verifier)).status, 400);
  const tools = await fetch(origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await tools.json()).result.tools[0].name, 'smoke_echo');
});
