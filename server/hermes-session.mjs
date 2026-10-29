import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HermesError, hermesProfile } from './hermes-client.mjs';

const PROTOCOL = 'hermes-gateway-v1';
const MAX_FRAME = 8 * 1024 * 1024;
export const SESSION_METHODS = new Set(['ping', 'runtime.describe', 'setup.status', 'setup.runtime_check',
  'session.create', 'session.list', 'session.info', 'session.resume', 'session.detach', 'session.interrupt', 'session.mutate',
  'session.events.since', 'session.stats', 'prompt.submit', 'prompt.receipt', 'prompt.cancel',
  'image.attach_bytes', 'file.attach',
  'prompt.resolve_unknown', 'approval.respond', 'clarify.respond', 'command.dispatch', 'session.control.read', 'session.control',
  'bot_relay.deliver', 'groups.capabilities', 'groups.list', 'groups.create', 'groups.state', 'groups.log', 'groups.send',
  'groups.stop', 'groups.rename', 'groups.disband', 'groups.retry', 'groups.discard', 'groups.approve',
  'browser.controller.register', 'browser.controller.result', 'browser.controller.heartbeat', 'browser.controller.detach']);
const unavailable = () => new HermesError(503,
  'Hermes session connection is unavailable. Check the conversation before resending work.', 'SESSION_UNAVAILABLE');

export function createSessionBootstrap({ env = process.env, execute = promisify(execFile) } = {}) {
  return async profile => {
    hermesProfile(profile);
    if (!env.HERMES_DIR || !env.HERMES_HOME) throw unavailable();
    const root = path.resolve(env.HERMES_DIR);
    // A multiplexing gateway publishes ONE control socket at its launch home and serves
    // every profile from it, so a named bot has no socket in its own profile directory.
    // Dial the launch home, and let the child bind the requested bot by its profile home.
    const hermesHome = path.resolve(env.HERMES_HOME);
    const home = profile === 'default' ? hermesHome : path.resolve(hermesHome, 'profiles', profile);
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
      !/^(?:MUSE_|HOB_|API_SERVER_|HERMES_DASHBOARD_|HERMES_TUI_GATEWAY_URL$)/i.test(key)));
    Object.assign(childEnv, { HERMES_HOME: home, HERMES_GATEWAY_HOME: hermesHome, HERMES_DIR: root, PYTHONPATH: root,
      PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', HERMES_DISABLE_LAZY_INSTALLS: '1' });
    try {
      const { stdout } = await execute(env.HERMES_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
        [fileURLToPath(new URL('../deploy/hermes-session-bootstrap.py', import.meta.url))],
        { cwd: root, env: childEnv, timeout: 15000, maxBuffer: 65536, windowsHide: true });
      return JSON.parse(stdout);
    } catch { throw unavailable(); }
  };
}

/** One private native connection per enrolled bot. No write retries or second agent owner. */
export class HermesSessionBridge extends EventEmitter {
  #bootstrap;
  #access;
  #WebSocket;
  #connections = new Map();
  #closed = false;
  #timeout;
  #telemetry;
  constructor({ bootstrap = createSessionBootstrap(), profileAccess, telemetry, WebSocketClass = globalThis.WebSocket, timeout = 30000 } = {}) {
    super();
    this.#bootstrap = bootstrap; this.#access = profileAccess; this.#WebSocket = WebSocketClass; this.#timeout = timeout;
    this.#telemetry = telemetry;
    if (typeof profileAccess !== 'function') throw new Error('Native sessions require an enrolled bot authority.');
  }

  async #connection(profile) {
    if (this.#closed) throw unavailable();
    const binding = this.#access(profile);
    if (!binding) throw unavailable();
    let entry = this.#connections.get(profile);
    if (entry && entry.binding !== binding) { entry.close(); entry = undefined; }
    if (!entry) {
      entry = { binding, pending: new Map(), sequence: 0, ws: null };
      const close = () => {
        if (entry.dead) return;
        entry.dead = true;
        clearTimeout(entry.readyTimer);
        clearInterval(entry.heartbeat);
        if (this.#connections.get(profile) === entry) this.#connections.delete(profile);
        entry.rejectReady?.(unavailable());
        for (const item of entry.pending.values()) { clearTimeout(item.timer); item.reject(unavailable()); }
        entry.pending.clear();
        try { entry.ws?.close(); } catch { /* connection may already be closed */ }
        if (entry.canonical) this.emit('event', { profile, event: { type: 'gateway.disconnected' } });
      };
      entry.close = close;
      this.#connections.set(profile, entry);
      entry.ready = (async () => {
        const grant = await this.#bootstrap(profile);
        if (this.#closed || this.#access(profile) !== binding || this.#connections.get(profile) !== entry) throw unavailable();
        const target = new URL(grant.url);
        if (target.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(target.hostname)
          || !target.port || target.username || target.password || target.pathname !== '/api/ws' || target.search || target.hash
          || typeof grant.profile_id !== 'string' || !grant.profile_id || typeof grant.instance_id !== 'string' || !grant.instance_id
          || !Array.isArray(grant.protocols) || grant.protocols.length !== 2 || grant.protocols[0] !== PROTOCOL
          || typeof grant.protocols[1] !== 'string' || !/^hermes-gateway-ticket\.[A-Za-z0-9_-]{1,4096}$/.test(grant.protocols[1])) throw unavailable();
        const ws = entry.ws = new this.#WebSocket(target.href, grant.protocols);
        await new Promise((resolve, reject) => {
          entry.rejectReady = reject;
          entry.readyTimer = setTimeout(() => { close(); reject(unavailable()); }, this.#timeout);
          ws.addEventListener('error', close);
          ws.addEventListener('close', close);
          ws.addEventListener('message', event => {
            try {
              if (this.#access(profile) !== binding) { close(); return; }
              if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_FRAME) throw unavailable();
              // Hermes's WS transport also supports newline-coalesced frames.
              for (const line of event.data.split('\n').filter(line => line.trim())) {
                const frame = JSON.parse(line);
                if (frame.jsonrpc !== '2.0') throw unavailable();
                if (frame.method === 'event') {
                  const event = frame.params;
                  if (event?.type === 'gateway.ready') {
                    if (entry.canonical) throw unavailable();
                    if (event.payload?.session_authority !== true || ws.protocol !== PROTOCOL) throw unavailable();
                    clearTimeout(entry.readyTimer); entry.rejectReady = undefined; entry.canonical = true;
                    entry.lastPong = Date.now();
                    entry.heartbeat = setInterval(() => {
                      try {
                        if (this.#access(profile) !== binding || Date.now() - entry.lastPong > 45000) { close(); return; }
                        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'heartbeat', method: 'gateway.ping', params: {} }));
                      } catch { close(); }
                    }, 15000);
                    entry.heartbeat.unref(); resolve();
                  } else if (entry.canonical) this.emit('event', { profile, event });
                } else if (entry.canonical && frame.id === 'heartbeat' && frame.result?.ok === true) {
                  entry.lastPong = Date.now();
                } else if (entry.canonical && entry.pending.has(frame.id)) {
                  const item = entry.pending.get(frame.id);
                  entry.pending.delete(frame.id); clearTimeout(item.timer);
                  if (frame.error) {
                    const reason = typeof frame.error.message === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(frame.error.message)
                      ? frame.error.message : 'request_failed';
                    item.reject(new HermesError(409, `Hermes session request refused (${reason}).`, reason));
                  } else if ('result' in frame) item.resolve(frame.result);
                  else item.reject(unavailable());
                }
              }
            } catch { close(); }
          });
        });
        return entry;
      })().catch(() => { close(); throw unavailable(); });
    }
    return entry.ready;
  }

  async rpc(profile, method, params = {}) {
    hermesProfile(profile);
    if (!SESSION_METHODS.has(method) || !params || typeof params !== 'object' || Array.isArray(params)
      || Object.hasOwn(params, 'profile')) throw new HermesError(400, 'Invalid native session request.', 'INVALID_REQUEST');
    const encoded = JSON.stringify(params);
    const staging = ['image.attach_bytes', 'file.attach'].includes(method);
    if (Buffer.byteLength(encoded) > (staging ? 7 : 1) * 1024 * 1024) throw new HermesError(413, 'Session request is too large.', 'INVALID_REQUEST');
    // Freeze the exact validated request before discovery waits. A caller must
    // not change a control generation, input or profile selector in flight.
    const payload = JSON.parse(encoded);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.hasOwn(payload, 'profile')) {
      throw new HermesError(400, 'Invalid native session request.', 'INVALID_REQUEST');
    }
    // This native ingress requires a profile hint even on a profile-bound
    // ticket. Derive it here; callers still cannot supply or override it.
    if (method === 'bot_relay.deliver') payload.profile = profile;
    const finish = this.#telemetry?.start(profile, 'native.rpc', { operation: method, runId: payload.admission_id });
    try {
      const entry = await this.#connection(profile);
      if (this.#access(profile) !== entry.binding || !entry.canonical || entry.ws.readyState !== 1) { entry.close(); throw unavailable(); }
      if (entry.pending.size >= 128) throw new HermesError(429, 'Too many pending session requests.', 'SESSION_BUSY');
      const id = ++entry.sequence;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          entry.pending.delete(id); reject(unavailable()); // unknown outcome, never replay
        }, this.#timeout);
        entry.pending.set(id, { resolve, reject, timer });
        try { entry.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: payload })); }
        catch { entry.close(); }
      });
      finish?.('ok', { runId: result?.admission_id || payload.admission_id });
      return result;
    } catch (error) { finish?.(error.code === 'SESSION_UNAVAILABLE' ? 'unknown' : 'error'); throw error; }
  }

  close() {
    this.#closed = true;
    for (const entry of this.#connections.values()) entry.close();
  }
}
