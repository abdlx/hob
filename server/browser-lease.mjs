// Exclusive control lease for one bot's browser.
//
// This is the single arbiter that makes "human takeover" real: every mutating
// CDP command is admitted only through `enterAgentMutation` /
// `enterViewerMutation`, so while a human holds the lease no agent mutation can
// reach Chromium — not through Hermes' high-level browser tools, and not through
// a raw `browser_cdp` command, because both are routed through the same gateway.
//
// Ordering guarantees:
//   * A handover closes the door first (`#blockAgents`), then waits for in-flight
//     commands to drain. A command can never start after a handover begins, and a
//     handover never interleaves with a running command, in either direction.
//   * Agent mutations that arrive during human control wait (bounded) in the
//     waiter queue and resume on `releaseControl`, rather than failing
//     immediately. On timeout the caller gets a structured refusal.
//   * Viewers are never queued: a click while the agent works is dropped, not
//     replayed later onto a page it was not aimed at.
//   * Observational commands never consult the lease; reading is always safe.

export const AGENT = 'agent';
export const HUMAN = 'human';

export class ControlLease {
  #holder = AGENT;
  #since = Date.now();
  #inFlight = 0;
  #blockAgents = false;
  #waiters = [];
  #drainers = [];
  #listeners = new Set();
  #defaultWaitMs;

  constructor({ agentWaitMs = 20000 } = {}) { this.#defaultWaitMs = agentWaitMs; }

  get holder() { return this.#holder; }
  get since() { return this.#since; }
  get inFlight() { return this.#inFlight; }
  get pending() { return this.#waiters.length; }
  /** True while a handover is closing the agent door and draining what is in flight. */
  get draining() { return this.#blockAgents; }

  snapshot() {
    return {
      holder: this.#holder, since: this.#since, inFlight: this.#inFlight,
      pending: this.#waiters.length, draining: this.#blockAgents,
    };
  }

  on(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  /**
   * Admit one agent-side mutating CDP command. Resolves to a release function
   * the caller must always invoke, or to a refusal with a machine-readable
   * reason (`human_has_control`, `handover_in_progress`, `cancelled`).
   */
  async enterAgentMutation({ waitMs = this.#defaultWaitMs, signal } = {}) {
    if (this.#holder === AGENT && !this.#blockAgents) return this.#admit();
    if (signal?.aborted) return { ok: false, reason: 'cancelled' };
    const admitted = await this.#enqueue(signal, waitMs);
    if (admitted) return this.#admit();
    if (signal?.aborted) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: this.#holder === HUMAN ? 'human_has_control' : 'handover_in_progress' };
  }

  /** Admit one viewer-side mutation. Refused unless the human currently holds the lease. */
  enterViewerMutation() {
    if (this.#holder !== HUMAN || this.#blockAgents) return { ok: false, reason: 'agent_has_control' };
    return this.#admit();
  }

  /** Give control to the human, after letting the agent's current command finish. */
  requestControl({ timeoutMs = 15000 } = {}) { return this.#handover(HUMAN, timeoutMs); }

  /** Return control to the agent, after letting the human's current gesture finish. */
  async releaseControl({ timeoutMs = 5000 } = {}) {
    const result = await this.#handover(AGENT, timeoutMs);
    // Whether or not the flip happened, a human that is gone must not leave
    // agent commands parked in the waiter queue.
    if (!result.ok) this.#wake();
    return result;
  }

  async #handover(target, timeoutMs) {
    if (this.#holder === target && !this.#blockAgents) {
      return { ok: true, holder: target, alreadyHeld: true };
    }
    this.#blockAgents = true;
    if (this.#inFlight > 0) await this.#waitForDrain(timeoutMs);
    if (this.#inFlight > 0) {
      this.#blockAgents = false;
      if (this.#holder === AGENT) this.#wake();
      return { ok: false, reason: 'busy', inFlight: this.#inFlight };
    }
    this.#holder = target;
    this.#since = Date.now();
    this.#blockAgents = false;
    this.#notify();
    this.#wake();
    return { ok: true, holder: target };
  }

  #admit() {
    this.#inFlight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight -= 1;
        if (this.#inFlight === 0 && this.#drainers.length) {
          for (const resolve of this.#drainers.splice(0)) resolve();
        }
      },
    };
  }

  #enqueue(signal, waitMs) {
    return new Promise(resolve => {
      const waiter = { resolve: null, timer: null, onAbort: null };
      const settle = value => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', waiter.onAbort);
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        resolve(value);
      };
      waiter.resolve = () => settle(true);
      waiter.onAbort = () => settle(false);
      waiter.timer = setTimeout(() => settle(false), waitMs);
      waiter.timer.unref?.();
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #waitForDrain(timeoutMs) {
    return new Promise(resolve => {
      let timer;
      const finish = () => { clearTimeout(timer); resolve(); };
      timer = setTimeout(() => {
        const index = this.#drainers.indexOf(finish);
        if (index !== -1) this.#drainers.splice(index, 1);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      this.#drainers.push(finish);
    });
  }

  #wake() {
    while (this.#waiters.length && this.#holder === AGENT && !this.#blockAgents) {
      this.#waiters.shift().resolve();
    }
  }

  #notify() {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) {
      try { listener(snapshot); } catch { /* a listener must not break the lease */ }
    }
  }
}
