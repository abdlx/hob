import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import test from 'node:test';
import { bootstrap, supervise } from './start.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'openmuse-deploy-'));
  try {
    await run({
      MUSE_PASSWORD: 'synthetic-test-password',
      OPENCLAW_DIR: join(root, 'backend'),
      OPENCLAW_STATE_DIR: join(root, 'state'),
      OPENCLAW_CONFIG_PATH: join(root, 'state', 'openclaw.json'),
      OPENCLAW_WORKSPACE: join(root, 'workspace'),
    });
  } finally {
    // Delete only the fixture's verified direct child of the system temp directory.
    assert.equal(relative(tmpdir(), root), basename(root));
    assert.ok(basename(root).startsWith('openmuse-deploy-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('first launch initializes a private local Gateway and shared adapter token', async () => {
  await fixture(async (env) => {
    const commands = await bootstrap(env);
    const config = JSON.parse(await readFile(env.OPENCLAW_CONFIG_PATH, 'utf8'));
    assert.equal(config.gateway.bind, 'loopback');
    assert.equal(config.agents.defaults.workspace, env.OPENCLAW_WORKSPACE);
    assert.deepEqual(config.agents.entries, { main: { name: 'OpenClaw', workspace: env.OPENCLAW_WORKSPACE } });
    assert.equal(config.browser.noSandbox, false);
    assert.deepEqual(config.gateway.auth.token, { source: 'env', provider: 'default', id: 'OPENCLAW_GATEWAY_TOKEN' });
    assert.equal(commands.env.OPENCLAW_GATEWAY_URL, 'ws://127.0.0.1:18789');
    assert.equal(commands.gateway.at(-1), commands.env.OPENCLAW_GATEWAY_TOKEN);
    assert.match(commands.env.OPENCLAW_GATEWAY_TOKEN, /^[0-9a-f]{64}$/);
  });
});

test('restarting preserves existing configuration bytes and operator settings', async () => {
  await fixture(async (env) => {
    await bootstrap(env);
    const userConfig = '{\n  // Operator config with comments\n  models: { provider: "custom" }\n}\n';
    await writeFile(env.OPENCLAW_CONFIG_PATH, userConfig);
    await bootstrap(env);
    assert.equal(await readFile(env.OPENCLAW_CONFIG_PATH, 'utf8'), userConfig);
  });
});

test('startup requires an app credential', async () => {
  await assert.rejects(bootstrap({}), /Set MUSE_PASSWORD/);
});

function child() {
  const process = new EventEmitter();
  process.exitCode = null;
  process.receivedSignals = [];
  process.kill = (signal) => {
    process.receivedSignals.push(signal);
    queueMicrotask(() => {
      process.exitCode = 0;
      process.emit('exit', 0, signal);
    });
    return true;
  };
  return process;
}

test('unexpected child exit shuts down its sibling and fails container startup', async () => {
  const signals = new EventEmitter();
  const children = [child(), child()];
  let index = 0;
  const completion = supervise({ gateway: [], server: [], env: {} }, {
    signals, spawnChild: () => children[index++],
  });
  children[0].exitCode = 1;
  children[0].emit('exit', 1);
  assert.equal(await completion, 1);
  assert.deepEqual(children[1].receivedSignals, ['SIGTERM']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('container termination signals both children and exits normally', async () => {
  const signals = new EventEmitter();
  const children = [child(), child()];
  let index = 0;
  const completion = supervise({ gateway: [], server: [], env: {} }, {
    signals, spawnChild: () => children[index++],
  });
  signals.emit('SIGTERM');
  assert.equal(await completion, 0);
  assert.deepEqual(children.map((item) => item.receivedSignals), [['SIGTERM'], ['SIGTERM']]);
});

test('a synchronous server launch error cleans up the already-started Gateway', async () => {
  const signals = new EventEmitter();
  const gateway = child();
  let index = 0;
  await assert.rejects(supervise({ gateway: [], server: [], env: {} }, {
    signals,
    spawnChild: () => {
      if (index++ === 0) return gateway;
      throw new Error('synthetic spawn failure');
    },
  }), /synthetic spawn failure/);
  assert.deepEqual(gateway.receivedSignals, ['SIGTERM']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
