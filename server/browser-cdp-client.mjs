// Minimal Chrome DevTools Protocol client over one WebSocket.
//
// The gateway needs a *stable* CDP connection for work it initiates itself
// (screencast, tab discovery, viewer input), which is different from the
// per-call connections Hermes makes. Keeping it here means the policy proxy and
// the gateway's own commands share one implementation.

import { WebSocket } from 'ws';

export class CdpError extends Error {
  constructor(message, { method, code } = {}) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
    this.code = code;
  }
}

export class CdpConnection {
  #socket = null;
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  #onEvent;
  #onClose;

  constructor(url, { onEvent, onClose } = {}) { this.#url = url; this.#onEvent = onEvent; this.#onClose = onClose; }
  #url;

  get url() { return this.#url; }
  get open() { return this.#socket?.readyState === WebSocket.OPEN; }

  connect({ timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      // maxPayload: 0 disables the frame limit; CDP replies such as
      // DOM.getDocument and screencast metadata can be large. Compression and
      // heartbeats are off because CDP has no ping contract and both add latency.
      const socket = new WebSocket(this.#url, { maxPayload: 0, perMessageDeflate: false, handshakeTimeout: timeoutMs });
      this.#socket = socket;
      const timer = setTimeout(() => { socket.terminate(); reject(new CdpError('Timed out connecting to the browser.')); }, timeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolve(this); });
      socket.once('error', error => { clearTimeout(timer); reject(new CdpError(`Browser connection failed: ${error.message}`)); });
      socket.once('close', () => {
        this.#closed = true;
        for (const entry of this.#pending.values()) entry.reject(new CdpError('Browser connection closed.'));
        this.#pending.clear();
        this.#onClose?.();
      });
      socket.on('message', (data, isBinary) => this.#dispatch(data, isBinary));
    });
  }

  send(method, params = {}, { sessionId, timeoutMs = 30000 } = {}) {
    if (this.#closed || this.#socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpError('Browser connection is not open.', { method }));
    }
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(`Browser did not answer ${method} in time.`, { method }));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        resolve: result => { clearTimeout(timer); resolve(result); },
        reject: error => { clearTimeout(timer); reject(error); },
        method,
      });
      this.#socket.send(JSON.stringify(message), error => {
        if (!error) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError(`Failed to send ${method}: ${error.message}`, { method }));
      });
    });
  }

  /** Fire-and-forget: used where a lost reply must not stall the caller. */
  post(method, params = {}, options = {}) {
    return this.send(method, params, options).catch(() => undefined);
  }

  close() {
    this.#closed = true;
    try { this.#socket?.close(); } catch { /* already closed */ }
  }

  #dispatch(data, isBinary) {
    if (isBinary) return;
    let message;
    try { message = JSON.parse(data.toString('utf8')); } catch { return; }
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const entry = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) entry.reject(new CdpError(message.error.message || 'CDP command failed.', { method: entry.method, code: message.error.code }));
      else entry.resolve(message.result);
      return;
    }
    if (message.method) this.#onEvent?.(message);
  }
}
