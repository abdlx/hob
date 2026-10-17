#!/usr/bin/env node
// Release-tier proof of the actual image. It uses only isolated synthetic state.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHermesSmokeApi } from './hermes-smoke-api.mjs';
import { SMOKE_FILE } from './smoke-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const image = process.env.MUSE_SMOKE_IMAGE || 'openmuse:smoke';
// The provider tier runs a synthetic OpenAI-compatible fixture on the project's
// private network. It never publishes a port and never reaches a real provider.
const providerTier = process.env.MUSE_SMOKE_PROVIDER !== '0';
const project = 'openmuse-smoke-' + randomBytes(8).toString('hex');
const password = randomBytes(32).toString('hex');
const sessionSecret = randomBytes(64).toString('base64');
const portReservation = createServer();
await new Promise((ok, fail) => { portReservation.once('error', fail); portReservation.listen(0, '127.0.0.1', ok); });
const port = portReservation.address().port;
await new Promise(ok => portReservation.close(ok));
const origin = 'http://127.0.0.1:' + port;
const modelUrl = 'http://smoke-model:18793/v1';
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
let runError;

function docker(args, timeout = 400000) {
  const result = spawnSync('docker', args, { cwd: root, env: environment, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Docker ' + args[0] + ' failed (exit ' + result.status + '): ' + result.stderr.trim());
  return result.stdout.trim();
}
const compose = (...args) => docker([...composeArgs, ...args]);
async function ready() {
  const status = await fetch(origin + '/healthz', { headers: { Connection: 'close' }, signal: AbortSignal.timeout(10000) });
  assert.equal(status.status, 200, 'The real Gateway must finish writable startup preparation.');
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
    console.error('Container diagnostic: ' + JSON.stringify({
      status: state.Status, running: state.Running, restarting: state.Restarting,
      dead: state.Dead, oomKilled: state.OOMKilled, exitCode: state.ExitCode,
      health: state.Health?.Status, failingStreak: state.Health?.FailingStreak,
    }));
  } catch {
    console.error('Container diagnostic: Docker state inspection was unavailable.');
  }
}
function probeChromiumSandbox(container) {
  // A fresh blank profile with no credentials, cookies, or user browsing history.
  // The container's capabilities and seccomp policy stay in force, so this proves
  // the shipped browser can use its namespace sandbox or reports why it cannot.
  const script = [
    'chromium=""',
    'for candidate in /ms-playwright/*/chrome-linux/chrome /ms-playwright/*/chrome-linux/headless_shell /root/.cache/ms-playwright/*/chrome-linux/chrome /opt/*/chrome-linux/chrome /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do',
    '  if [ -x "$candidate" ]; then chromium="$candidate"; break; fi',
    'done',
    'if [ -z "$chromium" ]; then echo NOT_FOUND; exit 3; fi',
    'profile=$(mktemp -d)',
    'if "$chromium" --headless --no-first-run --no-default-browser-check --user-data-dir="$profile" --dump-dom about:blank >/dev/null 2>/tmp/chromium-probe.err; then echo SANDBOX_OK; else echo SANDBOX_FAILED; head -n 4 /tmp/chromium-probe.err; fi',
  ].join('\n');
  try {
    console.log('Blank-profile browser sandbox probe: ' + docker(['exec', container, 'sh', '-lc', script], 60000));
  } catch (error) {
    console.error('Browser sandbox probe inconclusive: ' + error.message);
  }
}

try {
  // Override only the image, host port, and the synthetic provider service. All
  // hardening and the real seccomp profile are inherited from compose.yaml.
  const services = { muse: { image, pull_policy: 'never',
    ports: [{ target: 3000, published: String(port), host_ip: '127.0.0.1', protocol: 'tcp' }] } };
  if (providerTier) {
    services['smoke-model'] = { image, pull_policy: 'never', entrypoint: ['/usr/local/bin/node'],
      command: ['/app/deploy/smoke-model.mjs'],
      environment: { HOB_SMOKE_MODEL_PORT: '18793', HOB_SMOKE_HOST: '0.0.0.0',
        HOB_SMOKE_FILE: '/opt/data/workspaces/main/' + SMOKE_FILE } };
  }
  await writeFile(override, JSON.stringify({ services }));
  docker(['version'], 30000);
  compose('config', '--quiet');
  console.log('Using isolated test project ' + project + ' on localhost port ' + port + '.');
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
  console.log('Hardening, capabilities, seccomp and the absence of a Docker socket are verified.');
  probeChromiumSandbox(container);
  const unauthorized = await fetch(origin + '/api/sessions', { headers: { Connection: 'close' }, signal: AbortSignal.timeout(10000) });
  assert.equal(unauthorized.status, 401);
  const smoke = createHermesSmokeApi({ origin, password, modelUrl: providerTier ? modelUrl : undefined });
  const saved = await smoke.firstBoot();
  console.log('Actual image first boot passed ' + smoke.checks.length + ' authenticated native checks.');
  compose('up', '-d', '--no-build', '--pull', 'never', '--force-recreate', '--wait', '--wait-timeout', '300');
  await ready();
  assert.notEqual(compose('ps', '--quiet', 'muse'), container, 'Recreation must replace the container.');
  await smoke.afterRestart(saved);
  console.log('All ' + smoke.checks.length + ' checks passed across container recreation.');
  if (saved.providerTier) console.log('A real Hermes tool turn used only the isolated local fixture provider.');
  else console.log('The synthetic provider tier was disabled (MUSE_SMOKE_PROVIDER=0); no model turn was claimed.');
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
    console.error('Cleanup of test project ' + project + ' failed; preserving its Compose override at ' + override + '.');
    console.error('Recovery: docker compose --project-name ' + project + ' --project-directory "' + root + '" -f "' + resolve(root, 'compose.yaml') + '" -f "' + override + '" down --volumes --remove-orphans');
  } finally {
    if (!cleanupError) {
      assert.equal(relative(tmpdir(), scratch), basename(scratch));
      assert.ok(basename(scratch).startsWith('openmuse-container-smoke-'));
      await rm(scratch, { recursive: true, force: true });
    }
  }
  if (cleanupError && !runError) throw cleanupError;
}
