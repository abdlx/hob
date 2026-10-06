#!/usr/bin/env node
// Release-tier proof of the actual image; it uses only isolated synthetic state.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const image = process.env.MUSE_SMOKE_IMAGE || 'openmuse:smoke';
const project = `openmuse-smoke-${randomBytes(8).toString('hex')}`;
const password = randomBytes(32).toString('hex');
const sessionSecret = randomBytes(64).toString('base64');
const portReservation = createServer();
await new Promise((ok, fail) => { portReservation.once('error', fail); portReservation.listen(0, '127.0.0.1', ok); });
const port = portReservation.address().port;
await new Promise(ok => portReservation.close(ok));
const origin = `http://127.0.0.1:${port}`;
const scratch = await mkdtemp(join(tmpdir(), 'openmuse-container-smoke-'));
const override = join(scratch, 'smoke-compose.json');
const environment = {
  ...process.env,
  SERVICE_PASSWORD_64_MUSE: password,
  SERVICE_REALBASE64_64_MUSE: sessionSecret,
  SERVICE_URL_MUSE_3000: origin,
  MUSE_SECURE_COOKIES: 'false',
};
const composeArgs = ['compose', '--project-name', project, '--project-directory', root,
  '-f', resolve(root, 'compose.yaml'), '-f', override];
let started = false;
let cookie = '';
let runError;

function docker(args, timeout = 400000) {
  const result = spawnSync('docker', args, { cwd: root, env: environment, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed (exit ${result.status}): ${result.stderr.trim()}`);
  return result.stdout.trim();
}
const compose = (...args) => docker([...composeArgs, ...args]);
async function api(path, method = 'GET', value) {
  const response = await fetch(origin + path, {
    // Recreation deliberately destroys the server's TCP connections. Every probe
    // uses a fresh socket so a stale pre-recreation pool entry cannot fail it.
    method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', Connection: 'close' },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}), signal: AbortSignal.timeout(60000),
  });
  assert.ok(response.ok, `${method} ${path} returned ${response.status}: ${await response.clone().text()}`);
  return response.json();
}
async function ready() {
  const status = await fetch(origin + '/healthz', { headers: { Connection: 'close' }, signal: AbortSignal.timeout(10000) });
  assert.equal(status.status, 200, 'The real Gateway must finish writable startup preparation.');
}

function reportBrowserDiagnostic(container) {
  // A new blank profile has no credentials, cookies, or user browsing history.
  // Keep the container's capabilities, seccomp policy, and Chromium sandbox.
  const script = `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const executable = require('/app/openclaw/node_modules/playwright-core').chromium.executablePath();
    const profile = fs.mkdtempSync('/tmp/openmuse-browser-diagnostic-');
    const result = spawnSync(executable, ['--headless', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + profile, '--dump-dom', 'about:blank'],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    console.log(JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.code,
      stderr: (result.stderr || '').split('\\n').slice(0, 12).join('\\n') }));
  `;
  try { console.error(`Blank-profile browser diagnostic: ${docker(['exec', container, 'node', '-e', script], 20000)}`); }
  catch (error) { console.error(`Browser diagnostic unavailable: ${error.message}`); }
}
function reportContainerState() {
  try {
    const container = compose('ps', '--all', '--quiet', 'muse');
    if (!container || container.includes('\n')) {
      console.error('Container diagnostic: no single app container was available for inspection.');
      return;
    }
    const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', container], 30000));
    // Never dump container environment, process arguments, or application logs.
    console.error(`Container diagnostic: ${JSON.stringify({
      status: state.Status, running: state.Running, restarting: state.Restarting,
      dead: state.Dead, oomKilled: state.OOMKilled, exitCode: state.ExitCode,
      health: state.Health?.Status, failingStreak: state.Health?.FailingStreak,
    })}`);
  } catch {
    console.error('Container diagnostic: Docker state inspection was unavailable.');
  }
}

try {
  // Override only image/port. All hardening and the real seccomp profile are inherited.
  await writeFile(override, JSON.stringify({ services: { muse: {
    image, pull_policy: 'never',
    ports: [{ target: 3000, published: String(port), host_ip: '127.0.0.1', protocol: 'tcp' }],
  } } }));
  docker(['version'], 30000);
  compose('config', '--quiet');
  console.log(`Using isolated test project ${project} on localhost port ${port}.`);
  started = true;
  compose('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '300');
  await ready();
  const container = compose('ps', '--quiet', 'muse');
  assert.ok(container && !container.includes('\n'), 'Exactly one app container must be running.');
  const hardening = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig}}', container]));
  assert.equal(hardening.Privileged, false);
  assert.ok(hardening.CapDrop.includes('ALL'));
  assert.ok(hardening.SecurityOpt.some(item => item.startsWith('no-new-privileges')));
  const seccomp = hardening.SecurityOpt.find(item => item.startsWith('seccomp='));
  assert.ok(seccomp, 'Compose must load the repository seccomp file.');
  assert.equal(JSON.parse(seccomp.slice('seccomp='.length)).defaultAction, 'SCMP_ACT_ERRNO');
  assert.ok(!hardening.Binds?.some(item => item.includes('docker.sock')));

  const unauthorized = await fetch(origin + '/api/sessions', { headers: { Connection: 'close' }, signal: AbortSignal.timeout(10000) });
  assert.equal(unauthorized.status, 401);
  const login = await fetch(origin + '/api/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('/api/auth/status')).authenticated, true);
  const agent = await api('/api/agent');
  assert.equal(agent.id, 'main');
  assert.equal((await api('/api/settings')).config.browser.noSandbox, false);
  assert.ok((await api('/api/settings/schema')).schema.properties.agents.properties.entries);
  assert.ok(Array.isArray((await api('/api/rpc', 'POST', {
    method: 'models.list', params: { agentId: agent.id, view: 'all', includeDetails: true, preparedOnly: true },
  })).models));
  const session = await api('/api/sessions', 'POST', { title: 'Isolated container smoke conversation', agentId: agent.id });
  assert.ok(session.id);
  assert.ok(Array.isArray(await api(`/api/sessions/${encodeURIComponent(session.id)}/messages`)));
  const name = 'Isolated container smoke agent';
  assert.equal((await api('/api/agent', 'PATCH', { id: agent.id, name })).name, name);
  const soulRoute = `/api/agent/files/SOUL.md?agentId=${encodeURIComponent(agent.id)}`;
  const original = (await api(soulRoute)).file;
  const soul = '# Container persistence proof\n\nSynthetic verification content.\n';
  await api(soulRoute, 'PUT', { content: soul, ...(original.missing ? { expectedMissing: true } : { expectedHash: original.hash }) });
  assert.equal((await api(soulRoute)).file.content, soul);
  const job = await api('/api/goals', 'POST', {
    name: 'Isolated disabled persistence proof', enabled: false, agentId: agent.id,
    schedule: { kind: 'at', at: new Date(Date.now() + 86400000).toISOString() },
    sessionTarget: 'main', wakeMode: 'next-heartbeat',
    payload: { kind: 'systemEvent', text: 'Synthetic smoke proof. This disabled job must not execute.' },
  });
  assert.ok(job.id);
  assert.equal((await api('/api/goals')).jobs.find(item => item.id === job.id)?.enabled, false);
  assert.ok(Array.isArray((await api('/api/library?kind=artifacts')).files));

  try { await api('/api/browser/actions', 'POST', { action: 'start', profile: 'openclaw' }); }
  catch (error) { reportBrowserDiagnostic(container); throw error; }
  const tab = await api('/api/browser/actions', 'POST', { action: 'open', profile: 'openclaw', url: 'about:blank' });
  assert.ok(tab.targetId);
  assert.ok((await api('/api/browser/tabs?profile=openclaw')).tabs.some(item => item.targetId === tab.targetId));
  const snapshot = await api('/api/browser/actions', 'POST', { action: 'snapshot', profile: 'openclaw', targetId: tab.targetId, format: 'ai' });
  assert.equal(typeof snapshot.snapshot, 'string');
  const shot = await api('/api/browser/actions', 'POST', { action: 'screenshot', profile: 'openclaw', targetId: tab.targetId });
  assert.match(shot.imageUrl, /^data:image\/png;base64,/);
  const png = Buffer.from(shot.imageUrl.split(',')[1], 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  await api('/api/browser/actions', 'POST', { action: 'stop', profile: 'openclaw' });
  console.log('Actual image first boot, protected login, owner APIs, and sandboxed browser passed.');

  compose('up', '-d', '--no-build', '--pull', 'never', '--force-recreate', '--wait', '--wait-timeout', '300');
  await ready();
  assert.notEqual(compose('ps', '--quiet', 'muse'), container, 'Recreation must replace the container.');
  assert.equal((await api('/api/auth/status')).authenticated, true, 'The signed cookie must survive recreation with the same secret.');
  assert.equal((await api('/api/agent')).name, name);
  assert.equal((await api(soulRoute)).file.content, soul);
  assert.ok((await api('/api/sessions')).some(item => item.id === session.id));
  assert.equal((await api('/api/goals')).jobs.find(item => item.id === job.id)?.enabled, false);
  console.log('Config, identity, conversation, schedule, SOUL.md, and login persisted across container recreation.');
  console.log('Provider-backed chat requires configured provider credentials and is not claimed by this secretless smoke test.');
} catch (error) {
  runError = error;
  if (started) reportContainerState();
  throw error;
} finally {
  // Only this freshly generated Compose project and its test volume are removed.
  let cleanupError;
  try {
    if (started) compose('down', '--volumes', '--remove-orphans', '--timeout', '40');
  } catch (error) {
    cleanupError = error;
    console.error(`Cleanup of test project ${project} failed; preserving its Compose override at ${override}.`);
    console.error(`Recovery: docker compose --project-name ${project} --project-directory "${root}" -f "${resolve(root, 'compose.yaml')}" -f "${override}" down --volumes --remove-orphans`);
  } finally {
    if (!cleanupError) {
      assert.equal(relative(tmpdir(), scratch), basename(scratch));
      assert.ok(basename(scratch).startsWith('openmuse-container-smoke-'));
      await rm(scratch, { recursive: true, force: true });
    }
  }
  if (cleanupError && !runError) throw cleanupError;
}
