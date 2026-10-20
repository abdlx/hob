// Adversarial tests for exclusive human takeover.
//
// Each case here is a concrete attempt to mutate the page *while a human holds
// control*, expressed on the raw CDP wire — the same wire Hermes' `browser_cdp`
// tool uses. They are written to assert the secure outcome, so any regression in
// the gateway's classification shows up as a real navigation/script change in a
// real Chromium rather than as a unit-level "the function returned false".

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { BrowserRegistry } from '../browser-registry.mjs';
import { BrowserManager } from '../browser-manager.mjs';
import { probeCdp, readDevToolsActivePort } from '../browser-launcher.mjs';
import { classify, MUTATE, OBSERVE } from '../browser-policy.mjs';

const dataUrl = html => `data:text/html,${encodeURIComponent(html)}`;
const delay = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });

async function waitFor(check, { timeoutMs = 20000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for a browser condition.');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/**
 * Every TCP port the browser's own process tree is listening on.
 *
 * This is the adversarial reading of "no DevTools port": not "the port we know
 * about is closed" but "the process tree has no listening socket at all", which
 * is what a pipe-backed browser should look like. Throws rather than returning
 * an empty list when the tree cannot be found, so a broken probe can never pass
 * as a secure result.
 */
function browserListeningPorts(profileDir) {
  if (process.platform === 'win32') {
    const escaped = profileDir.replace(/'/g, "''");
    const script = '$pids = @(Get-CimInstance Win32_Process | '
      + `Where-Object { $_.Name -match '^(chrome|chromium)' -and $_.CommandLine -like '*${escaped}*' } | `
      + 'ForEach-Object { $_.ProcessId }); '
      + "if ($pids.Count -eq 0) { 'NO-PROCESS' } else { "
      + '$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | '
      + "Where-Object { $pids -contains $_.OwningProcess } | ForEach-Object { $_.LocalPort }); "
      + "if ($ports.Count -eq 0) { 'NONE' } else { $ports -join ',' } }";
    const result = String(spawnSync('powershell', ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true }).stdout || '').trim();
    if (result === 'NO-PROCESS') throw new Error('Could not find the browser process tree.');
    if (result === 'NONE' || result === '') return [];
    return result.split(',').map(Number).filter(Number.isFinite);
  }
  const tree = String(spawnSync('pgrep', ['-f', profileDir], { encoding: 'utf8' }).stdout || '').trim();
  if (!tree) throw new Error('Could not find the browser process tree.');
  const pids = new Set(tree.split(/\s+/));
  const listing = String(spawnSync('sh', ['-c', 'ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null'],
    { encoding: 'utf8' }).stdout || '');
  const ports = new Set();
  for (const line of listing.split('\n')) {
    const owner = /pid=(\d+)/.exec(line);
    if (!owner || !pids.has(owner[1])) continue;
    const port = /:(\d+)\s/.exec(line);
    if (port) ports.add(Number(port[1]));
  }
  return [...ports];
}

/**
 * A raw CDP client with no policy of its own: it can send any JSON it likes,
 * including messages shaped unlike anything agent-browser would produce.
 */
function openRawCdp(url) {
  const socket = new WebSocket(url, { maxPayload: 0, perMessageDeflate: false });
  const pending = new Map();
  const received = [];
  let nextId = 1;
  const failAll = reason => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    pending.clear();
  };
  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString('utf8')); } catch { return; }
    received.push(message);
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
    received,
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
    /** Send an arbitrary message and do not wait for (or expect) a reply. */
    sendRaw(message) { socket.send(JSON.stringify(message)); },
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

const evaluate = (agent, expression) =>
  agent.raw.call('Runtime.evaluate', { expression, returnByValue: true }, agent.sessionId);

/** Read the title through an observational command, so it works during takeover. */
async function titleOf(agent) {
  const targets = await agent.raw.call('Target.getTargets');
  return targets.result?.targetInfos?.find(info => info.targetId === agent.targetId)?.title;
}

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
  const stateDir = await mkdtemp(join(tmpdir(), 'hob-browser-bypass-'));
  const registry = await BrowserRegistry.open({ stateDir });
  const manager = await BrowserManager.open({
    registry, stateDir,
    options: { agentWaitMs: 1500, maxFps: 5, idleMs: 2000 },
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const probe = await manager.probe();
  if (!probe.ready) { t.skip('No Chromium-family browser is installed on this host.'); return null; }
  return { manager, stateDir, registry };
}

/** Put a human in control of a fresh page showing `title`, and return the parts. */
async function takeControlOf(t, title, { beforeControl } = {}) {
  const started = await startManager(t);
  if (!started) return null;
  const { manager } = started;
  const session = await manager.ensure('alpha');
  const agent = await agentClient(session);
  t.after(() => agent.raw.close());
  await agent.raw.call('Page.navigate', { url: dataUrl(`<title>${title}</title><h1>${title}</h1>`) }, agent.sessionId);
  await waitFor(async () => (await titleOf(agent)) === title);

  const viewer = await createViewer(session);
  t.after(() => viewer.close());
  await waitFor(() => viewer.hello());
  if (beforeControl) await beforeControl({ manager, session, agent, viewer });
  viewer.send({ t: 'request_control' });
  await waitFor(() => session.status().control.holder === 'human');
  return { manager, session, agent, viewer };
}

test('policy: methods with side effects are never treated as observational', () => {
  // A method whose name *sounds* like a read but which grants scripting, injects
  // a capability, ships a message to a target, or destroys state must be a
  // mutation. Nothing here is on the observational allowlist.
  const mustMutate = [
    // Script execution, in every spelling.
    'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.compileScript',
    'Runtime.runScript', 'Page.addScriptToEvaluateOnNewDocument',
    'Page.addScriptToEvaluateOnLoad', 'Page.setDocumentContent',
    // Document mutation.
    'DOM.setAttributeValue', 'DOM.setAttributesAsText', 'DOM.setOuterHTML',
    'DOM.setNodeValue', 'DOM.setFileInputFiles', 'DOM.removeNode',
    // Capability injection / session routing that can carry a command.
    'Target.exposeDevToolsProtocol', 'Target.sendMessageToTarget',
    'Target.createTarget', 'Target.closeTarget', 'Target.activateTarget',
    // Storage, network interception and emulation.
    'Network.setCookie', 'Network.setCookies', 'Network.clearBrowserCookies',
    'Storage.setCookies', 'Storage.clearDataForOrigin', 'Fetch.enable',
    'Emulation.setDeviceMetricsOverride', 'Page.setBypassCSP',
    // Process-level.
    'Browser.close', 'Browser.crash', 'Browser.setDownloadBehavior',
  ];
  for (const method of mustMutate) {
    assert.equal(classify(method), MUTATE, `${method} must require the lease`);
  }
  // And the reads we deliberately keep available during takeover still hold.
  for (const method of ['Target.getTargets', 'Page.captureScreenshot', 'Accessibility.getFullAXTree']) {
    assert.equal(classify(method), OBSERVE, `${method} must stay readable during takeover`);
  }
});

test('takeover: an id-less CDP command cannot mutate the page', async t => {
  const state = await takeControlOf(t, 'BEFORE');
  if (!state) return;
  const { agent } = state;

  // Chromium dispatches commands it can read a method from, whether or not the
  // message carries a correlatable id. A gateway that only classifies messages
  // *with* an id would forward each of these verbatim, ungated.
  agent.raw.sendRaw({ method: 'Page.navigate', params: { url: dataUrl('<title>HACK-NOID</title>') } });
  agent.raw.sendRaw({
    method: 'Runtime.evaluate',
    params: { expression: "document.title='HACK-EVAL'", returnByValue: true },
    sessionId: agent.sessionId,
  });
  agent.raw.sendRaw({
    method: 'Runtime.evaluate',
    params: { expression: "document.body.innerHTML='<title>HACK-REPLACED</title>'", returnByValue: true },
  });
  // The non-flattened tunnel, with the hidden command also lacking an id.
  agent.raw.sendRaw({
    method: 'Target.sendMessageToTarget',
    params: {
      sessionId: agent.sessionId,
      message: JSON.stringify({ id: 9001, method: 'Page.navigate', params: { url: dataUrl('<title>HACK-TUNNEL</title>') } }),
    },
  });
  agent.raw.sendRaw({
    method: 'Target.sendMessageToTarget',
    params: {
      sessionId: agent.sessionId,
      message: JSON.stringify({ method: 'Runtime.evaluate', params: { expression: "document.title='HACK-TUNNEL-EVAL'" } }),
    },
  });

  await delay(1200);
  assert.equal(await titleOf(agent), 'BEFORE',
    'no id-less command may change the page while a human holds control');
  assert.ok(
    agent.raw.received.some(message => message.id === null && message.error),
    'an id-less mutation must be answered with an explicit refusal',
  );
});

test('takeover: a target session id cannot smuggle a mutation past the lease', async t => {
  const state = await takeControlOf(t, 'SESSION-ISOLATED');
  if (!state) return;
  const { agent } = state;

  // A session-scoped mutation is still a mutation: attaching to a target must
  // not confer the ability to drive it.
  const scoped = await agent.raw.call('Runtime.evaluate',
    { expression: "document.title='HACK-SESSION'", returnByValue: true }, agent.sessionId);
  assert.ok(scoped.error, 'a session-scoped mutation must be refused while the human holds control');
  assert.equal(scoped.error.code, -32001);

  const scopedNav = await agent.raw.call('Page.navigate',
    { url: dataUrl('<title>HACK-SESSION-NAV</title>') }, agent.sessionId);
  assert.ok(scopedNav.error, 'a session-scoped navigation must be refused as well');

  // A command aimed at a *different* target than the one it attached to is the
  // same story: the method decides, not the routing.
  const otherTargets = await agent.raw.call('Target.getTargets');
  const foreign = otherTargets.result.targetInfos.find(info => info.targetId !== agent.targetId);
  if (foreign) {
    const indirect = await agent.raw.call('Page.navigate',
      { url: dataUrl('<title>HACK-FOREIGN</title>') }, foreign.targetId);
    assert.ok(indirect.error, 'a navigation aimed at another target is still a mutation');
  }

  assert.equal(await titleOf(agent), 'SESSION-ISOLATED');
});

test('takeover: capability injection requires the lease', async t => {
  const state = await takeControlOf(t, 'NO-INJECTION');
  if (!state) return;
  const { agent } = state;

  // `Target.exposeDevToolsProtocol` installs a CDP-sending binding on the page,
  // which is a scripting capability rather than an observation.
  const injected = await agent.raw.call('Target.exposeDevToolsProtocol', { targetId: agent.targetId });
  assert.ok(injected.error, 'capability injection must be refused during human control');
  assert.equal(injected.error.code, -32001);

  // So does the generic message-shipping command, when it is not observable.
  const tunneled = await agent.raw.call('Target.sendMessageToTarget', {
    sessionId: agent.sessionId,
    message: JSON.stringify({ id: 7001, method: 'Page.navigate', params: { url: dataUrl('<title>HACK-TUNNEL-2</title>') } }),
  });
  assert.ok(tunneled.error, 'a tunnelled mutation must be refused during human control');
  assert.equal(tunneled.error.code, -32001);

  assert.equal(await titleOf(agent), 'NO-INJECTION');
});

test('takeover: in production the browser has no DevTools TCP door at all', async t => {
  const state = await takeControlOf(t, 'PORT-CLOSED');
  if (!state) return;
  const { session, agent } = state;
  const status = session.status();

  // Prove the browser is genuinely running, so "no port" cannot be the trivial
  // result of "no browser".
  const version = await agent.raw.call('Browser.getVersion');
  assert.ok(version.result?.product, 'a running browser answers through the gateway');

  const active = await readDevToolsActivePort(status.profileDir);
  const ports = browserListeningPorts(status.profileDir);
  t.diagnostic(`transport=${status.transport} chromiumPort=${status.chromiumPort} `
    + `DevToolsActivePort=${active ? active.port : 'absent'} listeners=[${ports.join(', ')}]`);

  if (status.transport === 'pipe') {
    // Finding H1 was that a same-host process could read DevToolsActivePort and
    // speak to Chromium directly, bypassing the lease. A pipe is not an address:
    // there is no port to read, none to dial, and no DevToolsHTTP endpoint to
    // find in the process tree. All three are asserted, because "the port is
    // loopback" would still leave a lease-free door on the same machine.
    assert.equal(status.chromiumPort, null, 'pipe mode must not report a DevTools port');
    assert.equal(active, null, 'pipe mode must not write DevToolsActivePort');
    assert.deepEqual(ports, [], 'a pipe-backed browser must not listen on any TCP port');
    for (const port of ports) {
      const devtools = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
        .then(response => response.ok).catch(() => false);
      assert.equal(devtools, false, `port ${port} must not be a DevTools endpoint`);
    }
    return;
  }

  // Development fallback (`HOB_CDP_TRANSPORT=tcp`): the port exists, and the
  // most that can be guaranteed is that it never answers off the machine.
  assert.ok(active, 'the tcp fallback publishes its DevTools port');
  const probe = await probeCdp(active.port);
  assert.ok(probe, 'a running browser publishes its DevTools port on loopback');

  // Enumerate this host's non-loopback IPv4 addresses and prove the port does not
  // answer on any of them.
  const os = await import('node:os');
  const external = Object.values(os.networkInterfaces()).flat()
    .filter(entry => entry && entry.family === 'IPv4' && !entry.internal)
    .map(entry => entry.address);
  for (const address of external) {
    const reachable = await fetch(`http://${address}:${active.port}/json/version`, { signal: AbortSignal.timeout(1500) })
      .then(response => response.ok).catch(() => false);
    assert.equal(reachable, false, `the DevTools port must not answer on ${address}`);
  }
  t.diagnostic(`DevTools port ${active.port} is loopback-only; a same-host process can still reach it (development fallback only).`);
});

test('takeover: an agent cannot freeze frames the person’s page loads', async t => {
  // A cross-*site* frame (different hostname, not just a different port) is an
  // out-of-process target, and an agent's `setAutoAttach(waitForDebuggerOnStart)`
  // leaves each such target suspended until somebody sends
  // `Runtime.runIfWaitingForDebugger` — a mutation, and therefore refused while a
  // person holds control. A suspended target is reported with
  // `waitingForDebugger: true`, which is the invariant asserted here.
  const { createServer } = await import('node:http');
  const child = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><script>document.title="CHILD-READY"</script>child</body></html>');
  });
  await new Promise(resolve => child.listen(0, '127.0.0.1', resolve));
  const childPort = child.address().port;
  const parent = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    // `localhost` is a different site from `127.0.0.1`, so this frame is
    // genuinely out of process.
    res.end(`<html><title>PARENT</title><iframe src="http://localhost:${childPort}/"></iframe></html>`);
  });
  await new Promise(resolve => parent.listen(0, '127.0.0.1', resolve));
  const parentUrl = `http://127.0.0.1:${parent.address().port}/`;
  t.after(() => { child.close(); parent.close(); });

  const suspended = agent => agent.raw.received
    .filter(message => message.method === 'Target.attachedToTarget' && message.params?.waitingForDebugger === true)
    .map(message => message.params?.targetInfo?.type);

  // Case 1: the agent attaches while the person already holds control. The
  // gateway keeps the attach and drops the suspension.
  const during = await takeControlOf(t, 'FRAME-DURING');
  if (!during) return;
  await during.agent.raw.call('Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, during.agent.sessionId);
  await during.viewer.send({ t: 'navigate', url: parentUrl });
  await waitFor(async () => {
    const targets = await during.agent.raw.call('Target.getTargets');
    return targets.result?.targetInfos?.some(info => info.url === parentUrl);
  }, { timeoutMs: 15000 }).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(suspended(during.agent), [],
    'no target may be left waiting for a debugger while the person holds control');

  // Case 2: the agent attached *before* the person took over. The handover must
  // revert the suspension that is already installed inside Chromium.
  const before = await takeControlOf(t, 'FRAME-BEFORE', {
    beforeControl: async ({ agent }) => {
      await agent.raw.call('Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, agent.sessionId);
    },
  });
  if (!before) return;
  await before.viewer.send({ t: 'navigate', url: parentUrl });
  await waitFor(async () => {
    const targets = await before.agent.raw.call('Target.getTargets');
    return targets.result?.targetInfos?.some(info => info.url === parentUrl);
  }, { timeoutMs: 15000 }).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(suspended(before.agent), [],
    'a suspension installed before the handover must be reverted by the handover');
});

test('takeover: the HTTP tab endpoint cannot open a page while the person is in control', async t => {
  // `PUT /json/new` is the HTTP convenience path a CDP client uses for tabs. It
  // is a mutation, so it must be admitted exactly like `Target.createTarget` over
  // the socket — otherwise the lease has a second, quieter door.
  const parts = await takeControlOf(t, 'TAB-ENDPOINT');
  if (!parts) return;
  const { session, viewer } = parts;
  const list = async () => (await (await fetch(`${session.cdpUrl}/json/list`)).json()).length;
  const before = await list();

  const refused = await fetch(`${session.cdpUrl}/json/new?about:blank`, { method: 'PUT' });
  assert.equal(refused.status, 409, 'a new tab is a mutation and the person holds control');
  assert.equal(await list(), before, 'the refused request created no tab');

  viewer.send({ t: 'release_control' });
  await waitFor(() => session.status().control.holder === 'agent');
  const allowed = await fetch(`${session.cdpUrl}/json/new?about:blank`, { method: 'PUT' });
  assert.equal(allowed.status, 200, 'the agent can open a tab as soon as it holds control again');
  const created = await allowed.json();
  assert.ok(created.id, 'the endpoint returns the new target');
});

