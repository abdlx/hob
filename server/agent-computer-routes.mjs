import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { WebSocketServer, WebSocket } from 'ws';
import { HermesError, hermesProfile } from './hermes-client.mjs';

const BASE = '/api/hermes/agent-computer';
const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');
const computerId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw invalid('Select a computer explicitly.');
  return value;
};
function endpoint(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error();
    if (url.pathname === '/') url.pathname = '/mcp';
    return url;
  } catch { throw invalid('Configure an HTTP or HTTPS computer endpoint without embedded credentials.'); }
}
function profileFrom(url) {
  const values = url.searchParams.getAll('profile');
  if (values.length > 1) throw invalid('Select one bot.');
  const profile = hermesProfile(values[0] ?? 'default');
  if (profile === 'all') throw invalid('Select one bot.');
  return profile;
}
const project = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const publicComputer = value => value && typeof value === 'object' ? {
  ...project(value, ['id', 'name', 'state', 'cpuMillis', 'memoryMb']),
  ...(value.health ? { health: project(value.health, ['ok', 'display', 'screen', 'cursor', 'control', 'counters', 'browser_engine']) } : {}),
} : null;

/** Explicit per-profile configuration. No baked-in endpoint, credential or computer identity. */
export function createAgentComputerRoutes({ client, hermesHome, authenticated = () => false,
  assertOrigin = () => { throw new Error('Origin authority is unavailable.'); }, knownBot, env = process.env, fetchImpl = fetch } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const upstreams = new Set();
  const authorize = async profile => {
    if (knownBot && !await knownBot(profile)) throw new HermesError(404, 'This bot is not enrolled.', 'BOT_NOT_FOUND');
    if (client?.credentialBinding) await client.credentialBinding(profile);
  };
  async function getAgentComputerConfig(profile = 'default') {
    hermesProfile(profile);
    await authorize(profile);
    let config;
    if (hermesHome) {
      try {
        const root = await realpath(hermesHome);
        const expected = profile === 'default' ? root : path.join(root, 'profiles', profile);
        const home = await realpath(expected);
        if (home !== expected) throw new Error('Invalid profile home.');
        const filename = await realpath(path.join(home, 'config.yaml'));
        const relative = path.relative(home, filename);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid config path.');
        const info = await stat(filename);
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid config file.');
        const document = parseDocument(await readFile(filename, 'utf8'), { uniqueKeys: true, prettyErrors: false, logLevel: 'silent' });
        if (document.errors.length) throw new Error('Invalid config syntax.');
        const native = document.toJS({ maxAliasCount: 50 });
        config = native?.mcp_servers?.agent_computer ?? native?.mcp_servers?.['agent-computer'];
      } catch (error) {
        if (error.code !== 'ENOENT') throw new HermesError(503, 'The selected bot’s computer configuration could not be read safely.', 'COMPUTER_CONFIG_INVALID');
      }
    }
    // Environment configuration belongs only to Main, never to another bot.
    if (!config && profile === 'default' && env.AGENT_COMPUTER_URL) config = { url: env.AGENT_COMPUTER_URL, bearer_token: env.AGENT_COMPUTER_TOKEN || '' };
    if (!config || config.enabled === false) return { connected: false };
    const url = endpoint(config.url);
    const authorization = config.headers?.Authorization ?? config.headers?.authorization ?? '';
    const token = config.bearer_token ?? (/^Bearer\s+(.+)$/i.exec(authorization)?.[1]) ?? '';
    if (typeof token !== 'string' || token.length > 8192 || /[\r\n]|\$\{|\[stored credential\]/.test(token)) throw invalid('Configure a resolved computer credential for this bot.');
    return { connected: true, serverName: 'agent_computer', mcpUrl: url.href, origin: url.origin, token };
  }
  async function callMcpTool(cfg, name, args = {}) {
    // A timeout can happen after a wake/sleep completed. Never replay it at a
    // fallback URL or through another protocol after an ambiguous result.
    try {
      const response = await fetchImpl(cfg.mcpUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Remote request failed.'); }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 1024 * 1024) throw new Error('Response too large.');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (data.error || data.result?.isError || !data.result) throw new Error('Remote tool failed.');
      const content = data.result.content?.find(item => item.type === 'text')?.text;
      return content ? JSON.parse(content) : data.result;
    } catch { throw new HermesError(502, 'The configured computer service did not confirm the request. Refresh its status before retrying.', 'COMPUTER_REQUEST_UNCONFIRMED'); }
  }
  async function route(req, res, url, { json, body }) {
    if (!url.pathname.startsWith(BASE + '/')) return false;
    if (!authenticated(req)) throw new HermesError(401, 'Sign in to hob.', 'UNAUTHORIZED');
    const send = (status, value) => { json(res, status, value); return true; };
    const profile = profileFrom(url), cfg = await getAgentComputerConfig(profile);
    if (url.pathname === BASE + '/status' && req.method === 'GET') {
      if (!cfg.connected) return send(200, { configured: false, connected: false });
      try {
        const result = await callMcpTool(cfg, 'computer_list');
        const computers = Array.isArray(result) ? result : result?.computers;
        if (!Array.isArray(computers)) throw new Error('Invalid computer list.');
        const active = computers[0];
        const detail = active ? await callMcpTool(cfg, 'computer_status', { computer: computerId(active.id) }) : null;
        const current = detail?.computer || detail;
        if (current?.id !== undefined && current.id !== active?.id) throw new Error('The computer service returned another identity.');
        return send(200, { configured: true, connected: true, serverName: cfg.serverName, origin: cfg.origin,
          vncToken: cfg.token, computers: computers.map(publicComputer).filter(Boolean), computer: active ? publicComputer({ ...active, ...current }) : null });
      } catch { return send(200, { configured: true, connected: false, error: 'The configured computer service is unavailable. Refresh before retrying.' }); }
    }
    const action = new RegExp(`^${BASE}/(wake|sleep)$`).exec(url.pathname);
    if (action && req.method === 'POST') {
      assertOrigin(req);
      if (!cfg.connected) throw invalid('Configure this bot’s computer connection first.');
      const value = await body(req);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'computerId')) throw invalid('Select a computer explicitly.');
      await callMcpTool(cfg, `computer_${action[1]}`, { computer: computerId(value.computerId) });
      return send(200, { ok: true });
    }
    return false;
  }
  function upgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://hob.local'); } catch { return false; }
    if (url.pathname !== BASE + '/vnc') return false;
    let profile, id;
    try {
      if (req.method !== 'GET' || !authenticated(req)) throw new Error('Unauthorized.');
      assertOrigin(req); profile = profileFrom(url);
      if (url.searchParams.getAll('computerId').length !== 1) throw invalid('Select one computer.');
      id = computerId(url.searchParams.get('computerId'));
    } catch { socket.destroy(); return true; }
    void (async () => {
      const cfg = await getAgentComputerConfig(profile);
      if (!cfg.connected || socket.destroyed) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, downstream => {
        const target = new URL(`/api/computers/${encodeURIComponent(id)}/vnc`, cfg.origin);
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
        if (cfg.token) target.searchParams.set('token', cfg.token);
        const upstream = new WebSocket(target, ['binary'], { handshakeTimeout: 15000,
          ...(cfg.token ? { headers: { Authorization: `Bearer ${cfg.token}` } } : {}) });
        upstreams.add(upstream);
        const pending = []; let pendingBytes = 0;
        const cleanup = () => { pending.length = 0; upstreams.delete(upstream); upstream.terminate(); downstream.terminate(); };
        downstream.on('message', (message, binary) => {
          if (upstream.readyState === WebSocket.OPEN) {
            if (upstream.bufferedAmount > 4 * 1024 * 1024) return cleanup();
            upstream.send(message, { binary });
          } else if (upstream.readyState === WebSocket.CONNECTING) {
            pendingBytes += message.length;
            if (pendingBytes > 1024 * 1024) return cleanup();
            pending.push({ message, binary });
          }
        });
        upstream.on('open', () => { for (const item of pending.splice(0)) upstream.send(item.message, { binary: item.binary }); pendingBytes = 0; });
        upstream.on('message', (message, binary) => {
          if (downstream.readyState !== WebSocket.OPEN) return;
          if (downstream.bufferedAmount > 4 * 1024 * 1024) return cleanup();
          downstream.send(message, { binary });
        });
        downstream.on('close', cleanup); downstream.on('error', cleanup);
        upstream.on('close', cleanup); upstream.on('error', cleanup);
      });
    })().catch(() => socket.destroy());
    return true;
  }
  const close = () => { for (const socket of upstreams) socket.terminate(); for (const socket of wss.clients) socket.terminate(); wss.close(); };
  return { route, upgrade, getAgentComputerConfig, close };
}
