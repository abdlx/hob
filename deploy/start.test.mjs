import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { bootstrap, supervise } from './start.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'hob-hermes-deploy-'));
  try {
    await run({
      HOB_PASSWORD: 'synthetic-test-password',
      HOB_SESSION_SECRET: 'synthetic-session-secret',
      HOB_EXPO_ACCESS_TOKEN: 'synthetic-private-push-token',
      HERMES_DIR: join(root, 'backend'),
      HERMES_HOME: join(root, 'hermes'),
      HOB_STATE_DIR: join(root, 'private-state'),
      HOB_MAIN_WORKSPACE: join(root, 'workspace'),
    });
  } finally {
    assert.equal(relative(tmpdir(), root), basename(root));
    assert.ok(basename(root).startsWith('hob-hermes-deploy-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('fresh startup provisions three services and private local listener credentials, with no provider requirement', async () => {
  await fixture(async env => {
    const commands = await bootstrap(env);
    const config = JSON.parse(await readFile(join(env.HERMES_HOME, 'config.yaml'), 'utf8'));
    assert.deepEqual(config, { gateway: { multiplex_profiles: true }, terminal: { cwd: env.HOB_MAIN_WORKSPACE },
      auth: { adopt_external_logins: false } });
    const [dashboard, runtime, app] = commands.processes;
    assert.deepEqual(dashboard.args, ['-p', 'default', 'serve', '--host', '127.0.0.1', '--port', '8080', '--isolated']);
    assert.deepEqual(runtime.args, ['-p', 'default', 'gateway', 'run', '--no-supervise', '--external-supervisor']);
    assert.equal(runtime.restart, true);
    assert.equal(runtime.cwd, env.HOB_MAIN_WORKSPACE);
    assert.equal(runtime.env.API_SERVER_HOST, '127.0.0.1');
    assert.equal(runtime.env.API_SERVER_PORT, '8642');
    assert.equal(runtime.env.GATEWAY_MULTIPLEX_PROFILES, 'true');
    assert.equal(runtime.env.HERMES_GATEWAY_EXTERNAL_SUPERVISOR, '1');
    assert.match(runtime.env.API_SERVER_KEY, /^[a-f0-9]{64}$/);
    assert.equal(app.env.API_SERVER_KEY, runtime.env.API_SERVER_KEY);
    assert.match(dashboard.env.HERMES_DASHBOARD_SESSION_TOKEN, /^[a-f0-9]{64}$/);
    assert.equal(app.env.HERMES_DASHBOARD_SESSION_TOKEN, dashboard.env.HERMES_DASHBOARD_SESSION_TOKEN);
    assert.notEqual(runtime.env.API_SERVER_KEY, dashboard.env.HERMES_DASHBOARD_SESSION_TOKEN);
    assert.equal(app.env.HERMES_API_URL, 'http://127.0.0.1:8642');
    assert.equal(app.env.HERMES_DASHBOARD_URL, 'http://127.0.0.1:8080');
    for (const command of commands.processes) {
      assert.equal(command.args.join(' ').includes(runtime.env.API_SERVER_KEY), false);
      assert.equal(command.args.join(' ').includes(dashboard.env.HERMES_DASHBOARD_SESSION_TOKEN), false);
    }
  });
});

test('runtime environment excludes dashboard authority and application login/session credentials', async () => {
  await fixture(async env => {
    const { processes: [dashboard, runtime, app] } = await bootstrap({
      ...env, HERMES_DASHBOARD_SESSION_TOKEN: 'do-not-inherit', HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: 'do-not-inherit',
    });
    for (const key of ['HOB_PASSWORD', 'HOB_SESSION_SECRET', 'HERMES_DASHBOARD_SESSION_TOKEN', 'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD', 'HOB_STATE_DIR', 'HOB_EXPO_ACCESS_TOKEN']) {
      assert.equal(runtime.env[key], undefined, key);
    }
    assert.equal(dashboard.env.HOB_PASSWORD, undefined);
    assert.equal(app.env.HOB_PASSWORD, env.HOB_PASSWORD);
  });
});

test('restart preserves exact user configuration bytes and listener credentials', async () => {
  await fixture(async env => {
    const first = await bootstrap(env);
    const operatorConfig = '# Operator-owned YAML\nmodel:\n  default: custom-model\nterminal:\n  backend: ssh\n';
    await writeFile(join(env.HERMES_HOME, 'config.yaml'), operatorConfig);
    const second = await bootstrap(env);
    assert.equal(await readFile(join(env.HERMES_HOME, 'config.yaml'), 'utf8'), operatorConfig);
    assert.equal(first.processes[2].env.API_SERVER_KEY, second.processes[2].env.API_SERVER_KEY);
    assert.equal(first.processes[2].env.HERMES_DASHBOARD_SESSION_TOKEN, second.processes[2].env.HERMES_DASHBOARD_SESSION_TOKEN);
  });
});

test('MCP callback origin is provisioned only to settings from the explicit application origin', async () => {
  await fixture(async env => {
    const { processes: [settings, runtime, app] } = await bootstrap({ ...env,
      HOB_PUBLIC_URL: 'https://dashboard.example/', HERMES_DASHBOARD_PUBLIC_URL: 'https://other.invalid' });
    assert.equal(settings.env.HERMES_DASHBOARD_PUBLIC_URL, 'https://dashboard.example');
    // A declared public URL engages Hermes' dashboard auth gate, which would replace the
    // operator-minted session token on the private loopback listener. Only settings is marked
    // as that operator-owned loopback backend; the runtime and web server never are.
    assert.equal(settings.env.HERMES_DESKTOP, '1');
    assert.equal(runtime.env.HERMES_DASHBOARD_PUBLIC_URL, undefined);
    assert.equal(runtime.env.HERMES_DESKTOP, undefined);
    assert.equal(app.env.HOB_PUBLIC_URL, 'https://dashboard.example/');
    assert.equal(app.env.HERMES_DESKTOP, undefined);
    const malformed = await bootstrap({ ...env, HOB_PUBLIC_URL: 'https://dashboard.example/other' });
    assert.equal(malformed.processes[0].env.HERMES_DASHBOARD_PUBLIC_URL, undefined);
    assert.equal(malformed.processes[0].env.HERMES_DESKTOP, undefined);
  });
});

test('corrupt listener state fails closed without rotating or overwriting existing bytes', async () => {
  await fixture(async env => {
    await bootstrap(env);
    const filename = join(env.HOB_STATE_DIR, 'listener-auth.json');
    await writeFile(filename, '{corrupt');
    await assert.rejects(bootstrap(env), /not regenerated/);
    assert.equal(await readFile(filename, 'utf8'), '{corrupt');
  });
});

test('startup requires an app credential before creating any runtime state', async () => {
  await assert.rejects(bootstrap({}), /Set HOB_PASSWORD/);
});

test('oversized listener state is rejected without replacing it', async () => {
  await fixture(async env => {
    await bootstrap(env);
    const filename = join(env.HOB_STATE_DIR, 'listener-auth.json');
    const original = 'x'.repeat(4097);
    await writeFile(filename, original);
    await assert.rejects(bootstrap(env), /Invalid Hermes listener credential file/);
    assert.equal(await readFile(filename, 'utf8'), original);
  });
});

test('hard-linked listener state is refused rather than borrowing another file as authority', async () => {
  await fixture(async env => {
    await bootstrap(env);
    const filename = join(env.HOB_STATE_DIR, 'listener-auth.json');
    const original = await readFile(filename, 'utf8');
    await link(filename, join(env.HOB_STATE_DIR, 'other-auth.json'));
    await assert.rejects(bootstrap(env), /Invalid Hermes listener credential file/);
    assert.equal(await readFile(filename, 'utf8'), original);
  });
});

function child() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.receivedSignals = [];
  proc.kill = signal => {
    proc.receivedSignals.push(signal);
    queueMicrotask(() => { proc.exitCode = 0; proc.emit('exit', 0, signal); });
    return true;
  };
  return proc;
}
const specs = () => ({ processes: [
  { name: 'Settings', executable: 'hermes', args: ['serve'], env: {} },
  { name: 'Web', executable: process.execPath, args: ['server.mjs'], env: {} },
] });

test('a critical settings or web service failure stops siblings and fails the container', async () => {
  const signals = new EventEmitter();
  const children = [child(), child()];
  let index = 0;
  const completion = supervise(specs(), { signals, spawnChild: () => children[index++] });
  children[0].exitCode = 1; children[0].emit('exit', 1);
  assert.equal(await completion, 1);
  assert.deepEqual(children[1].receivedSignals, ['SIGTERM']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('shutdown signals every running service and removes its handlers', async () => {
  const signals = new EventEmitter();
  const children = [child(), child()];
  let index = 0;
  const completion = supervise(specs(), { signals, spawnChild: () => children[index++] });
  signals.emit('SIGTERM');
  assert.equal(await completion, 0);
  assert.deepEqual(children.map(item => item.receivedSignals), [['SIGTERM'], ['SIGTERM']]);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('synchronous launch failure joins cleanup of already running services', async () => {
  const signals = new EventEmitter();
  const first = child();
  let index = 0;
  await assert.rejects(supervise(specs(), {
    signals, spawnChild: () => { if (index++ === 0) return first; throw new Error('synthetic spawn failure'); },
  }), /synthetic spawn failure/);
  assert.deepEqual(first.receivedSignals, ['SIGTERM']);
});

test('an agent runtime crash restarts only that service while Settings and web stay alive', async () => {
  const signals = new EventEmitter();
  const settings = child(), web = child(), firstRuntime = child(), nextRuntime = child();
  let index = 0, restarted;
  const restartObserved = new Promise(resolve => { restarted = resolve; });
  const commands = specs();
  commands.processes.push({ name: 'Runtime', executable: 'hermes', args: ['gateway', 'run'], env: {}, restart: true });
  const completion = supervise(commands, { signals, restartDelayMs: 1, spawnChild: (_file, _args, options) => {
    assert.equal(options.windowsHide, true);
    const proc = [settings, web, firstRuntime, nextRuntime][index++];
    if (index === 4) queueMicrotask(restarted);
    return proc;
  } });
  firstRuntime.exitCode = 1; firstRuntime.emit('exit', 1);
  await restartObserved;
  assert.deepEqual(settings.receivedSignals, []);
  assert.deepEqual(web.receivedSignals, []);
  signals.emit('SIGTERM');
  assert.equal(await completion, 0);
  assert.deepEqual(nextRuntime.receivedSignals, ['SIGTERM']);
});

test('shutdown cancels a pending runtime retry without waiting for the backoff', async () => {
  const signals = new EventEmitter();
  const runtime = child();
  let count = 0;
  const completion = supervise({ processes: [{ name: 'Runtime', executable: 'hermes', args: [], env: {}, restart: true }] },
    { signals, restartDelayMs: 60000, spawnChild: () => { count++; return runtime; } });
  runtime.exitCode = 1; runtime.emit('exit', 1);
  await setImmediate();
  signals.emit('SIGTERM');
  assert.equal(await completion, 0);
  assert.equal(count, 1);
});

test('runtime preparation completes before launch while web and settings remain available', async () => {
  const signals = new EventEmitter();
  const launches = [];
  let finishPreparation;
  const prepared = new Promise(resolve => { finishPreparation = resolve; });
  const commands = specs();
  commands.processes.push({ name: 'Runtime', executable: 'runtime', args: [], env: {}, prepare: () => prepared });
  const completion = supervise(commands, { signals, spawnChild: file => { launches.push(file); return child(); } });
  assert.deepEqual(launches, ['hermes', process.execPath]);
  finishPreparation();
  await setImmediate();
  assert.equal(launches.at(-1), 'runtime');
  signals.emit('SIGTERM');
  assert.equal(await completion, 0);
});

test('shutdown aborts runtime preparation without launching a stale runtime', async () => {
  const signals = new EventEmitter();
  let launches = 0;
  const commands = specs();
  commands.processes.push({ name: 'Runtime', executable: 'runtime', args: [], env: {}, prepare: ({ signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const completion = supervise(commands, { signals, spawnChild: () => { launches++; return child(); } });
  signals.emit('SIGTERM');
  assert.equal(await completion, 0);
  assert.equal(launches, 2);
});


test('global browser endpoint overrides cannot merge bot cookie jars at startup', async () => {
  await fixture(async env => {
    const commands = await bootstrap({ ...env, BROWSER_CDP_URL: 'http://127.0.0.1:9222', BU_CDP_URL: 'http://127.0.0.1:9222', BU_CDP_WS: 'ws://127.0.0.1:9222' });
    for (const process of commands.processes) {
      for (const key of ['BROWSER_CDP_URL', 'BU_CDP_URL', 'BU_CDP_WS']) assert.equal(process.env[key], undefined);
    }
  });
});
