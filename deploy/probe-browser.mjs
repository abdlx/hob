// Container-only verification: can this image run Chromium at all, with its
// sandbox intact, over the transport production actually uses?
//
// Two questions, one launch:
//
//   1. Sandbox. Chromium must report its namespace and seccomp-BPF sandbox
//      layers as enabled. This is what the seccomp profile and the image's
//      capabilities are for, and a missing layer is a silent downgrade.
//   2. No TCP door. The browser is started with `--remote-debugging-pipe`, the
//      same way HOB starts it, so the check also proves that no DevTools TCP
//      listener and no `DevToolsActivePort` file exist in this environment. A
//      raw port here would be a lease-free back door into every bot's browser.
//
// It speaks CDP through the real transport module from `server/browser-pipe.mjs`,
// so a framing or fd regression fails the probe as well.
//
// No operator profile, external page or credential is used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PipeChromium } from '../server/browser-pipe.mjs';

assert.ok(process.getuid?.() > 0, 'The browser probe must run as the unprivileged runtime user.');

const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/hermes/tools';
async function executable(directory, depth = 0) {
  if (depth > 4) return null;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === 'chrome') {
      try { await access(path, constants.X_OK); return path; } catch { /* continue */ }
    }
    if (entry.isDirectory()) { const found = await executable(path, depth + 1); if (found) return found; }
  }
  return null;
}

/** Ports the browser's own process tree listens on, or `null` when it cannot be known. */
function listeningPorts(profile) {
  const tree = spawnSync('pgrep', ['-f', profile], { encoding: 'utf8' });
  const pids = new Set(String(tree.stdout || '').split(/\s+/).filter(Boolean));
  if (tree.error || tree.status !== 0 || pids.size === 0) return { ports: null, reason: 'pgrep' };
  const listing = spawnSync('sh', ['-c', 'ss -ltnp 2>/dev/null'], { encoding: 'utf8' });
  if (listing.error || listing.status !== 0) return { ports: null, reason: 'ss' };
  const ports = [];
  for (const line of String(listing.stdout || '').split('\n')) {
    const owner = /pid=(\d+)/.exec(line);
    if (!owner || !pids.has(owner[1])) continue;
    const port = /:(\d+)\s/.exec(line);
    if (port) ports.push(Number(port[1]));
  }
  return { ports, reason: null };
}

const chrome = await executable(root);
assert.ok(chrome, 'The pinned Chromium executable must be available in the managed tool store.');
const profile = await mkdtemp(join(tmpdir(), 'hob-browser-probe-'));
let stderr = '';
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
  '--disable-default-apps', '--disable-sync', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], detached: true });
browser.stdout?.resume();
browser.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
const closed = new Promise(resolve => browser.once('close', resolve));
let spawnError;
browser.once('error', error => { spawnError = error; });

let pipe = null;
let channel = null;
try {
  pipe = new PipeChromium({ child: browser, label: 'probe' });
  const version = await pipe.request('Browser.getVersion');
  assert.ok(version?.product, 'Chromium must answer over the debugging pipe.');

  // The fix this phase shipped: a pipe is not an address.
  assert.equal(existsSync(join(profile, 'DevToolsActivePort')), false,
    'A pipe-backed browser must not write DevToolsActivePort.');
  const listeners = listeningPorts(profile);
  if (listeners.ports === null) {
    console.log(`PROBE_NOTE: ${listeners.reason} is not available; the TCP listener check was skipped.`);
  } else {
    assert.deepEqual(listeners.ports, [], 'A pipe-backed browser must not listen on any TCP port.');
  }

  // The sandbox page is created the same way `/json/new?chrome://sandbox` did
  // before the pipe existed: through the browser's own target API.
  const created = await pipe.request('Target.createTarget', { url: 'chrome://sandbox' });
  assert.ok(created?.targetId, 'Chromium must create the sandbox page.');
  channel = await pipe.createChannel({ kind: 'page', targetId: created.targetId, label: 'probe' });

  let nextId = 1;
  const pending = new Map();
  channel.on('message', data => {
    const message = JSON.parse(data.toString('utf8'));
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    entry(message);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No reply to ${method}.`)); }, 5000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    channel.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;

  let rows = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnError) throw spawnError;
    assert.equal(browser.exitCode, null, 'Chromium exited before its sandbox page answered.');
    rows = await evaluate(
      'Array.from(document.querySelectorAll("tr"), row => Array.from(row.cells, cell => cell.innerText.trim()))') || [];
    if (rows.some(row => /^layer 1 sandbox$/i.test(row[0]))) break;
    await delay(100);
  }
  const enabled = name => rows.some(row => name.test(row[0]) && /^yes$/i.test(row[1]));
  // Chromium reports its first layer as "Layer 1 Sandbox: Namespace".
  const evidence = JSON.stringify(rows);
  assert.ok(rows.some(row => /^layer 1 sandbox$/i.test(row[0]) && /^namespace$/i.test(row[1])),
    'Chromium namespace sandbox must be enabled: ' + evidence);
  assert.ok(enabled(/^seccomp-bpf sandbox$/i), 'Chromium seccomp-BPF sandbox must be enabled: ' + evidence);
  console.log(`SANDBOX_OK (${version.product}; zero TCP listeners)`);
} catch (error) {
  console.error('SANDBOX_FAILED: ' + error.message + '\n' + stderr);
  process.exitCode = 1;
} finally {
  channel?.close();
  pipe?.close('probe finished');
  if (browser.pid) {
    // Signal only the process group started above, including its renderer children.
    try { process.kill(-browser.pid, 'SIGTERM'); } catch { /* already gone */ }
    await Promise.race([closed, delay(2000)]);
    try { process.kill(-browser.pid, 'SIGKILL'); } catch { /* already gone */ }
    // Bounded: a probe that cannot reap its browser must still not hang the
    // deployment script that runs it.
    await Promise.race([closed, delay(3000)]);
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  // The child's stdio pipes can outlive a failed kill; exit rather than wait.
  process.exit(process.exitCode ?? 0);
}
