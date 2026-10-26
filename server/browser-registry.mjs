import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const LIMIT = 1024 * 1024;
const PORT_FLOOR = 32100;
const PORT_CEILING = 32999;

// Bot ids come from Hermes profile names, but this file is also read back from
// disk, so every id is re-validated on load before it is ever turned into a path.
export function validBotId(botId) {
  return typeof botId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(botId);
}

// A stable port per bot so the profile's `browser.cdp_url` is written once and
// never has to be rewritten when the gateway is restarted. Deterministic from
// the bot id; the port is only bound while that bot's browser is running.
export function portForBot(botId) {
  let hash = 2166136261;
  for (const char of botId) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return PORT_FLOOR + ((hash >>> 0) % (PORT_CEILING - PORT_FLOOR));
}

/**
 * Where this bot's port search starts for one install.
 *
 * The install contributes an offset, because the bot id alone is not unique across
 * installs: a development tree next to a deployed one has the same `default` bot,
 * and both would otherwise begin their search at the same port and race for it.
 * Within one install the result is stable forever, which is what the profile's
 * `browser.cdp_url` needs.
 */
export function preferredPortFor(botId, stateDir) {
  let hash = 2166136261;
  for (const char of String(stateDir ?? '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  const span = PORT_CEILING - PORT_FLOOR + 1;
  return PORT_FLOOR + ((((hash >>> 0) % span) + (portForBot(botId) - PORT_FLOOR)) % span);
}

/**
 * Is this exact loopback port free to bind?
 *
 * The preferred port is derived from the bot id, but nothing else on the machine
 * knows that: a second HOB instance, a leftover process from a crashed run, or a
 * colleague's unrelated service can already hold it. A port that is chosen without
 * being checked is not an allocation, it is a guess, so the first time a bot is
 * registered its port is verified and the search walks forward on a collision.
 */
function loopbackPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    const done = free => { probe.removeAllListeners(); try { probe.close(); } catch { /* never listened */ } resolve(free); };
    probe.once('error', () => done(false));
    probe.once('listening', () => done(true));
    probe.listen(port, '127.0.0.1');
  });
}

const PORT_SEARCH_LIMIT = 64;

const view = record => ({ ...record });
const fresh = (botId, gatewayPort) => ({
  bot: botId,
  browserProfileId: `br-${randomBytes(8).toString('hex')}`,
  storageVersion: 2,
  gatewayPort,
  // Stable per-bot credential for the loopback CDP gateway. It is written into
  // this bot's Hermes profile as part of `browser.cdp_url` and read back on
  // every agent CDP request, so it must not change between browser restarts.
  gatewayToken: randomBytes(16).toString('hex'),
  createdAt: new Date().toISOString(),
  lastActiveAt: null,
});

// One application writer owns this file, exactly like HermesBotRegistry. It is a
// roster of HOB-owned browser profiles, not an isolation boundary, and never
// stores page content, cookies or credentials.
export class BrowserRegistry {
  #filename;
  #data;
  #stateDir;
  #profileRoot;
  #queue = Promise.resolve();
  constructor(filename, data, stateDir, profileRoot) { this.#filename = filename; this.#data = data; this.#stateDir = stateDir; this.#profileRoot = profileRoot; }

  static async open({ stateDir, profileRoot }) {
    if (typeof stateDir !== 'string' || !stateDir) throw new Error('A state directory is required for the browser registry.');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const filename = path.join(stateDir, 'browsers.json');
    try { await writeFile(filename, JSON.stringify({ version: 1, browsers: [] }) + '\n', { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > LIMIT) throw new Error('Invalid browser registry.');
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let data;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.dev !== entry.dev || info.ino !== entry.ino || info.size > LIMIT) throw new Error('Invalid browser registry.');
      const bytes = Buffer.alloc(LIMIT + 1);
      let size = 0;
      while (size < bytes.length) {
        const part = await handle.read(bytes, size, bytes.length - size, size);
        if (!part.bytesRead) break;
        size += part.bytesRead;
      }
      if (size > LIMIT) throw new Error('Invalid browser registry.');
      data = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    } finally { await handle.close(); }
    if (data?.version !== 1 || !Array.isArray(data.browsers) || data.browsers.length > 500) throw new Error('Invalid browser registry.');
    const seen = new Set();
    const ports = new Set();
    const tokens = new Set();
    const profiles = new Set();
    for (const record of data.browsers) {
      if (!validBotId(record?.bot) || seen.has(record.bot) || !/^br-[a-f0-9]{16}$/.test(record.browserProfileId || '')
        || !(record.storageVersion === undefined || record.storageVersion === 2)
        || !Number.isInteger(record.gatewayPort) || record.gatewayPort < 1024 || record.gatewayPort > 65535
        || !/^[a-f0-9]{32}$/.test(record.gatewayToken || '')
        || ports.has(record.gatewayPort) || tokens.has(record.gatewayToken) || profiles.has(record.browserProfileId)
        || typeof record.createdAt !== 'string' || !(record.lastActiveAt === null || typeof record.lastActiveAt === 'string')) {
        throw new Error('Invalid browser registry.');
      }
      seen.add(record.bot);
      ports.add(record.gatewayPort);
      tokens.add(record.gatewayToken);
      profiles.add(record.browserProfileId);
    }
    return new BrowserRegistry(filename, data, stateDir, profileRoot ? path.resolve(profileRoot) : undefined);
  }

  get(botId) {
    if (!validBotId(botId)) return null;
    const record = this.#data.browsers.find(item => item.bot === botId);
    return record ? view(record) : null;
  }

  list() { return this.#data.browsers.map(view); }

  /**
   * Register a bot on first use and hand back its stable browser identity. The
   * port is verified free before it is recorded; `portFree` is injectable so the
   * unit tests stay hermetic and do not depend on the machine's real ports.
   */
  async getOrCreate(botId, { portFree = loopbackPortFree } = {}) {
    if (!validBotId(botId)) throw new Error('Invalid bot id.');
    const existing = this.#data.browsers.find(item => item.bot === botId);
    if (existing) return view(existing);
    return this.#mutate(async data => {
      const duplicate = data.browsers.find(item => item.bot === botId);
      if (duplicate) return view(duplicate);
      if (data.browsers.length >= 500) throw new Error('The browser registry is full.');
      const gatewayPort = await this.#pickPort(botId, portFree);
      const record = fresh(botId, gatewayPort);
      data.browsers.push(record);
      return view(record);
    });
  }

  /**
   * Check the preferred port first, then walk forward. The
   * preferred port is only a preference: a leftover process, an unrelated service
   * on the same port, or another install can already hold it, and a port that is
   * chosen without being checked is a guess rather than an allocation.
   */
  async #pickPort(botId, portFree) {
    const span = PORT_CEILING - PORT_FLOOR + 1;
    const start = preferredPortFor(botId, this.#stateDir) - PORT_FLOOR;
    // Ports already promised to another bot count as taken even though nothing is
    // bound to them yet: two bot ids can hash to the same port, and only one of
    // them can ever bind it.
    const promised = new Set(this.#data.browsers.map(item => item.gatewayPort));
    for (let offset = 0; offset < PORT_SEARCH_LIMIT; offset += 1) {
      const port = PORT_FLOOR + ((start + offset) % span);
      if (promised.has(port)) continue;
      if (await portFree(port)) return port;
    }
    throw new Error('No free loopback port is available for this bot’s browser gateway.');
  }

  update(botId, patch) {
    if (!validBotId(botId)) throw new Error('Invalid bot id.');
    return this.#mutate(data => {
      const record = data.browsers.find(item => item.bot === botId);
      if (!record) throw new Error('This bot has no browser record.');
      for (const key of Object.keys(patch)) if (!['lastActiveAt'].includes(key)) throw new Error(`Browser record field "${key}" is not writable.`);
      Object.assign(record, patch);
      return view(record);
    });
  }

  async remove(botId) {
    if (!validBotId(botId)) return false;
    return this.#mutate(data => {
      const index = data.browsers.findIndex(item => item.bot === botId);
      if (index === -1) return false;
      data.browsers.splice(index, 1);
      return true;
    });
  }

  // The profile directory is derived, never stored: a recorded path could be
  // forged to point at another bot's profile. Records created before storage v2
  // keep their legacy location so upgrades never orphan existing cookies or
  // logins. Every newly created identity includes its opaque profile id, so a
  // deleted and recreated bot name cannot inherit the deleted identity's data.
  profileDir(stateDir, botId) {
    if (!validBotId(botId)) throw new Error('Invalid bot id.');
    const record = this.#data.browsers.find(item => item.bot === botId);
    if (!record) throw new Error('This bot has no browser record.');
    return record.storageVersion === 2
      ? path.join(this.#profileRoot || path.join(stateDir, 'browsers'), botId, record.browserProfileId, 'chromium')
      : path.join(this.#profileRoot || path.join(stateDir, 'browsers'), botId, 'chromium');
  }

  async prepareProfile(botId) {
    const directory = this.profileDir(this.#stateDir, botId);
    const trustedRoot = this.#profileRoot || this.#stateDir;
    await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
    let parent = await realpath(trustedRoot);
    for (const segment of path.relative(trustedRoot, directory).split(path.sep)) {
      const current = path.join(parent, segment);
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const entry = await lstat(current);
      const resolved = await realpath(current);
      if (!entry.isDirectory() || entry.isSymbolicLink() || path.dirname(resolved) !== parent) {
        throw new Error('The browser profile must be an independent directory.');
      }
      parent = resolved;
    }
    return directory;
  }

  #mutate(change) {
    const work = this.#queue.then(async () => {
      const data = structuredClone(this.#data);
      const result = await change(data);
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
}
