// Two-phase proof that a persistent browser profile survives a container restart.
//
//   write: open a real HTTP origin and put a value in localStorage, then close the
//          browser gracefully so the profile is flushed to the volume.
//   read:  after `docker compose restart`, open the same profile and require the
//          value to still be there. A profile on the container filesystem, or a
//          fresh temporary profile, fails this.
//
// Driven by deploy/phase4-validation.mjs. The origin port is fixed because
// localStorage is keyed by scheme, host and port: a new random port would look
// like a different site and prove nothing.

import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { BrowserRegistry } from '../browser-registry.mjs';
import { BrowserManager } from '../browser-manager.mjs';

const [mode, stateDir] = process.argv.slice(2);
assert.ok(mode === 'write' || mode === 'read', 'usage: phase4-profile.mjs write|read <stateDir>');
assert.ok(stateDir, 'usage: phase4-profile.mjs write|read <stateDir>');
const port = Number(process.env.PHASE4_PROFILE_PORT || 18794);
const origin = `http://127.0.0.1:${port}`;

const site = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>PHASE4</title><h1>profile</h1>');
});
await new Promise((resolve, reject) => {
  site.once('error', reject);
  site.listen(port, '127.0.0.1', resolve);
});

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

async function pageFor(cdpUrl) {
  const version = await (await fetch(`${cdpUrl}/json/version`)).json();
  const raw = openRawCdp(version.webSocketDebuggerUrl);
  await raw.ready;
  const targets = await raw.call('Target.getTargets');
  const page = targets.result.targetInfos.find(info => info.type === 'page');
  assert.ok(page, 'the managed browser must expose a page target');
  const attached = await raw.call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  assert.ok(sessionId, 'attaching to the page must return a CDP session');
  return {
    evaluate: expression => raw.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId),
    navigate: async url => {
      const result = await raw.call('Page.navigate', { url }, sessionId);
      assert.equal(result.error, undefined, 'navigation failed: ' + JSON.stringify(result.error));
    },
    close: () => raw.close(),
  };
}

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('The page did not become ready.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

const registry = await BrowserRegistry.open({ stateDir });
const manager = await BrowserManager.open({
  registry, stateDir,
  options: { idleMs: 10 * 60 * 1000, maxFps: 5, agentWaitMs: 5000 },
});
try {
  const session = await manager.ensure('phase4');
  const page = await pageFor(session.cdpUrl);
  try {
    await page.navigate(origin);
    await waitFor(async () => (await page.evaluate('document.readyState')).result?.result?.value === 'complete');
    if (mode === 'write') {
      const written = await page.evaluate("localStorage.setItem('phase4', 'kept')");
      assert.equal(written.error, undefined, 'localStorage write failed');
      await waitFor(async () => (await page.evaluate("localStorage.getItem('phase4')")).result?.result?.value === 'kept');
      console.log('PROFILE_WRITTEN ' + session.status().profileDir);
    } else {
      const value = (await page.evaluate("localStorage.getItem('phase4')")).result?.result?.value;
      assert.equal(value, 'kept', 'localStorage did not survive the container restart');
      console.log('PROFILE_OK ' + session.status().profileDir);
    }
  } finally {
    page.close();
  }
} finally {
  await manager.shutdown();
  await new Promise(resolve => site.close(resolve));
}
