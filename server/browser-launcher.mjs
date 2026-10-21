// Chromium process lifecycle for one bot's persistent browser profile.
//
// Headless only: no Xvfb, VNC or desktop environment is required, because the
// UI is a CDP screencast rather than a real screen. The profile directory is
// long-lived so cookies, IndexedDB, localStorage and logins survive restarts;
// the debugging port is NOT: it is chosen by the OS (`--remote-debugging-port=0`)
// and discovered from `DevToolsActivePort`, so it can never collide with another
// bot, another service, or a stale run.
//
// The browser is never exposed publicly: `--remote-debugging-address=127.0.0.1`
// keeps the raw DevTools endpoint on loopback, and only the HOB CDP gateway is
// allowed to talk to it.

import { spawn, spawnSync } from 'node:child_process';
import { CdpConnection } from './browser-cdp-client.mjs';
import { PipeChromium } from './browser-pipe.mjs';
import { resolveChromiumExecutable } from './browser-executable.mjs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export { resolveChromiumExecutable };

const DEVTOOLS_FILE = 'DevToolsActivePort';
const START_TIMEOUT_MS = 30000;
const STOP_GRACE_MS = 5000;
// Chromium's own stderr is the only place a failed launch explains itself (a
// missing library, a profile lock, an unusable sandbox). Keep the tail of it so
// the error a caller sees can quote the browser instead of guessing.
const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * How HOB talks to Chromium.
 *
 * `pipe` (the default, and the only production mode) hands Chromium fds 3/4 and
 * speaks CDP over them: there is no TCP listener, so no local process can reach
 * the browser without going through the HOB gateway. `tcp` restores the
 * loopback DevTools port and exists only as a development fallback — it is the
 * configuration that carries finding H1, so it is off unless an operator asks
 * for it by name.
 */
export function cdpTransportMode() {
  const requested = (process.env.HOB_CDP_TRANSPORT || '').trim().toLowerCase();
  if (requested === 'tcp') return 'tcp';
  if (requested === 'pipe' || requested === '') return 'pipe';
  throw new Error(`HOB_CDP_TRANSPORT must be "pipe" or "tcp" (got "${requested}").`);
}

export async function readDevToolsActivePort(profileDir) {
  let raw;
  try { raw = await readFile(path.join(profileDir, DEVTOOLS_FILE), 'utf8'); }
  catch { return null; }
  const [portLine, wsPath] = raw.split('\n');
  const port = Number.parseInt(portLine, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, wsPath: (wsPath || '').trim() || '/devtools/browser' };
}

/** Fetch `/json/version` from a DevTools port. `null` when it is not answering. */
export async function probeCdp(port, { timeoutMs = 2000 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && typeof payload === 'object' ? payload : null;
  } catch { return null; }
}

async function waitForCdp(profileDir, child, { timeoutMs = START_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return { error: 'exited' };
    const active = await readDevToolsActivePort(profileDir);
    if (active) {
      const version = await probeCdp(active.port, { timeoutMs: 1500 });
      if (version) return { port: active.port, wsPath: active.wsPath, version };
    }
    await new Promise(resolve => { const timer = setTimeout(resolve, 150); timer.unref?.(); });
  }
  return { error: 'timeout' };
}

// A profile left behind by a hard kill keeps a stale SingletonLock plus a stale
// DevToolsActivePort. Both must go before a fresh launch, or Chromium silently
// hands the request to a dead process and never opens a debugging port.
async function clearStaleProfileState(profileDir) {
  await rm(path.join(profileDir, DEVTOOLS_FILE), { force: true });
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await rm(path.join(profileDir, name), { force: true });
  }
}

/**
 * Launch Chromium for a profile, or adopt one that is already serving that
 * profile (a previous HOB process, or a browser that outlived a gateway
 * restart). Either way the caller gets a live DevTools port back.
 *
 * A profile that was just shut down can still be held for a moment by a process
 * that has not finished exiting, and Chromium refuses to start twice on one
 * profile. So a launch that dies during startup is retried with backoff rather
 * than surfaced as a failure on the first attempt.
 */
// One 4:3 viewport for every managed browser. It is the page's real layout
// viewport, not a CSS crop: screenshots, agent coordinates and the live viewer
// all agree on the same rectangle. 1280x960 is the largest common 4:3 size that
// still fits a laptop workspace when scaled down.
export const BROWSER_VIEWPORT = Object.freeze({ w: 1280, h: 960 });
export const BROWSER_WINDOW_SIZE = `${BROWSER_VIEWPORT.w},${BROWSER_VIEWPORT.h}`;

/**
 * Launch one Chromium with its profile and no DevTools TCP door in production.
 *
 * The window size is the page viewport in headless mode, so the constant above
 * is what makes the agent, screenshots and the live viewer share a 4:3 frame.
 */
export async function launchChromium({ profileDir, executablePath, headless = true, extraArgs = [], attempts = 3, transport }) {
  const mode = transport || cdpTransportMode();
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  if (mode === 'tcp') {
    const existing = await readDevToolsActivePort(profileDir);
    if (existing) {
      const version = await probeCdp(existing.port, { timeoutMs: 1500 });
      if (version) return { mode, adopted: true, child: null, port: existing.port, wsPath: existing.wsPath, version, executablePath, profileDir };
    }
  }

  const sandboxArgs = [];
  if (process.getuid?.() === 0) {
    // Chromium refuses to enable its sandbox as uid 0; the production image runs
    // unprivileged, so this only fires for an operator running the dev gateway
    // as root. Sandboxing stays ON everywhere the platform supports it.
    sandboxArgs.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  const debuggingArgs = mode === 'pipe'
    // One pipe on fds 3/4, and deliberately no `--remote-debugging-port`: a
    // browser started this way never creates a DevTools TCP listener, so there
    // is no loopback port for another process to read out of DevToolsActivePort
    // and speak to directly (finding H1).
    ? ['--remote-debugging-pipe']
    : ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];

  const args = [
    ...(headless ? ['--headless=new'] : []),
    ...debuggingArgs,
    '--disable-blink-features=AutomationControlled',
    `--user-data-dir=${profileDir}`,
    // Session cookies are the one class of login state a browser would otherwise
    // drop on every restart: Chromium only loads them from disk when it believes
    // the last session is worth restoring. This switch is that belief, expressed
    // on the command line instead of as a user preference, and it is the only
    // supported way to keep them (verified against this Chromium: without it a
    // session cookie is gone after a restart, with it the cookie is back).
    //
    '--restore-last-session',
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update',
    '--disable-default-apps', '--disable-sync', '--disable-translate',
    '--disable-extensions', '--disable-plugins', '--disable-gpu',
    '--metrics-recording-only', '--mute-audio',
    `--window-size=${BROWSER_WINDOW_SIZE}`,
    ...sandboxArgs, ...extraArgs,
  ];

  let lastReason = mode === 'pipe' ? 'did not answer on its debugging pipe in time' : 'did not open a DevTools port in time';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await clearStaleProfileState(profileDir);
    if (mode === 'pipe') {
      // fd 3 is the browser's command pipe, fd 4 its reply pipe. Both must exist
      // or there is no way to speak CDP at all, so that is a launch failure.
      const child = spawn(executablePath, args, {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true, detached: false,
      });
      child.stdout?.resume();
      const stderr = createTail(child.stderr);
      let pipe = null;
      try {
        pipe = new PipeChromium({ child, label: path.basename(profileDir) });
        const started = await waitForPipe(pipe, child);
        if (!started.error) {
          return { mode, adopted: false, child, pipe, version: started.version, executablePath, profileDir };
        }
        lastReason = started.error === 'exited'
          ? `exited during startup${stderr.hint()}`
          : `did not answer on its debugging pipe in time${stderr.hint()}`;
      } catch (error) {
        lastReason = `${error.message}${stderr.hint()}`;
      }
      pipe?.close('The browser did not start.');
      await stopChromium(child).catch(() => undefined);
      if (attempt < attempts) await new Promise(resolve => { const t = setTimeout(resolve, 300 * attempt); t.unref?.(); });
      continue;
    }

    const child = spawn(executablePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: false });
    child.stdout?.resume();
    child.stderr?.resume();

    const started = await waitForCdp(profileDir, child);
    if (!started.error) {
      return { mode, adopted: false, child, port: started.port, wsPath: started.wsPath, version: started.version, executablePath, profileDir };
    }
    lastReason = started.error === 'exited'
      ? 'exited during startup' : 'did not open a DevTools port in time';
    await stopChromium(child).catch(() => undefined);
    if (attempt < attempts) await new Promise(resolve => { const t = setTimeout(resolve, 300 * attempt); t.unref?.(); });
  }
  throw new Error(`Chromium ${lastReason} after ${attempts} attempts.`);
}

function createTail(stream) {
  const chunks = [];
  let bytes = 0;
  stream?.on('data', chunk => {
    chunks.push(chunk);
    bytes += chunk.length;
    while (bytes > STDERR_TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift().length;
  });
  stream?.resume?.();
  return {
    hint() {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      return text ? ` — Chromium said: ${text.slice(-400).replace(/\s+/g, ' ')}` : '';
    },
  };
}

async function waitForPipe(pipe, child, { timeoutMs = START_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return { error: 'exited' };
    try {
      const version = await pipe.request('Browser.getVersion', {}, { timeoutMs: 1500 });
      if (version?.product) return { version };
    } catch { /* the pipe is not answering yet */ }
    await new Promise(resolve => { const timer = setTimeout(resolve, 150); timer.unref?.(); });
  }
  return { error: 'timeout' };
}

/**
 * Ask a running browser to exit through CDP, which is the protocol's own
 * graceful shutdown.
 *
 * This is not politeness. A browser that is killed outright loses whatever it
 * had not yet flushed, and cookies and localStorage are written asynchronously:
 * a bot that signs in, goes idle and comes back would find itself signed out.
 * It is also the only way to close a browser HOB *adopted* instead of spawned,
 * since there is no child process to signal.
 */
export async function closeBrowserGracefully(port, { timeoutMs = 5000 } = {}) {
  if (!port) return false;
  const version = await probeCdp(port, { timeoutMs: 1500 }).catch(() => null);
  if (!version?.webSocketDebuggerUrl) return false;
  const connection = new CdpConnection(version.webSocketDebuggerUrl);
  try {
    await connection.connect({ timeoutMs: 3000 });
    // Fire-and-forget: the browser usually exits without answering, and a lost
    // reply must not stall an idle shutdown.
    connection.post('Browser.close', {}, { timeoutMs });
    return true;
  } catch { return false; }
  finally { connection.close(); }
}

/**
 * The pipe equivalent of `closeBrowserGracefully`: the same protocol command,
 * sent over the transport HOB owns.
 *
 * The reply usually never arrives because the browser exits first, so the request
 * is fire-and-forget — but the *exit* must be waited for. A session cookie only
 * exists on disk because Chromium writes it while shutting down, and killing the
 * process one millisecond after asking it to close loses exactly the state the
 * durable profile exists to keep.
 */
export async function closePipeGracefully(pipe, { child = null, timeoutMs = 5000 } = {}) {
  if (pipe && !pipe.closed) pipe.request('Browser.close', {}, { timeoutMs }).catch(() => undefined);
  if (child) return waitForExit(child, timeoutMs);
  return Boolean(pipe && !pipe.closed);
}

/** Resolve true when the child has exited, false if it is still running later. */
export async function waitForExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    new Promise(resolve => { const timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); }),
  ]);
}

/** `Browser.getVersion` over the pipe, or `null` if the browser is not answering. */
export async function probePipe(pipe, { timeoutMs = 1500 } = {}) {
  if (!pipe || pipe.closed) return null;
  try { return await pipe.request('Browser.getVersion', {}, { timeoutMs }); }
  catch { return null; }
}

/**
 * Stop the browser and wait for the process to actually go away.
 *
 * POSIX: SIGTERM the parent and let it reap its own zygotes (a browser that is
 * SIGKILLed before its children turns a clean shutdown into a crashed profile);
 * only survivors get SIGKILL afterwards.
 *
 * Windows: `kill()` maps to `TerminateProcess`, which kills only the browser
 * process and orphans its renderers — and those orphans keep the profile's
 * `lockfile` open, so the next launch of the same profile fails or hangs. There
 * the whole tree is terminated with `taskkill /T` while the parent still exists,
 * which is the same intent (parent first, descendants as its children).
 */
export async function stopChromium(child, { graceMs = STOP_GRACE_MS } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise(resolve => child.once('exit', resolve));

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }

  let timer;
  const result = await Promise.race([
    exited.then(() => 'exited'),
    new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), graceMs); }),
  ]);
  clearTimeout(timer);

  if (result !== 'exited') {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    await Promise.race([exited, new Promise(resolve => { const t = setTimeout(resolve, 3000); t.unref?.(); })]);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

/** Forget a profile's runtime state without touching its cookies or storage. */
export async function resetProfileRuntimeState(profileDir) {
  await clearStaleProfileState(profileDir);
}

export async function markProfileOwned(profileDir) {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(profileDir, '.hob-owned'), 'This directory is a HOB-managed Chromium profile.\n', { flag: 'w', mode: 0o600 });
}
