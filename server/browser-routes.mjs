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
  };
}

export function createBrowserRoutes({
  browser, knownBot, authenticated, assertOrigin, startEvents, sendEvent, json, body,
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
      await browser.ensure(profile);
      return json(res, 200, publicStatus(await browser.view(profile)));
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

    if (tail === '/viewer' && method === 'POST') {
      // Field names match what @atriumjs/react consumes: it appends `viewerToken`
      // to `wsUrl` as the `token` query parameter, and displays `sessionId`.
      return json(res, 200, { profile, sessionId: profile, wsPath: STREAM, ...mintTicket(profile) });
    }

    if (tail === '/activity' && method === 'GET') {
      const unsubscribe = await browser.activity(profile, payload => sendEvent(res, 'browser', payload));
      startEvents(res);
      sendEvent(res, 'ready', { bot: profile });
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
    try { url = new URL(req.url, 'http://muse.local'); } catch { socket.destroy(); return false; }
    if (url.pathname !== STREAM) return false;
    if (req.method !== 'GET') { socket.destroy(); return true; }
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
