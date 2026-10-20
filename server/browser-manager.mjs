// Owns every HOB-managed browser: one persistent Chromium profile per bot,
// started on first use, reused across agent turns and viewers, and shut down
// only after genuine inactivity.
//
// The idle rule is deliberately conservative. A browser is stopped only when
// *all* of these are true, so shutdown can never interrupt real work:
//   * no viewer is connected,
//   * no agent CDP connection is attached,
//   * no mutating command is running or waiting for the lease,
//   * the last activity is older than the idle timeout.

import { join } from 'node:path';
import { BrowserSession } from './browser-gateway.mjs';
import { resolveChromiumExecutable } from './browser-launcher.mjs';

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

export class BrowserManager {
  #registry; #stateDir; #sessions = new Map(); #idleMs; #sweepMs; #sweep = null; #options; #closed = false;

  constructor({ registry, stateDir, options = {} }) {
    this.#registry = registry;
    this.#stateDir = stateDir;
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    // How often the idle check runs. Production is deliberately lazy (a sweep is
    // a few comparisons); tests shorten it so a short idle window is observable.
    this.#sweepMs = options.sweepMs ?? SWEEP_INTERVAL_MS;
    this.#options = options;
  }

  static async open({ registry, stateDir, options }) {
    const manager = new BrowserManager({ registry, stateDir, options });
    manager.#sweep = setInterval(() => { void manager.sweep(); }, manager.#sweepMs);
    manager.#sweep.unref?.();
    // Every bot that already has a browser gets its endpoint back at boot. The
    // browser itself still starts on first use, so a restart of hob is not a
    // restart of everyone's Chromium.
    await manager.ensureEndpoints();
    return manager;
  }

  get idleMs() { return this.#idleMs; }

  /**
   * Bind the CDP endpoint for every bot on the roster, without starting a browser.
   * One bot's port being unavailable must not stop the others from being reachable.
   */
  async ensureEndpoints() {
    for (const record of this.#registry.list()) {
      await this.ensureEndpoint(record.bot).catch(() => undefined);
    }
  }

  /**
   * Bind a bot's loopback CDP endpoint without starting a browser. This is what
   * makes the URL in the bot's Hermes profile true before the bot has ever browsed.
   */
  async ensureEndpoint(botId) {
    const session = await this.#sessionFor(botId);
    await session.ensureGateway();
    return session;
  }

  /** Report whether the host can run a browser at all, without starting one. */
  async probe() {
    const executable = await resolveChromiumExecutable();
    return { chromium: executable, ready: Boolean(executable) };
  }

  /**
   * The session for a bot, created on first use. Registering the bot here also
   * mints its stable gateway port and token, which is what its Hermes profile's
   * `browser.cdp_url` is derived from.
   */
  async ensure(botId) {
    if (this.#closed) throw new Error('The browser manager is shutting down.');
    const session = await this.#sessionFor(botId);
    await session.start();
    await this.#registry.update(botId, { lastActiveAt: new Date().toISOString() }).catch(() => undefined);
    return session;
  }

  /**
   * The session for a bot, created but *not* started. Watching a bot, or opening
   * its settings, must not launch a browser nobody asked for; only `ensure` and
   * `attachViewer` do that.
   */
  async #sessionFor(botId) {
    const existing = this.#sessions.get(botId);
    if (existing) return existing;
    const record = await this.#registry.getOrCreate(botId);
    const session = new BrowserSession({
      botId,
      record,
      options: { profileDir: this.#registry.profileDir(this.#stateDir, botId), ...this.#options },
    });
    this.#sessions.set(botId, session);
    return session;
  }

  /** The session record (port, token, profile) without starting anything. */
  async record(botId) { return this.#registry.getOrCreate(botId); }

  session(botId) { return this.#sessions.get(botId) ?? null; }

  /**
   * Subscribe to a bot's agent/viewer activity without starting its browser.
   * Returns the unsubscribe function.
   */
  async activity(botId, listener) {
    const session = await this.#sessionFor(botId);
    return session.onActivity(listener);
  }

  /** Attach a viewer socket, starting the browser if it is not running. */
  async attachViewer(botId, socket) {
    const session = await this.#sessionFor(botId);
    return { session, viewer: session.attachViewer(socket) };
  }

  async status(botId) {
    const session = this.#sessions.get(botId);
    if (session) return session.status();
    const record = await this.#registry.getOrCreate(botId);
    return {
      bot: botId, state: 'stopped', cdpUrl: `http://127.0.0.1:${record.gatewayPort}/${record.gatewayToken}`,
      port: record.gatewayPort, viewers: 0, agentConnections: 0,
      control: { holder: 'agent', since: null, inFlight: 0, pending: 0, draining: false },
      viewport: { w: 1280, h: 800 }, tabs: [], url: '', title: '', loading: false,
      profileDir: this.#registry.profileDir(this.#stateDir, botId), lastError: null,
    };
  }

  /**
   * The dashboard's status: like `status`, but reads the browser's live page and
   * tabs first, so the URL and title are real even when nobody is streaming. An
   * observational read only — it can neither start the browser nor hold the lease.
   */
  async view(botId) {
    const session = this.#sessions.get(botId);
    if (session) return session.refresh();
    return this.status(botId);
  }

  /**
   * Idle/forced shutdown. The session object is kept, not discarded: its status,
   * its activity subscribers and its agent token must outlive the browser, so a
   * dashboard can still see "stopped" and a later command restarts the same
   * profile at the same CDP URL.
   */
  async stop(botId, { reason = 'idle' } = {}) {
    const session = this.#sessions.get(botId);
    if (!session) return false;
    const wasRunning = session.running;
    await session.stop({ reason });
    await this.#registry.update(botId, { lastActiveAt: new Date().toISOString() }).catch(() => undefined);
    return wasRunning;
  }

  /** Bot deletion: stop the browser and forget the profile roster entry. */
  async remove(botId) {
    const session = this.#sessions.get(botId);
    this.#sessions.delete(botId);
    if (session) await session.destroy({ reason: 'destroyed' }).catch(() => undefined);
    return this.#registry.remove(botId);
  }

  async sweep() {
    if (this.#closed) return;
    const cutoff = Date.now() - this.#idleMs;
    for (const [botId, session] of this.#sessions) {
      if (!session.running) continue;
      if (session.hasWork()) continue;
      if (session.lastActiveAt > cutoff) continue;
      await this.stop(botId, { reason: 'idle' }).catch(() => undefined);
    }
  }

  async shutdown() {
    this.#closed = true;
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = null;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map(session => session.destroy({ reason: 'destroyed' }).catch(() => undefined)));
  }
}
