// Load and reliability: the browser subsystem under the conditions it will
// actually meet.
//
// The other browser tests answer "is it correct?". These answer "does it stay
// correct when there are eight people watching, one of them on a bad connection,
// when tabs open and close in a loop, when the browser idles down and comes back
// three times over, and when Chromium dies mid-stream?". Every assertion is about
// observable behaviour: frames delivered, viewers counted, state reaching
// `stopped`, the same endpoint returning, storage surviving, no leaked process.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../app.mjs';
import { BrowserRegistry } from '../browser-registry.mjs';
import { BrowserManager } from '../browser-manager.mjs';

const PASSWORD = 'correct horse battery staple';
const PROFILE = 'alpha';

function stubGateway() {
  return { kind: 'other', connected: false, on() {}, request: async () => ({}), start() {}, stop() {} };
}

async function waitFor(check, { timeoutMs = 30000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for a browser condition.');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

async function startApp(t, { idleMs = 60000, maxFps = 10, sweepMs } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'hob-browser-load-'));
  const registry = await BrowserRegistry.open({ stateDir });
  const manager = await BrowserManager.open({
    registry, stateDir,
    options: { idleMs, maxFps, agentWaitMs: 2000, ...(sweepMs ? { sweepMs } : {}) },
  });
  const app = createApp({
    gateway: stubGateway(),
    bots: {
      list: async () => ({ profiles: [{ name: PROFILE }] }),
      has: name => name === PROFILE,
      token: () => 'x'.repeat(32),
    },
    browser: manager,
    password: PASSWORD,
    stateDir,
    staticDir: join(stateDir, 'no-such-static-dir'),
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    // Browser first: `session.stop()` closes every viewer and agent socket. An
    // HTTP server will not finish closing while upgraded sockets are attached, so
    // doing this in the other order hangs teardown instead of ending it.
    await manager.shutdown();
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5000);
      timer.unref?.();
      app.close(() => { clearTimeout(timer); resolve(); });
      app.closeAllConnections?.();
    });
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const probe = await manager.probe();
  if (!probe.ready) { t.skip('No Chromium-family browser is installed on this host.'); return null; }
  return { app, manager, origin, stateDir };
}

async function signIn(origin) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}

/** The page every viewer watches: something that changes on every animation frame. */
const ANIMATION = `data:text/html,${encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#111">
<canvas id="c" width="640" height="360"></canvas>
<script>
const c = document.getElementById('c').getContext('2d');
let tick = 0;
function draw() {
  tick += 1;
  c.fillStyle = 'hsl(' + (tick % 360) + ',80%,45%)';
  c.fillRect(0, 0, 640, 360);
  c.fillStyle = '#fff';
  c.fillRect((tick * 7) % 560, 120, 80, 80);
  requestAnimationFrame(draw);
}
draw();
</script></body></html>`)}`;

/** A raw CDP client for the agent side: the same wire Hermes' tools use. */
function openRawCdp(url) {
  const socket = new WebSocket(url, { maxPayload: 0, perMessageDeflate: false });
  const pending = new Map();
  let nextId = 1;
  const failAll = reason => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    pending.clear();
  };
  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString('utf8')); } catch { return; }
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  });
  socket.on('close', () => failAll('The CDP connection closed.'));
  socket.on('error', error => failAll(`The CDP connection failed: ${error.message}`));
  return {
    ready: new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }),
    call(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No reply to ${method}.`)); }, 20000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* already gone */ } },
  };
}

async function agentFor(session) {
  const version = await (await fetch(`${session.cdpUrl}/json/version`)).json();
  const raw = openRawCdp(version.webSocketDebuggerUrl);
  await raw.ready;
  const targets = await raw.call('Target.getTargets');
  const page = targets.result.targetInfos.find(info => info.type === 'page');
  const attached = await raw.call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const sessionId = attached.result.sessionId;
  return {
    raw,
    sessionId,
    evaluate: expression => raw.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId),
    navigate: async url => {
      await raw.call('Page.navigate', { url }, sessionId);
    },
    close: () => raw.close(),
  };
}

/** A dashboard viewer: mint a ticket, upgrade, count frames. */
async function openViewer(origin, cookie) {
  const stream = origin.replace('http:', 'ws:') + '/api/hermes/browser/stream';
  const ticket = await (await fetch(`${origin}/api/hermes/browser/viewer?profile=${PROFILE}`, {
    method: 'POST', headers: { Cookie: cookie },
  })).json();
  const socket = new WebSocket(`${stream}?profile=${PROFILE}&token=${ticket.viewerToken}`);
  let hello = null;
  let frames = 0;
  const errors = [];
  const messages = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) { frames += 1; return; }
    try {
      const message = JSON.parse(data.toString('utf8'));
      messages.push(message);
      if (message.t === 'hello') hello = message;
    } catch { /* a malformed frame is a failure for the sender, not for this counter */ }
  });
  socket.on('error', error => errors.push(error));

  const opened = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 15000);
    timer.unref?.();
    socket.once('open', () => { clearTimeout(timer); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
    socket.once('close', () => { clearTimeout(timer); resolve(false); });
  });
  return {
    socket, errors, messages,
    get hello() { return hello; },
    get frames() { return frames; },
    get open() { return opened; },
    close() { try { socket.close(); } catch { /* already gone */ } },
    /** Stop reading: the socket's receive buffer fills, like a stalled tab. */
    stall() { socket._socket?.pause(); },
    resume() { socket._socket?.resume(); },
  };
}

async function openViewers(origin, cookie, count) {
  const viewers = await Promise.all(Array.from({ length: count }, () => openViewer(origin, cookie)));
  for (const viewer of viewers) {
    if (!viewer.open) throw new Error(`viewer refused: ${viewer.errors[0]?.message || 'no reason'}`);
  }
  await waitFor(() => viewers.every(viewer => viewer.hello));
  return viewers;
}

/** Size of the profile on disk, and the biggest thing in it. */
async function profileSize(dir) {
  let total = 0;
  let files = 0;
  const sizes = new Map();
  const walk = async current => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      try {
        const info = await stat(path);
        total += info.size;
        files += 1;
        sizes.set(entry.name, (sizes.get(entry.name) || 0) + info.size);
      } catch { /* removed while walking */ }
    }
  };
  await walk(dir);
  const largest = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([name, size]) => `${name}=${Math.round(size / 1024)}K`);
  return { total, files, largest };
}

/** Kill the browser tree by profile directory: a crash, not a shutdown. */
function crashBrowser(profileDir) {
  if (process.platform === 'win32') {
    const escaped = profileDir.replace(/'/g, "''");
    const script = '$p = @(Get-CimInstance Win32_Process | '
      + `Where-Object { $_.Name -match '^(chrome|chromium)' -and $_.CommandLine -like '*${escaped}*' } | `
      + 'ForEach-Object { $_.ProcessId }); $p -join ","';
    const result = String(spawnSync('powershell', ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true }).stdout || '').trim();
    const pids = result.split(',').filter(Boolean);
    for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return pids.length;
  }
  const tree = String(spawnSync('pgrep', ['-f', profileDir], { encoding: 'utf8' }).stdout || '').trim();
  const pids = tree.split(/\s+/).filter(Boolean);
  for (const pid of pids) spawnSync('kill', ['-9', pid], { stdio: 'ignore' });
  return pids.length;
}

test('load: eight viewers watch one browser at once', async t => {
  const started = await startApp(t, { maxFps: 10 });
  if (!started) return;
  const { origin, manager } = started;
  const cookie = await signIn(origin);
  const session = await manager.ensure(PROFILE);
  const agent = await agentFor(session);
  t.after(() => agent.close());

  await agent.navigate(ANIMATION);
  const viewers = await openViewers(origin, cookie, 8);
  t.after(() => viewers.forEach(viewer => viewer.close()));

  assert.equal(session.status().viewers, 8);
  await waitFor(() => viewers.every(viewer => viewer.frames > 0), { timeoutMs: 25000 });
  const afterFirst = viewers.map(viewer => viewer.frames);

  // All eight are on the same page and keep receiving frames; nobody was starved.
  await waitFor(() => viewers.every((viewer, index) => viewer.frames > afterFirst[index]), { timeoutMs: 25000 });
  t.diagnostic(`frames per viewer: ${viewers.map(viewer => viewer.frames).join(', ')}`);

  // The ninth is refused before it is ever attached, and the eight are untouched.
  const ninth = await openViewer(origin, cookie);
  assert.equal(ninth.open, false, 'a ninth viewer must not be accepted');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(session.status().viewers, 8);
  assert.ok(viewers.every(viewer => viewer.hello), 'existing viewers kept their session');
});

test('load: a stalled viewer does not slow the others, or the agent', async t => {
  const started = await startApp(t, { maxFps: 12 });
  if (!started) return;
  const { origin, manager } = started;
  const cookie = await signIn(origin);
  const session = await manager.ensure(PROFILE);
  const agent = await agentFor(session);
  t.after(() => agent.close());

  await agent.navigate(ANIMATION);
  const viewers = await openViewers(origin, cookie, 3);
  t.after(() => viewers.forEach(viewer => { viewer.resume(); viewer.close(); }));
  await waitFor(() => viewers.every(viewer => viewer.frames > 0), { timeoutMs: 25000 });

  // One tab stops reading entirely. Frames for it pile up in its socket buffer;
  // the other two must not notice, and the browser must stay commandable.
  const [slow, first, second] = viewers;
  slow.stall();
  const baseline = [first.frames, second.frames];

  await waitFor(() => first.frames > baseline[0] && second.frames > baseline[1], { timeoutMs: 25000 });
  const answered = await agent.evaluate('document.querySelectorAll("canvas").length');
  assert.equal(answered.result?.result?.value, 1, 'the agent still drives the page');
  assert.equal(session.status().viewers, 3);

  slow.resume();
  const recovered = slow.frames;
  await waitFor(() => slow.frames > recovered, { timeoutMs: 25000 });
  t.diagnostic(`stalled viewer resumed at frame ${recovered} and kept going`);
});

test('load: viewers can come and go without leaking sessions or the browser', async t => {
  const started = await startApp(t, { maxFps: 10 });
  if (!started) return;
  const { origin, manager } = started;
  const cookie = await signIn(origin);
  const session = await manager.ensure(PROFILE);
  const agent = await agentFor(session);
  t.after(() => agent.close());
  await agent.navigate(ANIMATION);

  // Twenty short-lived panels, one after another, is what a dashboard left open
  // on a wobbly connection looks like.
  for (let index = 0; index < 20; index += 1) {
    const viewer = await openViewer(origin, cookie);
    assert.equal(viewer.open, true, `viewer ${index} should be accepted`);
    viewer.close();
    // Wait for the *server* to count the departure before the next arrival, so
    // this tests churn rather than racing the eight-viewer cap.
    await waitFor(() => session.status().viewers === 0, { timeoutMs: 10000, intervalMs: 20 });
  }
  await waitFor(() => session.status().viewers === 0, { timeoutMs: 20000 });

  // The browser is still there, and still streams.
  const fresh = await openViewers(origin, cookie, 1);
  t.after(() => fresh.forEach(viewer => viewer.close()));
  await waitFor(() => fresh[0].frames > 0, { timeoutMs: 25000 });
  assert.equal(session.status().state, 'running');
});

test('load: three idle shutdowns in a row keep the same endpoint and the same session state', async t => {
  // A short idle window so the test is about repetition, not patience.
  const started = await startApp(t, { idleMs: 900, sweepMs: 200, maxFps: 5 });
  if (!started) return;
  const { manager } = started;

  // A real origin: `localStorage` on a `data:` URL is per-document (opaque
  // origin) and would never prove anything about a persistent profile.
  const site = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<title>CYCLES</title><h1>${request.url}</h1>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  t.after(() => site.close());
  const url = `http://127.0.0.1:${site.address().port}/`;

  const first = await manager.ensure(PROFILE);
  const endpoint = first.cdpUrl;
  const profileDir = first.status().profileDir;
  const before = await profileSize(profileDir);
  const sizes = [];

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const session = await manager.ensure(PROFILE);
    const agent = await agentFor(session);
    await agent.navigate(url);
    await waitFor(async () => (await agent.evaluate('document.title')).result?.result?.value === 'CYCLES',
      { timeoutMs: 10000 });
    await agent.evaluate(`localStorage.setItem('cycles', '${cycle}')`);
    agent.close();

    // Nobody is watching and the agent connection is closed: HOB must shut it
    // down by itself, and the state must say so.
    await waitFor(() => manager.session(PROFILE)?.status().state === 'stopped', { timeoutMs: 20000 });
    const size = await profileSize(profileDir);
    sizes.push(size.total);

    const restarted = await manager.ensure(PROFILE);
    assert.equal(restarted.cdpUrl, endpoint, 'the same endpoint comes back');
    const again = await agentFor(restarted);
    await again.navigate(url);
    await waitFor(async () => (await again.evaluate('document.title')).result?.result?.value === 'CYCLES',
      { timeoutMs: 10000 });
    const stored = await again.evaluate("localStorage.getItem('cycles')");
    assert.equal(stored.result?.result?.value, String(cycle), 'profile state survives the shutdown');
    again.close();
  }

  const after = await profileSize(profileDir);
  t.diagnostic(`profile ${Math.round(before.total / 1024)}K -> ${Math.round(after.total / 1024)}K `
    + `(${after.files} files); after each cycle: ${sizes.map(size => `${Math.round(size / 1024)}K`).join(' -> ')}`);
  t.diagnostic(`largest files: ${after.largest.join(' ')}`);

  // Three restarts are not an excuse for unbounded growth. A restart adds a
  // little (a Preferences rewrite, a session file); it must not add a profile.
  const growth = after.total - before.total;
  assert.ok(growth < 30 * 1024 * 1024,
    `the profile grew by ${Math.round(growth / 1024)}K over three restarts`);
});

test('load: a crash under a watching viewer is reported and the browser comes back', async t => {
  const started = await startApp(t, { maxFps: 10, idleMs: 60000 });
  if (!started) return;
  const { origin, manager } = started;
  const cookie = await signIn(origin);
  const session = await manager.ensure(PROFILE);
  const endpoint = session.cdpUrl;
  const agent = await agentFor(session);
  await agent.navigate(ANIMATION);
  const [viewer] = await openViewers(origin, cookie, 1);
  t.after(() => viewer.close());
  await waitFor(() => viewer.frames > 0, { timeoutMs: 25000 });

  // The agent's socket dies with the browser; the viewer does not.
  let viewerClosed = false;
  viewer.socket.once('close', () => { viewerClosed = true; });
  const killed = crashBrowser(session.status().profileDir);
  assert.ok(killed > 0, 'the crash must actually kill a browser process');
  agent.close();

  await waitFor(() => viewer.messages.some(message => message.t === 'error' && message.code === 'browser_crashed'),
    { timeoutMs: 20000 });
  assert.equal(viewerClosed, false, 'a watched viewer is kept, so it can see the recovery');

  // Somebody is watching, so the crash is repaired rather than left for later.
  await waitFor(() => session.status().state === 'running', { timeoutMs: 30000 });
  assert.equal(session.cdpUrl, endpoint, 'the endpoint does not change across a crash');

  // The restarted browser accepts the agent again, and the same viewer gets the
  // new page's frames without having to reconnect.
  const again = await agentFor(session);
  t.after(() => again.close());
  const before = viewer.frames;
  await again.navigate(ANIMATION);
  await waitFor(() => viewer.frames > before, { timeoutMs: 30000 });
  t.diagnostic(`viewer survived the crash and resumed at frame ${viewer.frames}`);

  assert.ok(crashBrowser(session.status().profileDir) > 0);
  again.close();
  await waitFor(() => viewer.messages.filter(message => message.t === 'error' && message.code === 'browser_crashed').length === 2,
    { timeoutMs: 20000 });
  await waitFor(() => session.status().state === 'running', { timeoutMs: 30000 });
  const recovered = await agentFor(session);
  t.after(() => recovered.close());
  const framesBeforeRecovery = viewer.frames;
  await recovered.navigate(ANIMATION);
  await waitFor(() => viewer.frames > framesBeforeRecovery, { timeoutMs: 30000 });
  assert.equal(viewerClosed, false);
  assert.equal(session.cdpUrl, endpoint);
});
