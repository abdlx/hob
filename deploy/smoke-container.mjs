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
const usersIsolation = process.env.MUSE_SMOKE_ISOLATION === 'users';
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
  '-f', resolve(root, 'compose.yaml'), ...(usersIsolation ? ['-f', resolve(root, 'compose.isolation.yaml')] : []), '-f', override];
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
    'echo "runtime_pyfiles=$(timeout 20 find /opt/hermes -maxdepth 3 -name "*.py" 2>/dev/null | wc -l)"',
    'if timeout 25 grep -rqs "session-authority-v1" /opt/hermes --include=*.py 2>/dev/null; then echo runtime_code=session-authority:present; else echo runtime_code=session-authority:absent; fi',
    'if timeout 25 grep -rqs "runtime_protocol" /opt/hermes --include=*.py 2>/dev/null; then echo runtime_code=runtime_protocol:present; else echo runtime_code=runtime_protocol:absent; fi',
    'cat > /tmp/hob-runtime-probe.py <<\'PROBE\'',
    'import importlib.util, json, os',
    'from pathlib import Path',
    'spec = importlib.util.spec_from_file_location("hob_boot", "/app/deploy/hermes-session-bootstrap.py")',
    'module = importlib.util.module_from_spec(spec)',
    'verdict = {}',
    'try:',
    '    spec.loader.exec_module(module)',
    '    grant = module.bootstrap()',
    '    verdict = {"attached": True, "url": grant["url"]}',
    'except Exception as error:',
    '    verdict = {"attached": False, "error": type(error).__name__, "detail": str(error)[:200]}',
    '    try:',
    '        home = Path(os.environ["HERMES_HOME"]).resolve(strict=True)',
    '        owner = module.call(home, {"protocol": 1, "verb": "identify", "id": 1, "params": {}})',
    '        verdict["owner_keys"] = sorted(owner)',
    '        verdict["owner_identity"] = {key: owner[key] for key in ("kind", "profile", "supervisor", "state", "runtime_protocol", "authority_epoch", "instance_id", "code_sha", "version", "code_version") if key in owner}',
    '        served = owner.get("served_profiles")',
    '        verdict["served_count"] = len(served) if isinstance(served, list) else None',
    '        verdict["served_keys"] = sorted(served[0]) if isinstance(served, list) and served and isinstance(served[0], dict) else None',
    '    except Exception as inner:',
    '        verdict["identify_error"] = type(inner).__name__ + ": " + str(inner)[:200]',
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
  // docker exec starts with the image's root HOME. Match the upstream main
  // wrapper's runtime HOME as well as its user; a UID-only switch leaves
  // Crashpad trying to write under /root. The probe uses a new private profile
  // and requires namespace/seccomp status from the actual renderer over CDP.
  const result = docker(['exec', '--user', 'hermes', '--env', 'HOME=/opt/data', container,
    '/usr/local/bin/node', '/app/deploy/probe-browser.mjs'], 60000);
  assert.match(result.trim(), /^SANDBOX_OK \([^)]+; zero TCP listeners; .+\)$/,
    'The shipped Chromium must report both sandbox layers enabled and no TCP listener.');
  console.log('Blank-profile browser sandbox probe: ' + result);
}

function verifyRuntimeUsers(container) {
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
  console.log('Runtime service users verified: ' + docker(['exec', container, '/opt/hermes/.venv/bin/python', '-c', script], 30000));
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
      environment: { HOB_SMOKE_ISOLATION: usersIsolation ? 'users' : 'shared', HOB_SMOKE_MODEL_PORT: '18793', HOB_SMOKE_HOST: '0.0.0.0',
        HOB_SMOKE_MCP_BASE: 'http://smoke-model:18793',
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
  const smoke = createHermesSmokeApi({ origin, password, modelUrl: providerTier ? modelUrl : undefined, proactive: true, isolation: usersIsolation,
    authorizeMcp: url => {
      // Only this fixture's URL may be fetched from the private Compose network.
      const target = new URL(url);
      assert.equal(target.origin, 'http://smoke-model:18793');
      assert.equal(target.pathname, '/oauth/authorize');
      const script = "fetch(process.argv[1], {redirect:'manual', signal:AbortSignal.timeout(5000)}).then(r => {if(r.status !== 302) throw Error(); process.stdout.write(JSON.stringify({location:r.headers.get('location')}));}).catch(() => {console.error('Synthetic OAuth redirect failed'); process.exitCode=1;});";
      return JSON.parse(docker(['exec', container, '/usr/local/bin/node', '-e', script, url], 10000)).location;
    } });
  const saved = await smoke.firstBoot();
  verifyRuntimeUsers(container);
  if (usersIsolation) console.log('OS isolation proof: ' + docker(['exec', container, '/usr/bin/python3', '/app/deploy/isolation-proof.py'], 120000));
  console.log('Actual image first boot passed ' + smoke.checks.length + ' authenticated native checks.');
  compose('up', '-d', '--no-build', '--pull', 'never', '--force-recreate', '--wait', '--wait-timeout', '300');
  await ready();
  assert.notEqual(compose('ps', '--quiet', 'muse'), container, 'Recreation must replace the container.');
  await smoke.afterRestart(saved);
  verifyRuntimeUsers(compose('ps', '--quiet', 'muse'));
  if (usersIsolation) console.log('OS isolation after recreation: ' + docker(['exec', compose('ps', '--quiet', 'muse'), '/usr/bin/python3', '/app/deploy/isolation-proof.py'], 120000));
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
