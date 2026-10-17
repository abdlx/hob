// Container-only verification. No operator profile, external page or credential is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

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
const chrome = await executable(root);
assert.ok(chrome, 'The pinned Chromium executable must be available in the managed tool store.');
const profile = await mkdtemp(join(tmpdir(), 'hob-browser-probe-'));
let stderr = '', spawnError;
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
  '--disable-default-apps', '--disable-sync', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
const closed = new Promise(resolve => { browser.once('close', resolve); });
browser.once('error', error => { spawnError = error; });
browser.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
let socket;
try {
  const deadline = Date.now() + 25000;
  let port;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert.equal(browser.exitCode, null, 'Chromium exited before its debugging endpoint became ready.');
    const data = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const candidate = Number(data.split('\n')[0]);
    if (Number.isInteger(candidate) && candidate > 0 && candidate < 65536) { port = candidate; break; }
    await delay(100);
  }
  assert.ok(port, 'Chromium did not publish its debugging endpoint within 25 seconds.');
  const response = await fetch(`http://127.0.0.1:${port}/json/new?chrome://sandbox`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, 'Chromium must create a renderer for its sandbox status page.');
  const target = await response.json();
  const targetUrl = new URL(target.webSocketDebuggerUrl);
  assert.equal(targetUrl.hostname, '127.0.0.1');
  assert.equal(targetUrl.port, String(port));
  socket = new WebSocket(targetUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium DevTools handshake timed out.')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chromium DevTools handshake failed.')); }, { once: true });
  });
  let nextId = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const finish = (error, value) => {
      clearTimeout(timer); socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      if (error) reject(error); else resolve(value);
    };
    const onClose = () => finish(new Error('Chromium closed during the renderer check.'));
    const onMessage = event => {
      const message = JSON.parse(event.data);
      if (message.id === id) finish(message.error ? new Error('Chromium rejected the renderer check.') : null, message.result);
    };
    const timer = setTimeout(() => finish(new Error('Chromium renderer check timed out.')), 5000);
    socket.addEventListener('message', onMessage); socket.addEventListener('close', onClose, { once: true });
    socket.send(JSON.stringify({ id, method, params }));
  });
  let rows = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await request('Runtime.evaluate', {
      expression: 'Array.from(document.querySelectorAll("tr"), row => Array.from(row.cells, cell => cell.innerText.trim()))', returnByValue: true,
    });
    rows = result?.result?.value || [];
    if (rows.some(row => /namespace sandbox/i.test(row[0]))) break;
    await delay(100);
  }
  const enabled = name => rows.some(row => name.test(row[0]) && /^yes$/i.test(row[1]));
  assert.ok(enabled(/^namespace sandbox$/i), 'Chromium namespace sandbox must be enabled.');
  assert.ok(enabled(/^seccomp-bpf sandbox$/i), 'Chromium seccomp-BPF sandbox must be enabled.');
  console.log('SANDBOX_OK');
} catch (error) {
  console.error('SANDBOX_FAILED: ' + error.message + '\n' + stderr);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (browser.pid) {
    // Signal only the process group started above, including its renderer children.
    try { process.kill(-browser.pid, 'SIGTERM'); } catch { /* already gone */ }
    await Promise.race([closed, delay(2000)]);
    try { process.kill(-browser.pid, 'SIGKILL'); } catch { /* already gone */ }
    await closed;
  }
  await rm(profile, { recursive: true, force: true });
}
