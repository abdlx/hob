// Manager-level behaviour against a real Chromium: lazy start, idle shutdown,
// crash recovery, and the persistence guarantee that makes the whole feature
// worth having — a bot's logins and page state survive the browser being stopped
// and started again.
//
// The persistence case deliberately writes to a *real* HTTP origin on loopback,
// because `localStorage` and cookies are unavailable on `data:` URLs and a test
// that passes on a `data:` URL would prove nothing about a real site.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { BrowserRegistry } from '../browser-registry.mjs';
import { BrowserManager } from '../browser-manager.mjs';

const dataUrl = html => `data:text/html,${encodeURIComponent(html)}`;

async function waitFor(check, { timeoutMs = 20000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for a browser condition.');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

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
  socket.on('close', () => failAll('The CDP connection closed before the command was answered.'));
  socket.on('error', error => failAll(`The CDP connection failed: ${error.message}`));
  return {
    ready: new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }),
    call(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No reply to ${method}.`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function agentClient(session) {
  const version = await (await fetch(`${session.cdpUrl}/json/version`)).json();
  const raw = openRawCdp(version.webSocketDebuggerUrl);
  await raw.ready;
  const targets = await raw.call('Target.getTargets');
  const page = targets.result.targetInfos.find(info => info.type === 'page');
  assert.ok(page, 'the managed browser must expose a page target');
  const attached = await raw.call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const sessionId = attached.result.sessionId;
  return {
    raw,
    targetId: page.targetId,
    sessionId,
    /** Evaluate and unwrap, so a CDP error fails the test instead of reading `undefined`. */
    async evaluate(expression) {
      const message = await raw.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (message.error) throw new Error(`Runtime.evaluate was refused: ${message.error.message}`);
      if (message.result?.exceptionDetails) throw new Error(`Runtime.evaluate threw: ${message.result.exceptionDetails.text}`);
      return message.result?.result?.value;
    },
    navigate: url => raw.call('Page.navigate', { url }, sessionId),
  };
}

/**
 * Read the page title through an *observational* command. This survives the
 * navigation that replaces the execution context, which `Runtime.evaluate` does
 * not, and it works during a takeover as well.
 */
async function titleOf(agent) {
  const targets = await agent.raw.call('Target.getTargets');
  return targets.result?.targetInfos?.find(info => info.targetId === agent.targetId)?.title;
}

async function createViewer(session) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  const received = [];
  client.on('message', (data, isBinary) => { if (!isBinary) received.push(JSON.parse(data.toString('utf8'))); });
  const [socket] = await once(server, 'connection');
  session.attachViewer(socket);
  await waitFor(() => received.some(message => message.t === 'hello'));
  return {
    received,
    close() { try { client.close(); } catch { /* already closed */ } try { server.close(); } catch { /* already closed */ } },
  };
}

/** A loopback page server, so the browser has a real origin to store state on. */
async function pageServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Persist</title><p>seed</p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections?.(); server.close(); } };
}

async function startManager(t, { idleMs = 1500, agentWaitMs = 2500 } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'hob-browser-manager-'));
  const registry = await BrowserRegistry.open({ stateDir });
  const manager = await BrowserManager.open({ registry, stateDir, options: { idleMs, agentWaitMs, maxFps: 10 } });
  t.after(async () => {
    await manager.shutdown();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { manager, registry, stateDir };
}

test('manager: nothing is launched until a bot actually needs a browser', async t => {
  const { manager } = await startManager(t);
  const status = await manager.status('alpha');
  assert.equal(status.state, 'stopped', 'a configured bot must not have a browser running');
  assert.equal(manager.session('alpha'), null, 'no session object exists before first use');
  // Listing activity must not start one either: watching a bot is not using it.
  const unsubscribe = await manager.activity('alpha', () => undefined);
  assert.equal(manager.session('alpha').running, false, 'subscribing must not launch a browser');
  unsubscribe();
});

test('manager: concurrent first use shares one session and one endpoint', async t => {
  const { manager } = await startManager(t);
  const sessions = await Promise.all(Array.from({ length: 8 }, () => manager.ensureEndpoint('alpha')));
  assert.equal(new Set(sessions).size, 1);
  assert.equal(sessions[0], manager.session('alpha'));
});

test('manager: a removed session cannot reopen its old browser endpoint', async t => {
  const { manager, registry } = await startManager(t);
  const session = await manager.ensureEndpoint('alpha');
  await manager.remove('alpha');
  assert.equal(registry.get('alpha'), null);
  await assert.rejects(session.start(), /has been removed/);
  await assert.rejects(session.ensureGateway(), /has been removed/);
});

test('manager: an idle browser is shut down, and a watched one is kept', async t => {
  const { manager } = await startManager(t, { idleMs: 1200 });
  const session = await manager.ensure('alpha');
  assert.equal(session.status().state, 'running');

  // Too early: the browser is idle, but not idle *enough*.
  await manager.sweep();
  assert.equal(session.status().state, 'running', 'a browser must not be stopped before the idle window elapses');

  // A viewer is a reason to stay up, even when nothing else is happening.
  const viewer = await createViewer(session);
  await new Promise(resolve => setTimeout(resolve, 1600));
  await manager.sweep();
  assert.equal(session.status().state, 'running', 'a watched browser must never be reaped');

  viewer.close();
  await waitFor(() => session.viewerCount === 0);
  await new Promise(resolve => setTimeout(resolve, 1600));
  await manager.sweep();
  assert.equal(session.status().state, 'stopped', 'the browser must idle down once nobody is watching');
  assert.equal(session.viewerCount, 0);
  // The session record outlives the browser, so the URL a bot was told to use
  // does not change out from under it.
  assert.match(session.cdpUrl, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}$/);
});

test('manager: a quiet browser is reaped even while an agent is connected', async t => {
  const { manager } = await startManager(t, { idleMs: 1200 });
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());

  // agent-browser keeps a daemon connection to the browser open indefinitely. A
  // connection is not use; a command is. Counting connections would mean the idle
  // shutdown never fires in real use.
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(session.hasWork(), false, 'an idle agent connection is not work');
  await manager.sweep();
  assert.equal(session.status().state, 'stopped', 'a browser nobody is using must idle down');
});

test('manager: an agent mid-command keeps the browser alive', async t => {
  const { manager } = await startManager(t, { idleMs: 1200 });
  const session = await manager.ensure('alpha');

  const admission = await session.lease.enterAgentMutation({ waitMs: 1000 });
  assert.equal(admission.ok, true, 'the agent must be admitted while it holds control');
  try {
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(session.hasWork(), true, 'a command in flight is work');
    await manager.sweep();
    assert.equal(session.status().state, 'running', 'a browser must not be pulled out from under a command');
  } finally {
    admission.release();
  }
});

test('manager: a crashed browser restarts only while somebody is watching', async t => {
  const { manager } = await startManager(t, { idleMs: 60000 });
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());

  // An unwatched crash is reported, not fought: restarting would burn a browser
  // nobody is looking at.
  const version = await (await fetch(`${session.cdpUrl}/json/version`)).json();
  const killer = openRawCdp(version.webSocketDebuggerUrl);
  await killer.ready;
  await killer.call('Browser.close');
  await waitFor(() => session.status().state !== 'running');
  assert.match(session.status().lastError ?? '', /exited/i);
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(session.status().state, 'stopped', 'an unwatched browser must stay down after a crash');

  // A watched one is brought back, because a blank panel is not an answer.
  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  await waitFor(() => session.status().state === 'running', { timeoutMs: 20000 });
  const restarted = await agentClient(session);
  t.after(() => restarted.raw.close());
  // The restarted browser is genuinely drivable, not just a live process: it
  // accepts a navigation and reports the new page back.
  await restarted.navigate(dataUrl('<title>BACK</title>'));
  await waitFor(async () => (await titleOf(restarted)) === 'BACK');
  assert.equal(session.status().lastError, null, 'a successful restart clears the crash report');
});

/** Chromium processes still alive on a profile: the only proof that a browser really died. */
function browsersOn(profileDir) {
  if (process.platform === 'win32') {
    const script = '(Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | '
      + `Where-Object { $_.CommandLine -like '*${profileDir}*' }).Count`;
    const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    return Number(out.trim()) || 0;
  }
  const out = spawnSync('pgrep', ['-f', profileDir], { encoding: 'utf8' }).stdout ?? '';
  return out.trim() ? out.trim().split('\n').length : 0;
}

test('manager: a browser that starts while a stop is in flight is not left behind', async t => {
  const { manager } = await startManager(t, { idleMs: 60000 });
  // A session, and its endpoint, without a browser: this is what `configureBrowser`
  // leaves behind before anything connects.
  await manager.ensureEndpoint('alpha');
  const session = manager.session('alpha');
  const profileDir = session.status().profileDir;
  assert.ok(session, 'the endpoint binds a session');
  assert.equal(session.status().state, 'stopped');

  // The race that used to leak a browser: the first connection starts it
  // asynchronously, and the idle policy (or a host shutdown) stops it before the
  // launch lands. The launch had not been recorded yet, so the stop found nothing
  // to kill and the browser came up after the stop had finished.
  const launching = session.start();
  await manager.stop('alpha', { reason: 'idle' });

  const outcome = await launching.then(() => 'started', error => `refused: ${error.message}`);
  assert.match(outcome, /refused: .*stopped while it was starting/,
    'a launch invalidated by a stop must not report success');
  await waitFor(() => browsersOn(profileDir) === 0, { timeoutMs: 20000 });
  assert.equal(browsersOn(profileDir), 0, 'the invalidated launch must not leave a process behind');
  assert.equal(session.status().state, 'stopped');
  assert.equal(session.status().chromiumPort, null);
  // The kill belongs to the stop, so it must not be reported as a crash.
  assert.equal(session.status().lastError, null);
});

test('manager: a bot keeps its logins, cookies and page state across a shutdown', async t => {
  const pages = await pageServer();
  t.after(() => pages.close());
  const { manager, registry, stateDir } = await startManager(t, { idleMs: 1000 });

  const first = await manager.ensure('alpha');
  const agent = await agentClient(first);
  await agent.navigate(`${pages.origin}/seed`);
  await waitFor(async () => (await titleOf(agent)) === 'Persist');
  // Both durable cookies and page storage, because those are what "the bot is
  // still signed in" actually consists of.
  //
  // A plain *session* cookie is asserted too: browsers drop those on exit unless
  // they are told to restore the last session, which the launcher now does with
  // `--restore-last-session`. Session cookies are a real login mechanism, so a
  // bot that comes back signed out would be the whole feature failing.
  await agent.evaluate(`localStorage.setItem('hob', 'kept'); document.cookie = 'hob=kept; path=/; Max-Age=86400'; document.cookie = 'sess=kept; path=/'; 'ok'`);
  const snapshot = `localStorage.getItem('hob') + '|' + document.cookie.split('; ').sort().join('; ')`;
  const before = await agent.evaluate(snapshot);
  assert.equal(before, 'kept|hob=kept; sess=kept');
  const extra = await agent.raw.call('Target.createTarget', { url: `${pages.origin}/second` });
  assert.ok(extra.result?.targetId);
  await waitFor(async () => {
    const targets = await agent.raw.call('Target.getTargets');
    return targets.result.targetInfos.some(info => info.url === `${pages.origin}/second` && info.title === 'Persist');
  });
  agent.raw.close();

  // Idle all the way down: no viewers, no agent, past the window.
  await new Promise(resolve => setTimeout(resolve, 1400));
  await manager.sweep();
  assert.equal(first.status().state, 'stopped');
  assert.equal(first.status().lastError, null, 'an idle shutdown is not a crash');

  // The same bot comes back on the same profile, with the same CDP URL.
  const second = await manager.ensure('alpha');
  assert.equal(second.cdpUrl, first.cdpUrl, 'the bot URL must be stable across restarts');
  const resumed = await agentClient(second);
  t.after(() => resumed.raw.close());
  const restarted = await resumed.raw.call('Target.getTargets');
  const restoredUrls = restarted.result.targetInfos.filter(info => info.type === 'page').map(info => info.url);
  assert.ok(restoredUrls.includes(`${pages.origin}/seed`), 'the first tab must survive a restart');
  assert.ok(restoredUrls.includes(`${pages.origin}/second`), 'additional tabs must survive a restart');
  assert.equal(restoredUrls.length, 2, 'restarting must not accumulate extra launch tabs');
  await resumed.navigate(`${pages.origin}/again`);
  await waitFor(async () => (await titleOf(resumed)) === 'Persist');
  const after = await resumed.evaluate(snapshot);
  assert.equal(after, 'kept|hob=kept; sess=kept', 'stored state must survive the browser being stopped and started');

  // Reopening the registry from disk must yield the same identity, so the value
  // written into the bot's Hermes profile is never invalidated by a HOB restart.
  const reopened = await BrowserRegistry.open({ stateDir });
  const record = await reopened.getOrCreate('alpha');
  assert.equal(record.gatewayPort, registry.get('alpha').gatewayPort);
  assert.equal(record.gatewayToken, registry.get('alpha').gatewayToken);
  assert.equal(record.browserProfileId, registry.get('alpha').browserProfileId);
});

test('manager: two bots never share a browser process or a profile', async t => {
  const pages = await pageServer();
  t.after(() => pages.close());
  const { manager, registry } = await startManager(t, { idleMs: 60000 });
  const alpha = await manager.ensure('alpha');
  const beta = await manager.ensure('beta');
  assert.notEqual(alpha.cdpUrl, beta.cdpUrl, 'each bot needs its own gateway credential and port');
  assert.notEqual(alpha.status().profileDir, beta.status().profileDir, 'each bot needs its own user-data directory');
  assert.match(alpha.status().profileDir, new RegExp(registry.get('alpha').browserProfileId));
  assert.match(beta.status().profileDir, new RegExp(registry.get('beta').browserProfileId));

  const agentAlpha = await agentClient(alpha);
  const agentBeta = await agentClient(beta);
  t.after(() => { agentAlpha.raw.close(); agentBeta.raw.close(); });

  await agentAlpha.evaluate(`document.title = 'ALPHA-ONLY'`);
  const betaTitle = await waitFor(async () => {
    const targets = await agentBeta.raw.call('Target.getTargets');
    return targets.result.targetInfos.find(info => info.targetId === agentBeta.targetId)?.title;
  });
  assert.notEqual(betaTitle, 'ALPHA-ONLY', 'one bot must never see another bot’s page');

  await Promise.all([agentAlpha.navigate(`${pages.origin}/alpha`), agentBeta.navigate(`${pages.origin}/beta`)]);
  await waitFor(async () => (await titleOf(agentAlpha)) === 'Persist' && (await titleOf(agentBeta)) === 'Persist');
  await agentAlpha.evaluate(`localStorage.setItem('owner', 'alpha'); document.cookie = 'owner=alpha; path=/; Max-Age=86400'; 'ok'`);
  assert.equal(await agentBeta.evaluate(`localStorage.getItem('owner')`), null,
    'beta must not read alpha localStorage');
  assert.equal(await agentBeta.evaluate(`document.cookie.includes('owner=alpha')`), false,
    'beta must not read alpha cookies');

  // Stopping one leaves the other running: windows do not idle out together.
  await manager.stop('alpha', { reason: 'idle' });
  assert.equal(alpha.status().state, 'stopped');
  assert.equal(beta.status().state, 'running');
});

test('manager: stopping one bot does not stop another bot’s viewers', async t => {
  const { manager } = await startManager(t, { idleMs: 60000 });
  const alpha = await manager.ensure('alpha');
  const beta = await manager.ensure('beta');
  const watched = await createViewer(beta);
  t.after(() => watched.close());

  await manager.stop('alpha', { reason: 'idle' });
  assert.equal(alpha.status().state, 'stopped');
  assert.equal(beta.status().state, 'running');
  assert.ok(!watched.received.some(message => message.t === 'bye'), 'an unrelated shutdown must not close this viewer');
});
