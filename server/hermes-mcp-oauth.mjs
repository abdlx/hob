import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { HermesError, hermesResource } from './hermes-client.mjs';

const CALLBACK = '/api/mcp/oauth/callback/';
const TTL = 15 * 60 * 1000;
const statuses = new Set(['starting', 'authorization_required', 'approved', 'error']);
const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');
const missing = () => new HermesError(404, 'This sign-in attempt is unavailable or expired. Start a new attempt from Settings.', 'MCP_OAUTH_EXPIRED');
const equal = (left, right) => timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
const serverRevision = server => createHash('sha256').update(JSON.stringify(
  ['name', 'transport', 'url', 'command', 'auth', 'enabled', 'source', 'plugin'].map(key => server?.[key] ?? null),
)).digest('hex');

export function mcpOAuthOrigin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

/** Presentation bridge only. Hermes owns OAuth state/PKCE validation and tokens. */
export function createHermesMcpOAuth(client, { publicUrl, now = Date.now } = {}) {
  const origin = mcpOAuthOrigin(publicUrl);
  const flows = new Map();
  const prune = () => { for (const [id, flow] of flows) if (flow.expires <= now()) flows.delete(id); };
  const binding = async flow => {
    if (flow.binding !== await client.credentialBinding(flow.profile)) throw missing();
  };
  const owned = async (id, profile) => {
    prune();
    const flow = flows.get(id);
    if (!flow || flow.profile !== profile) throw missing();
    await binding(flow);
    return flow;
  };
  const project = flow => ({
    id: flow.id, serverName: flow.name, status: flow.status, expiresAt: flow.expires, canClose: Boolean(flow.nativeId),
    ...(flow.authorizationUrl ? { authorizationUrl: flow.authorizationUrl } : {}),
    ...(flow.status === 'error' ? { error: 'Hermes could not complete this sign-in attempt. Check the server setup, or cancel before starting again.' } : {}),
    ...(flow.status === 'unknown' ? { error: 'The sign-in start outcome is unknown. It was not retried. Wait for this attempt to expire before starting again.' } : {}),
  });
  const update = (flow, result) => {
    if (result?.flow_id !== flow.nativeId || result.server_name !== flow.name || !statuses.has(result.status)) {
      throw new HermesError(502, 'Hermes returned an invalid MCP sign-in response.', 'HERMES_PROTOCOL_ERROR');
    }
    let authorizationUrl, state;
    if (result.status === 'authorization_required') {
      try {
        const url = new URL(result.authorization_url);
        const redirect = new URL(url.searchParams.get('redirect_uri'));
        state = url.searchParams.get('state');
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
          || url.href.length > 16000 || url.searchParams.getAll('state').length !== 1
          || !state || state.length > 2048 || url.searchParams.getAll('redirect_uri').length !== 1
          || redirect.origin !== origin || redirect.username || redirect.password || redirect.search || redirect.hash
          || !redirect.pathname.startsWith(CALLBACK) || decodeURIComponent(redirect.pathname.slice(CALLBACK.length)) !== flow.name) throw new Error();
        authorizationUrl = url.href;
      } catch {
        throw new HermesError(502, 'Hermes returned an unsafe or unreachable sign-in callback. Check the public URL and this server’s redirect URI.', 'MCP_OAUTH_CALLBACK_MISMATCH');
      }
    }
    // A repeated pending snapshot must not authorize a second delivery. Hermes
    // may publish a fresh state on a later attempt within the same native flow.
    if (state && !flow.seenStates.has(state)) {
      if (flow.seenStates.size >= 128) throw new HermesError(502, 'Too many native sign-in attempts. Cancel this flow.', 'HERMES_PROTOCOL_ERROR');
      flow.seenStates.add(state);
    }
    flow.state = state;
    flow.authorizationUrl = authorizationUrl;
    flow.status = result.status;
    return project(flow);
  };
  const start = async (name, profile) => {
    if (!origin) throw new HermesError(503, 'Set HOB_PUBLIC_URL to this dashboard’s HTTP(S) origin before starting MCP sign-in.', 'MCP_OAUTH_PUBLIC_URL_REQUIRED');
    const currentBinding = await client.credentialBinding(profile);
    const encoded = hermesResource(name);
    const inventory = await client.dashboard('/api/mcp/servers', { profile });
    const server = inventory.servers?.find(item => item.name === name);
    if (!server || server.source === 'plugin' || server.plugin || server.transport === 'stdio' || server.auth !== 'oauth') {
      throw invalid('Choose this bot’s configured remote OAuth MCP server.');
    }
    if (currentBinding !== await client.credentialBinding(profile)) throw missing();
    prune();
    if ([...flows.values()].some(flow => flow.profile === profile && flow.name === name && !flow.cancelled)) {
      throw new HermesError(409, 'Close the existing sign-in attempt before starting another.', 'MCP_OAUTH_IN_PROGRESS');
    }
    if (flows.size >= 32) throw new HermesError(429, 'Too many sign-in attempts. Wait for an earlier attempt to expire.', 'MCP_OAUTH_LIMIT');
    const flow = { id: randomUUID(), nativeId: null, name, profile, binding: currentBinding, expires: now() + TTL, status: 'unknown',
      serverRevision: serverRevision(server), seenStates: new Set(), usedStates: new Set(), readSequence: 0 };
    // Reserve before the write, including when its reply is lost. Never replay
    // an uncertain auth start or adopt a flow created by another bot/client.
    flows.set(flow.id, flow);
    let result;
    try { result = await client.dashboard(`/api/mcp/servers/${encoded}/auth`, { profile, method: 'POST' }); }
    catch (error) {
      // Native precondition refusals are known non-admissions. An unavailable
      // service or lost/malformed reply remains fenced; neither is retried.
      if ([400, 403, 404, 409, 422, 429].includes(error.status)) flows.delete(flow.id);
      if (error.status === 409) throw new HermesError(409, 'Hermes still has a sign-in attempt for this server. Wait for it to finish or expire before starting again.', 'MCP_OAUTH_IN_PROGRESS');
      if (error.status === 429) throw new HermesError(429, 'Hermes has too many sign-ins in progress. Wait for an earlier attempt to finish before trying again.', 'MCP_OAUTH_LIMIT');
      throw error;
    }
    if (typeof result?.flow_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.flow_id)) {
      throw new HermesError(502, 'Hermes returned an invalid MCP sign-in identifier.', 'HERMES_PROTOCOL_ERROR');
    }
    flow.nativeId = result.flow_id;
    await binding(flow);
    return update(flow, result);
  };
  const list = async profile => {
    prune();
    const result = [];
    for (const flow of flows.values()) if (flow.profile === profile && !flow.cancelled) { await binding(flow); result.push(project(flow)); }
    return { flows: result };
  };
  const poll = async (id, profile) => {
    const flow = await owned(id, profile);
    if (flow.cancelled || !flow.nativeId) return project(flow);
    const sequence = ++flow.readSequence;
    const result = await client.dashboard(`/api/mcp/oauth/flows/${hermesResource(flow.nativeId)}`, { profile });
    await binding(flow);
    // A poll already in flight cannot reopen a cancelled attempt.
    return flow.cancelled || sequence !== flow.readSequence ? project(flow) : update(flow, result);
  };
  const cancel = async (id, profile) => {
    const flow = await owned(id, profile);
    if (flow.cancelled) return project(flow);
    if (!flow.nativeId) throw new HermesError(409, 'The native attempt identifier is unknown. Wait for this attempt to expire.', 'MCP_OAUTH_UNKNOWN');
    flow.cancelled = true; flow.state = undefined; flow.authorizationUrl = undefined; flow.status = 'cancelled';
    // This only closes the attempt. It does not revoke already-saved tokens.
    await client.dashboard(`/api/mcp/oauth/flows/${hermesResource(flow.nativeId)}`, { profile, method: 'DELETE' });
    return project(flow);
  };
  const callback = async (req, res, url) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>MCP sign-in</title><h1>${text}</h1><p>Return to Settings to check the sign-in status. You can close this tab.</p></html>`); };
    try {
      if (req.method !== 'GET') return send(405, 'This callback requires a provider redirect.');
      if (!origin || url.search.length > 12000) throw invalid('Invalid callback.');
      const values = {};
      for (const [key, value] of url.searchParams) {
        if (!['state', 'code', 'error', 'iss', 'error_description', 'error_uri'].includes(key) || key in values || value.length > (key === 'code' ? 8192 : 2048)) throw invalid('Invalid callback.');
        values[key] = value;
      }
      if (!values.state || Boolean(values.code) === Boolean(values.error)) throw invalid('Invalid callback.');
      const name = decodeURIComponent(url.pathname.slice(CALLBACK.length));
      hermesResource(name);
      prune();
      const flow = [...flows.values()].find(item => !item.cancelled && item.name === name && item.state && equal(item.state, values.state));
      if (!flow) throw missing();
      if (flow.usedStates.has(values.state)) return send(409, 'This callback has already been received.');
      await binding(flow);
      const inventory = await client.dashboard('/api/mcp/servers', { profile: flow.profile });
      if (serverRevision(inventory.servers?.find(item => item.name === flow.name)) !== flow.serverRevision) throw missing();
      await binding(flow);
      if (flow.cancelled || !flow.state || !equal(flow.state, values.state) || flow.usedStates.has(values.state) || flow.expires <= now()) throw missing();
      flow.usedStates.add(values.state);
      const query = Object.fromEntries(['code', 'state', 'error', 'iss'].filter(key => values[key]).map(key => [key, values[key]]));
      await client.mcpOAuthCallback(flow.name, { profile: flow.profile, query });
      return send(200, 'Authorization received.');
    } catch (error) {
      return send([400, 403, 404, 409].includes(error.status) ? error.status : 502, 'This sign-in callback could not be accepted.');
    }
  };
  return { start, list, poll, cancel, callback };
}
