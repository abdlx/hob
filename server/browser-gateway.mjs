// HOB CDP gateway: one authenticated, loopback-only CDP endpoint per bot.
//
//   Hermes (browser_cdp, browser_navigate, agent-browser, the CDP supervisor)
//        │  ws://127.0.0.1:<port>/<token>/devtools/browser/<id>
//        ▼
//   BrowserSession  ── classify ──│── ControlLease ──► raw Chromium
//        ▲                         │
//        └── viewer stream (Atrium protocol: JPEG frames + input)
//
// Everything Hermes does to the browser goes through this file, which is what
// lets a human takeover be enforced rather than advertised: the lease is
// consulted at the only place where a CDP mutation could otherwise reach
// Chromium. `browser.cdp_url` points here, never at the browser.

import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { parseClientMessage } from '@atriumjs/protocol';
import { classify, OBSERVE } from './browser-policy.mjs';
import { ControlLease, AGENT, HUMAN } from './browser-lease.mjs';
import { CdpConnection } from './browser-cdp-client.mjs';
import { PipeCdpConnection } from './browser-pipe.mjs';
import { ModifierState, inputCommands } from './browser-input.mjs';
import { BROWSER_VIEWPORT, closeBrowserGracefully, closePipeGracefully, cdpTransportMode, launchChromium, probeCdp, probePipe, resolveChromiumExecutable, markProfileOwned, stopChromium } from './browser-launcher.mjs';

// CDP error code for a command the gateway refused to forward. Hermes surfaces
// the message verbatim to the model, so it names the reason and the remedy.
const CDP_DENIED = -32001;
const MAX_VIEWER_BUFFER = 8 * 1024 * 1024;
// The legacy, non-flattened `Target.sendMessageToTarget` tunnel gives no reply
// we can correlate, so it holds the drain barrier for a bounded window instead.
const TUNNEL_HOLD_MS = 1500;
const CRASH_RESTART_ATTEMPTS = 3;
const CRASH_RESTART_DELAY_MS = 1000;
// How long a browser must stay up before its crash-restart budget is restored.
const CRASH_HEALTHY_MS = 60 * 1000;
// The gateway's own CDP commands use ids no client can collide with, and are
// never relayed back as replies.
const INTERNAL_ID_BASE = -100000;
// A CDP frame this size is already pathological (a screenshot is a few MB); the
// bound exists so a hostile or broken peer cannot make the gateway allocate
// without limit. 64 MiB leaves generous headroom for MHTML snapshots.
const MAX_CDP_FRAME = 64 * 1024 * 1024;

export class BrowserUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'BrowserUnavailableError'; }
}

// Opt-in wire trace (`HOB_BROWSER_TRACE=/path/to/file`). It records command
// names and their shape — never parameters, so a page URL or a cookie value can
// never be logged — and it is the only way to audit which CDP methods a client
// actually depends on. Off unless the operator asks for it.
const TRACE_FILE = (process.env.HOB_BROWSER_TRACE || '').trim();
if (TRACE_FILE) process.on('exit', () => { try { appendFileSync(TRACE_FILE, 'trace: end\n'); } catch { /* ignore */ } });
function trace(line) {
  if (!TRACE_FILE) return;
  try { appendFileSync(TRACE_FILE, `${Date.now()} ${line}\n`); } catch { /* tracing must never break the browser */ }
}

function denialMessage(reason, method) {
  if (reason === 'human_has_control') {
    return `Browser control is held by the human operator. "${method}" was not sent to the browser. It will be accepted again once control returns to the agent.`;
  }
  if (reason === 'cancelled') return `"${method}" was cancelled because the requesting connection closed.`;
  return `The browser is being handed over to the human operator; "${method}" was not sent. Retry once control settles.`;
}

// ── One agent (Hermes) CDP connection ────────────────────────────────────────
//
// Chromium accepts many concurrent CDP clients, so each inbound connection gets
// its own upstream connection. That keeps CDP id spaces trivially unambiguous
// and means one misbehaving client cannot corrupt another's message stream.

class AgentProxy {
  #session;
  #client;
  #upstream = null;
  #kind;
  #targetId;
  #inFlight = new Map();
  #abort = new AbortController();
  #closed = false;
  #ready = null;
  #inbound = Promise.resolve();
  #mutations = Promise.resolve();
  // Auto-attach state this client installed, keyed by the session it was sent
  // on, plus the ids of the gateway's own neutralizing commands (which are never
  // forwarded back to the client, so its id space stays untouched).
  #autoAttach = new Map();
  #internal = new Set();
  #internalSeq = 0;
  label;

  constructor(session, client, { kind, targetId, label }) {
    this.#session = session; this.#client = client; this.#kind = kind; this.#targetId = targetId;
    this.label = label;
  }

  get inFlightCount() { return this.#inFlight.size; }

  async open() {
    // Attach to the client *before* any await. `ws` discards messages that
    // arrive while a socket has no `message` listener, and a CDP client sends
    // its first command the instant the upgrade completes. Processing is
    // serialised so commands reach Chromium in the order they were sent.
    this.#client.on('message', (data, isBinary) => this.#enqueueInbound(data, isBinary));
    this.#client.on('close', () => this.#teardown());
    this.#client.on('error', () => this.#teardown());
    this.#ready = this.#connectUpstream();
    await this.#ready.catch(() => undefined);
  }

  #enqueueInbound(data, isBinary) {
    this.#inbound = this.#inbound.then(() => this.#onClientMessage(data, isBinary)).catch(() => undefined);
  }

  /**
   * Mutations queue among themselves so their relative order is preserved, but
   * never inside `#inbound`: a command waiting out a human takeover must not
   * stall the observational commands behind it. Watching is not controlling, and
   * it must stay live exactly when control changes hands.
   */
  #enqueueMutation(run) {
    this.#mutations = this.#mutations.then(run).catch(() => undefined);
  }

  async #connectUpstream() {
    let upstream;
    try {
      // The endpoint is listening whenever hob is; the browser is not. A CDP
      // connection is the moment the browser is genuinely needed, so it starts
      // here — the agent never has to ask for a separate "start the browser" step.
      await this.#session.start();
      upstream = await this.#session.openUpstream(this.#kind, this.#targetId, this.label);
    }
    catch (error) { this.#close(1011, error.message); return; }

    this.#upstream = upstream;
    upstream.on('message', (data, isBinary) => this.#onUpstreamMessage(data, isBinary));
    upstream.on('close', () => { this.#releaseAll(); this.#close(1011, 'The browser connection closed.'); });
    upstream.on('error', error => { this.#close(1011, `The browser connection failed: ${error.message}`); });

    await new Promise(resolve => {
      if (upstream.readyState === WebSocket.OPEN) return resolve();
      upstream.once('open', resolve);
      upstream.once('error', resolve);
    });
    if (upstream.readyState !== WebSocket.OPEN) return;
    this.#session.noteAgentConnected(this);
  }

  async #onClientMessage(data, isBinary) {
    if (this.#closed) return;
    await this.#ready?.catch(() => undefined);
    if (this.#closed) return;
    if (isBinary || this.#upstream?.readyState !== WebSocket.OPEN) {
      this.#sendClient({ id: null, error: { code: CDP_DENIED, message: 'The browser is not available right now.' } });
      return;
    }
    const text = data.toString('utf8');
    let message;
    try { message = JSON.parse(text); }
    catch { this.#sendClient({ id: null, error: { code: CDP_DENIED, message: 'The gateway only accepts JSON CDP messages.' } }); return; }

    trace(`client ${this.label} method=${typeof message?.method === 'string' ? message.method : '(none)'} id=${message?.id === undefined ? 'absent' : 'present'}${message?.sessionId ? ' session' : ''}`);

    if (!message || typeof message !== 'object' || message.method === undefined) {
      // A response-shaped or event-shaped message from a client is not valid CDP
      // input, but forwarding it lets Chromium answer with its own protocol error.
      return this.#forward(text);
    }

    const method = message.method;
    if (typeof method !== 'string' || message.id === undefined || message.id === null) {
      // A method without a correlatable id is not something a well-formed CDP
      // client sends, and it cannot be attributed to a principal — yet Chromium
      // may still dispatch it. Nothing genuine depends on that, so the gateway
      // refuses it rather than relying on undocumented Chromium behaviour.
      this.#sendClient({
        id: null,
        error: { code: CDP_DENIED, message: `The gateway requires a CDP command id. "${String(method)}" was not sent to the browser.` },
      });
      return;
    }

    if (method === 'Target.setAutoAttach') return this.#forwardAutoAttach(message, text);
    if (classify(method) === OBSERVE) return this.#forward(text);

    if (method === 'Target.sendMessageToTarget') {
      this.#enqueueMutation(() => this.#forwardTunnel(message, text));
      return;
    }

    this.#enqueueMutation(() => this.#admitAndForward(message.id, method, message.params, text));
  }

  /**
   * `Target.setAutoAttach` is how a client observes targets a page creates
   * (cross-origin frames, workers). Playwright asks for it with
   * `waitForDebuggerOnStart: true`, which *suspends* each such target until
   * somebody sends `Runtime.runIfWaitingForDebugger`.
   *
   * During a human takeover that resume is a mutation and is refused — so an
   * agent that attaches while a person is browsing would silently freeze every
   * frame the person's page loads. The gateway keeps the observation and drops
   * the suspension for as long as a human holds control, and reverts a
   * suspension that the agent installed beforehand across a handover.
   */
  #forwardAutoAttach(message, text) {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const key = message.sessionId || '';
    if (params.autoAttach === false) this.#autoAttach.delete(key);
    else this.#autoAttach.set(key, { sessionId: message.sessionId, params });

    if (this.#session.controlHolder() === HUMAN && params.waitForDebuggerOnStart === true) {
      return this.#forward(JSON.stringify({ ...message, params: { ...params, waitForDebuggerOnStart: false } }));
    }
    return this.#forward(text);
  }

  /** Re-point every suspension this client installed at "do not suspend". */
  neutralizeAutoAttach() {
    // Over a pipe there is nothing to neutralize: the gateway owns the single
    // browser-level auto-attach and always asks Chromium not to suspend new
    // targets, so no client can install a suspension in the first place.
    if (this.#upstream?.autoAttachNeutralized) return false;
    if (this.#closed || this.#upstream?.readyState !== WebSocket.OPEN) return false;
    let sent = false;
    for (const entry of this.#autoAttach.values()) {
      const id = INTERNAL_ID_BASE - (this.#internalSeq += 1);
      this.#internal.add(id);
      const message = { id, method: 'Target.setAutoAttach', params: { ...entry.params, waitForDebuggerOnStart: false } };
      if (entry.sessionId) message.sessionId = entry.sessionId;
      this.#upstream.send(JSON.stringify(message), () => undefined);
      sent = true;
    }
    return sent;
  }

  async #admitAndForward(id, method, params, text) {
    if (this.#closed) return;
    const admission = await this.#session.admitAgentMutation(this.#abort.signal);
    if (this.#closed) { if (admission.ok) admission.release(); return; }
    if (!admission.ok) {
      this.#sendClient({ id, error: { code: CDP_DENIED, message: denialMessage(admission.reason, method) } });
      return;
    }
    this.#track(id, admission.release);
    this.#session.noteAgentActivity(method, params);
    this.#forward(text);
  }

  // Non-flattened session traffic hides the real command inside a JSON string
  // with no correlatable reply. Observational inner commands pass straight
  // through; anything else is admitted and held for a bounded window so a
  // takeover cannot land in the middle of it.
  async #forwardTunnel(message, text) {
    let inner = null;
    try { inner = JSON.parse(String(message.params?.message ?? '')); } catch { inner = null; }
    const innerMethod = inner && typeof inner.method === 'string' ? inner.method : null;
    if (innerMethod && classify(innerMethod) === OBSERVE) return this.#forward(text);

    const method = innerMethod ? `Target.sendMessageToTarget(${innerMethod})` : 'Target.sendMessageToTarget';
    const admission = await this.#session.admitAgentMutation(this.#abort.signal);
    if (!admission.ok) {
      this.#sendClient({ id: message.id, error: { code: CDP_DENIED, message: denialMessage(admission.reason, method) } });
      return;
    }
    this.#track(message.id, admission.release, TUNNEL_HOLD_MS);
    this.#session.noteAgentActivity(innerMethod || 'Target.sendMessageToTarget', inner?.params);
    this.#forward(text);
  }

  #track(id, release, holdMs = 0) {
    const existing = this.#inFlight.get(id);
    if (existing) existing.release();
    const timer = holdMs > 0 ? setTimeout(() => { this.#inFlight.delete(id); release(); }, holdMs) : null;
    timer?.unref?.();
    this.#inFlight.set(id, { release, timer });
  }

  #releaseAll() {
    for (const entry of this.#inFlight.values()) { if (entry.timer) clearTimeout(entry.timer); entry.release(); }
    this.#inFlight.clear();
  }

  #forward(text) {
    if (this.#upstream?.readyState !== WebSocket.OPEN) return;
    this.#upstream.send(text, error => { if (error) this.#close(1011, 'Failed to reach the browser.'); });
  }

  #onUpstreamMessage(data, isBinary) {
    if (this.#closed) return;
    if (!isBinary) {
      // Release the drain barrier the moment the command's reply lands, so a
      // takeover waits exactly as long as the browser is actually busy.
      const id = peekId(data);
      if (id !== null) {
        // The reply to a neutralizing command belongs to nobody: it must not be
        // relayed to a client that never asked for it.
        if (this.#internal.delete(id)) return;
        const entry = this.#inFlight.get(id);
        if (entry) {
          this.#inFlight.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          entry.release();
        }
      }
    }
    this.#sendClientRaw(data, isBinary);
  }

  #sendClient(value) { if (this.#client.readyState === WebSocket.OPEN) this.#client.send(JSON.stringify(value)); }
  #sendClientRaw(data, isBinary) { if (this.#client.readyState === WebSocket.OPEN) this.#client.send(data, { binary: isBinary }); }

  /** Public teardown used by `BrowserSession.stop()`. */
  close() { this.#close(1000, 'The browser session is shutting down.'); }

  #close(code, reason) {
    if (this.#closed) return;
    this.#teardown();
    try { this.#client.close(code, String(reason || '').slice(0, 120)); } catch { /* already closed */ }
  }

  #teardown() {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    this.#releaseAll();
    try { this.#upstream?.close(); } catch { /* already closed */ }
    this.#session.noteAgentDisconnected(this);
  }
}

// Read only the `id` of a CDP reply, without materialising the whole payload.
function peekId(data) {
  if (typeof data === 'string') return idFromText(data);
  if (Buffer.isBuffer(data)) return idFromText(data.toString('utf8', 0, Math.min(data.length, 64)));
  return null;
}

function idFromText(text) {
  // Signed, because the gateway's own neutralizing commands use negative ids
  // that no client can collide with.
  const match = /^\s*\{\s*"id"\s*:\s*(-?\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

// ── One bot's browser ────────────────────────────────────────────────────────

export class BrowserSession {
  #botId; #record; #profileDir; #token; #port;
  #chromium = null; #chromiumPort = null; #pipe = null;
  // Resolved once, at construction: a status read must not claim "tcp" just
  // because no browser happens to be running at that moment.
  #transportMode = cdpTransportMode();
  #server = null;
  // Created once, never closed: with `noServer` it owns no port, so it can
  // outlive individual start/stop cycles and keep accepting upgrades.
  #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CDP_FRAME, perMessageDeflate: false });
  #lease;
  #agents = new Set();
  #viewers = new Map();
  #activity = new Set();
  #stateListeners = new Set();
  #castCdp = null; #castSessionId = null; #castTargetId = null; #castPinned = false;
  #frameSeq = 0; #lastFrame = null; #lastFrameAt = 0;
  #viewport = { ...BROWSER_VIEWPORT };
  #tabs = [];
  #page = { url: '', title: '', loading: false };
  #lastError = null;
  #lastActiveAt = Date.now();
  #starting = null;
  // Bumped by every stop. A launch that is already in flight when a stop begins
  // is stale the moment it lands, and closing the browser it just started is the
  // only way to avoid an orphan that nothing tracks any more.
  #launchEpoch = 0;
  #listening = null;
  #restarts = 0;
  #stopping = false;
  #minFrameIntervalMs;

  constructor({ botId, record, options = {} }) {
    this.#botId = botId;
    this.#record = record;
    this.#token = record.gatewayToken;
    this.#port = record.gatewayPort;
    this.#profileDir = options.profileDir;
    this.#agentWaitMs = options.agentWaitMs ?? 20000;
    this.#minFrameIntervalMs = Math.max(0, Math.floor(1000 / (options.maxFps ?? 24)));
    this.#lease = new ControlLease({ agentWaitMs: this.#agentWaitMs });
    this.#lease.on(snapshot => {
      this.#touch();
      this.#broadcast({ t: 'control', holder: snapshot.holder });
      this.#emitActivity({ type: 'control', holder: snapshot.holder, since: snapshot.since, pending: snapshot.pending });
      this.#emitState();
    });
  }

  #agentWaitMs;

  get bot() { return this.#botId; }
  get cdpUrl() { return `http://127.0.0.1:${this.#port}/${this.#token}`; }
  get lease() { return this.#lease; }
  get running() { return this.#server !== null && this.#chromium !== null; }
  get viewerCount() { return this.#viewers.size; }
  get lastActiveAt() { return this.#lastActiveAt; }

  #touch() { this.#lastActiveAt = Date.now(); }

  status() {
    return {
      bot: this.#botId,
      // "running" means a browser is attached *and* the gateway serving it. A
      // browser that crashed is "stopped", not "starting": nothing is on its way
      // back unless a viewer is watching, and `lastError` says what happened.
      state: this.#starting ? 'starting' : (this.#chromium && this.#server ? 'running' : 'stopped'),
      cdpUrl: this.cdpUrl,
      port: this.#port,
      // The *browser's* ephemeral DevTools port, not the gateway's. Internal: the
      // dashboard view strips it, and tests use it to prove a browser really is
      // gone rather than merely forgotten. Always null over a pipe: that is the
      // point of pipe mode, and it is asserted by test.
      chromiumPort: this.#chromiumPort,
      transport: this.#transportMode,
      viewers: this.#viewers.size,
      agentConnections: this.#agents.size,
      control: this.#lease.snapshot(),
      viewport: { ...this.#viewport },
      tabs: this.#tabs.map(tab => ({ ...tab })),
      url: this.#page.url,
      title: this.#page.title,
      loading: this.#page.loading,
      profileDir: this.#profileDir,
      lastError: this.#lastError,
    };
  }

  onStateChange(listener) { this.#stateListeners.add(listener); return () => this.#stateListeners.delete(listener); }
  onActivity(listener) { this.#activity.add(listener); return () => this.#activity.delete(listener); }

  /**
   * Read the current page and tabs from the browser's own target list.
   *
   * `#page` is otherwise fed only by the screencast, and the screencast runs only
   * while somebody is watching — so without this the dashboard would show no URL and
   * the tests would have nothing but a stale cache to assert on. Reading goes
   * through the target list rather than a CDP session, so it is purely
   * observational and can never queue behind, or interfere with, the lease.
   */
  async refresh() {
    const targets = await this.#listTargets();
    if (Array.isArray(targets)) {
      const pages = targets.filter(target => target?.type === 'page' && !String(target.url || '').startsWith('devtools://'));
      const active = pages.find(target => target.id === this.#castTargetId) ?? pages[0];
      this.#tabs = pages.map(target => ({
        id: target.id,
        url: String(target.url || ''),
        title: String(target.title || ''),
        active: target.id === active?.id,
      }));
      if (active) {
        this.#page.url = String(active.url || this.#page.url);
        const title = String(active.title || '');
        if (title && title !== this.#page.url && !isLocationTitle(title)) this.#page.title = title;
      }
    }
    return this.status();
  }

  /**
   * `Target.getTargets` in the gateway's `/json/list` shape, over whichever
   * transport the browser is using. `null` when there is no browser to ask.
   */
  async #listTargets() {
    if (this.#pipe && !this.#pipe.closed) {
      try {
        const { targetInfos = [] } = await this.#pipe.request('Target.getTargets', {}, { timeoutMs: 3000 });
        return targetInfos.map(info => ({
          id: info.targetId,
          type: info.type,
          title: info.title,
          url: info.url,
          attached: info.attached,
          webSocketDebuggerUrl: info.type === 'page'
            ? `ws://127.0.0.1:${this.#port}/${this.#token}/devtools/page/${info.targetId}`
            : undefined,
        }));
      } catch { return null; }
    }
    const port = this.#chromiumPort;
    if (!port) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return null;
      const targets = await response.json();
      return Array.isArray(targets) ? targets : null;
    } catch { return null; }
  }

  /**
   * True while something legitimately keeps the browser alive: a person watching,
   * or a command in flight or waiting for the lease.
   *
   * Agent *connections* are deliberately not work. agent-browser keeps a daemon
   * connection to the browser open indefinitely, so counting connections would mean
   * a browser is never idle in real use and the idle shutdown would never fire. A
   * connection is not use; a command is. When a browser is reaped its clients are
   * closed with 1011 and the endpoint stays up, so the next command connects to a
   * freshly started browser.
   */
  hasWork() {
    return this.#viewers.size > 0
      || this.#lease.inFlight > 0 || this.#lease.pending > 0 || this.#lease.draining;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the browser, or attach to one that is already running on this profile.
   * The loopback CDP endpoint is part of the gateway, not of the browser, so it is
   * brought up first and stays up across browser restarts.
   */
  start() {
    if (!this.#starting) {
      const epoch = this.#launchEpoch;
      this.#starting = this.#start(epoch).finally(() => { this.#starting = null; });
    }
    return this.#starting;
  }

  /**
   * Bind this bot's CDP endpoint without starting a browser.
   *
   * The endpoint has to exist before the *agent* is told about it: Hermes turns
   * `browser.cdp_url` into a websocket URL at the start of a turn, and a port that
   * is only open while Chromium happens to be running would fail that resolution —
   * with a warning and a confusing connect error, not a clear failure. The listener
   * is cheap (one loopback socket); the browser is not, so they have separate
   * lifetimes and only the browser idles down.
   */
  async ensureGateway() {
    if (!this.#server) {
      if (!this.#listening) {
        this.#listening = this.#listen().finally(() => { this.#listening = null; });
      }
      try {
        await this.#listening;
      } catch (error) {
        // The dashboard must be able to say why this bot's browser is unreachable
        // rather than just showing it as stopped.
        this.#lastError = `The browser endpoint could not start: ${error.message}`;
        throw error;
      }
    }
    return this.status();
  }

  async #start(epoch) {
    await markProfileOwned(this.#profileDir).catch(() => undefined);
    if (!this.#server) await this.ensureGateway();
    await this.#ensureChromium();
    if (epoch !== this.#launchEpoch) {
      // A stop was asked for while this launch was still in flight. The browser
      // that just came up belongs to nobody, and leaving it running would leak a
      // process (and a held profile) that no session tracks any more.
      const stale = this.#chromium;
      this.#chromium = null;
      this.#chromiumPort = null;
      if (stale?.child) await stopChromium(stale.child).catch(() => undefined);
      throw new Error('The browser was stopped while it was starting.');
    }
    this.#emitState();
    return this.status();
  }

  async #ensureChromium() {
    if (this.#chromium) {
      // Two chances: a browser in the middle of a large snapshot can miss a
      // short probe without being dead, and killing it for that would be worse
      // than waiting.
      if (await this.#browserAnswers(1000) || await this.#browserAnswers(3000)) return this.#chromium;
      // The transport is gone but the process may not be. Let go of it before a
      // relaunch can collide with the profile lock it is still holding.
      this.#pipe?.close('Replacing an unresponsive browser connection.');
      if (this.#chromium.child) await stopChromium(this.#chromium.child).catch(() => undefined);
      this.#pipe = null;
      this.#chromium = null;
      this.#chromiumPort = null;
    }
    const executablePath = await resolveChromiumExecutable();
    if (!executablePath) {
      throw new BrowserUnavailableError(
        'No Chromium-family browser was found. Install Chromium, or set HOB_CHROMIUM_PATH to the executable.');
    }
    const result = await launchChromium({ profileDir: this.#profileDir, executablePath, transport: this.#transportMode });
    this.#chromium = result;
    this.#chromiumPort = result.port ?? null;
    this.#pipe = result.pipe ?? null;
    if (this.#pipe) {
      // The pipe is the only route to the browser: the moment it drops, every
      // client is told so instead of waiting for a reply that cannot come.
      this.#pipe.onClose(error => this.#onPipeClosed(error));
    }
    this.#lastError = null;
    // The idle clock measures idleness *of a running browser*. Starting one takes
    // seconds, and without this a freshly launched browser would already be past a
    // short idle window and be reaped the moment the sweep ran.
    this.#touch();
    if (result.child) result.child.once('exit', (code, signal) => this.#onChromiumExit(code, signal));
    return result;
  }

  #onPipeClosed(error) {
    if (this.#stopping) return;
    // The transport is gone, so the process is on its way out. Reporting it here
    // as well keeps the failure honest even if the child's exit event is delayed.
    if (this.#chromium && !this.#lastError) {
      this.#lastError = `The browser connection closed unexpectedly (${error?.message || 'pipe closed'}).`;
      this.#emitState();
    }
  }

  async #listen() {
    const server = http.createServer((req, res) => {
      this.#handleRequest(req, res).catch(() => {
        try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Gateway failure.' })); }
        catch { /* the response is already gone */ }
      });
    });
    server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head));
    // The gateway must never outlive its usefulness: connections are bounded and
    // slow request bodies are not a thing here (there are no request bodies).
    server.headersTimeout = 20000;
    server.requestTimeout = 30000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 32;

    await new Promise((resolve, reject) => {
      const onError = error => reject(error.code === 'EADDRINUSE'
        ? new BrowserUnavailableError(`CDP gateway port ${this.#port} is already in use. Another process is bound to this bot's browser port.`)
        : error);
      server.once('error', onError);
      server.listen(this.#port, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
    });
    this.#server = server;
  }

  /**
   * Stop the browser, but keep the bot's CDP endpoint listening so the next agent
   * turn still finds it. `reason` becomes the viewer `bye` code, which is how the
   * UI tells an idle shutdown apart from a crash.
   */
  async stop({ reason = 'destroyed' } = {}) {
    // Marks an intentional shutdown so the Chromium `exit` handler does not
    // report a clean close as a crash.
    this.#stopping = true;
    try {
    // A launch may still be in flight (the first agent or viewer connection starts
    // the browser asynchronously). Invalidate it and let it finish — it closes the
    // browser it started — so a stop never returns with an orphan behind it.
    this.#launchEpoch += 1;
    if (this.#starting) await this.#starting.catch(() => undefined);
    this.#stopScreencast();
    for (const viewer of [...this.#viewers.values()]) {
      this.#sendTo(viewer, { t: 'bye', reason });
      try { viewer.socket.close(1000, reason); } catch { /* already closed */ }
    }
    this.#viewers.clear();
    for (const agent of [...this.#agents]) agent.close();
    this.#agents.clear();
    for (const client of this.#wss.clients) { try { client.terminate(); } catch { /* already gone */ } }

    const chromium = this.#chromium;
    const pipe = this.#pipe;
    this.#chromium = null;
    this.#chromiumPort = null;
    this.#pipe = null;
    if (chromium) {
      // Graceful first, and always: `Browser.close` is what flushes cookies and
      // storage to the profile. The kill below is only the fallback for a browser
      // that ignored the request.
      if (pipe) await closePipeGracefully(pipe, { child: chromium.child, timeoutMs: 5000 });
      else await closeBrowserGracefully(chromium.port).catch(() => undefined);
      if (chromium.child) {
        await stopChromium(chromium.child).catch(() => undefined);
      } else {
        // An adopted browser has no child to await; give it the same grace window
        // to finish flushing before we let go of it.
        await new Promise(resolve => { const timer = setTimeout(resolve, 1000); timer.unref?.(); });
      }
      // After the child is gone, drain whatever is left of the pipe so the
      // transport cannot keep the process alive (or hold a stale session).
      pipe?.close('The browser session is shutting down.');
    }
    this.#lastError = null;
    this.#emitState();
    } finally { this.#stopping = false; }
  }

  /**
   * Stop the browser *and* close the endpoint. Only for bot deletion and host
   * shutdown: while a bot exists, its endpoint must outlive its browser.
   */
  async destroy({ reason = 'destroyed' } = {}) {
    await this.stop({ reason });
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise(resolve => {
      server.close(() => resolve());
      try { server.closeAllConnections?.(); } catch { /* older node */ }
      const timer = setTimeout(resolve, 2000); timer.unref?.();
    });
  }

  #onChromiumExit(code, signal) {
    // An exit we asked for is not a crash, and must not be reported as one.
    if (this.#stopping) return;
    this.#chromium = null;
    this.#chromiumPort = null;
    this.#pipe?.close('The browser exited.');
    this.#pipe = null;
    this.#stopScreencast();
    this.#lastError = `The browser exited unexpectedly (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}).`;
    const watching = this.#viewers.size;
    for (const viewer of [...this.#viewers.values()]) {
      this.#sendTo(viewer, { t: 'error', code: 'browser_crashed', message: this.#lastError });
    }
    this.#emitActivity({ type: 'browser', state: 'crashed', message: this.#lastError });
    this.#emitState();
    // A watched browser that dies is restarted, because a human is looking at it
    // and a blank panel is not an answer. An unwatched one stays down until it
    // is next needed, which is what keeps idle cost at zero.
    if (watching > 0 && this.#restarts < CRASH_RESTART_ATTEMPTS && this.#server) this.#scheduleRestart();
  }

  #scheduleRestart() {
    this.#restarts += 1;
    const delay = CRASH_RESTART_DELAY_MS * this.#restarts;
    const timer = setTimeout(() => {
      if (!this.#server) return;
      this.start().then(() => {
        this.#ensureScreencast().catch(() => undefined);
        // The budget is for *consecutive* crashes: a browser that stays up for a
        // healthy window earns a fresh allowance instead of dying permanently
        // after three unrelated failures over a long session.
        const healthy = setTimeout(() => { this.#restarts = 0; }, CRASH_HEALTHY_MS);
        healthy.unref?.();
      }).catch(() => { if (this.#viewers.size > 0) this.#scheduleRestart(); });
    }, delay);
    timer.unref?.();
  }

  // ── HTTP surface (token-scoped, loopback only) ─────────────────────────────

  async #handleRequest(req, res) {
    const deny = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: message }));
    };
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return deny(400, 'Bad request.'); }
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== this.#token) return deny(404, 'Not found.');
    const rest = segments.slice(1);
    if (rest[0] !== 'json') return deny(404, 'Not found.');
    if (req.method !== 'GET' && req.method !== 'PUT') return deny(405, 'Method not allowed.');

    if (!this.#browserOnline()) {
      // Lazy startup lives here because this is where the browser is first
      // needed: an installed-but-unused browser must cost nothing, and the agent
      // must never have to wait for a separate "start the browser" step.
      try { await this.start(); }
      catch (error) { return deny(503, error.message); }
    }
    if (!this.#browserOnline()) return deny(503, 'The browser is not running.');

    if (rest[1] === 'version') return this.#sendVersion(res);
    if (rest[1] === 'list' || rest[1] === undefined) return void this.#sendList(res);
    if (rest[1] === 'protocol') {
      // `/json/protocol` is the DevTools frontend's schema dump. It is not part
      // of any agent path, and a pipe has no HTTP surface to proxy it from.
      if (this.#pipe) return deny(404, 'Not available over the debugging pipe.');
      return void this.#proxyJson(res, this.#chromiumPort, 'protocol');
    }
    if (rest[1] === 'new') return void this.#openTarget(res, url.search || '');
    return deny(404, 'Not found.');
  }

  #browserOnline() {
    if (!this.#chromium) return false;
    return this.#pipe ? !this.#pipe.closed : Boolean(this.#chromiumPort);
  }

  /** Does the browser answer on whichever transport it is using? */
  async #browserAnswers(timeoutMs) {
    if (!this.#chromium) return false;
    if (this.#pipe) return Boolean(await probePipe(this.#pipe, { timeoutMs }));
    if (!this.#chromiumPort) return false;
    return Boolean(await probeCdp(this.#chromiumPort, { timeoutMs }));
  }

  async #sendVersion(res) {
    let version = null;
    if (this.#pipe) version = await probePipe(this.#pipe, { timeoutMs: 2000 });
    else {
      try { version = await probeCdp(this.#chromiumPort, { timeoutMs: 2000 }); } catch { version = null; }
    }
    if (!version) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'The browser is not running.' })); }
    // `webSocketDebuggerUrl` is the single URL every Hermes browser path follows,
    // so it is rewritten to the gateway — and carries the gateway token, which
    // is what authenticates the WebSocket upgrade that follows.
    const payload = {
      ...version,
      Browser: `HOB-Gateway/${String(version.Browser || version.product || 'Chromium')}`,
      webSocketDebuggerUrl: `ws://127.0.0.1:${this.#port}/${this.#token}/devtools/browser/${this.#record.browserProfileId}`,
    };
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  async #sendList(res) {
    if (!this.#pipe) return void this.#proxyJson(res, this.#chromiumPort, 'list');
    const targets = await this.#listTargets();
    if (!targets) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'The browser did not answer.' }));
    }
    for (const target of targets) if ('devtoolsFrontendUrl' in target) target.devtoolsFrontendUrl = null;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(targets));
  }

  async #openTarget(res, search) {
    const requested = new URLSearchParams(search).get('url') || 'about:blank';
    // Opening a page is a mutation. It must not slip past a human takeover just
    // because it arrived over the HTTP convenience endpoint instead of the CDP
    // socket: same admission, same denial, same wait for control to come back.
    const admission = await this.admitAgentMutation();
    if (!admission.ok) {
      res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: denialMessage(admission.reason, 'Target.createTarget') }));
      return;
    }
    try {
      if (!this.#pipe) { await this.#proxyJson(res, this.#chromiumPort, `new${search}`, 'PUT'); return; }
      const { targetId } = await this.#pipe.request('Target.createTarget', { url: requested }, { timeoutMs: 5000 });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        id: targetId, type: 'page', url: requested,
        webSocketDebuggerUrl: `ws://127.0.0.1:${this.#port}/${this.#token}/devtools/page/${targetId}`,
      }));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    } finally {
      admission.release();
    }
  }

  async #proxyJson(res, chromiumPort, suffix, method = 'GET') {
    try {
      const response = await fetch(`http://127.0.0.1:${chromiumPort}/json/${suffix}`,
        { method, signal: AbortSignal.timeout(5000) });
      const body = await response.text();
      let payload;
      try { payload = JSON.parse(body); } catch { payload = null; }
      if (payload && suffix.split('?')[0] === 'list') {
        // Target list entries carry their own debugger URLs; rewriting them keeps
        // a page-level client inside the lease too.
        for (const target of Array.isArray(payload) ? payload : []) {
          if (typeof target?.webSocketDebuggerUrl === 'string') {
            target.webSocketDebuggerUrl = `ws://127.0.0.1:${this.#port}/${this.#token}/devtools/page/${target.id}`;
          }
          if ('devtoolsFrontendUrl' in target) target.devtoolsFrontendUrl = null;
        }
      }
      res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload ?? JSON.parse(body)));
    } catch {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'The browser did not answer.' }));
    }
  }

  #handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { socket.destroy(); return; }
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== this.#token || segments[1] !== 'devtools') { socket.destroy(); return; }
    const kind = segments[2];
    if (kind !== 'browser' && kind !== 'page') { socket.destroy(); return; }
    const targetId = kind === 'page' ? segments[3] : undefined;
    if (kind === 'page' && !targetId) { socket.destroy(); return; }
    this.#wss.handleUpgrade(req, socket, head, client => {
      const proxy = new AgentProxy(this, client, { kind, targetId, label: `${kind}:${targetId || 'browser'}` });
      this.#agents.add(proxy);
      this.#emitState();
      proxy.open().catch(() => proxy.close());
    });
  }

  // ── lease plumbing used by AgentProxy ─────────────────────────────────────

  admitAgentMutation(signal) { return this.#lease.enterAgentMutation({ waitMs: this.#agentWaitMs, signal }); }

  noteAgentConnected(proxy) { this.#agents.add(proxy); this.#touch(); this.#emitActivity({ type: 'agent', state: 'connected', label: proxy.label }); this.#emitState(); }

  noteAgentDisconnected(proxy) {
    if (!this.#agents.delete(proxy)) return;
    this.#emitActivity({ type: 'agent', state: 'disconnected', label: proxy.label });
    this.#emitState();
  }

  /**
   * The agent's own input commands are the only honest source of "where is the
   * agent pointing right now": they pass through this process on their way to
   * Chromium, in the same viewport coordinates the stream is drawn in.
   */
  noteAgentActivity(method, params) {
    this.#touch();
    if (method === 'Input.dispatchMouseEvent' && params && typeof params === 'object') {
      const x = Number(params.x) || 0; const y = Number(params.y) || 0;
      if (params.type === 'mouseMoved') this.#emitActivity({ type: 'cursor', x, y, source: 'agent' });
      else if (params.type === 'mousePressed' || params.type === 'mouseReleased') {
        this.#emitActivity({ type: 'click', x, y, button: params.button || 'left', phase: params.type === 'mousePressed' ? 'down' : 'up' });
      }
      return;
    }
    if (method === 'Input.dispatchKeyEvent') { this.#emitActivity({ type: 'action', kind: 'key', method }); return; }
    if (method === 'Input.insertText') { this.#emitActivity({ type: 'action', kind: 'type', method }); return; }
    this.#emitActivity({ type: 'action', kind: 'command', method });
  }

  /**
   * Open the upstream CDP endpoint a client asked for.
   *
   * Over a pipe this is a channel on the multiplexer: a browser-level channel for
   * `/devtools/browser/...`, or a page-bound channel that attaches the target and
   * hides the session id from the client, exactly like a page WebSocket does.
   */
  async openUpstream(kind, targetId, label) {
    await this.start();
    if (this.#pipe) {
      if (this.#pipe.closed) throw new BrowserUnavailableError('The browser connection closed.');
      return this.#pipe.createChannel({ kind, targetId, label });
    }
    const version = await probeCdp(this.#chromiumPort, { timeoutMs: 2000 });
    if (!version) throw new BrowserUnavailableError('The browser is not running.');
    const url = kind === 'page'
      ? `ws://127.0.0.1:${this.#chromiumPort}/devtools/page/${encodeURIComponent(targetId)}`
      : String(version.webSocketDebuggerUrl || '');
    if (!url) throw new BrowserUnavailableError('The browser did not report a WebSocket endpoint.');
    return new WebSocket(url, { maxPayload: MAX_CDP_FRAME, perMessageDeflate: false });
  }

  /** HOB's own long-lived CDP connection (tab discovery, screencast, viewer input). */
  async #openInternalConnection({ onEvent, onClose }) {
    await this.#ensureChromium();
    if (this.#pipe) {
      const channel = await this.#pipe.createChannel({ kind: 'browser', label: 'hob' });
      return new PipeCdpConnection(channel, { onEvent, onClose });
    }
    const version = await probeCdp(this.#chromiumPort, { timeoutMs: 2000 });
    if (!version?.webSocketDebuggerUrl) throw new BrowserUnavailableError('The browser did not report a WebSocket endpoint.');
    const cdp = new CdpConnection(version.webSocketDebuggerUrl, { onEvent, onClose });
    await cdp.connect();
    return cdp;
  }

  // ── viewers (Atrium protocol) ─────────────────────────────────────────────

  attachViewer(socket) {
    const viewer = {
      id: `v-${randomBytes(6).toString('hex')}`,
      socket,
      modifiers: new ModifierState(),
      pointer: { x: 0, y: 0 },
      interactive: true,
      ready: false,
    };
    this.#viewers.set(viewer.id, viewer);
    this.#touch();
    socket.on('message', (data, isBinary) => { if (!isBinary) this.#onViewerMessage(viewer, data.toString('utf8')); });
    const drop = () => this.#dropViewer(viewer);
    socket.on('close', drop);
    socket.on('error', drop);
    this.#emitState();

    this.#ensureViewerReady(viewer).catch(error => {
      this.#sendTo(viewer, { t: 'error', code: error instanceof BrowserUnavailableError ? 'browser_unavailable' : 'viewer_failed', message: error.message });
      this.#dropViewer(viewer);
    });
    return viewer;
  }

  async #ensureViewerReady(viewer) {
    await this.start();
    if (!this.#viewers.has(viewer.id)) return;
    this.#sendTo(viewer, {
      t: 'hello',
      sessionId: this.#botId,
      control: { holder: this.#lease.holder, since: this.#lease.since },
      viewport: { ...this.#viewport },
    });
    if (this.#page.title) this.#sendTo(viewer, { t: 'title', title: this.#page.title });
    if (this.#page.url) this.#sendTo(viewer, { t: 'navigate', url: this.#page.url });
    this.#sendTo(viewer, { t: 'loading', loading: this.#page.loading });
    this.#sendTo(viewer, { t: 'tabs', tabs: this.#tabs.map(tab => ({ ...tab })) });
    if (this.#lastFrame) this.#sendFrame(viewer, this.#lastFrame);
    viewer.ready = true;
    // Screencasting costs real CPU, so it exists only while somebody is watching.
    await this.#ensureScreencast();
  }

  #dropViewer(viewer) {
    if (!this.#viewers.delete(viewer.id)) return;
    this.#emitActivity({ type: 'viewer', state: 'left', viewers: this.#viewers.size });
    this.#emitState();
    if (this.#viewers.size === 0) {
      this.#stopScreencast();
      // Nobody is watching, so nobody can be holding control. Leaving the lease
      // with the human would strand every queued agent command.
      if (this.#lease.holder === HUMAN) void this.#lease.releaseControl({ timeoutMs: 2000 });
    }
  }

  #onViewerMessage(viewer, text) {
    let message;
    try { message = parseClientMessage(JSON.parse(text)); }
    catch { this.#sendTo(viewer, { t: 'error', code: 'bad_message', message: 'The gateway could not understand that viewer message.' }); return; }

    switch (message.t) {
      case 'ping': this.#sendTo(viewer, { t: 'pong' }); return;
      case 'request_control': void this.requestControl(viewer); return;
      case 'release_control': void this.releaseControl(viewer); return;
      case 'input': this.#viewerInput(viewer, message); return;
      case 'ime': return;
      case 'resize': void this.#viewerResize(viewer, message); return;
      case 'navigate': void this.#viewerCommand(viewer, 'Page.navigate', { url: message.url }); return;
      case 'back': void this.#viewerHistory(viewer, -1); return;
      case 'forward': void this.#viewerHistory(viewer, 1); return;
      case 'reload': void this.#viewerCommand(viewer, 'Page.reload', { ignoreCache: false }); return;
      case 'tab_activate': void this.#switchTarget(viewer, message.tabId); return;
      case 'tab_close': void this.#viewerCommand(viewer, 'Target.closeTarget', { targetId: message.tabId }); return;
      default: return;
    }
  }

  #viewerInput(viewer, message) {
    viewer.modifiers.update(message.payload?.type, message.payload?.code);
    for (const command of inputCommands(message, { modifiers: viewer.modifiers, viewport: this.#viewport, lastPointer: viewer.pointer })) {
      if (command.pointer) viewer.pointer = command.pointer;
      this.#viewerCommand(viewer, command.method, command.params, { quiet: true });
    }
  }

  async #viewerResize(viewer, message) {
    const w = Math.max(200, Math.min(4000, Math.round(Number(message.w) || 0)));
    const h = Math.max(200, Math.min(4000, Math.round(Number(message.h) || 0)));
    if (!w || !h) return;
    const admission = this.#lease.enterViewerMutation();
    if (!admission.ok) return; // A resize re-lays-out the page the agent is reading.
    try {
      await this.#ensureScreencast();
      if (!this.#castCdp?.open) return;
      await this.#castCdp.send('Emulation.setDeviceMetricsOverride',
        { width: w, height: h, deviceScaleFactor: 1, mobile: false }, { sessionId: this.#castSessionId });
      this.#viewport = { w, h };
      this.#broadcast({ t: 'viewport', w, h });
      await this.#restartScreencast();
    } catch { /* the next frame still streams at the previous size */ }
    finally { admission.release(); }
  }

  async #viewerHistory(viewer, offset) {
    const admission = this.#lease.enterViewerMutation();
    if (!admission.ok) return this.#viewerDenied(viewer);
    try {
      await this.#ensureScreencast();
      if (!this.#castCdp?.open) throw new BrowserUnavailableError('The browser is not streaming yet.');
      const history = await this.#castCdp.send('Page.getNavigationHistory', {}, { sessionId: this.#castSessionId });
      const entry = history?.entries?.[history.currentIndex + offset];
      if (!entry) return;
      await this.#castCdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, { sessionId: this.#castSessionId });
    } catch { /* nothing to hand back against */ }
    finally { admission.release(); }
  }

  async #viewerCommand(viewer, method, params, { quiet = false } = {}) {
    if (this.#lease.holder !== HUMAN) {
      if (!quiet) this.#viewerDenied(viewer);
      return;
    }
    const admission = this.#lease.enterViewerMutation();
    if (!admission.ok) { if (!quiet) this.#viewerDenied(viewer); return; }
    try {
      await this.#ensureScreencast();
      if (!this.#castCdp?.open) throw new BrowserUnavailableError('The browser is not streaming yet.');
      await this.#castCdp.send(method, params, { sessionId: this.#castSessionId });
    }
    catch (error) { if (!quiet) this.#sendTo(viewer, { t: 'error', code: 'command_failed', message: error.message }); }
    finally { admission.release(); }
  }

  #viewerDenied(viewer) {
    this.#sendTo(viewer, { t: 'error', code: 'agent_has_control', message: 'Take control before driving the browser.' });
  }

  async requestControl(viewer) {
    const result = await this.#lease.requestControl({ timeoutMs: 15000 });
    if (!result.ok) {
      this.#sendTo(viewer, { t: 'control', holder: this.#lease.holder, reason: 'busy' });
      return result;
    }
    this.#controlOwner = viewer?.id ?? null;
    // A handover closes the agent door, but state the agent installed earlier
    // lives *inside* Chromium, not in this process. Undo the one piece of it that
    // can silently hang a page the person is about to use.
    for (const agent of this.#agents) {
      try { agent.neutralizeAutoAttach(); } catch { /* one bad client must not block the handover */ }
    }
    return result;
  }

  /** Which principal currently holds control; observation only. */
  controlHolder() { return this.#lease.holder; }

  async releaseControl(viewer) {
    const result = await this.#lease.releaseControl({ timeoutMs: 5000 });
    if (this.#controlOwner && (!viewer || viewer.id === this.#controlOwner)) this.#controlOwner = null;
    return result;
  }

  #controlOwner = null;

  // ── screencast ────────────────────────────────────────────────────────────

  async #ensureScreencast() {
    if (this.#castCdp?.open) {
      if (!this.#castSessionId) await this.#attachActiveTarget();
      return;
    }
    const cdp = await this.#openInternalConnection({
      onEvent: message => this.#onCastEvent(message),
      onClose: () => { this.#castCdp = null; this.#castSessionId = null; },
    });
    this.#castCdp = cdp;
    await cdp.post('Target.setDiscoverTargets', { discover: true });
    await cdp.post('Page.enable');
    await this.#attachActiveTarget();
  }

  async #attachActiveTarget() {
    if (!this.#castCdp?.open) return;
    const { targetInfos = [] } = await this.#castCdp.send('Target.getTargets');
    const pages = targetInfos.filter(isPageTarget);
    if (pages.length === 0) {
      this.#tabs = [];
      this.#broadcast({ t: 'tabs', tabs: [] });
      this.#emitState();
      return;
    }
    const target = this.#selectTarget(pages);
    await this.#detachCastSession();
    this.#castTargetId = target.targetId;
    const { sessionId } = await this.#castCdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    this.#castSessionId = sessionId;
    await this.#castCdp.post('Page.enable', {}, { sessionId });
    const metrics = await this.#castCdp.send('Page.getLayoutMetrics', {}, { sessionId }).catch(() => null);
    const view = metrics?.cssLayoutViewport;
    if (view?.clientWidth && view?.clientHeight) this.#viewport = { w: Math.round(view.clientWidth), h: Math.round(view.clientHeight) };
    this.#updatePageFromTarget(target);
    await this.#startScreencast();
    this.#broadcast({ t: 'viewport', w: this.#viewport.w, h: this.#viewport.h });
    await this.#refreshTabs();
    // Attaching to a page that already navigated does not replay
    // `Page.frameNavigated`; tell the viewer where it now is. Announce even
    // when the URL was updated by an event during the attach, otherwise a
    // viewer moved after its tab was closed would show the right frames with a
    // stale location.
    if (this.#page.url) this.#broadcast({ t: 'navigate', url: this.#page.url });
  }

  /**
   * Which page the viewer should show.
   *
   * A viewer that attaches while the browser is still on its launch page pins the
   * screencast to `about:blank`. The agent's first navigation can then happen in
   * a *different* target (a new tab), and the person watches a white page while
   * the bot works elsewhere. Prefer a real page unless someone deliberately chose
   * a tab; otherwise keep the current one.
   */
  #selectTarget(pages) {
    const current = pages.find(page => page.targetId === this.#castTargetId);
    if (this.#castPinned && current) return current;
    if (current && !isBlankUrl(current.url)) return current;
    // Prefer the newest real page: when an agent opens a tab, that is the one it
    // is about to drive.
    const real = [...pages].reverse().find(page => !isBlankUrl(page.url));
    return real ?? current ?? pages[0];
  }

  async #detachCastSession() {
    const sessionId = this.#castSessionId;
    this.#castSessionId = null;
    if (!sessionId || !this.#castCdp?.open) return;
    await this.#castCdp.post('Page.stopScreencast', {}, { sessionId }).catch(() => undefined);
    await this.#castCdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }

  /**
   * Follow a page the agent opened while the viewer was still on a blank launch
   * page. This is observational (it never activates or navigates the target), so
   * it needs no lease admission. A page a person is already watching is left
   * alone: a background tab must not yank the view away.
   */
  async #adoptTarget(targetId) {
    if (!this.#castCdp?.open || this.#castPinned || targetId === this.#castTargetId) return;
    if (!isBlankUrl(this.#page.url)) return;
    this.#castTargetId = targetId;
    await this.#attachActiveTarget();
  }

  async #startScreencast() {
    if (!this.#castCdp?.open || !this.#castSessionId) return;
    await this.#castCdp.post('Page.startScreencast', {
      format: 'jpeg', quality: 62,
      maxWidth: this.#viewport.w, maxHeight: this.#viewport.h,
      everyNthFrame: 1,
    }, { sessionId: this.#castSessionId });
  }

  async #restartScreencast() {
    if (!this.#castCdp?.open || !this.#castSessionId) return;
    await this.#castCdp.post('Page.stopScreencast', {}, { sessionId: this.#castSessionId });
    await this.#startScreencast();
  }

  #stopScreencast() {
    this.#castCdp?.close();
    this.#castCdp = null;
    this.#castSessionId = null;
    this.#castPinned = false;
    this.#lastFrame = null;
  }

  #onCastEvent(message) {
    const { method, params, sessionId } = message;
    if (sessionId && sessionId !== this.#castSessionId) return;
    switch (method) {
      case 'Page.screencastFrame': {
        // Ack unconditionally: without it Chromium stops producing frames, and a
        // throttled or backed-up viewer must not blind the ones that are healthy.
        this.#castCdp?.post('Page.screencastFrameAck', { sessionId: params.sessionId }, { sessionId: this.#castSessionId });
        this.#publishFrame(Buffer.from(params.data, 'base64'));
        return;
      }
      case 'Page.frameNavigated': {
        const frame = params?.frame;
        if (frame && !frame.parentId) {
          this.#page.url = String(frame.url || '');
          this.#broadcast({ t: 'navigate', url: this.#page.url });
          this.#page.loading = true;
          this.#broadcast({ t: 'loading', loading: true });
        }
        return;
      }
      case 'Page.frameStartedLoading': this.#setLoading(true); return;
      case 'Page.frameStoppedLoading': this.#setLoading(false); return;
      case 'Page.loadEventFired': this.#setLoading(false); this.#refreshTabs(); return;
      case 'Page.javascriptDialogOpening':
        this.#emitActivity({ type: 'action', kind: 'dialog', method: 'Page.javascriptDialogOpening' });
        return;
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const info = params?.targetInfo;
        if (!isPageTarget(info)) return;
        if (info.targetId === this.#castTargetId) {
          this.#updatePageFromTarget(info);
          this.#refreshTabs();
          return;
        }
        this.#refreshTabs();
        // A viewer opened before the agent's first navigation is streaming the
        // launch page. Once the agent opens a real page, follow it.
        if (!this.#castPinned && isBlankUrl(this.#page.url)) {
          void this.#adoptTarget(info.targetId).catch(() => undefined);
        }
        return;
      }
      case 'Target.targetDestroyed': {
        // Unlike the other target events, this one carries a bare `targetId`,
        // not a `targetInfo` object.
        const targetId = params?.targetId;
        if (!targetId) return;
        if (targetId !== this.#castTargetId) {
          this.#refreshTabs();
          return;
        }
        // The screencast session died with its target. Choose another page now
        // instead of leaving every viewer on a frozen last frame.
        this.#castSessionId = null;
        this.#castTargetId = null;
        void this.#attachActiveTarget().catch(() => undefined);
        return;
      }
      case 'Target.attachedToTarget': {
        // Chromium can swap the attached session when a page is replaced during
        // navigation; keep streaming from whatever is actually attached.
        return;
      }
      default: return;
    }
  }

  #setLoading(loading) {
    if (this.#page.loading === loading) return;
    this.#page.loading = loading;
    this.#broadcast({ t: 'loading', loading });
    this.#emitState();
  }

  #updatePageFromTarget(target) {
    const url = String(target.url || '');
    if (url) this.#page.url = url;
    const title = String(target.title || '');
    // While a page is loading Chromium reports its URL as the title. Do not let
    // that replace a real title, and keep the old one until the new one arrives.
    if (title && title !== url && title !== this.#page.url && !isLocationTitle(title) && title !== this.#page.title) {
      this.#page.title = title;
      this.#broadcast({ t: 'title', title });
    }
  }

  #publishFrame(buffer) {
    const now = Date.now();
    if (this.#lastFrameAt && now - this.#lastFrameAt < this.#minFrameIntervalMs) return;
    this.#lastFrameAt = now;
    this.#frameSeq += 1;
    this.#lastFrame = buffer;
    for (const viewer of this.#viewers.values()) {
      if (viewer.socket.bufferedAmount > MAX_VIEWER_BUFFER) continue; // drop rather than queue
      this.#sendFrame(viewer, buffer);
    }
  }

  #sendFrame(viewer, buffer) {
    this.#sendTo(viewer, { t: 'frame', seq: this.#frameSeq, ts: Date.now(), mime: 'image/jpeg' });
    if (viewer.socket.readyState === WebSocket.OPEN) viewer.socket.send(buffer, { binary: true });
  }

  async #refreshTabs() {
    if (!this.#castCdp?.open) return;
    try {
      const { targetInfos = [] } = await this.#castCdp.send('Target.getTargets');
      const pages = targetInfos.filter(isPageTarget);
      this.#tabs = pages.map(target => ({
        id: target.targetId,
        url: String(target.url || ''),
        title: String(target.title || ''),
        active: target.targetId === this.#castTargetId,
      }));
      // The target list is the freshest snapshot of the page the viewer is
      // attached to; keep the status URL/title in sync with it even when the
      // loading target event did not carry a usable title.
      const active = this.#tabs.find(tab => tab.id === this.#castTargetId);
      if (active) this.#updatePageFromTarget(active);
      this.#broadcast({ t: 'tabs', tabs: this.#tabs.map(tab => ({ ...tab })) });
      this.#emitState();
    } catch { /* the next event refreshes it */ }
  }

  async #switchTarget(viewer, targetId) {
    if (this.#lease.holder !== HUMAN) return this.#viewerDenied(viewer);
    if (targetId === this.#castTargetId) return;
    const admission = this.#lease.enterViewerMutation();
    if (!admission.ok) return this.#viewerDenied(viewer);
    try {
      await this.#ensureScreencast();
      if (!this.#castCdp?.open) throw new BrowserUnavailableError('The browser is not streaming yet.');
      await this.#castCdp.send('Target.activateTarget', { targetId });
      // An explicit choice is sticky for this viewing session: automatic
      // following must not pull the person off the tab they picked.
      this.#castPinned = true;
      this.#castTargetId = targetId;
      await this.#attachActiveTarget();
    } catch (error) { this.#sendTo(viewer, { t: 'error', code: 'tab_failed', message: error.message }); }
    finally { admission.release(); }
  }

  // ── outbound plumbing ─────────────────────────────────────────────────────

  #sendTo(viewer, value) {
    // `viewer` is null when control was claimed from the dashboard rather than
    // from a viewer socket; there is no one to notify in that case.
    if (!viewer || viewer.socket.readyState !== WebSocket.OPEN) return;
    try { viewer.socket.send(JSON.stringify(value)); } catch { /* the socket is going away */ }
  }

  #broadcast(value) { for (const viewer of this.#viewers.values()) this.#sendTo(viewer, value); }

  #emitActivity(payload) {
    if (this.#activity.size === 0) return;
    const now = Date.now();
    if (payload.type === 'cursor' && this.#lastCursorAt && now - this.#lastCursorAt < 33) return;
    if (payload.type === 'cursor') this.#lastCursorAt = now;
    for (const listener of this.#activity) {
      try { listener(payload); } catch { /* a slow subscriber must not stall the stream */ }
    }
  }

  #lastCursorAt = 0;

  #emitState() {
    if (this.#stateListeners.size === 0) return;
    const status = this.status();
    for (const listener of this.#stateListeners) {
      try { listener(status); } catch { /* ignore */ }
    }
  }
}

function isPageTarget(target) { return target?.type === 'page' && !String(target.url || '').startsWith('devtools://'); }

/** The launch page, and any page that has not committed a real navigation yet. */
function isBlankUrl(value) {
  const url = String(value || '');
  return url === '' || url === 'about:blank' || url.startsWith('about:blank?');
}

/** Chromium briefly reports a loading page's location where a title belongs. */
function isLocationTitle(value) {
  return /^(?:https?|data|file|about|chrome|devtools):/i.test(String(value || ''));
}
