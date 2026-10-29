// HOB's HTTP/WebSocket surface for the per-bot managed browser.
//
// Two audiences, two credentials:
//
//   * The dashboard (this file) authenticates with the HOB session — the same
//     gate every other `/api/*` route uses — and exchanges it for a short-lived
//     viewer ticket that authorises the long-lived stream socket.
//   * Hermes (the agent) never touches this file. It speaks CDP to the per-bot
//     gateway, which is exactly why a takeover enforced there cannot be evaded
//     from here either.
//
// The status view deliberately omits the CDP URL and the profile path: the URL
// embeds the bot's agent credential, and the dashboard has no use for either.

import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { validBotId } from './browser-registry.mjs';

const BASE = '/api/hermes/browser';
const STREAM = `${BASE}/stream`;
const ACTIVITY = `${BASE}/activity`;
const TICKET_TTL_MS = 15 * 60 * 1000;
const MAX_TICKETS_PER_BOT = 8;
const MAX_VIEWERS_PER_BOT = 8;

class RouteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** The dashboard view of a session: no gateway credential, no host paths. */
function publicStatus(status) {
  return {
    bot: status.bot,
    state: status.state,
    control: status.control,
    viewers: status.viewers,
    agentConnections: status.agentConnections,
    viewport: status.viewport,
    tabs: status.tabs,
    url: status.url,
    title: status.title,
    loading: status.loading,
    lastError: status.lastError,
    // How HOB reaches Chromium: `pipe` in production. Operators (and the
    // end-to-end scenario) read this to confirm the raw DevTools port is off.
    transport: status.transport,
    // CAPTCHA state for the dashboard: provider and kind only. The sitekey
    // and any token are solving material, not display material, and this
    // view's whole discipline is omitting what an operator does not need.
    challenge: status.challenge
      ? { provider: status.challenge.provider, kind: status.challenge.kind, since: status.challenge.activeAt ?? null }
      : null,
    challengeStats: status.challengeStats ?? null,
    challengeCooldowns: status.challengeCooldowns ?? [],
  };
}

export function createBrowserRoutes({
  browser, knownBot, authenticated, assertOrigin, startEvents, sendEvent, json, body,
  ensureBinding, bindingFor,
  // Production leaves this at the default; tests shorten it so expiry can be
  // observed without a fifteen-minute wait.
  ticketTtlMs = TICKET_TTL_MS,
}) {
  const tickets = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const profileFrom = (req, url) => {
    // An explicit but empty `?profile=` is a mistake, not a request for the
    // default bot, so only a *missing* parameter falls back.
    const requested = url.searchParams.has('profile')
      ? url.searchParams.get('profile')
      : (req.headers['x-hob-profile'] ?? 'default');
    // The name becomes a directory and a config key, so it is validated before
    // it is ever looked up — never sanitised after.
    if (!validBotId(requested)) throw new RouteError(400, 'Select a valid bot.');
    return requested;
  };

  const requireKnownBot = async profile => {
    if (knownBot && !(await knownBot(profile))) throw new RouteError(404, 'This bot is not in your dashboard.');
  };

  // Repair the agent's browser binding before this bot's browser is used. A bot
  // created before the managed browser existed is otherwise left driving a
  // throwaway Hermes browser, which is what makes its live view stay blank while
  // the bot itself can still browse and screenshot. A failure is reported rather
  // than swallowed, so the dashboard can show why its view is empty; the viewer
  // still opens, and the next turn or boot retries the binding.
  const repoint = async profile => {
    if (!ensureBinding) return { ok: true, changed: false };
    try { return { ok: true, changed: Boolean(await ensureBinding(profile)) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };

  const mintTicket = profile => {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + ticketTtlMs;
    let forBot = tickets.get(profile);
    if (!forBot) { forBot = new Map(); tickets.set(profile, forBot); }
    for (const [existing, expiry] of forBot) if (expiry < Date.now()) forBot.delete(existing);
    forBot.set(token, expiresAt);
    // Bounded: a tab opened and closed repeatedly must not grow this map forever.
    while (forBot.size > MAX_TICKETS_PER_BOT) forBot.delete(forBot.keys().next().value);
    return { viewerToken: token, expiresAt };
  };

  /**
   * A ticket is a one-shot bearer credential. It is consumed the moment it is
   * presented, so a ticket that leaks — into a proxy log, a screenshot, a
   * Referer, a crash report — cannot be replayed for the rest of its lifetime.
   *
   * A viewer that reconnects after its ticket is spent is authenticated by its
   * same-origin session cookie instead, which `assertOrigin` has already made
   * safe against a cross-site hijack.
   */
  const redeemTicket = (profile, token) => {
    if (!token) return false;
    const forBot = tickets.get(profile);
    const expiry = forBot?.get(token);
    if (expiry === undefined) return false;
    forBot.delete(token);
    return expiry >= Date.now();
  };

  async function route(req, res, url) {
    if (!url.pathname.startsWith(BASE)) return false;
    const tail = url.pathname.slice(BASE.length);
    const method = req.method;
    const profile = profileFrom(req, url);
    await requireKnownBot(profile);

    if (tail === '' && method === 'GET') {
      const probe = await browser.probe();
      const status = await browser.view(profile);
      return json(res, 200, { ...publicStatus(status), available: probe.ready, browserExecutable: probe.chromium });
    }

    if (tail === '/start' && method === 'POST') {
      const repair = await repoint(profile);
      await browser.ensure(profile);
      const probe = await browser.probe();
      return json(res, 200, {
        ...publicStatus(await browser.view(profile)),
        available: probe.ready,
        browserExecutable: probe.chromium,
        binding: bindingFor ? await bindingFor(profile) : null,
        repair,
      });
    }

    // The dashboard's "why is my view empty?" surface. GET is observational;
    // POST also repairs the profile, which is the only write and therefore needs
    // the same session gate as every other dashboard action.
    if (tail === '/diagnose' && (method === 'GET' || method === 'POST')) {
      const repair = method === 'POST' ? await repoint(profile) : undefined;
      const probe = await browser.probe();
      const status = await browser.view(profile);
      const binding = bindingFor ? await bindingFor(profile) : null;
      return json(res, 200, {
        ...publicStatus(status),
        available: probe.ready,
        browserExecutable: probe.chromium,
        binding,
        ...(repair ? { repair } : {}),
      });
    }

    if (tail === '/stop' && method === 'POST') {
      await browser.stop(profile, { reason: 'idle' });
      return json(res, 200, publicStatus(await browser.view(profile)));
    }

    if (tail === '/control' && method === 'POST') {
      const input = await body(req);
      const action = input?.action;
      if (action !== 'take' && action !== 'release') throw new RouteError(400, 'Choose take or release.');
      // Claimed through the session's lease, so a handover waits for whatever the
      // agent is mid-way through instead of tearing the page in half.
      const session = await browser.ensure(profile);
      const result = action === 'take'
        ? await session.requestControl(null)
        : await session.releaseControl(null);
      return json(res, 200, { ok: result.ok, reason: result.reason ?? null, ...publicStatus(await browser.view(profile)) });
    }

    // Tab actions from the dashboard's Chrome-like chrome. They take human
    // control implicitly; the session enforces the same lease as a viewer click.
    if (tail === '/tabs' && method === 'GET') {
      return json(res, 200, publicStatus(await browser.view(profile)));
    }
    if (tail.startsWith('/tabs/') && method === 'POST') {
      const action = tail.slice('/tabs/'.length);
      if (!['activate', 'close', 'new'].includes(action)) throw new RouteError(404, 'Browser tab action not found.');
      if (typeof browser[action === 'new' ? 'createTab' : action === 'close' ? 'closeTab' : 'activateTab'] !== 'function') {
        throw new RouteError(503, 'Browser tab actions are unavailable.');
      }
      const input = await body(req);
      const expected = action === 'new' ? ['url'] : ['tabId'];
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !expected.includes(key))) {
        throw new RouteError(400, 'Unsupported browser tab request.');
      }
      if (action !== 'new' && (typeof input.tabId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.tabId))) {
        throw new RouteError(400, 'Select a valid browser tab.');
      }
      if (action === 'new' && input.url !== undefined
        && (typeof input.url !== 'string' || input.url.length > 4096)) {
        throw new RouteError(400, 'Enter a valid address for the new tab.');
      }
      const result = action === 'activate' ? await browser.activateTab(profile, input.tabId)
        : action === 'close' ? await browser.closeTab(profile, input.tabId)
          : await browser.createTab(profile, input.url);
      const status = result?.status ?? result;
      return json(res, 200, { ...publicStatus(status), ...(result?.tabId ? { tabId: result.tabId } : {}) });
    }

    if (tail === '/viewer' && method === 'POST') {
      // Field names match what @atriumjs/react consumes: it appends `viewerToken`
      // to `wsUrl` as the `token` query parameter, and displays `sessionId`.
      // Repair here as well as on the upgrade so the dashboard learns the result:
      // an upgrade cannot return a body to say why the view is about to be blank.
      const repair = await repoint(profile);
      return json(res, 200, {
        profile, sessionId: profile, wsPath: STREAM, ...mintTicket(profile),
        ...(bindingFor ? { binding: await bindingFor(profile) } : {}),
        repair,
      });
    }

    if (tail === '/activity' && method === 'GET') {
      // Announce the stream before anything can subscribe: a listener that fires
      // while this handler is still awaiting would otherwise write into a response
      // whose SSE headers have not been sent yet.
      startEvents(res);
      sendEvent(res, 'ready', { bot: profile });
      let unsubscribe = () => {};
      try {
        unsubscribe = await browser.activity(profile, payload => sendEvent(res, 'browser', payload));
      } catch (problem) {
        sendEvent(res, 'browser', { type: 'browser', state: 'crashed', message: problem.message });
        res.end();
        return true;
      }
      // The heartbeat is a liveness trickle for a connected dashboard, never a
      // reason for the server to stay alive: an SSE client that vanishes without
      // a clean close must not be able to pin the process open with a timer.
      const heartbeat = setInterval(() => { if (!authenticated(req)) { res.end(); return; } res.write(': heartbeat\n\n'); }, 20000);
      heartbeat.unref?.();
      req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
      return true;
    }

    throw new RouteError(404, 'Browser endpoint not found.');
  }

  /**
   * The viewer stream. Handled on the raw socket because it is an upgrade, not a
   * request, so the session gate that guards `/api/*` never ran: this function is
   * the only thing standing between a socket and a bot's screen.
   */
  function upgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://hob.local'); } catch { socket.destroy(); return false; }
    if (url.pathname !== STREAM) return false;
    if (req.method !== 'GET') { socket.destroy(); return true; }
    if (url.searchParams.getAll('profile').length !== 1) { socket.destroy(); return true; }
    // Cross-site WebSocket hijacking is the whole threat model here: a page on
    // another origin must not be able to open this socket with the user's cookie
    // attached. `assertOrigin` rejects a mismatched or cross-site origin.
    try { assertOrigin(req); } catch { socket.destroy(); return true; }

    let profile;
    try { profile = profileFrom(req, url); } catch { socket.destroy(); return true; }

    // The ticket is the intended credential. A live same-origin session is also
    // accepted, so a long-lived tab whose ticket has expired reconnects to a
    // working view rather than a permanently dead panel; `assertOrigin` above is
    // what makes a cookie-authenticated upgrade safe. The parameter is named
    // `token` because `@atriumjs/react` is the client that builds this URL.
    if (!redeemTicket(profile, url.searchParams.get('token')) && !authenticated(req)) {
      socket.destroy();
      return true;
    }

    const existing = browser.session(profile);
    if (existing && existing.viewerCount >= MAX_VIEWERS_PER_BOT) {
      socket.destroy();
      return true;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      void (async () => {
        try {
          if (knownBot && !(await knownBot(profile))) { ws.close(1008, 'unknown bot'); return; }
          await repoint(profile);
          await browser.attachViewer(profile, ws);
        } catch {
          try { ws.close(1011, 'browser unavailable'); } catch { /* already gone */ }
        }
      })();
    });
    return true;
  }

  function close() {
    tickets.clear();
    try { wss.close(); } catch { /* never opened */ }
  }

  return { route, upgrade, close, STREAM, ACTIVITY, BASE };
}
