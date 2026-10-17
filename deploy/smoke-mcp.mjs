// Isolated OAuth/MCP protocol peer for release verification. Never a production service.
import { createHash, randomUUID } from 'node:crypto';

const ACCESS = 'synthetic-container-mcp-access-token';
export function createMcpOAuthFixture({ baseUrl } = {}) {
  const clients = new Map(), codes = new Map();
  return async (req, res) => {
    const base = baseUrl || `http://127.0.0.1:${req.socket.localPort}`;
    const url = new URL(req.url, base);
    if (!url.pathname.startsWith('/oauth/') && !url.pathname.startsWith('/.well-known/') && url.pathname !== '/mcp') return false;
    const json = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); return true; };
    const read = async () => {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 64000) throw new Error('Fixture input too large.'); chunks.push(chunk); }
      return Buffer.concat(chunks).toString();
    };
    if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, { resource: base + '/mcp', authorization_servers: [base], scopes_supported: ['mcp:tools'], bearer_methods_supported: ['header'] });
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: base, authorization_endpoint: base + '/oauth/authorize', token_endpoint: base + '/oauth/token',
        registration_endpoint: base + '/oauth/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp:tools'] });
    }
    try {
      if (req.method === 'POST' && url.pathname === '/oauth/register') {
        const input = JSON.parse(await read());
        if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length) return json(400, { error: 'invalid_client_metadata' });
        const client_id = 'smoke-' + randomUUID();
        clients.set(client_id, input.redirect_uris);
        return json(201, { ...input, client_id, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: 'none' });
      }
      if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
        const p = url.searchParams;
        if (!clients.get(p.get('client_id'))?.includes(p.get('redirect_uri')) || p.get('response_type') !== 'code'
          || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('state')) return json(400, { error: 'invalid_request' });
        const code = randomUUID();
        codes.set(code, { client: p.get('client_id'), redirect: p.get('redirect_uri'), challenge: p.get('code_challenge') });
        const target = new URL(p.get('redirect_uri'));
        target.searchParams.set('code', code); target.searchParams.set('state', p.get('state')); target.searchParams.set('iss', base);
        res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store' }); res.end(); return true;
      }
      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        const p = new URLSearchParams(await read()), code = codes.get(p.get('code'));
        codes.delete(p.get('code'));
        if (!code || p.get('grant_type') !== 'authorization_code' || p.get('client_id') !== code.client || p.get('redirect_uri') !== code.redirect
          || createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== code.challenge) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600, scope: 'mcp:tools' }, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/mcp') {
        if (req.headers.authorization !== `Bearer ${ACCESS}`) return json(401, { error: 'authorization_required' }, {
          'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        });
        if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405); res.end(); return true; }
        if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
        const input = JSON.parse(await read());
        if (input.id === undefined) { res.writeHead(202); res.end(); return true; }
        let result;
        switch (input.method) {
          case 'initialize': result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'hob-smoke-mcp', version: '1.0.0' } }; break;
          case 'tools/list': result = { tools: [{ name: 'smoke_echo', description: 'Isolated smoke capability.', inputSchema: { type: 'object', properties: {} } }] }; break;
          case 'tools/call': result = { content: [{ type: 'text', text: 'Synthetic MCP tool result.' }] }; break;
          case 'resources/list': result = { resources: [] }; break;
          case 'prompts/list': result = { prompts: [] }; break;
          case 'ping': result = {}; break;
          default: return json(200, { jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'Unknown fixture method.' } });
        }
        return json(200, { jsonrpc: '2.0', id: input.id, result });
      }
    } catch { return json(400, { error: 'invalid_fixture_request' }); }
    return json(404, { error: 'unknown_fixture_route' });
  };
}
