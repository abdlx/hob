import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { WebSocketServer, WebSocket } from 'ws';
import { HermesError, hermesProfile } from './hermes-client.mjs';
import { normalizeOrigin } from '../portal/src/credential-vault.mjs';

// Portal speaks the same MCP + REST + VNC surface as Agent Computer, so one
// parameterized bridge serves both. A source with no configuration reports
// connected:false and its viewer hides, so a bot with only one computer
// shows only that one.
const SOURCES = {
  hob_computer: { base: '/api/hermes/hob-computer', configKeys: ['hob_computer'], serverName: 'hob_computer' },
  agent_computer: { base: '/api/hermes/agent-computer', configKeys: ['agent_computer', 'agent-computer'], envUrl: 'AGENT_COMPUTER_URL', envToken: 'AGENT_COMPUTER_TOKEN', serverName: 'agent_computer' },
  portal: { base: '/api/hermes/portal', configKeys: ['portal'], envUrl: 'PORTAL_URL', envToken: 'PORTAL_TOKEN', serverName: 'portal' },
};
const sourceFor = pathname => Object.entries(SOURCES).find(([, source]) => pathname.startsWith(source.base + '/'))?.[0] || null;
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
  assertOrigin = () => { throw new Error('Origin authority is unavailable.'); }, knownBot, roster = () => [], nativePortal, onComputerChanged, env = process.env, fetchImpl = fetch } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const upstreams = new Set();
  const authorize = async profile => {
    if (knownBot && !await knownBot(profile)) throw new HermesError(404, 'This bot is not enrolled.', 'BOT_NOT_FOUND');
    if (client?.credentialBinding) await client.credentialBinding(profile);
  };
  async function getComputerConfig(source, profile = 'default') {
    const desc = SOURCES[source] || SOURCES.agent_computer;
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
        const servers = native?.mcp_servers || {};
        config = desc.configKeys.map(key => servers[key]).find(Boolean);
        // Older HOB releases used the external Portal slot for the bundled
        // computer. Recognize it only as HOB until its settings are migrated.
        const legacy = servers.portal;
        if (source === 'hob_computer' && !config && nativePortal?.managed({ mcpUrl: legacy?.url })) config = legacy;
        if (source === 'portal' && nativePortal?.managed({ mcpUrl: config?.url })) config = undefined;
      } catch (error) {
        if (error.code !== 'ENOENT') throw new HermesError(503, 'The selected bot’s computer configuration could not be read safely.', 'COMPUTER_CONFIG_INVALID');
      }
    }
    // Environment configuration belongs only to Main, never to another bot.
    if (!config && profile === 'default' && env[desc.envUrl]) config = { url: env[desc.envUrl], bearer_token: env[desc.envToken] || '' };
    if (!config || config.enabled === false) return { connected: false };
    const url = endpoint(config.url);
    const authorization = config.headers?.Authorization ?? config.headers?.authorization ?? '';
    const token = config.bearer_token ?? (/^Bearer\s+(.+)$/i.exec(authorization)?.[1]) ?? '';
    if (typeof token !== 'string' || token.length > 8192 || /[\r\n]|\$\{|\[stored credential\]/.test(token)) throw invalid('Configure a resolved computer credential for this bot.');
    return { connected: true, serverName: desc.serverName, mcpUrl: url.href, origin: url.origin, token };
  }
  async function getAgentComputerConfig(profile = 'default') {
    return getComputerConfig('agent_computer', profile);
  }
  async function callMcpTool(cfg, name, args = {}) {
    // A timeout can happen after a wake/sleep completed. Never replay it at a
    // fallback URL or through another protocol after an ambiguous result.
    try {
      const response = await fetchImpl(cfg.mcpUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(name === 'computer_wake' ? 90000 : 15000),
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
      if (data.result?.isError && nativePortal?.managed(cfg)) {
        const detail = data.result.content?.find(item => item.type === 'text')?.text || '';
        if (/Xvnc|Xtigervnc|TigerVNC|display.*(?:missing|not installed)/i.test(detail)) throw new HermesError(502, 'The desktop display could not start. Check that TigerVNC is installed in the HOB image.', 'COMPUTER_DISPLAY_UNAVAILABLE');
        if (/memory headroom|reserving.*MB|out of memory/i.test(detail)) throw new HermesError(503, 'The host has insufficient free memory to start this computer. Free memory or sleep another computer, then retry.', 'COMPUTER_MEMORY_LIMIT');
        if (/EACCES|Permission denied|read-only/i.test(detail)) throw new HermesError(502, 'The browser cannot access its required files. Check the HOB service logs for the failing directory.', 'COMPUTER_PERMISSION_ERROR');
        if (/Camoufox|browser.*not installed|executable.*not (?:found|installed)/i.test(detail)) throw new HermesError(502, 'The computer browser could not start. Check the bundled Camoufox installation in the HOB service logs.', 'COMPUTER_BROWSER_UNAVAILABLE');
      }
      if (data.error || data.result?.isError || !data.result) throw new Error('Remote tool failed.');
      const content = data.result.content?.find(item => item.type === 'text')?.text;
      return content ? JSON.parse(content) : data.result;
    } catch (error) {
      if (error instanceof HermesError) throw error;
      throw new HermesError(502, 'The configured computer service did not confirm the request. Refresh its status before retrying.', 'COMPUTER_REQUEST_UNCONFIRMED');
    }
  }
  async function route(req, res, url, { json, body }) {
    const source = sourceFor(url.pathname);
    if (!source) return false;
    const base = SOURCES[source].base;
    if (!authenticated(req)) throw new HermesError(401, 'Sign in to hob.', 'UNAUTHORIZED');
    const send = (status, value) => { json(res, status, value); return true; };
    if (source === 'portal' && url.pathname === base + '/vault/bots' && req.method === 'GET') {
      const bots = [];
      if (nativePortal) for (const bot of await roster()) {
        if (bot.state && bot.state !== 'active') continue;
        const cfg = await getComputerConfig('hob_computer', bot.name);
        if (cfg.connected && nativePortal.managed(cfg)) bots.push({ name: bot.name, displayName: bot.displayName || bot.display_name || (bot.name === 'default' ? 'Main' : bot.name) });
      }
      return send(200, { bots });
    }
    const profile = profileFrom(url);
    await authorize(profile);
    const managedSource = ['portal', 'hob_computer'].includes(source) && nativePortal;
    const vaultMatch = /^\/vault\/items(?:\/([0-9a-f-]+))?$/i.exec(url.pathname.slice(base.length));
    if (source === 'portal' && vaultMatch) {
      if (!managedSource) throw new HermesError(503, 'The bundled vault is unavailable.', 'VAULT_UNAVAILABLE');
      const cfg = await getComputerConfig('hob_computer', profile);
      if (!cfg.connected || !nativePortal.managed(cfg)) throw new HermesError(409, 'Assign a computer to this bot before using its vault.', 'VAULT_COMPUTER_REQUIRED');
      const id = vaultMatch[1];
      if (req.method === 'GET' && !id) return send(200, await nativePortal.vault(profile));
      assertOrigin(req);
      if (req.method === 'POST' && !id) {
        const input = await body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'origin', 'username', 'password'].includes(key))) throw invalid('Enter a name, HTTPS site URL, username and password.');
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw invalid('Enter a credential name under 120 characters.');
        if (typeof input.username !== 'string' || input.username.length > 320) throw invalid('Enter a username under 320 characters.');
        if (typeof input.password !== 'string' || !input.password || input.password.length > 16384) throw invalid('Enter a password under 16 KiB.');
        let origin;
        try { origin = normalizeOrigin(input.origin); } catch { throw invalid('Enter an HTTPS site URL without embedded credentials.'); }
        return send(201, await nativePortal.vault(profile, 'POST', { name: input.name.trim(), origin, username: input.username, password: input.password }));
      }
      if (req.method === 'DELETE' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) return send(200, await nativePortal.vault(profile, 'DELETE', undefined, id));
      throw invalid('Invalid vault request.');
    }
    if (managedSource && ['/assign', '/unassign', '/control'].some(suffix => url.pathname === base + suffix) && req.method === 'POST') {
      assertOrigin(req);
      const value = await body(req);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Invalid computer request.');
      if (url.pathname === base + '/control') {
        if (Object.keys(value).some(key => key !== 'mode') || !['human', 'agent'].includes(value.mode)) throw invalid('Select human or agent control.');
        const cfg = await getComputerConfig('hob_computer', profile);
        if (!cfg.connected || !nativePortal.managed(cfg)) throw invalid('Assign the bundled computer first.');
        return send(200, await nativePortal.control(profile, value.mode));
      }
      if (Object.keys(value).length) throw invalid('Computer assignment does not accept custom paths or credentials.');
      const result = await nativePortal[url.pathname.endsWith('/unassign') ? 'unassign' : 'assign'](profile);
      await onComputerChanged?.();
      return send(200, result);
    }
    let cfg = await getComputerConfig(source, profile);
    // Old HOB viewers used Portal's control URL. External Portal takes priority
    // there; new HOB viewers always use their dedicated source.
    if (source === 'portal' && nativePortal && !cfg.connected && ['/wake', '/sleep'].some(action => url.pathname === base + action)) cfg = await getComputerConfig('hob_computer', profile);
    if (url.pathname === base + '/status' && req.method === 'GET') {
      if (!cfg.connected) return send(200, { configured: false, connected: false, ...(source === 'hob_computer' ? { assignable: Boolean(nativePortal) } : {}) });
      try {
        const result = await callMcpTool(cfg, 'computer_list');
        const computers = Array.isArray(result) ? result : result?.computers;
        if (!Array.isArray(computers)) throw new Error('Invalid computer list.');
        const active = computers[0];
        const detail = active ? await callMcpTool(cfg, 'computer_status', { computer: computerId(active.id) }) : null;
        const current = detail?.computer || detail;
        if (current?.id !== undefined && current.id !== active?.id) throw new Error('The computer service returned another identity.');
        const managed = source === 'hob_computer' && nativePortal?.managed(cfg);
        const control = managed ? await nativePortal.viewer(profile) : undefined;
        return send(200, { configured: true, connected: true, serverName: cfg.serverName,
          ...(managed ? { managed: true, controlMode: control.mode } : { origin: cfg.origin, vncToken: cfg.token }),
          computers: computers.map(publicComputer).filter(Boolean), computer: active ? publicComputer({ ...active, ...current }) : null });
      } catch { return send(200, { configured: true, connected: false, ...(managedSource && nativePortal.managed(cfg) ? { managed: true } : {}), error: 'The configured computer service is unavailable. Refresh before retrying.' }); }
    }
    const action = url.pathname === base + '/wake' ? 'wake' : url.pathname === base + '/sleep' ? 'sleep' : null;
    if (action && req.method === 'POST') {
      assertOrigin(req);
      if (!cfg.connected) throw invalid('Configure this bot’s computer connection first.');
      const value = await body(req);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'computerId')) throw invalid('Select a computer explicitly.');
      const managed = nativePortal?.managed(cfg);
      const controller = managed ? { ...cfg, ...await nativePortal.vncConfig(profile) } : cfg;
      await callMcpTool(controller, `computer_${action}`, { computer: computerId(value.computerId), ...(managed ? { profile } : {}) });
      return send(200, { ok: true });
    }
    return false;
  }
  function upgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://hob.local'); } catch { return false; }
    const source = sourceFor(url.pathname);
    if (!source || url.pathname !== SOURCES[source].base + '/vnc') return false;
    let profile, id;
    try {
      if (req.method !== 'GET' || !authenticated(req)) throw new Error('Unauthorized.');
      assertOrigin(req); profile = profileFrom(url);
      if (url.searchParams.getAll('computerId').length !== 1) throw invalid('Select one computer.');
      id = computerId(url.searchParams.get('computerId'));
    } catch { socket.destroy(); return true; }
    void (async () => {
      let cfg = await getComputerConfig(source, profile);
      if (!cfg.connected || socket.destroyed) { socket.destroy(); return; }
      if (source === 'hob_computer' && nativePortal?.managed(cfg)) {
        if (id !== 'portal') { socket.destroy(); return; }
        cfg = { ...cfg, ...await nativePortal.vncConfig(profile) };
      }
      wss.handleUpgrade(req, socket, head, downstream => {
        const target = new URL(`/api/computers/${encodeURIComponent(id)}/vnc`, cfg.origin);
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
        if (cfg.token) target.searchParams.set('token', cfg.token);
        if (cfg.profile) target.searchParams.set('profile', cfg.profile);
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
  return { route, upgrade, getAgentComputerConfig, getComputerConfig, close };
}
