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
// Health check for the fixture service, using only the image's own Node.
const modelProbe = "fetch('http://127.0.0.1:18793/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))";
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
let appContainer = null;
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

function probeRuntimeState(container) {
  // Bounded, secret-free facts about the native runtime the application attaches
  // to. It prints state names, presence flags, a process count and an error class
  // or message, and it runs the application's own bootstrap with stdout discarded
  // so no ticket can reach the log.
  const script = [
    'echo "runtime_probe home=$HERMES_HOME python=${HERMES_PYTHON:-python3} probe_uid=$(id -u) home_owner=$(stat -c %u "$HERMES_HOME" 2>/dev/null)"',
    'echo "layers=$(for layer in /opt/hermes/pm /opt/hermes/hermes_cli /opt/hermes/pm-runtime /opt/hermes/.venv /app/deploy/hermes-session-bootstrap.py; do if [ -e "$layer" ]; then printf "%s=yes " "$layer"; else printf "%s=no " "$layer"; fi; done)"',
    'for name in gateway.sock gateway.sock.path gateway.lock gateway_state.json; do if [ -e "$HERMES_HOME/$name" ]; then echo "present:$name"; else echo "absent:$name"; fi; done',
    'if command -v ps >/dev/null 2>&1; then echo "gateway_cmdline_processes=$(ps -eo args | grep -c "[g]ateway run")"; fi',
    'cat > /tmp/hob-runtime-probe.py <<\'PROBE\'',
    'import json, os, sys',
    'sys.path.insert(0, os.environ["HERMES_DIR"])',
    'try:',
    '    from pm.environments import activate_dependencies',
    '    activate_dependencies(os.environ["HERMES_DIR"])',
    '    from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint',
    '    result = discover_gateway_endpoint(os.environ["HERMES_HOME"], timeout=5)',
    '    verdict = {"state": result.state, "reason": result.reason_code, "attachable": attachable(result)}',
    'except Exception as error:',
    '    verdict = {"error": type(error).__name__, "detail": str(error)[:160]}',
    'print(json.dumps(verdict))',
    'PROBE',
    'runner=""',
    'if [ -x /command/s6-setuidgid ]; then runner="/command/s6-setuidgid hermes"; fi',
    '$runner "${HERMES_PYTHON:-python3}" /tmp/hob-runtime-probe.py 2>/dev/null || echo "runtime_probe_failed"',
    '$runner "${HERMES_PYTHON:-python3}" /app/deploy/hermes-session-bootstrap.py >/tmp/hob-boot.out 2>/tmp/hob-boot.err',
    'echo "app_bootstrap_exit=$? stderr=$(head -n 1 /tmp/hob-boot.err)"',
    'rm -f /tmp/hob-runtime-probe.py /tmp/hob-boot.out /tmp/hob-boot.err',
  ].join('\n');
  try {
    console.log('Native runtime probe: ' + docker(['exec', container, 'sh', '-c', script], 90000));
  } catch (error) {
    console.error('Native runtime probe inconclusive: ' + error.message);
  }
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
    'for candidate in "${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"/*/chrome-linux/chrome "${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"/*/chrome-linux/headless_shell /ms-playwright/*/chrome-linux/chrome /root/.cache/ms-playwright/*/chrome-linux/chrome /opt/hermes/tools/*/chrome-linux/chrome /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do',
    '  if [ -x "$candidate" ]; then chromium="$candidate"; break; fi',
    'done',
    'if [ -z "$chromium" ]; then chromium=$(find "${PLAYWRIGHT_BROWSERS_PATH:-/opt/hermes/tools}" -maxdepth 4 -type f -name chrome -perm -u+x 2>/dev/null | head -n 1); fi',
    'if [ -z "$chromium" ]; then echo NOT_FOUND; exit 3; fi',
    'profile=$(mktemp -d)',
    'if "$chromium" --headless --no-first-run --no-default-browser-check --user-data-dir="$profile" --dump-dom about:blank >/dev/null 2>/tmp/chromium-probe.err; then echo SANDBOX_OK; else echo SANDBOX_FAILED; head -n 4 /tmp/chromium-probe.err; fi',
  ].join('\n');
  try {
    console.log('Blank-profile browser sandbox probe: ' + docker(['exec', container, 'sh', '-c', script], 60000));
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
    // The fixture reuses the application image, so the inherited healthcheck
    // would probe port 3000 and report this service unhealthy. Compose also
    // refuses to "up --wait" on a service with no check at all, so probe the
    // fixture's own port instead.
    services['smoke-model'] = { image, pull_policy: 'never', entrypoint: ['/usr/local/bin/node'],
      command: ['/app/deploy/smoke-model.mjs'],
      healthcheck: { test: ['CMD', '/usr/local/bin/node', '-e', modelProbe],
        interval: '2s', timeout: '5s', start_period: '3s', retries: 30 },
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
  appContainer = container;
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
  probeRuntimeState(container);
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
  if (started) { reportContainerState(); if (appContainer) probeRuntimeState(appContainer); }
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
