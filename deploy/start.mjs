import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function bootstrap(env = process.env) {
  if (!env.MUSE_PASSWORD?.trim() && !env.MUSE_ACCESS_TOKEN?.trim()) {
    throw new Error('Set MUSE_PASSWORD before starting OpenMuse.');
  }
  const openclawDir = resolve(env.OPENCLAW_DIR || '/app/openclaw');
  const stateDir = resolve(env.OPENCLAW_STATE_DIR || '/data/openclaw');
  const configPath = resolve(env.OPENCLAW_CONFIG_PATH || join(stateDir, 'openclaw.json'));
  const workspace = resolve(env.OPENCLAW_WORKSPACE || '/data/workspace');
  const port = 18789;
  const childEnv = {
    ...env,
    OPENCLAW_DIR: openclawDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_WORKSPACE: workspace,
    OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${port}`,
    OPENCLAW_GATEWAY_TOKEN: env.OPENCLAW_GATEWAY_TOKEN || randomBytes(32).toString('hex'),
  };
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  if (env.HOME) await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  const config = {
    gateway: {
      mode: 'local', bind: 'loopback', port,
      auth: { mode: 'token', token: { source: 'env', provider: 'default', id: 'OPENCLAW_GATEWAY_TOKEN' } },
      controlUi: { enabled: false },
    },
    agents: { defaults: { workspace }, entries: { main: { name: 'OpenClaw', workspace } } },
    browser: { enabled: true, defaultProfile: 'openclaw', headless: true, noSandbox: false },
  };
  try {
    // Exclusive creation preserves every setting on subsequent starts.
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log('[OpenMuse] Initialized OpenClaw configuration. Add a model provider in Settings.');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return {
    env: childEnv,
    gateway: [join(openclawDir, 'openclaw.mjs'), 'gateway', 'run', '--bind', 'loopback', '--port', String(port), '--auth', 'token', '--token', childEnv.OPENCLAW_GATEWAY_TOKEN],
    server: [resolve(env.MUSE_SERVER_ENTRY || '/app/server/index.mjs')],
    openclawDir,
  };
}

export async function supervise(commands, options = {}) {
  const spawnChild = options.spawnChild || spawn;
  const signals = options.signals || process;
  const shutdownTimeout = options.shutdownTimeout || 30000;
  let stopping = false;
  let failed = false;
  let forceTimer;
  const children = [];
  const completions = [];
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    }, shutdownTimeout);
    forceTimer.unref();
  };
  signals.on('SIGTERM', stop);
  signals.on('SIGINT', stop);
  try {
    for (const [name, args, cwd] of [
      ['Gateway', commands.gateway, commands.openclawDir],
      ['web server', commands.server, undefined],
    ]) {
      const child = spawnChild(process.execPath, args, { cwd, env: commands.env, stdio: 'inherit' });
      children.push(child);
      completions.push(new Promise((resolveExit) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          if (!stopping) {
            failed = true;
            console.error(`[OpenMuse] ${name} stopped unexpectedly${error ? `: ${error.message}` : ''}. Restarting the container is required.`);
            stop();
          }
          resolveExit();
        };
        child.once('error', finish);
        child.once('exit', () => finish());
      }));
    }
    await Promise.all(completions);
    return failed ? 1 : 0;
  } catch (error) {
    stop();
    await Promise.all(completions);
    throw error;
  } finally {
    clearTimeout(forceTimer);
    signals.off('SIGTERM', stop);
    signals.off('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await supervise(await bootstrap());
  } catch (error) {
    console.error(`[OpenMuse] Startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
