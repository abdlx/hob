// Integration tests against a real Chromium.
//
// The load-bearing case is "raw CDP cannot mutate the page while a human holds
// control": the agent connection here is a plain WebSocket speaking raw CDP,
// which is exactly what Hermes' `browser_cdp` tool opens. Nothing is mocked
// except the viewer's transport, which is a local WebSocket so the test can
// drive the same server-side code path HOB's HTTP layer drives in production.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
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

/** A raw CDP client: the same wire shape Hermes' browser_cdp uses. */
function openRawCdp(url) {
  const socket = new WebSocket(url, { maxPayload: 0, perMessageDeflate: false });
  const pending = new Map();
  let nextId = 1;
  const failAll = reason => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    pending.clear();
  };
  // The listener must exist before the first reply: `ws` discards messages that
  // arrive while a socket has no `message` handler.
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
        const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
        socket.send(JSON.stringify(message));
      });
    },
    close() { socket.close(); },
    get open() { return socket.readyState === WebSocket.OPEN; },
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
  return { raw, targetId: page.targetId, sessionId: attached.result.sessionId };
}

const evaluate = (agent, expression) =>
  agent.raw.call('Runtime.evaluate', { expression, returnByValue: true }, agent.sessionId);

/** Read the title through an *observational* command, so it works during takeover too. */
async function titleOf(agent) {
  const targets = await agent.raw.call('Target.getTargets');
  return targets.result?.targetInfos?.find(info => info.targetId === agent.targetId)?.title;
}

/** A viewer is just an authenticated socket handed to the session, as HOB's HTTP layer does. */
async function createViewer(session) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  const received = [];
  let binaryFrames = 0;
  client.on('message', (data, isBinary) => {
    if (isBinary) { binaryFrames += 1; return; }
    received.push(JSON.parse(data.toString('utf8')));
  });
  const [socket] = await once(server, 'connection');
  const viewer = session.attachViewer(socket);
  return {
    viewer, received,
    get binaryFrames() { return binaryFrames; },
    send: message => client.send(JSON.stringify(message)),
    close() { client.close(); server.close(); },
    hello: () => received.find(message => message.t === 'hello'),
  };
}

async function startManager(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'hob-browser-gateway-'));
  const registry = await BrowserRegistry.open({ stateDir });
  const manager = await BrowserManager.open({
    registry, stateDir,
    // A short-but-real lease wait, and a fast frame rate, so the tests exercise
    // the queueing/draining paths without waiting on production timings.
    options: { agentWaitMs: 2500, maxFps: 10, idleMs: 2000 },
  });
  t.after(async () => {
    await manager.shutdown();
    // Chromium can still hold its profile lockfile for a moment after exit.
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const probe = await manager.probe();
  if (!probe.ready) { t.skip('No Chromium-family browser is installed on this host.'); return null; }
  return { manager, stateDir, registry };
}

test('gateway: the CDP endpoint is token-scoped and loopback-only', async t => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const port = new URL(session.cdpUrl).port;
  const token = new URL(session.cdpUrl).pathname.slice(1);

  const authorized = await fetch(`${session.cdpUrl}/json/version`);
  assert.equal(authorized.status, 200);
  const version = await authorized.json();
  assert.match(version.Browser, /^HOB-Gateway\//);
  assert.match(version.webSocketDebuggerUrl,
    new RegExp(`^ws://127\\.0\\.0\\.1:${port}/${token}/devtools/browser/`));

  // A caller without this bot's token learns nothing, and the gateway only
  // accepts the methods the DevTools discovery contract uses.
  assert.equal((await fetch(`http://127.0.0.1:${port}/json/version`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/not-the-token/json/version`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/${token}/json/nope`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/${token}/json/version`, { method: 'DELETE' })).status, 405);

  const upgrade = await new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/x`);
    socket.once('open', () => { socket.close(); resolve('opened'); });
    socket.once('error', () => resolve('refused'));
    socket.once('close', () => resolve('refused'));
  });
  assert.equal(upgrade, 'refused');

  assert.equal(session.status().state, 'running');
});

test('gateway: raw CDP cannot mutate the page while a human holds control', async t => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());

  await agent.raw.call('Page.navigate', { url: dataUrl('<title>BEFORE</title><h1 id=x>before</h1>') }, agent.sessionId);
  await waitFor(async () => (await titleOf(agent)) === 'BEFORE');

  // Sanity: while the agent holds control, its mutations are forwarded verbatim.
  assert.equal((await evaluate(agent, `document.title='AGENT-OK'`)).error, undefined);
  await waitFor(async () => (await titleOf(agent)) === 'AGENT-OK');

  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  await waitFor(() => viewer.hello());
  viewer.send({ t: 'request_control' });
  await waitFor(() => session.status().control.holder === 'human');

  // 1. A raw Runtime.evaluate from the agent's own connection.
  const mutation = await evaluate(agent, `document.title='AGENT-HACK'`);
  assert.ok(mutation.error, 'the mutation must be refused');
  assert.equal(mutation.error.code, -32001);
  assert.match(mutation.error.message, /human operator/i);

  // 2. A raw navigation on the same connection.
  const navigation = await agent.raw.call('Page.navigate', { url: dataUrl('<title>AGENT-HACK</title>') }, agent.sessionId);
  assert.ok(navigation.error, 'navigation must be refused while the human holds control');

  // 3. A DOM write through the DOM domain.
  const domWrite = await agent.raw.call('DOM.setAttributeValue',
    { nodeId: 1, name: 'data-hacked', value: 'yes' }, agent.sessionId);
  assert.ok(domWrite.error, 'DOM mutations must be refused as well');

  // The page is genuinely untouched, verified without mutating it.
  assert.equal(await titleOf(agent), 'AGENT-OK');

  // Observation is preserved: watching is not controlling.
  const observed = await agent.raw.call('Target.getTargets');
  assert.equal(observed.error, undefined);
  const screenshot = await agent.raw.call('Page.captureScreenshot', {}, agent.sessionId);
  assert.equal(screenshot.error, undefined);

  // Hand back, and the identical mutation lands on the same live page.
  viewer.send({ t: 'release_control' });
  await waitFor(() => session.status().control.holder === 'agent');
  const retried = await evaluate(agent, `document.title='AGENT-AFTER'`);
  assert.equal(retried.error, undefined);
  await waitFor(async () => (await titleOf(agent)) === 'AGENT-AFTER');
});

test('gateway: a queued agent mutation resumes against the same page after handback', async t => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());

  await agent.raw.call('Page.navigate', { url: dataUrl('<title>QUEUE</title>') }, agent.sessionId);
  await waitFor(async () => (await titleOf(agent)) === 'QUEUE');

  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  await waitFor(() => viewer.hello());
  viewer.send({ t: 'request_control' });
  await waitFor(() => session.status().control.holder === 'human');

  // Issued while the human holds control: the gateway holds it, then releases it
  // once control comes back, rather than failing the agent outright.
  const queued = evaluate(agent, `document.title='QUEUED-OK'`);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(await titleOf(agent), 'QUEUE', 'nothing may change while the human holds control');

  viewer.send({ t: 'release_control' });
  const result = await queued;
  assert.equal(result.error, undefined, 'the queued command resumes rather than failing');
  await waitFor(async () => (await titleOf(agent)) === 'QUEUED-OK');
});

test('gateway: the viewer streams frames and drives the browser while in control', async t => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());

  await agent.raw.call('Page.navigate', { url: dataUrl('<title>WATCH</title>') }, agent.sessionId);
  await waitFor(async () => (await titleOf(agent)) === 'WATCH');

  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  const hello = await waitFor(() => viewer.hello());
  assert.equal(hello.sessionId, 'alpha');
  assert.equal(hello.control.holder, 'agent');
  assert.ok(hello.viewport.w > 0 && hello.viewport.h > 0);
  assert.equal(hello.viewport.w * 4, hello.viewport.h * 5, 'the managed browser viewport is 5:4');

  // Frames arrive as a JSON header followed by a binary JPEG.
  await waitFor(() => viewer.received.some(message => message.t === 'frame'));
  const frame = viewer.received.find(message => message.t === 'frame');
  assert.equal(frame.mime, 'image/jpeg');
  await waitFor(() => viewer.binaryFrames > 0);

  // A viewer that is not in control cannot navigate.
  viewer.send({ t: 'navigate', url: dataUrl('<title>VIEWER-NO</title>') });
  await waitFor(() => viewer.received.some(message => message.t === 'error' && message.code === 'agent_has_control'));
  assert.equal(await titleOf(agent), 'WATCH');

  // Take control and drive the same browser.
  viewer.send({ t: 'request_control' });
  await waitFor(() => session.status().control.holder === 'human');
  viewer.send({ t: 'navigate', url: dataUrl('<title>VIEWER-OK</title>') });
  await waitFor(async () => (await titleOf(agent)) === 'VIEWER-OK');

  // While the viewer drives, the agent is locked out.
  const refused = await evaluate(agent, `document.title='AGENT-NO'`);
  assert.ok(refused.error, 'the agent must not mutate while the viewer drives');

  // The viewer keeps a live view of the tab it navigated.
  await waitFor(() => viewer.received.some(message => message.t === 'navigate' && message.url.startsWith('data:text/html')));
  await waitFor(() => viewer.received.some(message => message.t === 'tabs' && message.tabs.length >= 1));
});

test('gateway: a viewer opened on the launch page follows the page the agent opens', async t => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());

  // This is the dashboard's normal order: the person opens the live view while
  // the browser is still on its launch page, before the bot does anything.
  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  await waitFor(() => viewer.hello());
  await waitFor(() => /^(?:about:blank|chrome:\/\/(?:newtab|new-tab-page)\/?)$/.test(session.status().url));
  const framesBefore = viewer.received.filter(message => message.t === 'frame').length;

  // The agent opens its work in a new tab instead of navigating the blank one.
  const created = await agent.raw.call('Target.createTarget', {
    url: dataUrl('<title>FOLLOWED</title><h1>the bot page</h1>'),
  });
  assert.ok(created.result?.targetId);
  await waitFor(() => session.status().tabs.some(tab => tab.title === 'FOLLOWED'));

  // The live view moves to that tab rather than staying white on about:blank.
  await waitFor(() => {
    const active = session.status().tabs.find(tab => tab.active);
    return active?.title === 'FOLLOWED';
  });
  assert.equal(session.status().title, 'FOLLOWED');
  assert.match(session.status().url, /^data:text\/html/);
  await waitFor(() => viewer.received.some(message => message.t === 'navigate' && message.url.startsWith('data:text/html')));
  await waitFor(() => session.status().tabs.find(tab => tab.active)?.id === created.result.targetId);
  await waitFor(() => viewer.received.filter(message => message.t === 'frame').length > framesBefore);
});

test('gateway: a background tab does not replace the page a viewer is watching', async t => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());

  await agent.raw.call('Page.navigate', { url: dataUrl('<title>WATCHED</title>') }, agent.sessionId);
  await waitFor(async () => (await titleOf(agent)) === 'WATCHED');

  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  await waitFor(() => viewer.hello());
  await waitFor(() => session.status().title === 'WATCHED');
  const watchedId = session.status().tabs.find(tab => tab.active)?.id;
  assert.ok(watchedId);

  // A second tab must not yank the view away from a page that is already real.
  await agent.raw.call('Target.createTarget', { url: dataUrl('<title>BACKGROUND</title>') });
  await waitFor(() => session.status().tabs.some(tab => tab.id !== watchedId));
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(session.status().tabs.find(tab => tab.active)?.id, watchedId);
  assert.equal(session.status().title, 'WATCHED');
  assert.match(session.status().url, /^data:text\/html/);
});

test('gateway: closing the watched tab moves the viewer to a surviving page', async t => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());

  await agent.raw.call('Page.navigate', { url: dataUrl('<title>FIRST</title>') }, agent.sessionId);
  await waitFor(async () => (await titleOf(agent)) === 'FIRST');

  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  await waitFor(() => viewer.hello());
  await waitFor(() => session.status().title === 'FIRST');

  await agent.raw.call('Target.createTarget', { url: dataUrl('<title>SECOND</title>') });
  await waitFor(() => session.status().tabs.some(tab => tab.title === 'SECOND'));

  // The agent closes the tab the person is watching. The stream must move to
  // the surviving page instead of freezing on its last frame.
  await agent.raw.call('Target.closeTarget', { targetId: agent.targetId });
  await waitFor(() => session.status().tabs.find(tab => tab.active)?.title === 'SECOND');
  assert.equal(session.status().title, 'SECOND');
  assert.equal(session.status().tabs.some(tab => tab.id === agent.targetId), false);
  await waitFor(() => viewer.received.some(message => message.t === 'navigate' && message.url.includes('SECOND')));
});

test('gateway: an agent creates multiple tabs and switches the live viewer between them', async t => {
  const started = await startManager(t);
  if (!started) return;
  const session = await started.manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());
  await agent.raw.call('Page.navigate', { url: dataUrl('<title>FIRST-TAB</title>') }, agent.sessionId);
  await waitFor(async () => (await titleOf(agent)) === 'FIRST-TAB');
  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  await waitFor(() => session.status().tabs.find(tab => tab.active)?.id === agent.targetId);

  const second = await agent.raw.call('Target.createTarget', { url: dataUrl('<title>SECOND-TAB</title>') });
  const third = await agent.raw.call('Target.createTarget', { url: dataUrl('<title>THIRD-TAB</title>') });
  await waitFor(() => session.status().tabs.length === 3);
  assert.equal((await agent.raw.call('Target.activateTarget', { targetId: second.result.targetId })).error, undefined);
  await waitFor(() => session.status().tabs.find(tab => tab.active)?.title === 'SECOND-TAB');

  const attached = await agent.raw.call('Target.attachToTarget', { targetId: third.result.targetId, flatten: true });
  const front = await agent.raw.call('Page.bringToFront', {}, attached.result.sessionId);
  assert.equal(front.error, undefined);
  await waitFor(() => session.status().tabs.find(tab => tab.active)?.title === 'THIRD-TAB');

  await agent.raw.call('Target.activateTarget', { targetId: agent.targetId });
  await waitFor(() => session.status().tabs.find(tab => tab.active)?.title === 'FIRST-TAB');
  assert.equal(session.status().tabs.length, 3);

  const activations = await Promise.all([
    agent.raw.call('Target.activateTarget', { targetId: second.result.targetId }),
    agent.raw.call('Target.activateTarget', { targetId: third.result.targetId }),
    agent.raw.call('Target.activateTarget', { targetId: agent.targetId }),
  ]);
  assert.ok(activations.every(reply => !reply.error));
  await waitFor(() => session.status().tabs.find(tab => tab.active)?.title === 'FIRST-TAB'
    && session.status().title === 'FIRST-TAB');
  await agent.raw.call('Target.closeTarget', { targetId: second.result.targetId });
  await agent.raw.call('Target.closeTarget', { targetId: third.result.targetId });
  // Closing both background tabs and re-deriving the active page are separate
  // status updates; wait for both so this does not race the tab list.
  await waitFor(() => session.status().tabs.length === 1 && session.status().title === 'FIRST-TAB');
  assert.equal(session.status().title, 'FIRST-TAB');
});

test('gateway: the last viewer leaving returns control to the agent', async t => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());

  const viewer = await createViewer(session);
  await waitFor(() => viewer.hello());
  viewer.send({ t: 'request_control' });
  await waitFor(() => session.status().control.holder === 'human');

  viewer.close();
  await waitFor(() => session.status().control.holder === 'agent');
  const result = await evaluate(agent, `document.title='AFTER-VIEWER-GONE'`);
  assert.equal(result.error, undefined);
  await waitFor(async () => (await titleOf(agent)) === 'AFTER-VIEWER-GONE');
  assert.equal(session.viewerCount, 0);
});

test('gateway: bots get separate ports, tokens, profiles and pages', async t => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const alpha = await manager.ensure('alpha');
  const beta = await manager.ensure('beta');

  assert.notEqual(alpha.cdpUrl, beta.cdpUrl);
  assert.notEqual(alpha.status().profileDir, beta.status().profileDir);
  assert.match(alpha.status().profileDir, /alpha/);
  assert.match(beta.status().profileDir, /beta/);

  // Alpha's credential must not open beta's endpoint, and vice versa.
  const alphaToken = new URL(alpha.cdpUrl).pathname.slice(1);
  const betaPort = new URL(beta.cdpUrl).port;
  const crossed = await fetch(`http://127.0.0.1:${betaPort}/${alphaToken}/json/version`);
  assert.equal(crossed.status, 404);

  const alphaAgent = await agentClient(alpha);
  const betaAgent = await agentClient(beta);
  t.after(() => { alphaAgent.raw.close(); betaAgent.raw.close(); });

  await alphaAgent.raw.call('Page.navigate', { url: dataUrl('<title>ALPHA-PAGE</title>') }, alphaAgent.sessionId);
  await waitFor(async () => (await titleOf(alphaAgent)) === 'ALPHA-PAGE');

  // Beta's browser is untouched by alpha's navigation.
  const betaTargets = await betaAgent.raw.call('Target.getTargets');
  assert.equal(betaTargets.result.targetInfos.some(info => info.title === 'ALPHA-PAGE'), false);
});

test('gateway: agent pointer jumps reach the page as trusted, progressive mouse events', async t => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());

  await agent.raw.call('Page.navigate', { url: dataUrl(`
    <title>POINTER</title>
    <script>
      window.pointerEvents = [];
      addEventListener('mousemove', event => pointerEvents.push({
        x: event.clientX, y: event.clientY, trusted: event.isTrusted
      }));
    </script>
  `) }, agent.sessionId);
  await waitFor(async () => (await titleOf(agent)) === 'POINTER');

  await agent.raw.call('Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: 800, y: 600, button: 'none', buttons: 0 }, agent.sessionId);
  const observed = await evaluate(agent, `({
    count: pointerEvents.length,
    trusted: pointerEvents.every(event => event.trusted),
    last: pointerEvents.at(-1)
  })`);
  assert.ok(observed.result?.result?.value.count >= 4, 'the page should receive a progressive trajectory');
  assert.equal(observed.result.result.value.trusted, true, 'CDP input must remain browser-trusted');
  assert.deepEqual(observed.result.result.value.last, { x: 800, y: 600, trusted: true });
});

test('gateway: direct CDP clicks move to the element, hover and hold before release', async t => {
  const started = await startManager(t);
  if (!started) return;
  const session = await started.manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());
  await agent.raw.call('Page.navigate', { url: dataUrl(`
    <title>CLICK-SEQUENCE</title>
    <button style="position:absolute;left:700px;top:500px;width:120px;height:80px">Target</button>
    <script>
      window.events = [];
      for (const type of ['mousemove', 'mouseover', 'mousedown', 'mouseup', 'click']) {
        addEventListener(type, event => events.push({
          type, x: event.clientX, y: event.clientY, time: event.timeStamp,
          trusted: event.isTrusted, target: event.target.tagName
        }));
      }
    </script>
  `) }, agent.sessionId);
  await waitFor(async () => (await titleOf(agent)) === 'CLICK-SEQUENCE');

  const press = await agent.raw.call('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: 760, y: 540, button: 'left', buttons: 1, clickCount: 1,
  }, agent.sessionId);
  assert.equal(press.error, undefined);
  const release = await agent.raw.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: 760, y: 540, button: 'left', buttons: 0, clickCount: 1,
  }, agent.sessionId);
  assert.equal(release.error, undefined);

  const reply = await evaluate(agent, 'events');
  const events = reply.result.result.value;
  const down = events.find(event => event.type === 'mousedown');
  const up = events.find(event => event.type === 'mouseup');
  const moves = events.filter(event => event.type === 'mousemove');
  const clicks = events.filter(event => event.type === 'click');
  assert.ok(moves.length >= 4);
  assert.deepEqual({ x: moves.at(-1).x, y: moves.at(-1).y }, { x: 760, y: 540 });
  assert.ok(down.time - moves.at(-1).time >= 35, 'the pointer must hover before pressing');
  assert.ok(up.time - down.time >= 35, 'the press must be held before release');
  assert.ok(events.every(event => event.trusted));
  assert.equal(clicks.length, 1, 'one request must not produce duplicate clicks');
  assert.equal(clicks[0].target, 'BUTTON');
});

test('gateway: automation marker suppression remains native across tabs and frames', async t => {
  const started = await startManager(t);
  if (!started) return;
  const session = await started.manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());
  await agent.raw.call('Page.navigate', { url: dataUrl('<title>NATIVE-MARKER</title><iframe src="about:blank"></iframe>') }, agent.sessionId);
  await waitFor(async () => (await titleOf(agent)) === 'NATIVE-MARKER');
  const expression = `({
    webdriver: navigator.webdriver,
    ownProperty: Object.hasOwn(navigator, 'webdriver'),
    nativeGetter: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get).includes('[native code]'),
    frameWebdriver: frames[0].navigator.webdriver
  })`;
  const first = await evaluate(agent, expression);
  assert.deepEqual(first.result.result.value, {
    webdriver: false, ownProperty: false, nativeGetter: true, frameWebdriver: false,
  });
  const created = await agent.raw.call('Target.createTarget', { url: dataUrl('<title>NEW-MARKER</title>') });
  const attached = await agent.raw.call('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
  const second = await agent.raw.call('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true }, attached.result.sessionId);
  assert.equal(second.result.result.value, false);
  assert.equal(session.status().transport, 'pipe');
});

test('gateway: stopping is graceful and the same profile returns at the same URL', async t => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  await waitFor(() => viewer.hello());
  assert.equal(session.status().state, 'running');

  await session.stop({ reason: 'idle' });

  // A viewer is told why the stream ended rather than being dropped silently.
  await waitFor(() => viewer.received.some(message => message.t === 'bye' && message.reason === 'idle'));
  assert.equal(session.status().state, 'stopped');

  // The bot's identity is stable, so its Hermes profile never needs rewriting.
  const revived = await manager.ensure('alpha');
  assert.equal(revived.cdpUrl, session.cdpUrl);
  const version = await (await fetch(`${revived.cdpUrl}/json/version`)).json();
  assert.match(version.Browser, /^HOB-Gateway\//);
});
