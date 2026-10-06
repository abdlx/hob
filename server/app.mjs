import http from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const MAX_BODY = 2 * 1024 * 1024;
const PROFILE_FILES = new Set(['SOUL.md', 'MEMORY.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md']);
const MEDIA = /\.(png|jpe?g|gif|webp|svg|avif|mp4|webm|mov|mp3|wav|ogg|m4a|flac)$/i;
const EXPOSED_EVENTS = /^(chat|agent|session\.|sessions\.changed|cron|exec\.approval\.|plugin\.approval\.|openclaw\.approval\.|question\.|health|models\.snapshot)/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
export const SETTINGS_RPC_METHODS = new Set([
  'models.list', 'models.authStatus', 'models.authLogin', 'models.authSetApiKey', 'models.authLogout', 'models.authRefresh', 'models.authOrderSet', 'models.probe',
  'channels.status', 'channels.start', 'channels.stop', 'channels.logout', 'channels.pairing.list', 'channels.pairing.approve', 'channels.pairing.dismiss',
  'web.login.start', 'web.login.wait', 'plugins.list', 'plugins.search', 'plugins.inspect', 'plugins.install', 'plugins.setEnabled', 'plugins.uninstall', 'plugins.refresh', 'plugins.reload', 'plugins.credentials.inspect',
  'skills.status', 'skills.update', 'wizard.start', 'wizard.next', 'wizard.cancel', 'wizard.status',
  'secrets.reload', 'secrets.store.list', 'secrets.store.set', 'secrets.store.delete', 'config.schema.lookup', 'exec.approvals.get', 'exec.approvals.set', 'cron.status', 'cron.runs', 'approval.history', 'health',
]);
export function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
  return message?.text || '';
}
function presentMessage(message, index = 0) {
  return { id: message.id || message.entryId || `message-${index}`, role: message.role || 'assistant', content: messageText(message), timestamp: message.timestamp ? new Date(message.timestamp).toISOString() : '', status: 'complete' };
}
function presentSession(session) {
  return { id: session.key, title: session.displayName || session.label || session.derivedTitle || session.key, createdAt: session.createdAt || session.updatedAt ? new Date(session.createdAt || session.updatedAt).toISOString() : '', agentId: session.agentId || session.key?.split(':')[1] || 'main', lastMessageSnippet: session.lastMessagePreview || '' };
}
function safeEquals(a, b) {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right);
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request exceeds 2 MB.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'A JSON object is required.'); }
}
function required(value, label, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${label} is required (maximum ${max} characters).`);
  return value;
}
function sendEvent(res, event, data) {
  if (res.destroyed || res.writableEnded) return;
  if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function startEvents(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
}
async function browserImage(stateDir, filename) {
  const root = await realpath(path.join(stateDir, 'media', 'browser'));
  const resolved = await realpath(filename);
  if (path.dirname(resolved) !== root || !/\.(png|jpe?g)$/i.test(resolved)) throw new HttpError(502, 'Browser returned an unsafe screenshot path.');
  const rootHandle = await open(root, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
  let handle;
  try {
    const currentRoot = await realpath(process.platform === 'linux' ? `/proc/self/fd/${rootHandle.fd}` : root);
    if (currentRoot !== root) throw new HttpError(502, 'Browser media directory changed before the screenshot could be read.');
    // Linux resolves relative to the pinned directory, so renaming/replacing the
    // directory or final filename cannot redirect the read after validation.
    const pinnedPath = process.platform === 'linux' ? `/proc/self/fd/${rootHandle.fd}/${path.basename(resolved)}` : resolved;
    handle = await open(pinnedPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    const expected = await stat(resolved);
    if (!info.isFile() || info.nlink !== 1 || info.dev !== expected.dev || info.ino !== expected.ino) throw new HttpError(502, 'Screenshot changed before it could be read.');
    const max = 10 * 1024 * 1024;
    if (info.size > max) throw new HttpError(413, 'Screenshot is too large.');
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > info.size) throw new HttpError(502, 'Screenshot changed while it was being read.');
    return `data:image/${/\.png$/i.test(resolved) ? 'png' : 'jpeg'};base64,${bytes.subarray(0, count).toString('base64')}`;
  } finally { await handle?.close(); await rootHandle.close(); }
}

export function createApp({ gateway, password = process.env.MUSE_PASSWORD, accessToken = process.env.MUSE_ACCESS_TOKEN, sessionSecret = process.env.MUSE_SESSION_SECRET, publicUrl = process.env.MUSE_PUBLIC_URL, secureCookies = process.env.MUSE_SECURE_COOKIES === 'true', stateDir = process.env.OPENCLAW_STATE_DIR, staticDir = fileURLToPath(new URL('../web/dist', import.meta.url)) }) {
  const configured = Boolean(password || accessToken);
  const secret = sessionSecret || createHash('sha256').update(`muse-session:${password || accessToken || randomBytes(32).toString('hex')}`).digest();
  const fingerprint = createHash('sha256').update(`${password || ''}:${accessToken || ''}`).digest('base64url');
  const attempts = new Map();
  const streams = new Set();
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  const cookieValid = req => {
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('muse_session='))?.slice(13);
    if (!token || token.length > 1024) return false;
    const [payload, signature] = token.split('.');
    if (!signature || !safeEquals(sign(payload), signature)) return false;
    try { const data = JSON.parse(Buffer.from(payload, 'base64url')); return data.exp > Date.now() && data.fp === fingerprint; } catch { return false; }
  };
  const authenticated = req => configured && (cookieValid(req) || (accessToken && safeEquals(req.headers.authorization || '', `Bearer ${accessToken}`)));
  const setCookie = (res, value, maxAge) => res.setHeader('Set-Cookie', `muse_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookies || publicUrl?.startsWith('https:') ? '; Secure' : ''}`);
  const assertOrigin = req => {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are refused.');
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = publicUrl ? new URL(publicUrl).origin : `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    if (origin !== allowed) throw new HttpError(403, 'Request origin does not match Muse.');
  };
  const rpc = (method, params = {}) => gateway.request(method, params);
  const startup = async () => gateway.connected
    ? typeof gateway.getStartupStatus === 'function' ? gateway.getStartupStatus() : { ready: true, status: 'started' }
    : { ready: false, status: 'disconnected' };
  const paged = async (method, field, params) => {
    const items = [];
    let snapshot;
    for (let offset = 0; ; offset += 200) {
      snapshot = await rpc(method, { ...params, limit: 200, offset });
      const page = snapshot[field] || [];
      items.push(...page);
      if (page.length < 200) return { ...snapshot, [field]: items };
    }
  };
  const sessions = async () => (await paged('sessions.list', 'sessions', { includeDerivedTitles: true, includeLastMessage: true })).sessions;
  const agent = async agentId => {
    const result = await rpc('agents.list');
    const item = result.agents?.find(a => a.id === (agentId || result.defaultId)) || result.agents?.[0];
    if (!item) throw new HttpError(404, 'No OpenClaw agent is configured.');
    // The running roster can lag a committed identity update until hot reload.
    // Read the persisted owner snapshot for the display name, rather than
    // returning a stale name or projecting the caller's unconfirmed input.
    const snapshot = await rpc('config.get');
    const configuredAgent = snapshot.valid ? snapshot.config?.agents?.entries?.[item.id] : undefined;
    return { id: item.id, name: configuredAgent?.identity?.name || configuredAgent?.name || item.identity?.name || item.name || item.id, status: gateway.connected ? 'connected' : 'disconnected', avatarUrl: item.identity?.avatarUrl || '', roleDescription: item.identity?.theme || 'OpenClaw agent', model: item.model?.primary || '', ...(item.agentRuntime?.id ? { agentRuntime: item.agentRuntime.id } : {}) };
  };
  gateway.on('event', frame => { if (EXPOSED_EVENTS.test(frame.event)) for (const res of streams) sendEvent(res, 'gateway', { event: frame.event, payload: frame.payload }); });
  gateway.on('connected', () => { for (const res of streams) sendEvent(res, 'connection', { connected: true }); });
  gateway.on('disconnected', () => { for (const res of streams) sendEvent(res, 'connection', { connected: false }); });

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(req.url, 'http://muse.local');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const route = url.pathname;
      const method = req.method;
      if (route === '/healthz') {
        const state = await startup();
        return json(res, state.ready ? 200 : 503, { ok: state.ready, gatewayConnected: gateway.connected });
      }
      if (route === '/api/auth/status' && method === 'GET') return json(res, 200, { authenticated: Boolean(authenticated(req)), configured, gatewayConnected: gateway.connected });
      if (method !== 'GET' && method !== 'HEAD') assertOrigin(req);
      if (route === '/api/auth/login' && method === 'POST') {
        if (!configured) throw new HttpError(503, 'Set MUSE_PASSWORD or MUSE_ACCESS_TOKEN on the server.');
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        let record = attempts.get(ip);
        if (!record || now - record.at > 60000) record = { at: now, count: 0 };
        if (record.count >= 10) throw new HttpError(429, 'Too many login attempts. Try again in a minute.');
        record.count++;
        if (attempts.size >= 10000 && !attempts.has(ip)) attempts.delete(attempts.keys().next().value);
        attempts.set(ip, record);
        const input = await body(req);
        if (!((password && safeEquals(input.password || '', password)) || (accessToken && safeEquals(input.password || input.token || '', accessToken)))) throw new HttpError(401, 'Invalid password or access token.');
        attempts.delete(ip);
        const payload = Buffer.from(JSON.stringify({ exp: now + 86400000, fp: fingerprint, nonce: randomUUID() })).toString('base64url');
        setCookie(res, `${payload}.${sign(payload)}`, 86400);
        return json(res, 200, { authenticated: true });
      }
      if (route.startsWith('/api/')) {
        if (!authenticated(req)) throw new HttpError(401, 'Sign in to Muse.');
        if (route === '/api/readiness' && method === 'GET') return json(res, 200, await startup());
        if (route === '/api/auth/logout' && method === 'POST') { setCookie(res, '', 0); return json(res, 200, { authenticated: false }); }
        if (route === '/api/events' && method === 'GET') {
          startEvents(res); streams.add(res);
          sendEvent(res, 'connection', { connected: gateway.connected });
          const heartbeat = setInterval(() => { if (!authenticated(req)) { res.end(); return; } res.write(': heartbeat\n\n'); }, 20000);
          req.on('close', () => { clearInterval(heartbeat); streams.delete(res); });
          return;
        }
        if (route === '/api/sessions' && method === 'GET') return json(res, 200, (await sessions()).map(presentSession));
        if (route === '/api/sessions' && method === 'POST') {
          const input = await body(req);
          const title = input.title || 'New Conversation';
          // Token-only local operators lack the device/principal identity required
          // by OpenClaw's optional session-create idempotency contract. Never retry
          // this write automatically; an uncertain result must be refreshed.
          const result = await rpc('sessions.create', { agentId: input.agentId || (await agent()).id, displayName: required(title, 'title', 500), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) });
          return json(res, 201, presentSession({ ...result.entry, key: result.key, displayName: result.entry?.displayName || title }));
        }
        if (segments[1] === 'sessions' && segments.length === 4 && segments[3] === 'messages' && method === 'GET') {
          const result = await rpc('chat.history', { sessionKey: segments[2], limit: 200 });
          return json(res, 200, (result.messages || []).map(presentMessage));
        }
        if (segments[1] === 'sessions' && segments.length === 4 && segments[3] === 'abort' && method === 'POST') {
          const input = await body(req);
          return json(res, 200, await rpc('chat.abort', { sessionKey: segments[2], ...(input.runId ? { runId: input.runId } : {}) }));
        }
        if (segments[1] === 'sessions' && segments.length === 4 && segments[3] === 'turns' && method === 'POST') {
          const input = await body(req);
          const content = required(input.content, 'content', 100000);
          const runId = input.idempotencyKey || randomUUID();
          let text = '';
          let ended = false;
          const finish = () => { if (ended) return; ended = true; clearTimeout(timer); gateway.off('event', listen); gateway.off('disconnected', disconnect); res.end(); };
          const listen = frame => {
            const value = frame.payload;
            if (frame.event !== 'chat' || value?.sessionKey !== segments[2] || value.runId !== runId) return;
            if (value.state === 'delta') { text = value.replace ? value.deltaText : text + value.deltaText; sendEvent(res, 'delta', { text: value.deltaText, replace: Boolean(value.replace) }); }
            else if (value.state === 'final') { const message = value.message ? presentMessage(value.message) : { id: runId, role: 'assistant', content: text, timestamp: new Date().toISOString(), status: 'complete' }; sendEvent(res, 'done', { message }); finish(); }
            else if (value.state === 'error' || value.state === 'aborted') { sendEvent(res, 'error', { message: value.errorMessage || (value.state === 'aborted' ? 'Turn cancelled.' : 'OpenClaw turn failed.') }); finish(); }
            else sendEvent(res, 'status', value);
          };
          const disconnect = () => { sendEvent(res, 'error', { message: 'Gateway disconnected. The turn may continue; refresh this conversation after reconnection.' }); finish(); };
          const timer = setTimeout(() => { sendEvent(res, 'error', { message: 'Stream ended after 30 minutes. The agent may still be working; refresh the conversation.' }); finish(); }, 30 * 60000);
          gateway.on('event', listen); gateway.on('disconnected', disconnect);
          req.on('close', () => { if (res.destroyed) finish(); });
          startEvents(res);
          try {
            const accepted = await rpc('chat.send', { sessionKey: segments[2], message: content, idempotencyKey: runId, ...(input.attachments ? { attachments: input.attachments } : {}) });
            if (!ended) {
              sendEvent(res, 'accepted', { ...accepted, runId });
              if (accepted.status === 'ok') {
                sendEvent(res, 'error', { message: 'This turn already completed. Refresh the conversation to read its saved result.', refresh: true });
                finish();
              }
            }
          } catch (error) { clearTimeout(timer); gateway.off('event', listen); gateway.off('disconnected', disconnect); throw error; }
          return;
        }
        if (route === '/api/agent' && method === 'GET') return json(res, 200, await agent(url.searchParams.get('agentId')));
        if (route === '/api/agent' && method === 'PATCH') {
          const input = await body(req); const selected = input.id || (await agent()).id;
          if ('avatarUrl' in input && !('avatar' in input)) input.avatar = input.avatarUrl;
          if ('agentRuntime' in input) required(input.agentRuntime, 'agentRuntime');
          await rpc('agents.update', { agentId: selected, ...Object.fromEntries(['name', 'model', 'agentRuntime', 'emoji', 'avatar'].filter(k => k in input).map(k => [k, input[k]])) });
          return json(res, 200, await agent(selected));
        }
        if (route === '/api/agents' && method === 'GET') return json(res, 200, await rpc('agents.list'));
        if (route === '/api/agents' && method === 'POST') return json(res, 201, await rpc('agents.create', await body(req)));
        if (segments[1] === 'agent' && segments[2] === 'files' && segments.length === 4) {
          const name = segments[3];
          if (!PROFILE_FILES.has(name)) throw new HttpError(400, 'Select a supported agent Markdown file.');
          const agentId = url.searchParams.get('agentId') || (await agent()).id;
          if (method === 'GET') return json(res, 200, await rpc('agents.files.get', { agentId, name }));
          if (method === 'PUT' || method === 'PATCH') {
            const input = await body(req);
            if (typeof input.content !== 'string') throw new HttpError(400, 'content must be text.');
            if (!input.expectedHash && input.expectedMissing !== true) throw new HttpError(400, 'Read the file first and provide expectedHash or expectedMissing.');
            return json(res, 200, await rpc('agents.files.set', { agentId, name, content: input.content, ...(input.expectedHash ? { expectedHash: input.expectedHash } : { expectedMissing: true }) }));
          }
        }
        if (route === '/api/tasks' && method === 'GET') {
          const items = await sessions();
          return json(res, 200, items.map(s => ({ id: s.key, title: s.displayName || s.derivedTitle || s.label || s.key, subtitle: s.lastMessagePreview || s.runStatus || '', timestamp: s.updatedAt ? new Date(s.updatedAt).toISOString() : '', status: s.runStatus === 'running' ? 'in_progress' : s.runStatus === 'failed' ? 'cancelled' : 'completed', group: s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : '' })));
        }
        if (route === '/api/security/approvals' && method === 'GET') {
          const rows = await sessions();
          const approvals = new Map();
          // Replays are canonical and survive bridge restart. No approval sidecar.
          for (let i = 0; i < rows.length; i += 8) {
            const batch = await Promise.all(rows.slice(i, i + 8).map(s => rpc('sessions.messages.subscribe', { key: s.key, subscriptionId: 'muse-approvals', includeApprovals: true })));
            for (const result of batch) for (const item of result.approvalReplay?.approvals || []) approvals.set(item.id, item);
          }
          return json(res, 200, [...approvals.values()].map(a => {
            const kind = a.presentation?.kind || a.kind;
            return { id: a.id, kind, type: kind === 'exec' ? 'command' : kind === 'system-agent' ? 'configuration' : 'tool', description: a.presentation?.title || a.presentation?.description || 'Approval requested', commandSnippet: a.presentation?.commandText || a.presentation?.command, riskLevel: 'medium', requestedAt: a.createdAtMs ? new Date(a.createdAtMs).toISOString() : '', status: 'pending', details: a };
          }));
        }
        if (segments[1] === 'security' && segments[2] === 'approvals' && segments.length === 4 && method === 'POST') {
          const input = await body(req);
          const current = await rpc('approval.get', { id: segments[3] });
          const decision = { approved: 'allow-once', rejected: 'deny' }[input.decision] || input.decision;
          if (!['allow-once', 'allow-always', 'deny'].includes(decision)) throw new HttpError(400, 'Select allow-once, allow-always, or deny.');
          return json(res, 200, await rpc('approval.resolve', { id: segments[3], kind: current.approval.presentation?.kind || current.approval.kind, decision }));
        }
        if (route === '/api/stats' && method === 'GET') {
          const start = performance.now(); const status = await rpc('status');
          return json(res, 200, { tokensUsed: status.sessions?.recent?.reduce((n, s) => n + (s.totalTokens || 0), 0) || 0, maxTokens: status.sessions?.defaults?.contextTokens || 0, memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024), latencyMs: Math.round(performance.now() - start), activeProcesses: status.sessions?.recent?.filter(s => s.runStatus === 'running').length || 0, gateway: status });
        }
        if (route === '/api/goals' && method === 'GET') return json(res, 200, await paged('cron.list', 'jobs', { includeDisabled: true }));
        if (route === '/api/goals' && method === 'POST') return json(res, 201, await rpc('cron.add', await body(req)));
        if (segments[1] === 'goals' && segments.length === 3 && method === 'PATCH') { const input = await body(req); return json(res, 200, await rpc('cron.update', { id: segments[2], patch: input.patch, ...(input.expectedConfigRevision ? { expectedConfigRevision: input.expectedConfigRevision } : {}) })); }
        if (segments[1] === 'goals' && segments.length === 3 && method === 'DELETE') return json(res, 200, await rpc('cron.remove', { id: segments[2] }));
        if (segments[1] === 'goals' && segments.length === 4 && segments[3] === 'run' && method === 'POST') { const input = await body(req); return json(res, 200, await rpc('cron.run', { id: segments[2], mode: input.mode || 'force' })); }
        if (route === '/api/settings' && method === 'GET') return json(res, 200, await rpc('config.get'));
        if (route === '/api/credentials' && method === 'GET') return json(res, 200, await rpc('secrets.store.list'));
        if (route === '/api/credentials' && method === 'POST') return json(res, 200, await rpc('secrets.store.set', await body(req)));
        if (segments[1] === 'credentials' && segments.length === 3 && method === 'DELETE') return json(res, 200, await rpc('secrets.store.delete', { name: segments[2] }));
        if (route === '/api/settings/schema' && method === 'GET') return json(res, 200, await rpc('config.schema'));
        if (route === '/api/settings' && method === 'PATCH') {
          const input = await body(req);
          required(input.baseHash, 'baseHash');
          if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) throw new HttpError(400, 'patch must be a configuration object.');
          const transport = input.patch.gateway;
          const replacesMode = Array.isArray(input.replacePaths) && input.replacePaths.some(path => path === 'gateway' || path === 'gateway.mode');
          if (transport === null || (transport && Object.hasOwn(transport, 'mode') && transport.mode !== 'local') || (replacesMode && transport?.mode !== 'local')) {
            throw new HttpError(400, 'This installation runs its own Gateway. Keep gateway.mode set to local so OpenMuse can restart.');
          }
          return json(res, 200, await rpc('config.patch', { raw: JSON.stringify(input.patch), baseHash: input.baseHash, ...(input.replacePaths ? { replacePaths: input.replacePaths } : {}), note: 'Updated in Muse settings' }));
        }
        if (route === '/api/browser/tabs' && method === 'GET') return json(res, 200, await rpc('browser.request', { method: 'GET', path: '/tabs', ...(url.searchParams.get('profile') ? { query: { profile: url.searchParams.get('profile') } } : {}) }));
        if (route === '/api/browser/actions' && method === 'POST') {
          const input = await body(req);
          const actions = { start: ['POST', '/start'], open: ['POST', '/tabs/open'], navigate: ['POST', '/navigate'], close: ['DELETE', `/tabs/${encodeURIComponent(input.targetId || '')}`], snapshot: ['GET', '/snapshot'], screenshot: ['POST', '/screenshot'], stop: ['POST', '/stop'] };
          const action = actions[input.action]; if (!action) throw new HttpError(400, 'Unsupported browser action.');
          const payload = Object.fromEntries(['url', 'targetId', 'profile', 'format', 'fullPage'].filter(k => input[k] !== undefined).map(k => [k, input[k]]));
          const result = await rpc('browser.request', { method: action[0], path: action[1], ...(action[0] === 'GET' ? { query: payload } : { body: payload }) });
          if (input.action === 'screenshot' && result.path && stateDir) {
            result.imageUrl = await browserImage(stateDir, result.path);
          }
          return json(res, 200, result);
        }
        if (route === '/api/library' && method === 'GET') {
          const selected = url.searchParams.get('sessionId');
          const rows = selected ? [{ key: selected }] : await sessions();
          const files = new Map();
          const roots = new Set();
          let truncated = false;
          const add = (file, key, root) => {
            if (file.missing || (url.searchParams.get('kind') === 'media' ? !MEDIA.test(file.name) : MEDIA.test(file.name))) return;
            const identity = root ? path.resolve(root, file.path) : `${key}:${file.path}`;
            if (!files.has(identity)) files.set(identity, { ...file, sessionId: key });
          };
          for (let i = 0; i < rows.length; i += 8) {
            const results = await Promise.all(rows.slice(i, i + 8).map(async s => ({ key: s.key, result: await rpc('sessions.files.list', { sessionKey: s.key }) })));
            for (const { key, result } of results) {
              for (const file of result.files || []) add(file, key, result.root);
              if (result.root && !roots.has(result.root)) {
                roots.add(result.root);
                for (const file of result.browser?.entries || []) if (file.kind === 'file') add(file, key, result.root);
                const found = await rpc('sessions.files.list', { sessionKey: key, search: '.' });
                for (const file of found.browser?.entries || []) if (file.kind === 'file') add(file, key, result.root);
                truncated ||= Boolean(result.browser?.truncated || found.browser?.truncated);
              }
            }
          }
          return json(res, 200, { files: [...files.values()], truncated });
        }
        if (route === '/api/library/file' && method === 'GET') {
          const target = { sessionKey: required(url.searchParams.get('sessionId'), 'sessionId'), path: required(url.searchParams.get('path'), 'path') };
          const result = await rpc('sessions.files.get', target);
          if (url.searchParams.has('raw') || url.searchParams.has('download')) {
            const file = result.file;
            if (!file || file.missing) throw new HttpError(404, 'This file is no longer available.');
            if (typeof file.content !== 'string' && MEDIA.test(file.name)) {
              const ref = encodeURIComponent(file.name);
              const assets = await rpc('sessions.files.assets', { ...target, refs: [ref] });
              const asset = assets.assets?.find(a => a.ref === ref);
              if (asset?.error === 'too_large') throw new HttpError(413, 'OpenClaw limits media previews and downloads to 1 MiB per file.');
              if (asset?.error === 'outside_session_boundary') throw new HttpError(403, 'This media is outside the current session file boundary.');
              if (typeof asset?.content === 'string') Object.assign(file, { content: asset.content, contentEncoding: 'base64', mimeType: asset.mimeType });
            }
            if (typeof file.content !== 'string') throw new HttpError(422, 'OpenClaw provides bounded text and media previews for this file. Its full contents are not available through the Gateway file API.');
            const bytes = Buffer.from(file.content, file.contentEncoding === 'base64' ? 'base64' : 'utf8');
            // User artifacts never inherit the app's executable origin authority.
            res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
            res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-store');
            if (url.searchParams.has('download') || /html|svg|javascript/i.test(file.mimeType || '')) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
            return res.end(bytes);
          }
          return json(res, 200, result);
        }
        if (route === '/api/rpc' && method === 'POST') {
          const input = await body(req);
          // Settings workflows need plugin/channel/provider-specific screens.
          // Authority and schema remain at the Gateway, with no raw file/exec proxy.
          if (!SETTINGS_RPC_METHODS.has(input.method)) throw new HttpError(403, 'This Gateway method is not exposed by Muse.');
          return json(res, 200, await rpc(input.method, input.params || {}));
        }
        throw new HttpError(404, 'API endpoint not found.');
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      const root = await realpath(staticDir).catch(() => { throw new HttpError(503, 'Build the web frontend before starting Muse.'); });
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes('\0') || decoded.includes('\\')) throw new HttpError(400, 'Invalid asset path.');
      let filename = path.resolve(root, `.${decoded}`);
      if (filename !== root && !filename.startsWith(root + path.sep)) throw new HttpError(403, 'Asset path is outside the frontend.');
      let info = await stat(filename).catch(() => null);
      if (!info?.isFile()) { filename = path.join(root, 'index.html'); info = await stat(filename); }
      const resolved = await realpath(filename);
      if (!resolved.startsWith(root + path.sep)) throw new HttpError(403, 'Asset symlink is outside the frontend.');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': path.basename(filename) === 'index.html' ? 'no-cache' : 'public, max-age=3600', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" });
      if (method === 'HEAD') res.end(); else createReadStream(resolved).pipe(res);
    } catch (error) {
      const status = error.status || (error.code === 'UNAVAILABLE' || error.code === 'TIMEOUT' ? 503 : error.code === 'INVALID_REQUEST' ? 400 : 502);
      const message = error.status || error.code ? error.message : 'Muse could not complete this request.';
      if (!res.headersSent) json(res, status, { error: message, ...(error.code ? { code: error.code } : {}) });
      else { sendEvent(res, 'error', { message }); res.end(); }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('close', () => { for (const res of streams) res.end(); streams.clear(); });
  return server;
}
