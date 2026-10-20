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
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PipeChromium } from '../server/browser-pipe.mjs';
import { resolveChromiumExecutable } from '../server/browser-executable.mjs';

assert.ok(process.getuid?.() > 0, 'The browser probe must run as the unprivileged runtime user.');

// The production image ships no `ss` (iproute2); a skipped listener check must
// never be reported as a pass. These helpers read the kernel's own tables, so
// the proof works in a minimal image and cannot silently degrade.
function processTree(profile) {
  let entries;
  try { entries = readdirSync('/proc'); } catch { return null; }
  const pids = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let commandLine;
    try { commandLine = readFileSync(`/proc/${entry}/cmdline`, 'utf8'); } catch { continue; }
    if (commandLine.includes(profile)) pids.push(entry);
  }
  return pids;
}

/** Listening sockets in this network namespace, keyed by socket inode. */
function listeningSockets() {
  const listeners = new Map();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = readFileSync(table, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      return null;
    }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      // 0A is TCP_LISTEN; fields[1] is LOCAL_ADDRESS:PORT, fields[9] the inode.
      if (fields.length < 10 || fields[3] !== '0A') continue;
      const local = fields[1].split(':');
      if (local.length !== 2) continue;
      const port = Number.parseInt(local[1], 16);
      if (Number.isFinite(port)) listeners.set(fields[9], port);
    }
  }
  return listeners;
}

/** Ports the browser's own process tree listens on, or `null` when it cannot be known. */
function listeningPorts(profile) {
  const pids = processTree(profile);
  if (pids === null) return { ports: null, reason: '/proc' };
  if (pids.length === 0) return { ports: null, reason: 'the browser process tree' };
  const listeners = listeningSockets();
  if (listeners === null) return { ports: null, reason: '/proc/net/tcp' };
  const ports = new Set();
  for (const pid of pids) {
    let entries;
    try { entries = readdirSync(`/proc/${pid}/fd`); } catch { return { ports: null, reason: `/proc/${pid}/fd` }; }
    for (const entry of entries) {
      let target;
      try { target = readlinkSync(`/proc/${pid}/fd/${entry}`); } catch { continue; }
      const socket = /^socket:\[(\d+)\]$/.exec(target);
      if (socket && listeners.has(socket[1])) ports.add(listeners.get(socket[1]));
    }
  }
  return { ports: [...ports], reason: null };
}

// Resolve exactly as the application does, so a broken layout cannot pass the
// probe while production would fail to launch its browser.
const chrome = await resolveChromiumExecutable();
assert.ok(chrome, 'The pinned Chromium executable must be available to the application.');
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
  assert.notEqual(listeners.ports, null,
    `The probe could not prove a pipe-only browser has no TCP listener (${listeners.reason} unreadable).`);
  assert.deepEqual(listeners.ports, [], 'A pipe-backed browser must not listen on any TCP port.');

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
