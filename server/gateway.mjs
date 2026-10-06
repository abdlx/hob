import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class GatewayError extends Error {
  constructor(message, code = 'UNAVAILABLE', details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Wire version and local CLI authentication are owned by OpenClaw's protocol v4
// and connect-auth.ts. This server is a local operator, never a browser client.
export class GatewayBridge extends EventEmitter {
  constructor({ url, token, WebSocketImpl = globalThis.WebSocket, timeoutMs = 30000, reconnectMs = 1000, clock = { now: Date.now, setInterval, clearInterval } }) {
    super();
    const endpoint = new URL(url);
    if (!(endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) {
      throw new Error('The Muse bridge requires a loopback ws:// Gateway URL.');
    }
    if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN is required.');
    this.url = url;
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = timeoutMs;
    this.reconnectMs = reconnectMs;
    this.clock = clock;
    this.pending = new Map();
    this.connected = false;
    this.stopped = true;
    this.attempt = 0;
  }
  start() { this.stopped = false; this.open(); }
  async getStartupStatus() {
    if (!this.connected) return { ready: false, status: 'disconnected' };
    const endpoint = new URL('/startupz', this.url.replace(/^ws:/, 'http:'));
    try {
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${this.token}` }, redirect: 'error', signal: AbortSignal.timeout(3000) });
      const snapshot = await response.json();
      return { ready: response.ok && snapshot.ok === true && snapshot.status === 'started', status: snapshot.status || 'starting' };
    } catch { return { ready: false, status: 'starting' }; }
  }
  open() {
    if (this.stopped) return;
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => socket.close(), 10000);
    socket.addEventListener('message', ({ data }) => {
      if (socket !== this.socket) return;
      let frame;
      try { frame = JSON.parse(String(data)); } catch { socket.close(); return; }
      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        this.request('connect', {
          minProtocol: 4, maxProtocol: 4,
          client: { id: 'cli', displayName: 'Muse', version: '1.0.0', platform: process.platform, mode: 'cli' },
          role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals', 'operator.questions', 'operator.pairing'],
          caps: ['tool-events', 'exec-approvals', 'plugin-approvals', 'session-scoped-events'],
          auth: { token: this.token },
        }, { handshake: true }).then(hello => {
          if (socket !== this.socket) return;
          clearTimeout(this.handshakeTimer);
          this.connected = true;
          this.attempt = 0;
          this.hello = hello;
          const tickInterval = Number.isSafeInteger(hello.policy?.tickIntervalMs) && hello.policy.tickIntervalMs > 0 ? hello.policy.tickIntervalMs : 30000;
          this.lastTick = this.clock.now();
          this.watchdog = this.clock.setInterval(() => {
            if (this.clock.now() - this.lastTick > tickInterval * 2) socket.close();
          }, Math.max(1000, Math.min(tickInterval, 30000)));
          this.watchdog.unref?.();
          this.emit('connected', hello);
          this.request('sessions.subscribe').catch(() => {});
        }).catch(() => socket.close());
      } else if (frame.type === 'res') {
        const call = this.pending.get(frame.id);
        if (!call) return;
        // Some long-running RPCs first acknowledge admission with final:false.
        if (frame.final === false) return;
        this.pending.delete(frame.id);
        clearTimeout(call.timer);
        if (frame.ok) call.resolve(frame.payload);
        else call.reject(new GatewayError(frame.error?.message || 'Gateway request failed.', frame.error?.code, frame.error?.details));
      } else if (frame.type === 'event' && this.connected) {
        if (frame.event === 'tick') this.lastTick = this.clock.now();
        this.emit('event', frame);
      }
    });
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', () => {
      if (socket !== this.socket) return;
      clearTimeout(this.handshakeTimer);
      this.clock.clearInterval(this.watchdog);
      this.connected = false;
      this.hello = undefined;
      for (const call of this.pending.values()) {
        clearTimeout(call.timer);
        call.reject(new GatewayError('Gateway disconnected. Accepted writes may still have completed; refresh before retrying.'));
      }
      this.pending.clear();
      this.emit('disconnected');
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.open(), Math.min(this.reconnectMs * 2 ** this.attempt++, 15000));
        this.reconnectTimer.unref?.();
      }
    });
  }
  request(method, params = {}, { handshake = false } = {}) {
    if ((!this.connected && !handshake) || this.socket?.readyState !== 1) {
      return Promise.reject(new GatewayError('OpenClaw is starting or disconnected. Retry after it reconnects.'));
    }
    if (this.pending.size >= 256) return Promise.reject(new GatewayError('Gateway request capacity reached.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError('Gateway request timed out. Refresh the operation before retrying.', 'TIMEOUT'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ type: 'req', id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.handshakeTimer);
    this.clock.clearInterval(this.watchdog);
    this.socket?.close();
  }
}
