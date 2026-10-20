// What the HOB-managed browser actually costs.
//
// Runs the real manager (not a mock) through the scenarios that matter — no browser,
// one browser with an agent, one and two viewers, a repainting page (the worst case
// for the screencast), a second browser, idle shutdown, crash and restart — and
// records, per scenario: Chromium's process count, resident memory and CPU, and the
// same for this server process. A summary table is printed and written to a file.
//
//   node server/measure-browser.mjs [outfile.md]
//
// Per-process memory and CPU come from the platform: CIM on Windows, `ps` on Linux.
// Both paths are implemented; Phase 2 recorded its numbers on Windows (see
// docs/browser_integration/production_hardening_measurements.md).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { BrowserRegistry } from './browser-registry.mjs';
import { BrowserManager } from './browser-manager.mjs';
import { cdpTransportMode } from './browser-launcher.mjs';

const OUT = process.argv[2] || join(tmpdir(), 'hob-measure.md');
const stateDir = await mkdtemp(join(tmpdir(), 'hob-measure-'));
const registry = await BrowserRegistry.open({ stateDir });
const manager = await BrowserManager.open({
  registry, stateDir,
  options: { agentWaitMs: 2500, maxFps: 10, idleMs: 600000 },
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const dataUrl = html => `data:text/html,${encodeURIComponent(html)}`;
const ANIMATED = dataUrl('<title>BUSY</title><style>@keyframes m{to{transform:translateX(800px)}}'
  + 'div{width:120px;height:120px;background:#f00;animation:m .2s linear infinite}</style><div></div>');

/**
 * Chromium tree stats for a profile directory: processes, RSS (MiB), CPU seconds.
 *
 * Processes are found by the profile directory in their command line, which covers
 * every child Chromium spawns (they inherit `--user-data-dir`), and touches nothing
 * else on the host.
 */
function chromeStats(profileDir) {
  if (process.platform === 'win32') {
    // WorkingSetSize is in bytes; the CPU counters are in 100 ns ticks. Written as
    // `$(...)` expressions on purpose: a bare `$a + $b` inside a double-quoted
    // PowerShell string expands only the first variable and leaves a literal `+`.
    const script = 'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | '
      + `Where-Object { $_.CommandLine -like '*${profileDir}*' } | `
      + 'ForEach-Object { "$($_.WorkingSetSize) $(($_.KernelModeTime + $_.UserModeTime))" }';
    const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).stdout || '';
    const rows = out.trim().split(/\r?\n/).filter(Boolean)
      .map(line => line.trim().split(/\s+/).map(Number))
      .filter(row => row.length === 2 && row.every(Number.isFinite));
    return {
      procs: rows.length,
      rssMb: rows.reduce((sum, row) => sum + row[0] / 1048576, 0),
      cpuSec: rows.reduce((sum, row) => sum + row[1] / 1e7, 0),
    };
  }
  // Linux: `rss` is KiB, `cputimes` is cumulative CPU seconds per process.
  const out = spawnSync('ps', ['-eo', 'rss=,cputimes=,args='], { encoding: 'utf8' }).stdout || '';
  const rows = out.split('\n').filter(line => line.includes(profileDir))
    .map(line => line.trim().split(/\s+/).slice(0, 2).map(Number))
    .filter(row => row.length === 2 && row.every(Number.isFinite));
  return {
    procs: rows.length,
    rssMb: rows.reduce((sum, row) => sum + row[0] / 1024, 0),
    cpuSec: rows.reduce((sum, row) => sum + row[1], 0),
  };
}

const rows = [];

/** Measure one scenario over a sampling window, so CPU is an average, not a snapshot. */
async function measure(label, { dirs = [], windowMs = 6000, note = '' } = {}) {
  const before = { tree: dirs.map(chromeStats), cpu: process.cpuUsage(), rss: process.memoryUsage().rss };
  await wait(windowMs);
  const after = { tree: dirs.map(chromeStats), cpu: process.cpuUsage(), rss: process.memoryUsage().rss };
  const treeProcs = after.tree.reduce((sum, tree) => sum + tree.procs, 0);
  const treeRss = after.tree.reduce((sum, tree) => sum + tree.rssMb, 0);
  const treeCpu = after.tree.reduce((sum, tree, index) => sum + (tree.cpuSec - before.tree[index].cpuSec), 0);
  const serverCpu = (after.cpu.user - before.cpu.user + after.cpu.system - before.cpu.system) / 1e6;
  const row = {
    label,
    browsers: dirs.length,
    chromiumProcesses: treeProcs,
    chromiumRssMb: Math.round(treeRss),
    chromiumCpuPercent: +(100 * treeCpu / (windowMs / 1000)).toFixed(1),
    serverRssMb: Math.round(after.rss / 1048576),
    serverCpuPercent: +(100 * serverCpu / (windowMs / 1000)).toFixed(1),
    note,
  };
  rows.push(row);
  console.log(`${label}: ${JSON.stringify(row)}`);
  return row;
}

/** A viewer is an authenticated socket handed to the session, exactly as the HTTP layer does. */
async function createViewer(session) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  const received = [];
  let binaryFrames = 0;
  client.on('message', (data, isBinary) => {
    if (isBinary) binaryFrames += 1;
    else received.push(JSON.parse(data.toString('utf8')));
  });
  const [socket] = await once(server, 'connection');
  session.attachViewer(socket);
  return {
    get binaryFrames() { return binaryFrames; },
    received,
    send: message => client.send(JSON.stringify(message)),
    close() { client.close(); server.close(); },
  };
}

/** A raw CDP client, the same wire shape the agent's `browser_cdp` opens. */
async function agentClient(session) {
  const version = await (await fetch(`${session.cdpUrl}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 0, perMessageDeflate: false });
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  socket.on('message', data => {
    const message = JSON.parse(data.toString('utf8'));
    const entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); entry(message); }
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`No reply to ${method}.`)), 15000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
  const { result: targets } = await call('Target.getTargets');
  const page = targets.targetInfos.find(info => info.type === 'page');
  const attached = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  return {
    close: () => socket.close(),
    navigate: url => call('Page.navigate', { url }, attached.result.sessionId),
  };
}

const profileOf = botId => join(stateDir, 'browsers', botId, 'chromium');

const probe = await manager.probe();
console.log(`chromium: ${probe.chromium || '(not found)'}`);
console.log(`transport: ${cdpTransportMode()}`);

// 0. Nothing started yet.
await measure('idle host, no browser', { windowMs: 4000, note: 'manager created, nothing launched' });

// 1. One browser, agent attached, no viewer.
const alpha = await manager.ensure('alpha');
const agent = await agentClient(alpha);
await agent.navigate(dataUrl('<title>STATIC</title><p>still</p>'));
await measure('1 browser, 1 agent connection, no viewer, static page',
  { dirs: [profileOf('alpha')], note: `viewers=${alpha.status().viewers} agents=${alpha.status().agentConnections}` });

// 2. One viewer on a static page: the screencast exists but has nothing to encode.
const viewerA = await createViewer(alpha);
await wait(1500);
await measure('1 browser, agent + 1 viewer, static page', { dirs: [profileOf('alpha')], note: `viewers=${alpha.status().viewers}` });

// 3. Two viewers on the same browser, static page: one cast feeds them all.
const viewerB = await createViewer(alpha);
await wait(1500);
await measure('1 browser, agent + 2 viewers, static page', { dirs: [profileOf('alpha')], note: `viewers=${alpha.status().viewers}` });

// 4. Two viewers on a page that repaints: the worst case for the screencast.
await agent.navigate(ANIMATED);
await wait(2000);
const busy = await measure('1 browser, agent + 2 viewers, animating page (worst case)',
  { dirs: [profileOf('alpha')], note: `viewers=${alpha.status().viewers} framesA=${viewerA.binaryFrames} framesB=${viewerB.binaryFrames}` });

// 5. The same page with nobody watching: the screencast is stopped, not idled.
viewerA.close();
viewerB.close();
await wait(2500);
await measure('1 browser, agent only, animating page (no screencast)',
  { dirs: [profileOf('alpha')], note: `viewers=${alpha.status().viewers}; compare with the scenario above` });

// 6. A second browser: what a second bot costs.
const beta = await manager.ensure('beta');
const agentBeta = await agentClient(beta);
await agentBeta.navigate(dataUrl('<title>SECOND</title>'));
await measure('2 browsers, one agent each, static pages',
  { dirs: [profileOf('alpha'), profileOf('beta')],
    note: cdpTransportMode() === 'pipe' ? 'separate pipes, tokens and profiles' : 'separate ports, tokens and profiles' });

// 7. Idle shutdown of both, then look for leaks.
await manager.stop('alpha', { reason: 'idle' });
await manager.stop('beta', { reason: 'idle' });
agent.close();
agentBeta.close();
await wait(3000);
await measure('both browsers stopped by the idle policy',
  { windowMs: 4000, note: `alpha=${alpha.status().state} beta=${beta.status().state}` });

// 8. Crash and restart, to see whether a restart leaves anything behind.
const gamma = await manager.ensure('gamma');
const agentGamma = await agentClient(gamma);
await agentGamma.navigate(dataUrl('<title>RESTART</title>'));
await measure('1 browser after a fresh start', { dirs: [profileOf('gamma')], windowMs: 3000 });
if (process.platform === 'win32') {
  spawnSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | '
    + `Where-Object { $_.CommandLine -like '*${profileOf('gamma')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
  { windowsHide: true });
} else {
  spawnSync('pkill', ['-9', '-f', profileOf('gamma')]);
}
await wait(2500);
const restarted = await manager.ensure('gamma');
const revived = await agentClient(restarted);
await revived.navigate(dataUrl('<title>BACK</title>'));
await measure('1 browser after a crash and restart',
  { dirs: [profileOf('gamma')], windowMs: 3000, note: `state=${restarted.status().state} lastError=${restarted.status().lastError ? 'set' : 'none'}` });

await manager.shutdown();
const table = [
  '| Scenario | Browsers | Chromium processes | Chromium RSS (MiB) | Chromium CPU (%) | HOB server RSS (MiB) | HOB server CPU (%) | Notes |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map(row => `| ${row.label} | ${row.browsers} | ${row.chromiumProcesses} | ${row.chromiumRssMb} | ${row.chromiumCpuPercent} | ${row.serverRssMb} | ${row.serverCpuPercent} | ${row.note} |`),
].join('\n');
const clean = text => text.replace(/\|/g, '/');
await writeFile(OUT, table.split('\n').map(clean).join('\n') + '\n', 'utf8');
console.log(`\n${table}`);
await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
