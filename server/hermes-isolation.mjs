import net from 'node:net';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HermesError, hermesProfile } from './hermes-client.mjs';

const unavailable = () => new HermesError(503, 'Per-bot OS isolation is unavailable. No local execution fallback was selected.', 'ISOLATION_UNAVAILABLE');
const SOCKET = '/run/hob-isolation/broker.sock';

export function isolationMode(env = process.env) {
  const mode = env.HOB_ISOLATION || 'shared';
  if (!['shared', 'users'].includes(mode)) throw new Error('HOB_ISOLATION must be shared or users.');
  if (mode === 'users' && process.platform !== 'linux') throw new Error('Per-bot OS users require the Linux deployment.');
  return mode;
}

/** Private root broker protocol. No HTTP route accepts broker operations. */
export function isolationRequest(operation, profile, { socketPath = SOCKET, timeout = 30000 } = {}) {
  if (!['status', 'ensure', 'revoke'].includes(operation)) return Promise.reject(unavailable());
  if (operation !== 'status') hermesProfile(profile);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let bytes = Buffer.alloc(0), settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(unavailable()); else resolve(result);
    };
    const timer = setTimeout(() => finish(true), timeout);
    socket.once('connect', () => socket.write(JSON.stringify({ version: 1, operation, ...(profile ? { profile } : {}) }) + '\n'));
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 16384) return finish(true);
      const end = bytes.indexOf(10);
      if (end < 0) return;
      try {
        const reply = JSON.parse(bytes.subarray(0, end).toString('utf8'));
        if (reply.ok !== true || !reply.result || typeof reply.result !== 'object') return finish(true);
        finish(false, reply.result);
      } catch { finish(true); }
    });
    socket.once('error', () => finish(true));
    socket.once('close', () => { if (!settled) finish(true); });
  });
}

export class HermesBotIsolation {
  #request;
  #ready = new Map();
  constructor({ request = isolationRequest } = {}) { this.#request = request; }

  async configure(client, profile) {
    hermesProfile(profile);
    this.#ready.delete(profile);
    const owner = await this.#request('ensure', profile);
    if (owner.version !== 1 || owner.profile !== profile || !Number.isSafeInteger(owner.uid) || owner.uid < 20000 || owner.uid >= 60000
        || owner.gid !== owner.uid || owner.user !== `hob${owner.uid}` || owner.host !== '127.0.0.1' || owner.port !== 22220
        || typeof owner.workspace !== 'string' || !owner.workspace.startsWith('/') || typeof owner.keyPath !== 'string' || !owner.keyPath.endsWith(`/${profile}.key`)) throw unavailable();
    const terminal = { backend: 'ssh', cwd: owner.workspace, ssh_host: owner.host, ssh_port: owner.port, ssh_user: owner.user, ssh_key: owner.keyPath };
    const current = await client.dashboard('/api/config', { profile });
    if (Object.entries(terminal).some(([key, value]) => current?.terminal?.[key] !== value)) {
      const changed = await client.dashboard('/api/config', { profile, method: 'PUT', body: { profile, config: { terminal } } });
      if (changed?.ok !== true) throw unavailable();
    }
    this.#ready.set(profile, { profile, mode: 'users', uid: owner.uid, ready: true });
    return this.status(profile);
  }

  async ready() {
    const state = await this.#request('status');
    if (state.version !== 1 || state.ready !== true || !Number.isSafeInteger(state.operatorUid) || state.operatorUid <= 0) throw unavailable();
  }

  status(profile) { return this.#ready.get(profile) || { profile, mode: 'users', ready: false }; }
  async revoke(profile) { this.#ready.delete(profile); return this.#request('revoke', hermesProfile(profile)); }

  spawnBrowser(profile, _executable, args, options) {
    hermesProfile(profile);
    // The launcher receives no listener, provider, dashboard or login secrets.
    const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'PYTHONIOENCODING', 'PYTHONDONTWRITEBYTECODE'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    return spawn(process.env.HERMES_PYTHON || 'python3', ['-I', fileURLToPath(new URL('../deploy/isolation-browser-client.py', import.meta.url)), profile, JSON.stringify(args)],
      { ...options, env, windowsHide: true });
  }
}

/** Runs before the native gateway can execute persisted schedules or heartbeats. */
export async function prepareBotIsolation(isolation, client, stateDir, signal) {
  let records = [{ name: 'default', state: 'active' }];
  let handle;
  try {
    handle = await open(path.join(stateDir, 'bots.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw unavailable();
    const value = JSON.parse(await handle.readFile('utf8'));
    if (!Array.isArray(value.bots)) throw unavailable();
    records = value.bots;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { await handle?.close(); }
  // Multiplex serves native profiles beyond the dashboard roster. Refuse an
  // unenrolled profile instead of allowing its schedules to run as the operator.
  const native = await client.dashboard('/api/profiles');
  if (!Array.isArray(native?.profiles)) throw unavailable();
  const enrolled = new Set(records.map(record => record.name));
  if (native.profiles.some(profile => !enrolled.has(profile.name))) throw new HermesError(409,
    'Enroll or remove existing native profiles before enabling per-bot OS isolation.', 'ISOLATION_UNENROLLED_PROFILE');
  // Broker readiness is required even before Main is enrolled by the web process.
  await isolation.ready();
  for (const record of records) {
    signal?.throwIfAborted();
    if (record.state === 'revoked') await isolation.revoke(record.name);
    else if (record.state === 'active' || record.nativeCreated) await isolation.configure(client, record.name);
  }
}
