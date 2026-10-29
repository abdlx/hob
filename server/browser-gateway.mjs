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
import { PrecisionError, isPrecisionMethod, precisionHelp, runPrecisionMethod } from './browser-precision.mjs';
import { BROWSER_VIEWPORT, closeBrowserGracefully, closePipeGracefully, cdpTransportMode, launchChromium, probeCdp, probePipe, resolveChromiumExecutable, markProfileOwned, stopChromium } from './browser-launcher.mjs';
import { ChallengeTracker, captchaMode, DOM_PROBE_EXPRESSION, classifyBlockUrl } from './browser-challenge.mjs';
import { solveCheckboxChallenge, solveImageGridChallenge, visionSolverFromEnv, solverServiceFromEnv, solveWithService } from './browser-solvers.mjs';

// CDP error code for a command the gateway refused to forward. Hermes surfaces
// the message verbatim to the model, so it names the reason and the remedy.
const CDP_DENIED = -32001;
const CDP_FAILED = -32000;
const MAX_VIEWER_BUFFER = 8 * 1024 * 1024;
// The legacy, non-flattened `Target.sendMessageToTarget` tunnel gives no reply
// we can correlate, so it holds the drain barrier for a bounded window instead.
const TUNNEL_HOLD_MS = 1500;
// CAPTCHA gate: how long an agent mutation may be parked behind an active
// challenge before it is refused with `challenge_timeout`, and how often the
// session probes targets for challenge signals while a browser is running.
const CHALLENGE_PROBE_MS = 2000;
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
  if (reason === 'challenge_timeout') {
    return `A CAPTCHA challenge on this page did not resolve in time. "${method}" was not sent to the browser. A human can solve it from the browser viewer, or the page can be retried later.`;
  }
  if (reason === 'challenge_blocked') {
    return `This site is showing a bot-block page. "${method}" was not sent to the browser. The host is cooling down; retrying immediately will not help.`;
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
  #attachRequests = new Map();
  #attachedTargets = new Map();
  #focusAfterReply = new Set();
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
    if (classify(method) === OBSERVE) {
      if (method === 'Target.attachToTarget') this.#attachRequests.set(message.id, message.params?.targetId);
      return this.#forward(text);
    }

    if (method === 'Target.sendMessageToTarget') {
      this.#enqueueMutation(() => this.#forwardTunnel(message, text));
      return;
    }

    this.#enqueueMutation(() => this.#admitAndForward(message, text));
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

  async #admitAndForward(message, text) {
    const { id, method, params } = message;
    if (this.#closed) return;
    const admission = await this.#session.admitAgentMutation(this.#abort.signal);
    if (this.#closed) { if (admission.ok) admission.release(); return; }
    if (!admission.ok) {
      this.#sendClient({ id, error: { code: CDP_DENIED, message: denialMessage(admission.reason, method) } });
      return;
    }
    this.#track(id, admission.release, 0, message);
    if (this.#closed) return;
    if (isPrecisionMethod(method)) {
      await this.#runPrecision(message);
      return;
    }
    // The agent's CDP traffic is forwarded untouched and immediately: the live
    // viewer animates its own pointer towards the coordinates reported here, so
    // the page never waits on a visual effect.
    const sampleFocus = this.#session.noteAgentActivity(method, params, {
      targetId: this.#targetId || this.#attachedTargets.get(message.sessionId) || null,
    });
    if (sampleFocus) this.#focusAfterReply.add(id);
    this.#forward(text);
  }

  /**
   * Gateway-side precision input: the caller gets the element that was actually
   * under the point, and a verified click never presses unless that element is
   * the one it asked for. The action runs on a page-bound connection so it is
   * ordered independently of any other client's CDP session.
   */
  async #runPrecision(message) {
    const { id, method, params } = message;
    let outcome = 'unknown';
    try {
      if (method === 'Hob.input.help') {
        outcome = 'ok';
        this.#sendClient({ id, result: precisionHelp() });
        return;
      }
      const targetId = this.#targetId || this.#attachedTargets.get(message.sessionId) || null;
      const result = await this.#session.runPreciseInput(targetId, method, params, {
        signal: this.#abort.signal,
        onInput: (inputMethod, inputParams) => this.#session.noteAgentActivity(inputMethod, inputParams, { targetId }),
        onTyping: () => this.#session.sampleFocusPoint(),
      });
      this.#sendClient({ id, result });
      outcome = 'ok';
    } catch (error) {
      outcome = 'error';
      const denial = error instanceof PrecisionError ? error : null;
      this.#sendClient({
        id,
        error: {
          code: CDP_FAILED,
          message: denial?.message || error?.message || 'Precision input failed.',
          ...(denial?.hit ? { data: { hit: denial.hit } } : {}),
        },
      });
    } finally {
      this.#settle(id, outcome);
    }
  }

  #settle(id, outcome = 'unknown') {
    const entry = this.#inFlight.get(id);
    if (!entry) return;
    this.#inFlight.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.release(outcome);
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

  #track(id, release, holdMs = 0, command = null) {
    const existing = this.#inFlight.get(id);
    if (existing) existing.release();
    const finish = this.#session.measureCommand();
    const settle = (outcome = 'unknown') => { release(); finish?.(outcome); };
    const timer = holdMs > 0 ? setTimeout(() => { this.#inFlight.delete(id); settle(); }, holdMs) : null;
    timer?.unref?.();
    this.#inFlight.set(id, { release: settle, timer, command });
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
      // Detection tap: frame navigations on the agent's own pages are the
      // richest challenge signal (the anchor/bframe iframes live there), and
      // they are already flowing through this process on their way to the
      // client. A substring check keeps the parse cost off every other frame.
      const hasNav = Buffer.isBuffer(data) ? data.includes('Page.frameNavigated') : String(data).includes('"Page.frameNavigated"');
      if (hasNav) {
        try {
          const event = JSON.parse(data.toString('utf8'));
          const frame = event?.params?.frame;
          if (frame) {
            const targetId = this.#targetId || this.#attachedTargets.get(event.sessionId) || null;
            this.#session.noteChallengeUrl(targetId, String(frame.url || ''), { isMainFrame: !frame.parentId });
          }
        } catch { /* not JSON we understand; the relay below is unaffected */ }
      }
      // Release the drain barrier the moment the command's reply lands, so a
      // takeover waits exactly as long as the browser is actually busy.
      const id = peekId(data);
      if (id !== null) {
        // The reply to a neutralizing command belongs to nobody: it must not be
        // relayed to a client that never asked for it.
        if (this.#internal.delete(id)) return;
        if (this.#focusAfterReply.delete(id)) this.#session.sampleFocusPoint();
        if (this.#attachRequests.has(id)) {
          const targetId = this.#attachRequests.get(id);
          this.#attachRequests.delete(id);
          try {
            const reply = JSON.parse(data.toString('utf8'));
            if (!reply.error && reply.result?.sessionId) this.#attachedTargets.set(reply.result.sessionId, targetId);
          } catch {}
        }
        const entry = this.#inFlight.get(id);
        if (entry) {
          this.#inFlight.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          const command = entry.command;
          if (command?.method === 'Target.activateTarget' || command?.method === 'Page.bringToFront') {
            try {
              const reply = JSON.parse(data.toString('utf8'));
              const targetId = command.method === 'Target.activateTarget'
                ? command.params?.targetId
                : this.#targetId || this.#attachedTargets.get(command.sessionId);
              if (!reply.error && targetId) void this.#session.agentActivatedTarget(targetId).catch(() => undefined);
            } catch {}
          }
          let outcome = 'unknown';
          try { outcome = JSON.parse(data.toString('utf8')).error ? 'error' : 'ok'; } catch {}
          entry.release(outcome);
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
    this.#attachRequests.clear();
    this.#attachedTargets.clear();
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

// ── The solver ladder's CDP channel ─────────────────────────────────────────
//
// A minimal request/response client over one page-bound upstream connection,
// owned by the session for the duration of a single challenge. Solvers use it
// for evaluation, screenshots and frame attachment. It is deliberately not
// the agent's connection: solver traffic must never interleave with, or be
// credited to, the agent's CDP session.

class SolverChannel {
  #socket;
  #pending = new Map();
  #seq = 0;
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.on('message', data => this.#onMessage(data));
    socket.on('close', () => this.#failAll(new Error('The solver connection closed.')));
    socket.on('error', () => this.#failAll(new Error('The solver connection failed.')));
  }

  request(method, params = {}, { sessionId = null, timeoutMs = 15000 } = {}) {
    if (this.#closed) return Promise.reject(new Error('The solver channel is closed.'));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Solver command ${method} timed out.`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      try { this.#socket.send(JSON.stringify(message)); }
      catch (error) { this.#pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  /** Evaluate an expression and return its value (throws on a page error). */
  async evaluateValue(expression, { sessionId = null, timeoutMs = 10000 } = {}) {
    const reply = await this.request('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, { sessionId, timeoutMs });
    if (reply?.exceptionDetails) {
      throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text || 'Evaluation failed.');
    }
    return reply?.result?.value;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error('The solver channel is closed.'));
    try { this.#socket.close(); } catch { /* already closed */ }
  }

  #onMessage(data) {
    let message;
    try { message = JSON.parse(data.toString('utf8')); } catch { return; }
    if (message?.id === undefined) return;
    const entry = this.#pending.get(message.id);
    if (!entry) return;
    this.#pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message || 'Solver command failed.'));
    else entry.resolve(message.result);
  }

  #failAll(error) {
    for (const entry of this.#pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.#pending.clear();
  }
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
  #agentSelectedTargetId = null;
  #castAttach = Promise.resolve();
  #castAttachRevision = 0;
  #castAttachedRevision = 0;
  #castStarting = null;
  #castEpoch = 0;
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
  #destroyed = false;
  #minFrameIntervalMs;
  #pointer = { x: 0, y: 0 };
  #focusSampling = false;
  #focusSampleAt = 0;
  // CAPTCHA system (see browser-challenge.mjs and the plan in hob-docs):
  // the tracker classifies, the gate in `admitAgentMutation` parks, and the
  // stats are how an operator tells whether any of it is working.
  #challengeTracker;
  #captchaMode = 'detect';
  #challengeParkMs = 120000;
  #challengeActive = null;
  #activeChallenges = new Map();
  #challengeWaiters = [];
  #challengeStats = { seen: 0, agent: 0, human: 0, service: 0, passive: 0, failed: 0 };
  #challengeSolver = null;
  #probeTimer = null;
  #probeRunning = false;
  // Phase 7: hosts that served a hard block cool down here. The gate already
  // refuses fast while the block page is up; the cooldown is the record that
  // outlives it, so status (and the operator) can see which hosts are burnt
  // instead of an agent quietly retrying into a wall.
  #hostCooldowns = new Map();
  #challengeCooldownMs = 600000;
  #onChallengeEscalated = null;
  // Phase 6 service guardrails: a per-day attempt cap (spend control) and a
  // circuit breaker (three consecutive failures disable the service for the
  // session — a broken integration must not tax every challenge).
  #serviceState = { day: '', attempts: 0, consecutiveFailures: 0, disabled: false };
  #serviceDailyCap = 50;

  constructor({ botId, record, options = {} }) {
    this.#botId = botId;
    this.#telemetry = options.telemetry;
    this.#spawnChild = options.spawnBrowser ? (exe, args, settings) => options.spawnBrowser(botId, exe, args, settings) : undefined;
    this.#record = record;
    this.#token = record.gatewayToken;
    this.#port = record.gatewayPort;
    this.#profileDir = options.profileDir;
    this.#agentWaitMs = options.agentWaitMs ?? 20000;
    this.#minFrameIntervalMs = Math.max(0, Math.floor(1000 / (options.maxFps ?? 24)));
    this.#lease = new ControlLease({ agentWaitMs: this.#agentWaitMs });
    this.#captchaMode = options.captchaMode ?? captchaMode();
    this.#challengeParkMs = options.challengeParkMs ?? 120000;
    this.#challengeCooldownMs = options.challengeCooldownMs ?? 600000;
    this.#serviceDailyCap = options.challengeServiceDailyCap
      ?? (Number(process.env.HOB_CAPTCHA_SERVICE_DAILY_CAP) || 50);
    this.#onChallengeEscalated = typeof options.onChallengeEscalated === 'function' ? options.onChallengeEscalated : null;
    this.#challengeTracker = new ChallengeTracker({ onTransition: t => this.#onChallengeTransition(t) });
    this.#lease.on(snapshot => {
      this.#touch();
      this.#broadcast({ t: 'control', holder: snapshot.holder });
      this.#emitActivity({ type: 'control', holder: snapshot.holder, since: snapshot.since, pending: snapshot.pending });
      this.#emitState();
    });
  }

  #agentWaitMs;
  #spawnChild;
  #telemetry;

  get bot() { return this.#botId; }
  get cdpUrl() { return `http://127.0.0.1:${this.#port}/${this.#token}`; }
  get lease() { return this.#lease; }
  get running() { return this.#server !== null && this.#chromium !== null; }
  get viewerCount() { return this.#viewers.size; }
  get lastActiveAt() { return this.#lastActiveAt; }
  get viewport() { return { ...this.#viewport }; }
  get pointer() { return { ...this.#pointer }; }

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
      challenge: this.#challengeActive ? { ...this.#challengeActive } : null,
      challengeStats: { ...this.#challengeStats },
      captchaMode: this.#captchaMode,
      challengeCooldowns: [...this.#hostCooldowns.entries()]
        .filter(([, until]) => until > Date.now())
        .map(([host, until]) => ({ host, until })),
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
      || this.#lease.inFlight > 0 || this.#lease.pending > 0 || this.#lease.draining
      || this.#challengeActive !== null || this.#challengeWaiters.length > 0;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the browser, or attach to one that is already running on this profile.
   * The loopback CDP endpoint is part of the gateway, not of the browser, so it is
   * brought up first and stays up across browser restarts.
   */
  start() {
    if (this.#destroyed) return Promise.reject(new Error('The browser session has been removed.'));
    if (!this.#starting) {
      const epoch = this.#launchEpoch;
      const finish = this.#telemetry?.start(this.#botId, 'browser.start', { operation: this.running ? 'warm' : 'cold' });
      this.#starting = this.#start(epoch).then(value => { finish?.('ok'); return value; }, error => { finish?.('error'); throw error; }).finally(() => { this.#starting = null; });
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
    if (this.#destroyed) throw new Error('The browser session has been removed.');
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
    const result = await launchChromium({ profileDir: this.#profileDir, executablePath, transport: this.#transportMode, spawnChild: this.#spawnChild });
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
    this.#startChallengeProbes();
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
    this.#stopChallengeProbes();
    this.#wakeChallengeWaiters({ ok: false, reason: 'cancelled' });
    this.#challengeActive = null;
    this.#activeChallenges.clear();
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
    this.#agentSelectedTargetId = null;
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
    this.#destroyed = true;
    if (this.#listening) await this.#listening.catch(() => undefined);
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
    this.#agentSelectedTargetId = null;
    this.#pipe?.close('The browser exited.');
    this.#pipe = null;
    this.#stopChallengeProbes();
    this.#wakeChallengeWaiters({ ok: false, reason: 'cancelled' });
    this.#challengeActive = null;
    this.#activeChallenges.clear();
    this.#challengeSolver = null;
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

  /**
   * The single admission point for every agent mutation — CDP commands, the
   * tunnel, and the HTTP `/json/new` convenience endpoint all come through
   * here, which is why the CAPTCHA gate lives here too: while a confirmed
   * challenge is active (in human or legacy solve mode), mutations park behind it
   * instead of failing into the challenge or, worse, clicking at it blindly.
   * A hard block page never parks — there is nothing to wait for — so it is
   * refused immediately and the caller learns the host is the problem.
   */
  async admitAgentMutation(signal) {
    const finish = this.#telemetry?.start(this.#botId, 'browser.wait', { operation: 'agent' });
    try {
      if (['human', 'solve'].includes(this.#captchaMode) && this.#challengeActive) {
        if (this.#challengeActive.kind === 'block-page') { finish?.('refused'); return { ok: false, reason: 'challenge_blocked' }; }
        const gate = await this.#waitForChallenge(signal);
        if (!gate.ok) { finish?.(signal?.aborted ? 'cancelled' : 'refused'); return gate; }
      }
      const admission = await this.#lease.enterAgentMutation({ waitMs: this.#agentWaitMs, signal });
      finish?.(admission.ok ? 'ok' : signal?.aborted ? 'cancelled' : 'refused');
      return admission;
    } catch (error) { finish?.('error'); throw error; }
  }

  measureCommand() { return this.#telemetry?.start(this.#botId, 'browser.command', { operation: 'agent' }); }

  /** Feed a URL observation into challenge detection (frames, navigations). */
  noteChallengeUrl(targetId, url, { isMainFrame = false } = {}) {
    if (this.#captchaMode === 'off' || !targetId) return;
    this.#challengeTracker.observeUrl(targetId, url, { isMainFrame });
    // A main-frame block URL burns its host on sight (Phase 7): the cooldown
    // is recorded here, from the URL that proved it, not inferred later from
    // whichever page happens to be in front of the viewer.
    if (isMainFrame && classifyBlockUrl(url)) {
      try {
        const host = new URL(url).host;
        if (host) this.#hostCooldowns.set(host, Date.now() + this.#challengeCooldownMs);
      } catch { /* an unparseable URL burns nothing */ }
    }
  }

  /** Feed DOM probe facts into challenge detection (widgets, tokens). */
  noteChallengeDom(targetId, facts) {
    if (this.#captchaMode === 'off' || !targetId) return;
    this.#challengeTracker.observeDom(targetId, facts);
  }

  #onChallengeTransition({ targetId, to }) {
    if (to?.status === 'active') {
      this.#challengeActive = { ...to, targetId };
      this.#activeChallenges.set(targetId, this.#challengeActive);
      this.#challengeStats.seen += 1;
      trace(`challenge active bot=${this.#botId} provider=${to.provider} kind=${to.kind}`);
      this.#emitActivity({ type: 'challenge', state: 'active', provider: to.provider, kind: to.kind });
      // Viewers get the same signal the dashboard polls for, live: this is
      // what a UI renders as "CAPTCHA on this page — take control to solve".
      this.#broadcast({ t: 'challenge', state: 'active', provider: to.provider, kind: to.kind });
      this.#emitState();
      if (this.#captchaMode === 'solve') {
        void this.#runChallengeSolvers(targetId, { ...to }).catch(() => undefined);
      }
      if (this.#captchaMode === 'human') this.#escalate({ reason: 'human_required' });
      return;
    }
    if (to?.status === 'resolved') {
      const wasCurrent = this.#challengeActive?.targetId === targetId;
      this.#activeChallenges.delete(targetId);
      const solver = this.#challengeSolver
        ?? (this.#lease.holder === HUMAN ? 'human' : 'passive');
      if (solver === 'agent') this.#challengeStats.agent += 1;
      else if (solver === 'human') this.#challengeStats.human += 1;
      else if (solver === 'service') this.#challengeStats.service += 1;
      else this.#challengeStats.passive += 1;
      trace(`challenge resolved bot=${this.#botId} provider=${to.provider} via=${to.resolvedVia} solver=${solver}`);
      if (wasCurrent) this.#challengeActive = [...this.#activeChallenges.values()].at(-1) ?? null;
      this.#challengeSolver = null;
      this.#emitActivity({ type: 'challenge', state: 'resolved', provider: to.provider, via: to.resolvedVia, solver });
      this.#broadcast({ t: 'challenge', state: 'resolved', provider: to.provider, via: to.resolvedVia, solver });
      this.#emitState();
      if (!this.#challengeActive) this.#wakeChallengeWaiters({ ok: true });
    }
  }

  /**
   * Park one admission behind the active challenge. Mirrors the lease's
   * waiter semantics: settle exactly once, on resolution, on the bounded
   * timeout, on the caller's connection going away, or on session stop.
   */
  #waitForChallenge(signal) {
    if (!this.#challengeActive) return Promise.resolve({ ok: true });
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'cancelled' });
    return new Promise(resolve => {
      const waiter = { settle: null, timer: null, onAbort: null };
      const settle = value => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', waiter.onAbort);
        const index = this.#challengeWaiters.indexOf(waiter);
        if (index !== -1) this.#challengeWaiters.splice(index, 1);
        resolve(value);
      };
      waiter.settle = settle;
      waiter.onAbort = () => settle({ ok: false, reason: 'cancelled' });
      waiter.timer = setTimeout(() => {
        this.#challengeStats.failed += 1;
        this.#escalate({ reason: 'park_timeout' });
        settle({ ok: false, reason: 'challenge_timeout' });
      }, this.#challengeParkMs);
      waiter.timer.unref?.();
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.#challengeWaiters.push(waiter);
    });
  }

  #wakeChallengeWaiters(value) {
    for (const waiter of this.#challengeWaiters.splice(0)) waiter.settle(value);
  }

  /**
   * Tell whoever operates this bot that a challenge needs a human (Phase 5's
   * escalation hook). Interface only — the session has no notification
   * channel of its own; the host wires `options.onChallengeEscalated` to
   * whatever reaches the owner. Fires once per ladder exhaustion and once
   * per parked command that times out.
   */
  #escalate(detail) {
    if (!this.#onChallengeEscalated || !this.#challengeActive) return;
    try {
      this.#onChallengeEscalated({
        botId: this.#botId,
        provider: this.#challengeActive.provider,
        kind: this.#challengeActive.kind,
        url: this.#page.url,
        ...detail,
      });
    } catch { /* an operator callback must not break the gateway */ }
  }

  #serviceAllowed() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.#serviceState.day !== today) {
      this.#serviceState = { day: today, attempts: 0, consecutiveFailures: this.#serviceState.consecutiveFailures, disabled: this.#serviceState.disabled };
    }
    return !this.#serviceState.disabled && this.#serviceState.attempts < this.#serviceDailyCap;
  }

  #recordServiceAttempt() { this.#serviceState.attempts += 1; }

  #recordServiceOutcome(outcome) {
    if (outcome.outcome === 'solved') { this.#serviceState.consecutiveFailures = 0; return; }
    if (outcome.outcome === 'failed') {
      this.#serviceState.consecutiveFailures += 1;
      if (this.#serviceState.consecutiveFailures >= 3) {
        this.#serviceState.disabled = true;
        trace(`challenge solver bot=${this.#botId} method=service circuit-breaker=open`);
      }
    }
  }

  /**
   * The solver ladder's entry point (Phase 4 of the CAPTCHA plan): build a
 * context over a page-bound connection of the gateway's own — never the
 * agent's session, never through the lease — and climb: checkbox first,
 * image grid when a vision solver is configured, external services next
 * (Phase 6), and whatever remains belongs to the human at the viewer.
 * Resolution is credited by the transition handler from `#challengeSolver`,
 * which is why it is reset here only when the challenge outlived the ladder.
 */
  async #runChallengeSolvers(targetId, challenge) {
    if (this.#challengeSolver) return; // one ladder at a time
    if (!this.#chromium) return; // solvers need a live browser; the gate alone does not
    let channel = null;
    try {
      const upstream = await this.openUpstream('page', targetId, 'captcha solver').catch(() => null);
      if (!upstream) return;
      this.#challengeSolver = 'agent';
      channel = new SolverChannel(upstream);
      const ctx = {
        targetId,
        challenge,
        channel,
        clickPoint: (x, y, opts = {}) => this.runPreciseInput(targetId, 'Hob.input.click',
          { x, y, motion: 'human', ...(opts.expected ? { expected: opts.expected } : {}) }, {}),
        probeDom: async () => {
          const facts = await channel.evaluateValue(DOM_PROBE_EXPRESSION).catch(() => null);
          if (facts) this.noteChallengeDom(targetId, facts);
          return facts;
        },
        isResolved: () => !this.#challengeTracker.activeChallenge(targetId),
        currentChallenge: () => this.#challengeTracker.activeChallenge(targetId),
        waitForResolution: async (ms, onTick) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            if (ctx.isResolved()) return true;
            if (onTick) await onTick();
            await new Promise(resolve => setTimeout(resolve, 400));
          }
          return ctx.isResolved();
        },
        listTargets: () => this.#listTargets(),
      };
      if (['checkbox', 'interactive', 'image-grid'].includes(challenge.kind)) {
        const outcome = await solveCheckboxChallenge(ctx)
          .catch(error => ({ outcome: 'failed', method: 'checkbox', detail: error.message }));
        trace(`challenge solver bot=${this.#botId} method=checkbox outcome=${outcome.outcome} ${outcome.detail ?? ''}`);
      }
      if (this.#challengeActive?.kind === 'image-grid') {
        const vision = visionSolverFromEnv();
        if (vision) {
          const outcome = await solveImageGridChallenge(ctx, { vision })
            .catch(error => ({ outcome: 'failed', method: 'image-grid', detail: error.message }));
          trace(`challenge solver bot=${this.#botId} method=image-grid outcome=${outcome.outcome} ${outcome.detail ?? ''}`);
        }
      }
      // Phase 6: a paid solver service is the last automated rung, and only
      // when a key is configured, the challenge carries a sitekey, and the
      // spend guards allow it. The tracker still delivers the verdict.
      if (this.#challengeActive?.sitekey && this.#serviceAllowed()) {
        const service = solverServiceFromEnv();
        if (service?.supports(this.#challengeActive.provider)) {
          this.#challengeSolver = 'service';
          this.#recordServiceAttempt();
          const outcome = await solveWithService(ctx, { service })
            .catch(error => ({ outcome: 'failed', method: 'service', detail: error.message }));
          this.#recordServiceOutcome(outcome);
          trace(`challenge solver bot=${this.#botId} method=service outcome=${outcome.outcome} ${outcome.detail ?? ''}`);
        }
      }
      if (this.#challengeActive) this.#escalate({ reason: 'ladder_exhausted' });
    } finally {
      channel?.close();
      if (this.#challengeActive) this.#challengeSolver = null;
    }
  }

  /**
   * Periodic detection probes while a browser runs: target URLs and titles
   * from the target list (cheap, no sessions), plus a DOM probe on the
   * screencast session when one is attached. Agent-driven pages are also fed
   * by their own frame events; this loop is what catches everything else.
   */
  #startChallengeProbes() {
    if (this.#captchaMode === 'off' || this.#probeTimer) return;
    this.#probeTimer = setInterval(() => { void this.#probeChallenges(); }, CHALLENGE_PROBE_MS);
    this.#probeTimer.unref?.();
  }

  #stopChallengeProbes() {
    if (this.#probeTimer) clearInterval(this.#probeTimer);
    this.#probeTimer = null;
  }

  async #probeChallenges() {
    if (this.#probeRunning || !this.#chromium) return;
    this.#probeRunning = true;
    try {
      const targets = await this.#listTargets();
      if (Array.isArray(targets)) {
        for (const target of targets) {
          if (target?.type !== 'page' || !target.id) continue;
          this.#challengeTracker.observeUrl(target.id, String(target.url || ''), { isMainFrame: true });
          if (target.title) this.#challengeTracker.observeTitle(target.id, String(target.title));
        }
      }
      if (this.#castCdp?.open && this.#castSessionId && this.#castTargetId) {
        const result = await this.#castCdp.send('Runtime.evaluate',
          { expression: DOM_PROBE_EXPRESSION, returnByValue: true },
          { sessionId: this.#castSessionId, timeoutMs: 3000 }).catch(() => null);
        const facts = result?.result?.value;
        if (facts) this.#challengeTracker.observeDom(this.#castTargetId, facts);
      }
    } catch { /* the next tick probes again */ }
    finally { this.#probeRunning = false; }
  }

  noteAgentConnected(proxy) { this.#agents.add(proxy); this.#touch(); this.#emitActivity({ type: 'agent', state: 'connected', label: proxy.label }); this.#emitState(); }

  noteAgentDisconnected(proxy) {
    if (!this.#agents.delete(proxy)) return;
    this.#emitActivity({ type: 'agent', state: 'disconnected', label: proxy.label });
    this.#emitState();
  }

  /**
   * The agent's own input commands are the only honest source of "where is the
   * agent pointing right now": they pass through this process on their way to
   * Chromium, in the same viewport coordinates the stream is drawn in. Scripted
   * actions return `true` so the caller can sample the page's focus once the
   * command has actually landed.
   */
  noteAgentActivity(method, params, { force = false, targetId = null } = {}) {
    this.#touch();
    if (method === 'Input.dispatchMouseEvent' && params && typeof params === 'object') {
      const x = Number(params.x) || 0; const y = Number(params.y) || 0;
      this.#pointer = { x, y };
      if (params.type === 'mouseMoved' || params.type === 'mouseWheel') {
        this.#emitActivity({ type: 'cursor', x, y, source: 'agent' }, { force });
      } else if (params.type === 'mousePressed' || params.type === 'mouseReleased') {
        this.#emitActivity({ type: 'click', x, y, button: params.button || 'left', phase: params.type === 'mousePressed' ? 'down' : 'up' });
      }
      return;
    }

    // A DOM-level action (typing into a field, a scripted click or a focus call)
    // carries no coordinates of its own. The dashboard still needs a pointer, so
    // ask the page where the agent's focus landed. This is best-effort and never
    // blocks the command on its way to Chromium.
    const onWatchedTab = !targetId || targetId === this.#castTargetId;
    const interactive = /\.(?:click|focus|select)\s*\(|dispatchEvent\s*\(|\.value\s*=/;
    const scripted = method === 'Runtime.evaluate'
      ? interactive.test(String(params?.expression || ''))
      : method === 'Runtime.callFunctionOn'
        ? interactive.test(String(params?.functionDeclaration || ''))
        : false;
    const focusAction = method === 'Input.dispatchKeyEvent' || method === 'Input.insertText'
      || method === 'DOM.focus' || scripted;
    if (method === 'Input.dispatchKeyEvent') this.#emitActivity({ type: 'action', kind: 'key', method });
    else if (method === 'Input.insertText') this.#emitActivity({ type: 'action', kind: 'type', method });
    else this.#emitActivity({ type: 'action', kind: 'command', method });
    return focusAction && onWatchedTab && this.#activity.size > 0;
  }

  /**
   * Report the centre of the focused element as the agent's pointer. Scripted
   * actions have no mouse position, and a viewer that only ever sees cursor
   * events would look like the bot is working invisibly.
   */
  sampleFocusPoint(attempt = 0) {
    const cdp = this.#castCdp;
    const sessionId = this.#castSessionId;
    // The viewer may be between attach cycles (a navigation briefly detaches the
    // cast session), so wait for one rather than dropping the pointer.
    if (!cdp?.open || !sessionId) {
      if (attempt < 40) {
        const retry = setTimeout(() => this.sampleFocusPoint(attempt + 1), 150);
        retry.unref?.();
      }
      return;
    }
    if (this.#focusSampling) return;
    if (this.#focusSampleAt && Date.now() - this.#focusSampleAt < 100) return;
    this.#focusSampling = true;
    this.#focusSampleAt = Date.now();
    const expression = `(() => {
      const element = document.activeElement;
      if (!element || element === document.body || element === document.documentElement) return null;
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width < 2 || rect.height < 2) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`;
    cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false },
      { sessionId, timeoutMs: 500 })
      .then(result => {
        if (this.#castCdp !== cdp || this.#castSessionId !== sessionId) return;
        const point = result?.result?.value;
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        const x = Math.max(0, Math.min(this.#viewport.w - 1, point.x));
        const y = Math.max(0, Math.min(this.#viewport.h - 1, point.y));
        this.#pointer = { x, y };
        this.#emitActivity({ type: 'cursor', x, y, source: 'focus' }, { force: true });
      })
      .catch(() => undefined)
      .finally(() => { this.#focusSampling = false; });
  }

  async agentActivatedTarget(targetId) {
    if (this.#castPinned || this.#lease.holder !== AGENT) return;
    this.#agentSelectedTargetId = targetId;
    this.#castTargetId = targetId;
    if (this.#castCdp?.open) await this.#attachActiveTarget();
    else await this.refresh();
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

  /**
   * Run one exact-coordinate action against a page. This opens a page-bound CDP
   * connection (or a page channel over a pipe) so the action cannot interleave
   * with the caller's own session, and closes it when the action is done.
   */
  async runPreciseInput(targetId, method, params, hooks = {}) {
    if (!targetId) throw new BrowserUnavailableError('Attach to a page before using Hob.input.*.');
    const cdp = await this.#openPageConnection(targetId);
    try {
      return await runPrecisionMethod(cdp, method, params, hooks);
    } finally {
      cdp.close();
    }
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

  /** A short-lived page-level connection for a single verified input action. */
  async #openPageConnection(targetId) {
    await this.#ensureChromium();
    if (this.#pipe) {
      if (this.#pipe.closed) throw new BrowserUnavailableError('The browser connection closed.');
      const channel = await this.#pipe.createChannel({ kind: 'page', targetId, label: 'precision' });
      return new PipeCdpConnection(channel, { onEvent: () => undefined, onClose: () => undefined });
    }
    const version = await probeCdp(this.#chromiumPort, { timeoutMs: 2000 });
    if (!version?.webSocketDebuggerUrl) throw new BrowserUnavailableError('The browser did not report a WebSocket endpoint.');
    const cdp = new CdpConnection(
      `ws://127.0.0.1:${this.#chromiumPort}/devtools/page/${encodeURIComponent(targetId)}`,
      { onEvent: () => undefined, onClose: () => undefined },
    );
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
      if (command.pointer) {
        viewer.pointer = command.pointer;
        if (this.#lease.holder === HUMAN) this.#pointer = { ...command.pointer };
      }
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
    if (!this.#castStarting) {
      const pending = this.#openScreencast(this.#castEpoch);
      this.#castStarting = pending;
      void pending.finally(() => {
        if (this.#castStarting === pending) this.#castStarting = null;
      }).catch(() => undefined);
    }
    return this.#castStarting;
  }

  async #openScreencast(epoch) {
    let cdp;
    cdp = await this.#openInternalConnection({
      onEvent: message => { if (this.#castCdp === cdp) this.#onCastEvent(message); },
      onClose: () => {
        if (this.#castCdp !== cdp) return;
        this.#castCdp = null;
        this.#castSessionId = null;
      },
    });
    if (epoch !== this.#castEpoch || this.#viewers.size === 0) {
      cdp.close();
      return;
    }
    this.#castCdp = cdp;
    await cdp.post('Target.setDiscoverTargets', { discover: true });
    await cdp.post('Page.enable');
    await this.#attachActiveTarget();
  }

  #attachActiveTarget() {
    const revision = ++this.#castAttachRevision;
    const preferredTargetId = this.#castTargetId;
    const cdp = this.#castCdp;
    const pending = this.#castAttach.then(() => revision === this.#castAttachRevision ? this.#attachSelectedTarget(preferredTargetId, cdp, revision) : undefined);
    this.#castAttach = pending.catch(() => undefined);
    return pending;
  }

  async #attachSelectedTarget(preferredTargetId, cdp, revision) {
    // A target can close between `Target.getTargets` and `Target.attachToTarget`
    // — especially when a tab switch races a close. Re-list and choose again
    // rather than leaving the screencast pinned to a page that just vanished.
    for (let attempt = 0; ; attempt += 1) {
      if (!cdp?.open || this.#castCdp !== cdp) return;
      // These calls drive the viewer, not a command from the agent. Bound them
      // so one wedged session cannot block the whole attach queue indefinitely.
      const { targetInfos = [] } = await cdp.send('Target.getTargets', {}, { timeoutMs: 5000 });
      if (this.#castCdp !== cdp || revision !== this.#castAttachRevision) return;
      const pages = targetInfos.filter(isPageTarget);
      if (pages.length === 0) {
        this.#tabs = [];
        this.#broadcast({ t: 'tabs', tabs: [] });
        this.#emitState();
        return;
      }
      const target = this.#selectTarget(pages, attempt === 0 ? preferredTargetId : null);
      await this.#detachCastSession();
      if (this.#castCdp !== cdp || revision !== this.#castAttachRevision) return;
      this.#castTargetId = target.targetId;
      let sessionId;
      try {
        ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, { timeoutMs: 5000 }));
      } catch (error) {
        if (revision !== this.#castAttachRevision) return;
        this.#castTargetId = null;
        this.#castSessionId = null;
        if (attempt >= 2 || !cdp.open || this.#castCdp !== cdp) throw error;
        continue;
      }
      if (this.#castCdp !== cdp || revision !== this.#castAttachRevision) {
        await cdp.send('Target.detachFromTarget', { sessionId }, { timeoutMs: 3000 }).catch(() => undefined);
        return;
      }
      this.#castSessionId = sessionId;
      this.#castAttachedRevision = revision;
      await cdp.post('Page.enable', {}, { sessionId, timeoutMs: 5000 });
      const metrics = await cdp.send('Page.getLayoutMetrics', {}, { sessionId, timeoutMs: 5000 }).catch(() => null);
      if (this.#castCdp !== cdp || revision !== this.#castAttachRevision) return;
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
      return;
    }
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
  #selectTarget(pages, targetId = this.#castTargetId) {
    const current = pages.find(page => page.targetId === targetId);
    // An explicit activation is authoritative even before its navigation has
    // populated the URL/title. Falling back to a different real page here loses
    // the selection permanently when the chosen tab finishes loading later.
    if ((this.#castPinned || targetId === this.#agentSelectedTargetId) && current) return current;
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
    await this.#castCdp.post('Page.stopScreencast', {}, { sessionId, timeoutMs: 3000 }).catch(() => undefined);
    await this.#castCdp.send('Target.detachFromTarget', { sessionId }, { timeoutMs: 3000 }).catch(() => undefined);
  }

  /**
   * Follow a page the agent opened while the viewer was still on a blank launch
   * page. This is observational (it never activates or navigates the target), so
   * it needs no lease admission. A page a person is already watching is left
   * alone: a background tab must not yank the view away.
   */
  async #adoptTarget(targetId) {
    if (!this.#castCdp?.open || this.#castPinned || (this.#agentSelectedTargetId && this.#agentSelectedTargetId === this.#castTargetId) || targetId === this.#castTargetId) return;
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
    }, { sessionId: this.#castSessionId, timeoutMs: 5000 });
  }

  async #restartScreencast() {
    if (!this.#castCdp?.open || !this.#castSessionId) return;
    await this.#castCdp.post('Page.stopScreencast', {}, { sessionId: this.#castSessionId });
    await this.#startScreencast();
  }

  #stopScreencast() {
    this.#castEpoch += 1;
    this.#castAttachRevision += 1;
    this.#castStarting = null;
    this.#castCdp?.close();
    this.#castCdp = null;
    this.#castSessionId = null;
    this.#castPinned = false;
    this.#lastFrame = null;
  }

  #onCastEvent(message) {
    const { method, params, sessionId } = message;
    if (sessionId && (sessionId !== this.#castSessionId || this.#castAttachedRevision !== this.#castAttachRevision)) return;
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
        if (frame) {
          // Every frame navigation is detection evidence: challenge widgets
          // live in subframes, and the main frame's own URL is what resolves
          // an interstitial. Feeding it costs one map lookup.
          this.#challengeTracker.observeUrl(this.#castTargetId, String(frame.url || ''), { isMainFrame: !frame.parentId });
        }
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
        if (this.#agentSelectedTargetId === targetId) this.#agentSelectedTargetId = null;
        this.#challengeTracker.forget(targetId);
        this.#activeChallenges.delete(targetId);
        if (this.#challengeActive?.targetId === targetId) {
          // The challenged page is gone: parked commands should fall through
          // to the lease and fail (or succeed) against the browser as it is,
          // not wait out a challenge that no longer exists.
          this.#challengeActive = [...this.#activeChallenges.values()].at(-1) ?? null;
          this.#challengeSolver = null;
          if (!this.#challengeActive) this.#wakeChallengeWaiters({ ok: true });
          this.#emitState();
        }
        // Chromium can still list a just-closed target for a moment, and an
        // attach may be in flight when the event arrives. Re-read once the
        // target list has settled; otherwise the viewer can stay pinned to the
        // closed page with a stale title and no active tab.
        const settle = setTimeout(() => { void this.#refreshTabs().catch(() => undefined); }, 250);
        settle.unref?.();
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
    const cdp = this.#castCdp;
    const revision = this.#castAttachRevision;
    if (!cdp?.open) return;
    try {
      const { targetInfos = [] } = await cdp.send('Target.getTargets', {}, { timeoutMs: 5000 });
      if (this.#castCdp !== cdp || revision !== this.#castAttachRevision) return;
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
      // The screencast target can close between two snapshots — or while a tab
      // switch is still attaching — without the destroy event seeing it as the
      // cast target. Recover onto a surviving page instead of leaving the viewer
      // pinned to a dead target with a stale URL and title.
      if (this.#castTargetId && !active && this.#tabs.length) {
        this.#castTargetId = null;
        this.#castSessionId = null;
        void this.#attachActiveTarget().catch(() => undefined);
      }
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

  // ── dashboard tab actions ─────────────────────────────────────────────────
  //
  // The viewer protocol owns tab switching for its own socket, but the compact
  // dashboard chrome renders tabs even when no viewer stream is attached. These
  // actions therefore use the gateway's own short-lived CDP connection and obey
  // the same lease: the route takes human control first, so a tab click can never
  // be smuggled through while the agent is working.

  async #tabAction(work) {
    const admission = this.#lease.enterViewerMutation();
    if (!admission.ok) {
      throw new BrowserUnavailableError(admission.reason === 'human_has_control'
        ? 'Another viewer holds browser control.'
        : 'The browser is being handed over. Try again in a moment.');
    }
    try {
      this.#touch();
      const cdp = await this.#openInternalConnection({});
      try { return await work(cdp); }
      finally { cdp.close(); }
    } finally { admission.release(); }
  }

  async activateTab(targetId) {
    const id = requireTargetId(targetId);
    await this.#tabAction(cdp => cdp.send('Target.activateTarget', { targetId: id }));
    this.#castPinned = true;
    this.#castTargetId = id;
    if (this.#castCdp?.open) await this.#attachActiveTarget();
    else await this.refresh();
    this.#emitState();
    return this.status();
  }

  async closeTab(targetId) {
    const id = requireTargetId(targetId);
    await this.#tabAction(cdp => cdp.send('Target.closeTarget', { targetId: id }));
    if (this.#castTargetId === id) {
      this.#castTargetId = null;
      this.#castSessionId = null;
      if (this.#castCdp?.open) await this.#attachActiveTarget();
    }
    if (this.#castCdp?.open) await this.#refreshTabs();
    else await this.refresh();
    this.#emitState();
    return this.status();
  }

  async createTab(url) {
    const target = tabUrl(url);
    let targetId = '';
    await this.#tabAction(async cdp => {
      const created = await cdp.send('Target.createTarget', { url: target });
      targetId = typeof created?.targetId === 'string' ? created.targetId : '';
      if (targetId) await cdp.send('Target.activateTarget', { targetId }).catch(() => undefined);
    });
    if (!targetId) throw new BrowserUnavailableError('The browser did not confirm the new tab.');
    this.#castPinned = true;
    this.#castTargetId = targetId;
    if (this.#castCdp?.open) await this.#attachActiveTarget();
    else await this.refresh();
    this.#emitState();
    return { tabId: targetId, status: this.status() };
  }

  // ── outbound plumbing ─────────────────────────────────────────────────────

  #sendTo(viewer, value) {
    // `viewer` is null when control was claimed from the dashboard rather than
    // from a viewer socket; there is no one to notify in that case.
    if (!viewer || viewer.socket.readyState !== WebSocket.OPEN) return;
    try { viewer.socket.send(JSON.stringify(value)); } catch { /* the socket is going away */ }
  }

  #broadcast(value) { for (const viewer of this.#viewers.values()) this.#sendTo(viewer, value); }

  #emitActivity(payload, { force = false } = {}) {
    if (this.#activity.size === 0) return;
    const now = Date.now();
    if (!force && payload.type === 'cursor' && this.#lastCursorAt && now - this.#lastCursorAt < 33) return;
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
  return url === '' || url === 'about:blank' || url.startsWith('about:blank?')
    || /^chrome:\/\/(?:newtab|new-tab-page)\/?$/.test(url);
}

/** Chromium briefly reports a loading page's location where a title belongs. */
function isLocationTitle(value) {
  return /^(?:https?|data|file|about|chrome|devtools):/i.test(String(value || ''));
}

/** A tab id is an opaque target id, never a URL or a path. */
function requireTargetId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new BrowserUnavailableError('Select a valid browser tab.');
  }
  return value;
}

/** New tabs may only be HTTP(S) or the browser's own blank page. */
function tabUrl(value) {
  if (value === undefined || value === null || value === '') return 'about:blank';
  if (typeof value !== 'string' || value.length > 4096) {
    throw new BrowserUnavailableError('Enter a valid HTTP or HTTPS address for the new tab.');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new BrowserUnavailableError('Enter a valid HTTP or HTTPS address for the new tab.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new BrowserUnavailableError('Enter an HTTP or HTTPS address without embedded credentials.');
  }
  return parsed.href;
}
