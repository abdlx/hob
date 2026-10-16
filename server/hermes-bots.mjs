import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HermesError, hermesProfile } from './hermes-client.mjs';

const LIMIT = 1024 * 1024;
const view = item => ({ name: item.name, state: item.state, created_at: item.createdAt });

// This is the operator's dashboard roster, not a scan of arbitrary profile
// directories. Hermes still owns profile contents, secrets, sessions and runs.
// One application writer owns this file; it is not an OS isolation boundary.
export class HermesBotRegistry {
  #filename;
  #data;
  #queue = Promise.resolve();
  constructor(filename, data) { this.#filename = filename; this.#data = data; }

  static async open({ stateDir, mainApiKey }) {
    if (!/^[a-f0-9]{64}$/.test(mainApiKey || '')) throw new Error('Invalid Main listener credential.');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const filename = path.join(stateDir, 'bots.json');
    const initial = { version: 1, bots: [{ name: 'default', state: 'active', nativeCreated: true,
      apiKey: mainApiKey, createdAt: new Date().toISOString() }] };
    try { await writeFile(filename, JSON.stringify(initial) + '\n', { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > LIMIT) throw new Error('Invalid bot registry.');
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let data;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.dev !== entry.dev || info.ino !== entry.ino || info.size > LIMIT) throw new Error('Invalid bot registry.');
      const bytes = Buffer.alloc(LIMIT + 1);
      let size = 0;
      while (size < bytes.length) {
        const part = await handle.read(bytes, size, bytes.length - size, size);
        if (!part.bytesRead) break;
        size += part.bytesRead;
      }
      if (size > LIMIT) throw new Error('Invalid bot registry.');
      data = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    } finally { await handle.close(); }
    if (data?.version !== 1 || !Array.isArray(data.bots) || data.bots.length > 500) throw new Error('Invalid bot registry.');
    const names = new Set();
    const keys = new Set();
    for (const item of data.bots) {
      hermesProfile(item.name);
      if (!['active', 'setup_required', 'revoked'].includes(item.state) || names.has(item.name)
        || !/^[a-f0-9]{64}$/.test(item.apiKey || '') || keys.has(item.apiKey)
        || typeof item.nativeCreated !== 'boolean' || typeof item.createdAt !== 'string') throw new Error('Invalid bot registry.');
      names.add(item.name); keys.add(item.apiKey);
    }
    const main = data.bots.find(item => item.name === 'default');
    if (main?.state !== 'active' || main.apiKey !== mainApiKey) throw new Error('Main bot registry and listener credentials disagree. Restore their matching backup.');
    return new HermesBotRegistry(filename, data);
  }

  list() { return this.#data.bots.filter(item => item.state !== 'revoked').map(view); }
  #record(name) {
    const item = this.#data.bots.find(item => item.name === hermesProfile(name));
    if (!item || item.state === 'revoked') throw new HermesError(404, 'This bot is not in your dashboard.', 'BOT_NOT_FOUND');
    return item;
  }
  token(name) {
    const item = this.#record(name);
    if (item.state !== 'active') throw new HermesError(409, 'Finish this bot’s setup before using it.', 'BOT_SETUP_REQUIRED');
    return item.apiKey;
  }
  setup(name) { return { ...this.#record(name) }; }
  async #mutate(change) {
    const work = this.#queue.then(async () => {
      const data = structuredClone(this.#data);
      const result = change(data);
      const filename = this.#filename + '.' + randomBytes(8).toString('hex') + '.tmp';
      try {
        await writeFile(filename, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600, flush: true });
        await rename(filename, this.#filename);
        this.#data = data;
      } finally { await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return result;
    });
    this.#queue = work.catch(() => undefined);
    return work;
  }
  async reserve(name) {
    hermesProfile(name);
    return this.#mutate(data => {
      if (data.bots.some(item => item.name === name)) throw new HermesError(409, 'This bot name already has a dashboard record. Finish its setup or use another name.', 'BOT_EXISTS');
      if (data.bots.length >= 500) throw new HermesError(409, 'The bot roster limit has been reached.', 'BOT_LIMIT');
      const item = { name, state: 'setup_required', nativeCreated: false, apiKey: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
      data.bots.push(item);
      return view(item);
    });
  }
  async update(name, patch) {
    return this.#mutate(data => {
      const item = data.bots.find(item => item.name === name);
      if (!item || (item.state === 'revoked' && patch.state !== 'revoked')) throw new HermesError(404, 'This bot is not in your dashboard.', 'BOT_NOT_FOUND');
      Object.assign(item, patch);
      return view(item);
    });
  }
}

export class HermesBots {
  #registry;
  #client;
  #workspaceRoot;
  #settingUp = new Set();
  constructor({ registry, client, workspaceRoot }) {
    this.#registry = registry; this.#client = client; this.#workspaceRoot = path.resolve(workspaceRoot);
  }
  async list() {
    const native = await this.#client.dashboard('/api/profiles');
    if (!Array.isArray(native.profiles)) throw new HermesError(502, 'Hermes returned an invalid bot roster.', 'HERMES_PROTOCOL_ERROR');
    return { profiles: this.#registry.list().map(item => {
      const profile = native.profiles.find(profile => profile.name === item.name);
      return { ...profile, ...item, ...(item.state === 'active' && !profile ? { state: 'unavailable' } : {}) };
    }) };
  }
  async create(proposal) {
    const native = await this.#client.dashboard('/api/profiles');
    if (!Array.isArray(native.profiles)) throw new HermesError(502, 'Hermes returned an invalid bot roster.', 'HERMES_PROTOCOL_ERROR');
    if (native.profiles.some(item => item.name === proposal.name)) throw new HermesError(409, 'A Hermes profile already uses that name. Choose a new bot name.', 'BOT_EXISTS');
    await this.#registry.reserve(proposal.name);
    const created = await this.#client.dashboard('/api/profiles', { method: 'POST', body: proposal });
    if (created?.ok !== true || created.name !== proposal.name) throw new HermesError(502, 'Hermes did not confirm this bot’s creation. Refresh the roster before taking further action.', 'BOT_CREATION_UNCERTAIN');
    await this.#registry.update(proposal.name, { nativeCreated: true });
    return this.finishSetup(proposal.name);
  }
  async finishSetup(name, { confirmExisting = false } = {}) {
    const record = this.#registry.setup(name);
    if (record.state === 'active') return { ok: true, name, state: 'active' };
    if (this.#settingUp.has(name)) throw new HermesError(409, 'Bot setup is already running.', 'BOT_SETUP_ACTIVE');
    if (!record.nativeCreated && !confirmExisting) throw new HermesError(409,
      'Profile creation was not confirmed. Explicitly confirm the existing profile before finishing setup.', 'BOT_CREATION_UNCERTAIN');
    this.#settingUp.add(name);
    try {
      const native = await this.#client.dashboard('/api/profiles');
      if (!native.profiles?.some(item => item.name === name)) throw new HermesError(409, 'The native profile is missing. Nothing was recreated or activated.', 'BOT_PROFILE_MISSING');
      const workspace = path.join(this.#workspaceRoot, name);
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const entry = await lstat(workspace);
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || path.dirname(await realpath(workspace)) !== await realpath(this.#workspaceRoot)) {
        throw new HermesError(409, 'The bot workspace is not an independent directory. Nothing was activated.', 'BOT_WORKSPACE_INVALID');
      }
      this.#registry.setup(name);
      await this.#client.dashboard('/api/config', { profile: name, method: 'PUT',
        body: { profile: name, config: { terminal: { cwd: workspace }, auth: { adopt_external_logins: false } } } });
      this.#registry.setup(name);
      await this.#client.dashboard('/api/env', { profile: name, method: 'PUT',
        body: { profile: name, key: 'API_SERVER_KEY', value: record.apiKey } });
      await this.#registry.update(name, { nativeCreated: true, state: 'active' });
      return { ok: true, name, state: 'active' };
    } finally { this.#settingUp.delete(name); }
  }
  async remove(name) {
    if (name === 'default') throw new HermesError(400, 'The Main bot cannot be deleted.', 'INVALID_PROFILE');
    await this.#registry.update(name, { state: 'revoked' });
    return this.#client.dashboard(`/api/profiles/${hermesProfile(name)}`, { method: 'DELETE' });
  }
}
