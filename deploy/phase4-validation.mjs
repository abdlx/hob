#!/usr/bin/env node
// Phase 4: the production deployment checklist, executed against the real image.
//
// It creates an isolated Compose project (unique name, loopback-only port, its own
// volume), so it can run on a developer machine or a CI runner without touching a
// live deployment. Every check is against the shipped image, the shipped Compose
// hardening and the shipped seccomp profile. Requires a Linux host with Docker.
//
//   node deploy/phase4-validation.mjs
//
// The image is built unless PHASE4_SKIP_BUILD=1.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const image = process.env.PHASE4_IMAGE || 'openmuse:phase4';
const project = 'openmuse-phase4-' + randomBytes(6).toString('hex');
const password = randomBytes(32).toString('hex');
const sessionSecret = randomBytes(64).toString('base64');
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const scratch = await mkdtemp(join(tmpdir(), 'openmuse-phase4-'));
const override = join(scratch, 'compose.json');
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
let container = null;

async function reservePort() {
  const reservation = createServer();
  await new Promise((ok, fail) => { reservation.once('error', fail); reservation.listen(0, '127.0.0.1', ok); });
  const value = reservation.address().port;
  await new Promise(ok => reservation.close(ok));
  return value;
}

function run(command, { timeout = 600000, stream = false, allowFailure = false } = {}) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root, env: environment, encoding: 'utf8', timeout,
    maxBuffer: 64 * 1024 * 1024, stdio: stream ? 'inherit' : 'pipe',
  });
  if (result.error) throw result.error;
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command.slice(0, 3).join(' ')} failed (exit ${result.status})`
      + (stderr ? ': ' + stderr.slice(-4000) : ''));
  }
  return { status: result.status, stdout, stderr };
}
const docker = (args, options) => run(['docker', ...args], options);
const compose = (args, options) => docker([...composeArgs, ...args], options);

function exec(args, { user, env = {}, timeout = 600000, stream = false, allowFailure = false } = {}) {
  assert.ok(container, 'the application container must exist');
  const command = ['exec'];
  if (user) command.push('--user', user);
  for (const [key, value] of Object.entries(env)) command.push('--env', `${key}=${value}`);
  command.push(container, ...args);
  return docker(command, { timeout, stream, allowFailure });
}

async function ready(timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(5000) });
      if (response.status === 200) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('The application did not become healthy at ' + origin + '.');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function diagnostics() {
  try {
    const script = [
      'echo "runtime uid=$(id -u) data_owner=$(stat -c %u /opt/data)"',
      'echo "agent_browser=$(command -v agent-browser || echo missing)"',
      'echo "python=$(/opt/hermes/.venv/bin/python -V 2>&1)"',
      'echo "ss=$(command -v ss || echo missing) pgrep=$(command -v pgrep || echo missing)"',
      'echo "tools=$(ls -1 /opt/hermes/tools 2>/dev/null | head -8 | tr "\\n" " ")"',
      'echo "chromium=$(find /opt/hermes/tools -maxdepth 4 -type f -name chrome 2>/dev/null | head -3 | tr "\\n" " ")"',
    ].join('\n');
    const result = exec(['sh', '-lc', script], { user: 'hermes', env: { HOME: '/opt/data' }, timeout: 60000, allowFailure: true });
    console.log('Diagnostics:\n' + (result.stdout || result.stderr));
  } catch (error) {
    console.error('Diagnostics unavailable: ' + error.message);
  }
}

function containerStats(label) {
  try {
    const stats = docker(['stats', '--no-stream', '--format', '{{json .}}', container], { timeout: 30000, allowFailure: true });
    console.log(`Container stats (${label}): ` + (stats.stdout || stats.stderr));
  } catch (error) {
    console.error(`Container stats (${label}) unavailable: ` + error.message);
  }
}

// The application's services must all have dropped to the volume's owner. This is
// the same invariant the release smoke asserts; here it is checked against the
// compose configuration that is actually deployed.
function verifyRuntimeUsers() {
  const script = [
    'import json, os',
    'from pathlib import Path',
    'expected = os.stat("/opt/data").st_uid',
    'assert expected != 0, "The runtime home must belong to an unprivileged user"',
    'roles = {"supervisor": [], "web": [], "gateway": [], "settings": []}',
    'for entry in Path("/proc").iterdir():',
    '    if not entry.name.isdigit(): continue',
    '    try:',
    '        args = (entry / "cmdline").read_bytes().split(b"\\0")',
    '        program = Path(os.fsdecode(args[0])).name',
    '        role = "supervisor" if b"/app/deploy/start.mjs" in args else "web" if b"/app/server/index.mjs" in args else "gateway" if b"gateway" in args and b"run" in args else "settings" if b"serve" in args and b"--isolated" in args else None',
    '        if role is None: continue',
    '        if role in {"supervisor", "web"} and program not in {"node", "nodejs"}: continue',
    '        if role in {"gateway", "settings"} and not (program.startswith("python") or program == "hermes"): continue',
    '        status = (entry / "status").read_text()',
    '        uids = [int(uid) for line in status.splitlines() if line.startswith("Uid:") for uid in line.split()[1:]]',
    '        assert uids and all(uid == expected for uid in uids), role + " (" + program + ") did not drop runtime privileges: " + str(uids)',
    '        roles[role].append(expected)',
    '    except (FileNotFoundError, ProcessLookupError): continue',
    'assert all(roles.values()), "Every application service must be running for the privilege check"',
    'print(json.dumps(roles))',
  ].join('\n');
  const result = exec(['/opt/hermes/.venv/bin/python', '-c', script], { timeout: 60000 });
  assert.match(result.stdout, /"supervisor": \[10000\]/, 'the supervisor must run as the unprivileged owner');
  console.log('Runtime service users: ' + result.stdout);
}

function stopAndCheckOrphans() {
  compose(['stop', '--timeout', '40'], { timeout: 120000 });
  const inspected = JSON.parse(docker(['inspect', '--format', '{{json .State}}', container], { timeout: 30000 }).stdout);
  assert.equal(inspected.Running, false, 'the container must be stopped');
  assert.equal(inspected.ExitCode, 0, 'graceful shutdown must exit 0 (got ' + inspected.ExitCode + ')');
  console.log('Graceful stop exit code: ' + inspected.ExitCode);
  const logs = docker(['logs', '--no-color', '--tail', '30', container], { timeout: 30000, allowFailure: true });
  console.log('Last container log lines:\n' + (logs.stdout || logs.stderr));
  const survivors = spawnSync('bash', ['-lc',
    "pgrep -af '/opt/data/browsers|hob-browser|--user-data-dir=/opt/data' || true"],
  { encoding: 'utf8' }).stdout.trim();
  assert.equal(survivors, '', 'Chromium must not survive the container stop: ' + survivors);
  console.log('No Chromium process survived the stop.');
  const running = docker(['ps', '--format', '{{.Names}}'], { timeout: 30000 }).stdout;
  assert.ok(!running.split('\n').includes(project + '-muse-1'), 'the application container must not be running');
}

const results = [];
try {
  docker(['version'], { timeout: 30000 });
  if (process.env.PHASE4_SKIP_BUILD !== '1') {
    console.log('Building ' + image + ' from ' + root);
    docker(['build', '-t', image, '.'], { timeout: 30 * 60 * 1000, stream: true });
  }
  await writeFile(override, JSON.stringify({
    services: {
      muse: {
        image, pull_policy: 'never',
        ports: [{ target: 3000, published: String(port), host_ip: '127.0.0.1', protocol: 'tcp' }],
      },
    },
  }));
  started = true;
  compose(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '300'], { timeout: 420000 });
  await ready();
  container = compose(['ps', '--quiet', 'muse'], { timeout: 30000 }).stdout;
  assert.ok(container && !container.includes('\n'), 'exactly one application container must be running');
  console.log('Isolated project ' + project + ' is healthy on ' + origin + '.');

  const hardening = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig}}', container], { timeout: 30000 }).stdout);
  assert.equal(hardening.Privileged, false, 'the container must not be privileged');
  assert.ok(hardening.CapDrop.includes('ALL'), 'all capabilities must be dropped');
  assert.ok(hardening.SecurityOpt.some(item => item.startsWith('no-new-privileges')), 'no-new-privileges must be set');
  const seccomp = hardening.SecurityOpt.find(item => item.startsWith('seccomp='));
  assert.ok(seccomp, 'the repository seccomp profile must be loaded');
  assert.equal(JSON.parse(seccomp.slice('seccomp='.length)).defaultAction, 'SCMP_ACT_ERRNO');
  assert.ok(!hardening.Binds?.some(item => item.includes('docker.sock')), 'the Docker socket must not be mounted');
  console.log('Hardening verified: no privilege, cap drop ALL, no-new-privileges, errno seccomp, no Docker socket.');
  console.log('Capabilities granted: ' + JSON.stringify(hardening.CapAdd || []));
  results.push('hardening');

  diagnostics();
  const probe = exec(['/usr/local/bin/node', '/app/deploy/probe-browser.mjs'],
    { user: 'hermes', env: { HOME: '/opt/data' }, timeout: 120000 });
  assert.match(probe.stdout, /^SANDBOX_OK \([^)]+; zero TCP listeners\)$/,
    'the probe must prove both sandbox layers and no TCP listener');
  console.log('Sandbox/transport probe: ' + probe.stdout);
  results.push('probe');

  assert.equal(exec(['id', '-u'], { user: 'hermes' }).stdout, '10000', 'the runtime user must be uid 10000');
  assert.equal(exec(['stat', '-c', '%u', '/opt/data']).stdout, '10000', '/opt/data must belong to uid 10000');
  verifyRuntimeUsers();
  results.push('permissions');

  containerStats('idle');
  const suite = exec(['sh', '-lc',
    'cd /app/server && node --test --test-reporter=spec --test-timeout=180000 --test-concurrency=1 test/browser-*.test.mjs'],
  { user: 'hermes', env: { HOME: '/opt/data', HOB_CDP_TRANSPORT: 'pipe' }, timeout: 20 * 60 * 1000 });
  console.log(suite.stdout);
  results.push('browser-suite');

  const e2e = exec(['/opt/hermes/.venv/bin/python', '/app/server/e2e/hermes-tools-e2e.py'],
    { user: 'hermes', env: { HOME: '/opt/data', HERMES_REPO: '/opt/hermes', HOB_CDP_TRANSPORT: 'pipe' },
      timeout: 30 * 60 * 1000 });
  console.log(e2e.stdout);
  results.push('hermes-e2e');
  containerStats('after-e2e');

  const write = exec(['/usr/local/bin/node', '/app/server/e2e/phase4-profile.mjs', 'write', '/opt/data/.phase4-profile'],
    { user: 'hermes', env: { HOME: '/opt/data' }, timeout: 180000 });
  assert.match(write.stdout, /^PROFILE_WRITTEN /m, 'the profile write phase must report its profile');
  console.log('Profile written: ' + write.stdout);
  compose(['restart', 'muse', '--timeout', '40'], { timeout: 180000 });
  container = compose(['ps', '--quiet', 'muse'], { timeout: 30000 }).stdout;
  await ready();
  const read = exec(['/usr/local/bin/node', '/app/server/e2e/phase4-profile.mjs', 'read', '/opt/data/.phase4-profile'],
    { user: 'hermes', env: { HOME: '/opt/data' }, timeout: 180000 });
  assert.match(read.stdout, /^PROFILE_OK /m, 'localStorage must survive the container restart');
  console.log('Profile survived the container restart: ' + read.stdout);
  results.push('profile-restart');

  const measurement = exec(['/usr/local/bin/node', '/app/server/measure-browser.mjs', '/tmp/phase4-measure.md'],
    { user: 'hermes', env: { HOME: '/opt/data' }, timeout: 20 * 60 * 1000 });
  console.log(measurement.stdout);
  console.log(exec(['cat', '/tmp/phase4-measure.md'], { timeout: 30000 }).stdout);
  containerStats('after-measurement');
  results.push('measurements');

  stopAndCheckOrphans();
  results.push('graceful-stop');
  console.log('PHASE4_PASSED: ' + results.join(', '));
} catch (error) {
  if (container) {
    try {
      const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', container], { timeout: 30000, allowFailure: true }).stdout);
      console.error('Container state at failure: ' + JSON.stringify(state));
      const logs = docker(['logs', '--no-color', '--tail', '60', container], { timeout: 30000, allowFailure: true });
      console.error('Last container log lines:\n' + (logs.stdout || logs.stderr));
    } catch { /* diagnostics are best effort */ }
  }
  throw error;
} finally {
  try {
    if (started) compose(['down', '--volumes', '--remove-orphans', '--timeout', '40'], { timeout: 180000, allowFailure: true });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log('PHASE4_PASSED: ' + results.join(', '));
}
