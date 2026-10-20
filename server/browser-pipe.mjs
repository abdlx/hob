// Chromium's `--remote-debugging-pipe` transport, plus the multiplexer that lets
// several CDP clients share the single browser-level session that one pipe gives.
//
// Why this exists: with `--remote-debugging-port` Chromium listens on a loopback
// TCP port, and anything that can run code on the host can read
// `<profile>/DevToolsActivePort` and drive the browser directly, skipping the HOB
// gateway and the human-takeover lease (finding H1). A pipe (fds 3 and 4) has no
// address to connect to: the only way in is the file descriptor HOB itself owns.
//
// Facts about Chromium's pipe, all verified against Chrome 155 rather than assumed:
//
//   * HOB writes CDP JSON to the child's fd 3 and reads replies from fd 4.
//   * Messages are separated by a single NUL byte (`\0`), not by newlines and not
//     by WebSocket framing. A JSON message may contain anything else, including
//     embedded newlines, so only `\0` can be a delimiter.
//   * It is ONE browser-level CDP session. `Target.attachToTarget` on this one
//     session returns a *distinct* session id per call, even for the same target,
//     and `Target.detachFromTarget` only tears down the session it names. That is
//     what makes per-client sessions possible without a second connection.
//   * Browser-level state (`Target.setAutoAttach`, `Target.setDiscoverTargets`)
//     is shared, because there is only one connection. The multiplexer therefore
//     aggregates it and fans the resulting events out per client.
//
// The multiplexer is deliberately small and rule-driven:
//
//   * every client gets its own CDP id space -> a gateway id -> back again;
//   * explicit attaches hand out the real session id (Chromium already made it
//     unique per client), so the common path needs no session translation at all;
//   * auto-attach sessions ARE shared, so each interested client gets a private
//     virtual id that maps onto the one real session;
//   * events go only to clients that asked for them: session events to the
//     owners of that session, target-lifecycle events to `setDiscoverTargets`
//     clients, attach events to clients holding or auto-attaching the target.
//
// `waitForDebuggerOnStart` is always sent to Chromium as `false`. One pipe means
// one setting for everybody, and a suspended target can only be resumed by a
// command — which the lease refuses while a person holds control. That was H4;
// this makes the fix structural instead of a per-client rewrite.

import { EventEmitter } from 'node:events';

const MAX_FRAME = 64 * 1024 * 1024;
// A queue this deep means the browser has stopped reading its pipe. Failing the
// connection is better than growing without bound; the gateway restarts it.
const MAX_QUEUED = 64 * 1024 * 1024;
const INTERNAL_TIMEOUT_MS = 15000;

export class PipeClosedError extends Error {
  constructor(message = 'The browser connection closed.') { super(message); this.name = 'PipeClosedError'; }
}

// ── framing ──────────────────────────────────────────────────────────────────

/**
 * NUL-delimited JSON over a pair of streams. Owns the write order (one pipe
 * means one writer, so order is the whole ordering guarantee) and the read
 * buffer, with a hard cap on both.
 */
export class PipeTransport {
  #input; #output;
  #maxFrame;
  /** Set by the owner; a transport has exactly one consumer. */
  onMessage = null;
  onClose = null;
  #acc = Buffer.alloc(0);
  #queue = [];
  #queued = 0;
  #blocked = false;
  #closed = false;
  #failure = null;

  constructor({ input, output, onMessage, onClose, maxFrame = MAX_FRAME }) {
    this.#input = input;
    this.#output = output;
    this.onMessage = onMessage ?? null;
    this.onClose = onClose ?? null;
    this.#maxFrame = maxFrame;

    input.on('data', chunk => this.#read(chunk));
    input.on('error', error => this.#fail(error));
    input.on('close', () => this.#fail(new PipeClosedError()));
    output.on('error', error => this.#fail(error));
    output.on('drain', () => { this.#blocked = false; this.#flush(); });
  }

  get closed() { return this.#closed; }
  get failure() { return this.#failure; }

  /** Frame and queue one message. Returns false once the pipe is unusable. */
  send(message) {
    if (this.#closed) return false;
    let payload;
    try { payload = Buffer.from(JSON.stringify(message), 'utf8'); }
    catch { return false; }
    if (payload.length > this.#maxFrame) return false;
    const framed = Buffer.allocUnsafe(payload.length + 1);
    payload.copy(framed);
    framed[payload.length] = 0;
    this.#queued += framed.length;
    if (this.#queued > MAX_QUEUED) {
      this.#fail(new Error('The browser stopped reading its command pipe.'));
      return false;
    }
    this.#queue.push(framed);
    this.#flush();
    return true;
  }

  close() { this.#fail(new PipeClosedError()); }

  #flush() {
    if (this.#closed || this.#blocked) return;
    while (this.#queue.length > 0) {
      const framed = this.#queue.shift();
      this.#queued -= framed.length;
      // The child may have gone away between two writes; a write error arrives
      // as an 'error' event on the stream and is handled there.
      try { this.#blocked = this.#output.write(framed) === false; }
      catch (error) { this.#fail(error); return; }
      if (this.#blocked) return;
    }
  }

  #read(chunk) {
    if (this.#closed) return;
    this.#acc = this.#acc.length === 0 ? chunk : Buffer.concat([this.#acc, chunk]);
    for (;;) {
      const end = this.#acc.indexOf(0);
      if (end === -1) break;
      const frame = this.#acc.subarray(0, end);
      this.#acc = this.#acc.subarray(end + 1);
      if (frame.length === 0) continue;
      let message;
      try { message = JSON.parse(frame.toString('utf8')); }
      catch { continue; } // a broken frame is the browser's problem, never a crash here
      try { this.onMessage?.(message); } catch { /* a bad consumer must not stop the pipe */ }
    }
    if (this.#acc.length > this.#maxFrame) {
      this.#fail(new Error('The browser sent a frame larger than the limit.'));
    }
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error instanceof Error ? error : new Error(String(error));
    this.#queue.length = 0;
    this.#queued = 0;
    this.#acc = Buffer.alloc(0);
    try { this.onClose?.(this.#failure); } catch { /* ignore */ }
  }
}

// ── one client on the pipe ───────────────────────────────────────────────────

/**
 * A CDP endpoint that quacks like the `ws` client the gateway already used, so
 * the policy/lease layer above it did not have to be rewritten. `readyState`
 * uses the WebSocket values on purpose: callers compare against
 * `WebSocket.OPEN`, and 1 is 1 whether the bytes travel over TCP or a pipe.
 */
export class PipeChannel extends EventEmitter {
  #mux; #kind; #targetId;
  #real = new Map();   // virtual session id -> real session id
  #virtual = new Map(); // real session id -> virtual session id
  #autoAttach = false;
  #filter = null;
  #discover = false;
  #closed = false;
  #pendingPageAttach = null;
  #attachedTargets = new Set();
  #sessionTargets = new Map();
  label;

  /** kind is 'browser' (browser-level CDP) or 'page' (one target, session-less). */
  constructor(mux, { kind, targetId, label }) {
    super();
    this.#mux = mux;
    this.#kind = kind;
    this.#targetId = targetId;
    this.label = label || `${kind}:${targetId || 'browser'}`;
    this.readyState = 1;
  }

  get kind() { return this.#kind; }
  get targetId() { return this.#targetId; }
  get autoAttachEnabled() { return this.#autoAttach; }
  get closed() { return this.#closed; }

  /** Attach a page-bound channel before it is handed to a client. */
  async bind() {
    if (this.#kind !== 'page') return this;
    const result = await this.#mux.request('Target.attachToTarget', { targetId: this.#targetId, flatten: true }, { timeoutMs: INTERNAL_TIMEOUT_MS });
    const sessionId = result?.sessionId;
    if (!sessionId) throw new Error('The browser did not attach to that page.');
    this.#real.set(sessionId, sessionId);
    this.#virtual.set(sessionId, sessionId);
    this.#pendingPageAttach = sessionId;
    return this;
  }

  /** The wire form: what a WebSocket `send` accepted. */
  send(text, callback) {
    if (this.#closed) { callback?.(new Error('The browser connection closed.')); return false; }
    let message;
    try { message = JSON.parse(String(text)); }
    catch { callback?.(new Error('The gateway only accepts JSON CDP messages.')); return false; }
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
      // A response- or event-shaped message from a client is not CDP input.
      callback?.(new Error('The gateway only accepts CDP commands.'));
      return false;
    }
    const id = message.id;
    if (id === undefined || id === null) {
      callback?.(new Error('The gateway requires a CDP command id.'));
      return false;
    }
    this.#dispatch(message, callback);
    return true;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.readyState = 3;
    this.#mux.onChannelClosed(this);
    this.emit('close');
  }

  // ── mux callbacks ──

  /** A reply from Chromium addressed to this client. */
  onReply(message, clientId) {
    if (this.#closed) return;
    const out = { id: clientId };
    if (message.error) out.error = message.error;
    else out.result = message.result;
    if (message.sessionId) {
      const virtual = this.#virtual.get(message.sessionId);
      if (!virtual) return; // a session this client no longer owns
      if (this.#kind !== 'page') out.sessionId = virtual;
    }
    this.#deliver(JSON.stringify(out));
  }

  /** An event from Chromium, already decided to belong to this client. */
  onEvent(message, rewriteSession) {
    if (this.#closed) return;
    if (!rewriteSession) return this.#deliver(JSON.stringify(message));
    const virtual = this.#virtual.get(rewriteSession);
    if (!virtual) return;

    if (this.#kind === 'page' && rewriteSession === this.#pendingPageAttach) {
      // The connection *is* that page's session, exactly like a
      // `/devtools/page` WebSocket: the client never sees the id.
      const { sessionId: _drop, ...rest } = message;
      if (rest.params && typeof rest.params.sessionId === 'string') {
        const { sessionId: _alsoDrop, ...params } = rest.params;
        rest.params = params;
      }
      return this.#deliver(JSON.stringify(rest));
    }

    const out = { ...message };
    if (out.sessionId) out.sessionId = virtual;
    // `Target.attachedToTarget` and `Target.detachedFromTarget` carry the
    // session id inside `params`, and an attach event has no top-level one at
    // all. Rewriting only the top level would hand every client the same real
    // id — and then one client's detach would look like another's.
    if (out.params && typeof out.params.sessionId === 'string') {
      out.params = { ...out.params, sessionId: virtual };
    }
    this.#deliver(JSON.stringify(out));
  }

  /** Browser event with no session, e.g. Target.targetCreated. */
  onBrowserEvent(message) { if (!this.#closed) this.#deliver(JSON.stringify(message)); }

  owns(realSession) {
    // Explicit attaches carry an identity mapping (virtual === real) and are
    // keys; a shared auto-attach session is a *value* under a private virtual id.
    // Both count as ownership, and getting that wrong would let one client's
    // detach pull the session out from under another.
    if (this.#real.has(realSession)) return true;
    for (const real of this.#real.values()) if (real === realSession) return true;
    return false;
  }

  /** The real Chromium session ids this client currently holds. */
  sessions() { return [...new Set(this.#real.values())]; }

  // ── internals ──

  #deliver(text) {
    if (this.#closed) return;
    try { this.emit('message', Buffer.from(text, 'utf8'), false); }
    catch (error) {
      // A consumer that throws on a message must not be able to take the pipe —
      // or every other client on it — down. Surface it only to a listener that
      // asked for errors; emitting into the void would throw here instead.
      if (this.listenerCount('error') > 0) this.emit('error', error);
    }
  }

  #dispatch(message, callback) {
    const method = message.method;
    if (this.#kind === 'page') {
      // A page-bound client never names a session: the connection *is* one. And
      // its own auto-attach (for out-of-process child frames) stays session
      // scoped, but must not suspend what it attaches to — same reason as H4.
      if (!message.sessionId) message = { ...message, sessionId: this.#pendingPageAttach };
      if (method === 'Target.setAutoAttach') {
        const params = message.params && typeof message.params === 'object' ? message.params : {};
        this.#autoAttach = params.autoAttach !== false;
        this.#filter = Array.isArray(params.filter) && params.filter.length > 0 ? params.filter : null;
        if (params.waitForDebuggerOnStart === true) {
          message = { ...message, params: { ...params, waitForDebuggerOnStart: false } };
        }
      }
    }

    if (method === 'Target.attachToTarget' && this.#kind === 'browser') {
      this.#attach(message, callback);
      return;
    }
    if (method === 'Target.detachFromTarget' && this.#kind === 'browser') {
      this.#detach(message, callback);
      return;
    }
    if (method === 'Target.setAutoAttach' && this.#kind === 'browser') {
      this.#setAutoAttach(message, callback);
      return;
    }
    if (method === 'Target.setDiscoverTargets' && this.#kind === 'browser') {
      this.#setDiscoverTargets(message, callback);
      return;
    }

    // A session id inside params (Target.detachFromTarget, the legacy
    // Target.sendMessageToTarget tunnel, Page.* frame commands) may be one of the
    // private ids this client was given for a shared auto-attach session.
    if (message.params && typeof message.params.sessionId === 'string') {
      const real = this.#real.get(message.params.sessionId);
      if (real) message = { ...message, params: { ...message.params, sessionId: real } };
    }

    if (message.sessionId) {
      const real = this.#real.get(message.sessionId);
      if (!real) {
        this.#denied(message, 'That target session is not attached to this connection.');
        return;
      }
      message = { ...message, sessionId: real };
    }
    this.#mux.forward(this, message, callback);
  }

  #attach(message, callback) {
    const targetId = message.params?.targetId;
    const shouldFlatten = message.params?.flatten !== false;
    if (typeof targetId !== 'string' || !targetId) {
      this.#denied(message, 'Target.attachToTarget requires a targetId.');
      return;
    }
    this.#mux.request('Target.attachToTarget', { targetId, flatten: shouldFlatten }, { timeoutMs: INTERNAL_TIMEOUT_MS })
      .then(result => {
        if (this.#closed) return;
        const sessionId = result?.sessionId;
        if (!sessionId) throw new Error('The browser did not return a session id.');
        this.#real.set(sessionId, sessionId);
        this.#virtual.set(sessionId, sessionId);
        this.#attachedTargets.add(targetId);
        this.#sessionTargets.set(sessionId, targetId);
        this.#reply(message.id, { sessionId });
      })
      .catch(error => this.#replyError(message.id, -32000, error.message));
    callback?.(null);
  }

  #detach(message, callback) {
    const requested = message.params?.sessionId;
    const real = requested ? this.#real.get(requested) : null;
    if (!real) { this.#reply(message.id, {}); callback?.(null); return; }
    this.#real.delete(requested);
    this.#virtual.delete(real);
    const explicit = this.#sessionTargets.get(real);
    if (explicit) { this.#sessionTargets.delete(real); this.#attachedTargets.delete(explicit); }
    this.#mux.releaseSession(real, this)
      .then(() => this.#reply(message.id, {}))
      .catch(error => this.#replyError(message.id, -32000, error.message));
    callback?.(null);
  }

  #setAutoAttach(message, callback) {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const wasEnabled = this.#autoAttach;
    this.#autoAttach = params.autoAttach !== false;
    this.#filter = Array.isArray(params.filter) && params.filter.length > 0 ? params.filter : null;
    this.#mux.syncAutoAttach()
      // A client that enables auto-attach *after* the shared browser-level switch
      // is already on gets no attaches of its own — Chromium only announces them
      // to the connection that asked, and a second ask is a no-op. Catching this
      // client up is what keeps a late client's view the same as a
      // dedicated-connection one.
      .then(() => (this.#autoAttach && !wasEnabled ? this.#mux.catchUpAutoAttach(this) : undefined))
      .then(() => this.#reply(message.id, {}))
      .catch(error => this.#replyError(message.id, -32000, error.message));
    callback?.(null);
  }

  #setDiscoverTargets(message, callback) {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    this.#discover = params.discover !== false;
    this.#mux.syncDiscoverTargets()
      .then(() => this.#reply(message.id, {}))
      .catch(error => this.#replyError(message.id, -32000, error.message));
    callback?.(null);
  }

  wantsAutoAttachOf(targetInfo) {
    if (!this.#autoAttach || !targetInfo) return false;
    if (!this.#filter) return true;
    return matchesFilter(this.#filter, targetInfo);
  }

  wantsDiscover() { return this.#discover; }

  /** A client explicitly attached this target: it must not be attached twice. */
  holdsTarget(targetId) { return this.#attachedTargets.has(targetId); }
  holdTarget(targetId) { this.#attachedTargets.add(targetId); }

  /** Give an auto-attached real session a private virtual id for this client. */
  adoptSession(realSession) {
    const existing = this.#virtual.get(realSession);
    if (existing) return existing;
    const virtual = this.#mux.nextVirtualSessionId(realSession);
    this.#real.set(virtual, realSession);
    this.#virtual.set(realSession, virtual);
    return virtual;
  }

  /** Take a session Chromium created for this client at its own request. */
  adoptIdentity(realSession) {
    this.#real.set(realSession, realSession);
    this.#virtual.set(realSession, realSession);
    return realSession;
  }

  /** Deliver an event the mux built itself, in the shape Chromium would use. */
  deliverRaw(message) { if (!this.#closed) this.#deliver(JSON.stringify(message)); }

  /** Drop a session mapping without telling Chromium (another client owns it). */
  forgetSession(realSession) {
    const virtual = this.#virtual.get(realSession);
    if (!virtual) return false;
    this.#virtual.delete(realSession);
    this.#real.delete(virtual);
    return true;
  }

  #reply(id, result) { this.#deliver(JSON.stringify({ id, result })); }
  #replyError(id, code, message) { this.#deliver(JSON.stringify({ id, error: { code, message } })); }
  #denied(message, reason) { this.#replyError(message.id, -32601, reason); }
}

// `Target.setAutoAttach`'s filter is `TargetFilter[] = { type?, exclude? }[]`:
// an entry either includes or excludes one target type, exclusions win, and an
// empty filter includes everything.
function matchesFilter(entries, targetInfo) {
  const type = String(targetInfo.type || '');
  let included = entries.length === 0;
  let excluded = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const matches = entry.type === undefined || entry.type === '*' || String(entry.type) === type;
    if (!matches) continue;
    if (entry.exclude) excluded = true; else included = true;
  }
  return included && !excluded;
}

// ── the browser, its pipe and every client on it ─────────────────────────────

export class PipeChromium {
  #transport; #child;
  #channels = new Set();
  #pending = new Map();
  #nextId = 1;
  #nextVirtual = 1;
  #closed = false;
  #failure = null;
  #listeners = new Set();
  #autoAttach = false;
  #discover = false;
  #operations = Promise.resolve();
  version = null;
  label;

  constructor({ child, label = 'chromium' }) {
    this.#child = child;
    this.label = label;
    this.#transport = attachPipeTransport(child);
    this.#transport.onMessage = message => this.#onMessage(message);
    this.#transport.onClose = error => this.#fail(error);
    // A child that cannot be killed, or whose stdio broke, reports it here. With
    // no listener that would be an uncaught exception in the host process.
    child.on('error', error => this.#fail(error));
  }

  get closed() { return this.#closed; }
  get failure() { return this.#failure; }
  get child() { return this.#child; }
  get channelCount() { return this.#channels.size; }
  get autoAttachEnabled() { return this.#autoAttach; }
  get discoverEnabled() { return this.#discover; }

  onClose(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  /** A command HOB itself needs (attach, screencast, target list, version). */
  request(method, params = {}, { sessionId, timeoutMs = INTERNAL_TIMEOUT_MS } = {}) {
    if (this.#closed) return Promise.reject(new PipeClosedError());
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The browser did not answer ${method} in time.`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        internal: true,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      if (!this.#transport.send(message)) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(this.#failure || new PipeClosedError());
      }
    });
  }

  /** Open a client channel. A page channel binds its target before resolving. */
  async createChannel({ kind, targetId, label }) {
    if (this.#closed) throw new PipeClosedError();
    const channel = new PipeChannel(this, { kind, targetId, label });
    this.#channels.add(channel);
    if (kind === 'page') await channel.bind();
    return channel;
  }

  /** Write a client's command, remembering who owns the id it was given. */
  forward(channel, message, callback) {
    const id = this.#nextId++;
    this.#pending.set(id, { channel, clientId: message.id });
    const ok = this.#transport.send({ ...message, id });
    if (!ok) {
      this.#pending.delete(id);
      callback?.(this.#failure || new PipeClosedError());
      return;
    }
    callback?.(null);
  }

  /** Serialise the shared browser-level switches so a burst cannot interleave. */
  #serial(run) {
    const next = this.#operations.then(run).catch(() => undefined);
    this.#operations = next;
    return next;
  }

  syncAutoAttach() {
    return this.#serial(async () => {
      const wanted = [...this.#channels].some(channel => channel.autoAttachEnabled);
      if (wanted === this.#autoAttach) return;
      this.#autoAttach = wanted;
      // `waitForDebuggerOnStart` is always false: one pipe means one setting for
      // every client, and a suspended target could only be resumed by a command
      // the lease refuses during a human takeover (H4).
      await this.request('Target.setAutoAttach', {
        autoAttach: wanted, waitForDebuggerOnStart: false, flatten: true,
      }).catch(() => undefined);
    });
  }

  syncDiscoverTargets() {
    return this.#serial(async () => {
      const wanted = [...this.#channels].some(channel => channel.wantsDiscover());
      if (wanted === this.#discover) return;
      this.#discover = wanted;
      await this.request('Target.setDiscoverTargets', { discover: wanted }).catch(() => undefined);
    });
  }

  /** A client detached: really detach only when no other client holds the session. */
  releaseSession(realSession, channel) {
    const others = [...this.#channels].some(other => other !== channel && other.owns(realSession));
    if (others) return Promise.resolve();
    return this.request('Target.detachFromTarget', { sessionId: realSession }).catch(() => undefined);
  }

  nextVirtualSessionId(realSession) {
    return `${realSession}-hob${this.#nextVirtual++}`;
  }

  /**
   * Bring one client up to date with a browser-level auto-attach that is already
   * on.
   *
   * Chromium announces an attach only to the connection that enabled auto-attach,
   * and a second `setAutoAttach` on the same connection is a no-op. On a pipe
   * there is only one connection, so without this a client that connects later
   * would see nothing until the next target appeared — which is not what the same
   * client gets from a dedicated DevTools connection.
   *
   * The catch-up attach is made *on the client's behalf*, so it is a private
   * session rather than a share of somebody else's.
   */
  async catchUpAutoAttach(channel) {
    const targets = await this.request('Target.getTargets', {}, { timeoutMs: INTERNAL_TIMEOUT_MS })
      .catch(() => null);
    for (const targetInfo of targets?.targetInfos || []) {
      if (channel.closed) return;
      if (!channel.wantsAutoAttachOf(targetInfo)) continue;
      if (channel.holdsTarget(targetInfo.targetId)) continue;
      const attached = await this.request('Target.attachToTarget',
        { targetId: targetInfo.targetId, flatten: true }, { timeoutMs: INTERNAL_TIMEOUT_MS }).catch(() => null);
      if (!attached?.sessionId) continue;
      channel.adoptIdentity(attached.sessionId);
      channel.holdTarget(targetInfo.targetId);
      channel.deliverRaw({
        method: 'Target.attachedToTarget',
        params: { sessionId: attached.sessionId, targetInfo, waitingForDebugger: false },
      });
    }
  }

  onChannelClosed(channel) {
    this.#channels.delete(channel);
    // A client that leaves takes its auto-attach interest with it, and any
    // session it held by itself is released so Chromium is not left attached to
    // a target on behalf of a client that is gone.
    for (const realSession of channel.sessions()) {
      if (![...this.#channels].some(other => other.owns(realSession))) {
        this.request('Target.detachFromTarget', { sessionId: realSession }).catch(() => undefined);
      }
    }
    void this.syncAutoAttach();
    void this.syncDiscoverTargets();
  }

  #onMessage(message) {
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      if (entry.internal) {
        if (message.error) entry.reject(new Error(message.error.message || 'CDP command failed.'));
        else entry.resolve(message.result);
        return;
      }
      entry.channel.onReply(message, entry.clientId);
      return;
    }
    if (typeof message.method === 'string') this.#routeEvent(message);
  }

  #routeEvent(message) {
    const method = message.method;
    const sessionId = message.sessionId;

    if (sessionId) {
      for (const channel of this.#channels) {
        if (channel.owns(sessionId)) channel.onEvent(message, sessionId);
      }
      return;
    }

    if (method === 'Target.attachedToTarget') {
      const params = message.params || {};
      const real = params.sessionId;
      if (!real) return;
      for (const channel of this.#channels) {
        if (channel.owns(real)) {
          channel.onEvent(message, real);
          continue;
        }
        if (channel.wantsAutoAttachOf(params.targetInfo)) {
          channel.adoptSession(real);
          channel.onEvent(message, real);
        }
      }
      return;
    }

    if (method === 'Target.detachedFromTarget') {
      const real = message.params?.sessionId;
      if (!real) return;
      for (const channel of this.#channels) {
        if (!channel.owns(real)) continue;
        channel.onEvent(message, real);
        channel.forgetSession(real);
      }
      return;
    }

    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged' || method === 'Target.targetDestroyed') {
      for (const channel of this.#channels) {
        if (channel.wantsDiscover()) channel.onBrowserEvent(message);
      }
      return;
    }

    // Everything else browser-level (Browser.*, Inspector.*, ...) is delivered
    // to every client: it is rare, unaddressed, and dropping it would surprise a
    // client that enabled the domain it belongs to.
    for (const channel of this.#channels) channel.onBrowserEvent(message);
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error instanceof Error ? error : new PipeClosedError(String(error));
    for (const entry of this.#pending.values()) {
      if (entry.internal) entry.reject(this.#failure);
    }
    this.#pending.clear();
    for (const channel of [...this.#channels]) channel.close();
    this.#channels.clear();
    for (const listener of this.#listeners) { try { listener(this.#failure); } catch { /* ignore */ } }
  }

  close(reason = 'The browser connection closed.') { this.#fail(new PipeClosedError(reason)); }
}

/**
 * Promise/event facade over one browser-kind pipe channel, matching the
 * `CdpConnection` the gateway already uses for its own commands. The screencast
 * code does not need to know whether it is talking to a port or a pipe.
 */
export class PipeCdpConnection {
  #channel; #nextId = 1; #pending = new Map(); #closed = false; #onEvent; #onClose;

  constructor(channel, { onEvent, onClose } = {}) {
    this.#channel = channel;
    this.#onEvent = onEvent;
    this.#onClose = onClose;
    channel.on('message', (data) => this.#dispatch(data));
    channel.on('close', () => this.#teardown());
    channel.on('error', () => this.#teardown());
  }

  get open() { return !this.#closed && this.#channel.readyState === 1; }
  get url() { return 'pipe://hob'; }

  async connect() { return this; }

  send(method, params = {}, { sessionId, timeoutMs = 30000 } = {}) {
    if (!this.open) return Promise.reject(new Error('Browser connection is not open.'));
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The browser did not answer ${method} in time.`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.#channel.send(JSON.stringify(message), error => {
        if (!error) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  post(method, params = {}, options = {}) { return this.send(method, params, options).catch(() => undefined); }

  close() {
    this.#teardown();
    this.#channel.close();
  }

  #dispatch(data) {
    let message;
    try { message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); }
    catch { return; }
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const entry = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || 'CDP command failed.'));
      else entry.resolve(message.result);
      return;
    }
    if (message.method) this.#onEvent?.(message);
  }

  #teardown() {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#pending.values()) entry.reject(new Error('Browser connection closed.'));
    this.#pending.clear();
    this.#onClose?.();
  }
}

/** A transport bound to a spawned Chromium's fds 3 and 4. */
export function attachPipeTransport(child, { maxFrame = MAX_FRAME } = {}) {
  const input = child.stdio[4];
  const output = child.stdio[3];
  if (!input || !output) throw new Error('Chromium did not receive its command pipe.');
  return new PipeTransport({ input, output, maxFrame });
}
