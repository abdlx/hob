// Full-stack CAPTCHA fixture test (Phases 1+2+4 against a real Chromium).
//
// A local page carries a fake reCAPTCHA widget: a `.g-recaptcha` box that,
// when clicked, fills the `g-recaptcha-response` token field — the same
// evidence the real widget produces. The test drives the production path
// end to end: probe-loop detection confirms the challenge, an agent mutation
// parks behind the gate, the solver ladder clicks the box with human-motion
// precision input, the token resolves the challenge, and the parked command
// finally lands. Nothing is mocked except the widget itself.

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

const FIXTURE = `<title>Fixture Checkout</title>
<div class="g-recaptcha" data-sitekey="FIXTUREKEY" style="width:300px;height:78px;border:1px solid #ccc;position:relative">
  <div id="box" style="width:26px;height:26px;border:2px solid #888;position:absolute;left:18px;top:24px;cursor:pointer;background:#fff"></div>
  <span style="position:absolute;left:56px;top:28px">I'm not a robot</span>
</div>
<textarea name="g-recaptcha-response" id="token" style="display:none"></textarea>
<button id="target">Do it</button><div id="clicked">no</div>
<script>
  document.getElementById('box').addEventListener('click', () => {
    setTimeout(() => { document.getElementById('token').value = 'fixture-token-value-123'; }, 250);
  });
  document.getElementById('target').addEventListener('click', () => {
    document.getElementById('clicked').textContent = 'yes';
  });
</script>`;

async function waitFor(check, { timeoutMs = 25000, intervalMs = 40 } = {}) {
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
    if (message.id === undefined || message.id === null) return;
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
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No reply to ${method}.`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
        socket.send(JSON.stringify(message));
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
  return { raw, targetId: page.targetId, sessionId: attached.result.sessionId };
}

async function createViewer(session) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  const received = [];
  client.on('message', (data, isBinary) => {
    if (isBinary) return;
    received.push(JSON.parse(data.toString('utf8')));
  });
  const [socket] = await once(server, 'connection');
  session.attachViewer(socket);
  return {
    received,
    send(value) { client.send(JSON.stringify(value)); },
    close() { client.close(); server.close(); },
    hello: () => received.find(message => message.t === 'hello'),
  };
}

async function startManager(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'hob-challenge-e2e-'));
  const registry = await BrowserRegistry.open({ stateDir });
  const manager = await BrowserManager.open({
    registry, stateDir,
    options: { agentWaitMs: 1500, maxFps: 5, idleMs: 30000, captchaMode: 'solve', challengeParkMs: 60000, ...options },
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const probe = await manager.probe();
  if (!probe.ready) { t.skip('No Chromium-family browser is installed on this host.'); return null; }
  return { manager };
}

test('end to end: the gate parks, the solver clicks the widget, the parked command lands', async (t) => {
  const started = await startManager(t);
  if (!started) return;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());
  await agent.raw.call('Page.navigate', { url: dataUrl(FIXTURE) }, agent.sessionId);

  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  await waitFor(() => viewer.hello());

  // Detection: the probe loop sees the widget twice and confirms it.
  await waitFor(() => session.status().challenge?.provider === 'recaptcha-v2');
  assert.equal(session.status().challenge.kind, 'checkbox');

  // A mutation issued against the challenged page parks behind the gate.
  let answered = false;
  const parked = agent.raw.call('Runtime.evaluate', {
    expression: `document.getElementById('target').click(), document.getElementById('clicked').textContent`,
    returnByValue: true,
  }, agent.sessionId).then(reply => { answered = true; return reply; });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(answered, false, 'the mutation must still be parked behind the challenge');

  // The solver ladder clicks the fake checkbox; the page fills its token;
  // the tracker resolves; the gate releases the parked command, which runs.
  const reply = await parked;
  assert.equal(reply.result?.result?.value, 'yes', 'the parked command executed after resolution');
  await waitFor(() => session.status().challenge === null);
  assert.equal(session.status().challengeStats.seen, 1);
  assert.equal(session.status().challengeStats.agent, 1, 'the agent solver ladder earned the solve');
});

test('human intervention: real viewer resolves fixture and parked work waits for handback', async t => {
  const escalations = [];
  const started = await startManager(t, { captchaMode: 'human', agentWaitMs: 10000, onChallengeEscalated: event => escalations.push(event) });
  if (!started) return;
  const session = await started.manager.ensure('human');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());
  await agent.raw.call('Page.navigate', { url: dataUrl(FIXTURE) }, agent.sessionId);
  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  await waitFor(() => viewer.hello());
  await waitFor(() => session.status().challenge?.provider === 'recaptcha-v2');
  assert.equal(escalations[0]?.reason, 'human_required');
  let answered = false;
  const parked = agent.raw.call('Runtime.evaluate', {
    expression: `document.getElementById('target').click(), document.getElementById('clicked').textContent`, returnByValue: true,
  }, agent.sessionId).then(reply => { answered = true; return reply; });
  viewer.send({ t: 'request_control' });
  await waitFor(() => session.status().control.holder === 'human');
  assert.equal(answered, false);
  // Only the operator's viewer clicks this local test widget. No solver runs.
  viewer.send({ t: 'input', kind: 'mouse', payload: { type: 'down', x: 39, y: 45, button: 0 } });
  viewer.send({ t: 'input', kind: 'mouse', payload: { type: 'up', x: 39, y: 45, button: 0 } });
  await waitFor(() => session.status().challenge === null);
  assert.equal(answered, false, 'clearing the challenge must not bypass human control');
  viewer.send({ t: 'release_control' });
  const reply = await parked;
  assert.equal(reply.result?.result?.value, 'yes');
  assert.equal(session.status().challengeStats.human, 1);
  assert.equal(session.status().challengeStats.agent, 0);
  assert.equal(session.status().challengeStats.service, 0);
});
