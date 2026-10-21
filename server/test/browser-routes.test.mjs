// The HOB HTTP/WebSocket surface for the managed browser.
//
// This is the security boundary: everything the dashboard can do to a bot's
// browser goes through these routes, and a viewer socket is the only way an
// external client can reach a page. What matters here is that the boundary is
// real — an unauthenticated caller, an unknown bot, a forged ticket, a
// cross-site origin and a path-traversal bot name must all be refused, and the
// status view must not hand out the agent's CDP credential.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../app.mjs';
import { BrowserRegistry } from '../browser-registry.mjs';
import { BrowserManager } from '../browser-manager.mjs';

const PASSWORD = 'correct horse battery staple';

/** The browser routes never speak to the Hermes gateway, so it is inert here. */
function stubGateway() {
  return { kind: 'other', connected: false, on() {}, request: async () => ({}), start() {}, stop() {} };
}

async function startApp(t, { bots = ['alpha'], viewerTicketTtlMs, bind, binding } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'hob-browser-routes-'));
  const registry = await BrowserRegistry.open({ stateDir });
  const browser = await BrowserManager.open({ registry, stateDir, options: { idleMs: 60000, maxFps: 10 } });
  const app = createApp({
    gateway: stubGateway(),
    bots: {
      list: async () => ({ profiles: bots.map(name => ({ name })) }),
      has: name => bots.includes(name),
      token: () => 'x'.repeat(32),
      ...(bind ? { configureBrowser: bind } : {}),
      ...(binding ? { browserBinding: binding } : {}),
    },
    browser,
    password: PASSWORD,
    stateDir,
    viewerTicketTtlMs,
    staticDir: join(stateDir, 'no-such-static-dir'),
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    await new Promise(resolve => { app.close(() => resolve()); app.closeAllConnections?.(); });
    await browser.shutdown();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { app, browser, origin };
}

async function signIn(origin) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.match(cookie, /^muse_session=/);
  return cookie;
}

const getJson = async (origin, path, cookie) => {
  const response = await fetch(`${origin}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: response.status, body: await response.json().catch(() => null) };
};

test('browser routes: every endpoint requires the dashboard session', async t => {
  const { origin } = await startApp(t);
  for (const path of ['/api/hermes/browser?profile=alpha', '/api/hermes/browser/activity?profile=alpha']) {
    const { status } = await getJson(origin, path);
    assert.equal(status, 401, `${path} must not answer an unauthenticated caller`);
  }
  const control = await fetch(`${origin}/api/hermes/browser/control?profile=alpha`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'take' }),
  });
  assert.equal(control.status, 401);
});

test('browser routes: the status view never leaks the agent credential', async t => {
  const { origin, browser } = await startApp(t);
  const cookie = await signIn(origin);
  const { status, body } = await getJson(origin, '/api/hermes/browser?profile=alpha', cookie);
  assert.equal(status, 200);
  assert.equal(body.bot, 'alpha');
  assert.equal(body.state, 'stopped', 'asking about a bot must not start its browser');
  assert.equal(body.available, true, 'this host has a Chromium family browser');
  // The gateway URL embeds the token the agent authenticates with, and the
  // profile path is host layout. Neither belongs in a dashboard payload.
  const serialized = JSON.stringify(body);
  assert.ok(!('cdpUrl' in body), 'the gateway URL must not be exposed');
  assert.ok(!('profileDir' in body), 'the profile path must not be exposed');
  assert.ok(!/br-[a-f0-9]{16}/.test(serialized), 'the browser profile id must not be exposed');
  const record = await browser.record('alpha');
  assert.ok(!serialized.includes(record.gatewayToken), 'the gateway token must not appear anywhere');
});

test('browser routes: an unknown or malformed bot is refused', async t => {
  const { origin } = await startApp(t, { bots: ['alpha'] });
  const cookie = await signIn(origin);
  assert.equal((await getJson(origin, '/api/hermes/browser?profile=ghost', cookie)).status, 404);
  // A bot name becomes a directory and a config key, so it is validated before
  // anything is looked up, not sanitised after.
  for (const name of ['../../etc', 'Alpha', 'a'.repeat(65), '', '.']) {
    const { status } = await getJson(origin, `/api/hermes/browser?profile=${encodeURIComponent(name)}`, cookie);
    assert.equal(status, 400, `${JSON.stringify(name)} must be rejected as a bot id`);
  }
});

test('browser routes: a viewer socket needs a real ticket or a real session', async t => {
  const { origin, browser } = await startApp(t);
  const cookie = await signIn(origin);
  const profile = 'alpha';

  // A refused upgrade must be visible as a refusal, not as a timeout, and must
  // never quietly succeed.
  const refused = (url, options) => new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once('open', () => { socket.close(); reject(new Error('the upgrade should have been refused')); });
    socket.once('error', () => resolve());
    socket.once('close', () => resolve());
    setTimeout(() => reject(new Error('the server neither accepted nor refused the socket')), 10000).unref?.();
  });

  const minted = await fetch(`${origin}/api/hermes/browser/viewer?profile=${profile}`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(minted.status, 200);
  const ticket = await minted.json();
  // These names are not mine to choose: @atriumjs/react appends `viewerToken` to
  // `wsUrl` as the `token` query parameter and shows `sessionId`.
  assert.match(ticket.viewerToken, /^[a-f0-9]{64}$/);
  assert.equal(ticket.sessionId, profile);
  assert.match(ticket.wsPath, /^\/api\/hermes\/browser\/stream$/);

  const stream = origin.replace('http:', 'ws:') + ticket.wsPath;
  await refused(`${stream}?token=${ticket.viewerToken}`, { headers: { Cookie: cookie }, origin });
  await refused(`${stream}?profile=alpha&profile=beta&token=${ticket.viewerToken}`, { headers: { Cookie: cookie }, origin });
  // No credential at all.
  await refused(`${stream}?profile=${profile}`);
  // A forged ticket of the right shape.
  await refused(`${stream}?profile=${profile}&token=${'f'.repeat(64)}`);
  // A ticket minted for one bot must not open another bot's screen.
  await refused(`${stream}?profile=beta&token=${ticket.viewerToken}`);
  // A cross-site origin is refused even when the ticket is valid: that is what
  // stops another page from opening this socket.
  await refused(`${stream}?profile=${profile}&token=${ticket.viewerToken}`, { origin: 'http://evil.test' });

  // The real thing works, and streams what the browser is showing.
  const socket = new WebSocket(`${stream}?profile=${profile}&token=${ticket.viewerToken}`);
  const frames = [];
  socket.on('message', (data, isBinary) => { if (isBinary) frames.push(data.length); });
  const hello = await new Promise((resolve, reject) => {
    socket.on('message', (data, isBinary) => { if (!isBinary) resolve(JSON.parse(data.toString('utf8'))); });
    socket.once('error', reject);
    setTimeout(() => reject(new Error('no hello frame')), 20000).unref?.();
  });
  assert.equal(hello.t, 'hello');
  assert.equal(hello.sessionId, profile);
  assert.equal(hello.control.holder, 'agent');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.ok(frames.length > 0, 'a connected viewer must receive screen frames');
  assert.equal(browser.session(profile).viewerCount, 1);
  socket.close();
  await new Promise(resolve => setTimeout(resolve, 300));
});

test('browser routes: opening a viewer repairs a bot that was never bound to its managed browser', async t => {
  const bound = [];
  const { origin } = await startApp(t, { bind: async name => { bound.push(name); } });
  const cookie = await signIn(origin);
  const minted = await fetch(`${origin}/api/hermes/browser/viewer?profile=alpha`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(minted.status, 200);
  const ticket = await minted.json();
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${ticket.wsPath}?profile=alpha&token=${ticket.viewerToken}`);
  const hello = await new Promise((resolve, reject) => {
    socket.once('message', data => { try { resolve(JSON.parse(data.toString('utf8'))); } catch (error) { reject(error); } });
    socket.once('error', reject);
    setTimeout(() => reject(new Error('no hello frame')), 20000).unref?.();
  });
  assert.equal(hello.t, 'hello');
  assert.ok(bound.length >= 1 && bound.every(name => name === 'alpha'),
    'a viewer must repair the agent binding before streaming');
  socket.close();
  await new Promise(resolve => setTimeout(resolve, 300));
});

test('browser routes: diagnosis reports the binding but only a POST repairs it', async t => {
  let repaired = 0;
  const { origin, browser } = await startApp(t, {
    bind: async () => { repaired += 1; return true; },
    binding: async () => ({
      configured: false, backend: 'browser-use', configuredPort: 32100,
      expectedPort: 32100, envOverride: false, reason: 'backend',
    }),
  });
  const cookie = await signIn(origin);

  const read = await getJson(origin, '/api/hermes/browser/diagnose?profile=alpha', cookie);
  assert.equal(read.status, 200);
  assert.equal(read.body.binding.configured, false);
  assert.equal(read.body.binding.backend, 'browser-use');
  assert.equal(read.body.binding.expectedPort, 32100);
  assert.equal(repaired, 0, 'a diagnostic read must not write the profile');
  const record = await browser.record('alpha');
  assert.ok(!JSON.stringify(read.body).includes(record.gatewayToken),
    'the diagnosis must not expose the gateway credential');

  const write = await fetch(`${origin}/api/hermes/browser/diagnose?profile=alpha`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(write.status, 200);
  const body = await write.json();
  assert.deepEqual(body.repair, { ok: true, changed: true });
  assert.equal(repaired, 1, 'the explicit check repairs the binding');
});

test('browser routes: a failed binding repair is reported instead of hidden', async t => {
  const { origin } = await startApp(t, {
    bind: async () => { throw new Error('synthetic binding failure'); },
    binding: async () => ({
      configured: false, backend: null, configuredPort: null,
      expectedPort: 32100, envOverride: false, reason: 'unreadable', error: 'synthetic read failure',
    }),
  });
  const cookie = await signIn(origin);
  const response = await fetch(`${origin}/api/hermes/browser/diagnose?profile=alpha`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.repair.ok, false);
  assert.match(body.repair.error, /synthetic binding failure/);
  assert.equal(body.binding.configured, false);
  assert.equal(body.binding.error, 'synthetic read failure');
});

test('browser routes: a viewer ticket is single-use and cannot be replayed', async t => {
  const { origin } = await startApp(t);
  const cookie = await signIn(origin);
  const profile = 'alpha';
  const stream = origin.replace('http:', 'ws:') + '/api/hermes/browser/stream';

  const mint = async () => (await (await fetch(`${origin}/api/hermes/browser/viewer?profile=${profile}`, {
    method: 'POST', headers: { Cookie: cookie },
  })).json());

  // Resolves to the socket when the upgrade is accepted, or null when it is
  // refused — never a silent timeout.
  const open = (url, options) => new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const decided = value => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => reject(new Error('the server neither accepted nor refused the socket')), 10000);
    timer.unref?.();
    socket.once('open', () => decided(socket));
    socket.once('error', () => decided(null));
    socket.once('close', () => decided(null));
  });

  const ticket = await mint();
  const first = await open(`${stream}?profile=${profile}&token=${ticket.viewerToken}`);
  assert.ok(first, 'a freshly minted ticket opens the stream');
  const hello = await new Promise((resolve, reject) => {
    first.on('message', (data, isBinary) => { if (!isBinary) resolve(JSON.parse(data.toString('utf8'))); });
    setTimeout(() => reject(new Error('no hello frame')), 20000).unref?.();
  });
  assert.equal(hello.t, 'hello');
  first.close();
  await new Promise(resolve => setTimeout(resolve, 300));

  // The ticket is a one-shot bearer credential: a copy of it cannot be replayed
  // for the rest of its (15 minute) lifetime.
  const replay = await open(`${stream}?profile=${profile}&token=${ticket.viewerToken}`);
  assert.equal(replay, null, 'a spent ticket must not be replayable');

  // A reconnecting tab presents the same spent ticket, and is authenticated by
  // its same-origin session instead — which `assertOrigin` has already checked.
  const reconnect = await open(`${stream}?profile=${profile}&token=${ticket.viewerToken}`, { headers: { Cookie: cookie } });
  assert.ok(reconnect, 'a reconnecting viewer falls back to its same-origin session');
  reconnect.close();
  await new Promise(resolve => setTimeout(resolve, 300));

  // Minting still works, and a second viewer joins the same browser.
  const next = await mint();
  assert.notEqual(next.viewerToken, ticket.viewerToken);
  const second = await open(`${stream}?profile=${profile}&token=${next.viewerToken}`);
  assert.ok(second, 'a new ticket still opens the stream');
  second.close();
});

test('browser routes: an expired viewer ticket is dead even if it was never used', async t => {
  // A short lifetime so the clock, not a fifteen-minute wait, decides the test.
  // The ticket is presented without the session cookie, or the same-origin
  // fallback would legitimately accept the connection.
  const { origin } = await startApp(t, { viewerTicketTtlMs: 250 });
  const cookie = await signIn(origin);
  const profile = 'alpha';
  const stream = origin.replace('http:', 'ws:') + '/api/hermes/browser/stream';

  const ticket = await (await fetch(`${origin}/api/hermes/browser/viewer?profile=${profile}`, {
    method: 'POST', headers: { Cookie: cookie },
  })).json();
  assert.ok(ticket.viewerToken);

  await new Promise(resolve => setTimeout(resolve, 400));
  const refused = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${stream}?profile=${profile}&token=${ticket.viewerToken}`);
    const timer = setTimeout(() => reject(new Error('the server neither accepted nor refused the socket')), 10000);
    timer.unref?.();
    socket.once('open', () => { clearTimeout(timer); socket.close(); resolve(false); });
    socket.once('error', () => { clearTimeout(timer); resolve(true); });
  });
  assert.equal(refused, true, 'an unused but expired ticket must not open the stream');
});

test('browser routes: control can be taken and returned from the dashboard', async t => {
  const { origin, browser } = await startApp(t);
  const cookie = await signIn(origin);
  const control = action => fetch(`${origin}/api/hermes/browser/control?profile=alpha`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ action }),
  });

  const session = await browser.ensure('alpha');
  assert.equal(session.status().control.holder, 'agent');
  const taken = await control('take');
  assert.equal(taken.status, 200);
  assert.equal((await taken.json()).control.holder, 'human', 'the dashboard claim must reach the lease');
  const released = await control('release');
  assert.equal((await released.json()).control.holder, 'agent');
  // An unknown action must be refused rather than silently ignored.
  const nonsense = await fetch(`${origin}/api/hermes/browser/control?profile=alpha`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ action: 'seize' }),
  });
  assert.equal(nonsense.status, 400);
  assert.equal(session.status().control.holder, 'agent');
});

test('browser routes: agent activity reaches the dashboard, including live control state', async t => {
  const { origin, browser } = await startApp(t);
  const cookie = await signIn(origin);
  const session = await browser.ensure('alpha');

  const response = await fetch(`${origin}/api/hermes/browser/activity?profile=alpha`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      for (const chunk of decoder.decode(value).split('\n\n')) {
        const name = chunk.match(/^event: (.+)$/m)?.[1];
        if (name) events.push({ name, data: chunk.match(/^data: (.+)$/m)?.[1] });
      }
    }
  })();

  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(events.some(event => event.name === 'ready'), 'the stream must announce itself');

  // A viewer joining and the lease changing hands are both things the dashboard
  // must be able to show without polling.
  await session.requestControl(null);
  await session.releaseControl(null);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(session.status().control.holder === 'agent');
  await new Promise(resolve => setTimeout(resolve, 200));

  // The agent's own pointer is what the dashboard's cursor overlay draws, so those
  // movements have to arrive over this same stream — the viewer socket cannot carry
  // them, because it belongs to the person.
  const version = await (await fetch(`${session.cdpUrl}/json/version`)).json();
  const agent = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 0 });
  await once(agent, 'open');
  agent.send(JSON.stringify({
    id: 1, method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseMoved', x: 40, y: 60, button: 'none', clickCount: 0 },
  }));
  const deadline = Date.now() + 5000;
  const cursorEvents = () => events.filter(event => {
    if (event.name !== 'browser') return false;
    try { return JSON.parse(event.data).type === 'cursor'; } catch { return false; }
  });
  const finalCursor = () => cursorEvents().find(event => {
    const payload = JSON.parse(event.data);
    return payload.x === 40 && payload.y === 60;
  });
  while (Date.now() < deadline && !finalCursor()) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(finalCursor(), 'the agent pointer endpoint must reach the dashboard');
  assert.ok(cursorEvents().length >= 2, 'the dashboard should see progressive cursor movement');
  agent.close();

  reader.cancel().catch(() => undefined);
  await pump;
});
