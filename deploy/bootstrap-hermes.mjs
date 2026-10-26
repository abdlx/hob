import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedHermesConfig } from './seed-hermes-config.mjs';
import { prepareHermesRuntime } from './prepare-hermes-runtime.mjs';
import { HermesBotIsolation, isolationMode, prepareBotIsolation } from '../server/hermes-isolation.mjs';
import { mcpOAuthOrigin } from '../server/hermes-mcp-oauth.mjs';

async function listenerCredentials(filename) {
  const candidate = { version: 1, apiKey: randomBytes(32).toString('hex'), dashboardToken: randomBytes(32).toString('hex') };
  try { await writeFile(filename, JSON.stringify(candidate) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const entry = await lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Invalid Hermes listener credential file.');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || info.dev !== entry.dev || info.ino !== entry.ino) throw new Error('Invalid Hermes listener credential file.');
    const bytes = Buffer.alloc(4097);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > 4096) throw new Error('Invalid Hermes listener credential file.');
    let value;
    try { value = JSON.parse(bytes.subarray(0, size).toString('utf8')); }
    catch { throw new Error('Hermes listener credentials are unreadable. Restore the private state backup; credentials were not regenerated.'); }
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.apiKey) || !/^[a-f0-9]{64}$/.test(value.dashboardToken)) {
      throw new Error('Invalid Hermes listener credentials. Restore the private state backup; credentials were not regenerated.');
    }
    return value;
  } finally { await handle.close(); }
}

const without = (env, pattern) => Object.fromEntries(Object.entries(env).filter(([key]) => !pattern.test(key)));

export async function bootstrapHermes(env = process.env) {
  if (!env.MUSE_PASSWORD?.trim() && !env.MUSE_ACCESS_TOKEN?.trim()) throw new Error('Set MUSE_PASSWORD before starting hob.');
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const hermesDir = resolve(env.HERMES_DIR || join(projectDir, 'hermes-agent'));
  const home = resolve(env.HERMES_HOME || join(projectDir, '.muse-data', 'hermes'));
  const stateDir = resolve(env.HOB_STATE_DIR || join(home, '.hob'));
  const workspace = resolve(env.HOB_MAIN_WORKSPACE || join(home, 'workspaces', 'main'));
  for (const directory of [home, stateDir, workspace]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const credentials = await listenerCredentials(join(stateDir, 'listener-auth.json'));
  await seedHermesConfig(home, workspace);

  // A process-wide CDP override would send every bot to the same cookie jar.
  const mode = isolationMode(env);
  if (mode !== 'users') {
    try { await lstat(join(stateDir, 'isolation-enabled')); throw new Error('This home requires HOB_ISOLATION=users and its isolation volume.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const browserEnv = without(env, /^(?:BROWSER_CDP_URL|BU_CDP_URL|BU_CDP_WS)$/);
  if (mode === 'users') for (const key of Object.keys(browserEnv)) if (/^(?:TERMINAL_ENV|TERMINAL_CWD|TERMINAL_SSH_.*)$/.test(key)) delete browserEnv[key];
  const shared = { ...browserEnv, HERMES_HOME: home, HERMES_DIR: hermesDir,
    API_SERVER_KEY: credentials.apiKey, API_SERVER_HOST: '127.0.0.1', API_SERVER_PORT: '8642',
    GATEWAY_MULTIPLEX_PROFILES: 'true', HERMES_DASHBOARD: '0' };
  // Environment separation does not replace an execution sandbox.
  const runtimeEnv = without(shared, /^(?:MUSE_|HOB_|HERMES_DASHBOARD_)/);
  // Keep foreground ownership with our supervisor, including in an s6 image.
  // The explicit profile also prevents a sticky CLI selection redirecting Main.
  runtimeEnv.HERMES_GATEWAY_EXTERNAL_SUPERVISOR = '1';
  const dashboardEnv = { ...without(shared, /^(?:MUSE_|HOB_|HERMES_DASHBOARD_)/),
    HERMES_DASHBOARD_SESSION_TOKEN: credentials.dashboardToken };
  const publicOrigin = mcpOAuthOrigin(env.MUSE_PUBLIC_URL);
  if (publicOrigin) {
    dashboardEnv.HERMES_DASHBOARD_PUBLIC_URL = publicOrigin;
    // Declaring dashboard.public_url makes Hermes refuse the loopback bind unless a dashboard
    // auth provider is registered, and a registered provider replaces the operator-minted
    // session token this server sends to the private listener. Hermes' operator-owned loopback
    // backend (its spawn flag plus that token) keeps the loopback token authoritative on a
    // 127.0.0.1 bind while dashboard.public_url still supplies the public MCP OAuth redirect
    // origin. Only the settings listener receives it; the runtime never does.
    dashboardEnv.HERMES_DESKTOP = '1';
  }
  const appEnv = { ...shared, HOB_STATE_DIR: stateDir, HERMES_DASHBOARD_SESSION_TOKEN: credentials.dashboardToken,
    HERMES_API_URL: 'http://127.0.0.1:8642', HERMES_DASHBOARD_URL: 'http://127.0.0.1:8080' };
  const hermes = env.HERMES_EXECUTABLE || 'hermes';
  return {
    processes: [
      { name: 'Hermes settings', executable: hermes, args: ['-p', 'default', 'serve', '--host', '127.0.0.1', '--port', '8080', '--isolated'], cwd: home, env: dashboardEnv },
      { name: 'Hermes agent runtime', executable: hermes, args: ['-p', 'default', 'gateway', 'run', '--no-supervise', '--external-supervisor'], cwd: workspace, env: runtimeEnv, restart: true,
        prepare: ({ signal }) => prepareHermesRuntime({ dashboardUrl: appEnv.HERMES_DASHBOARD_URL,
          dashboardToken: credentials.dashboardToken, apiKey: credentials.apiKey, signal,
          prepareIsolation: mode === 'users' ? (client, signal) => prepareBotIsolation(new HermesBotIsolation(), client, stateDir, signal) : undefined }) },
      { name: 'hob web server', executable: process.execPath, args: [resolve(env.MUSE_SERVER_ENTRY || join(projectDir, 'server', 'index.mjs'))], cwd: projectDir, env: appEnv },
    ],
    home, stateDir, workspace,
  };
}
