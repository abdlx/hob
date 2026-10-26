import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HermesError, hermesProfile } from './hermes-client.mjs';
import { HermesBotNetwork } from './hermes-bot-network.mjs';
import { hermesBotTags, withBotIdentity } from './hermes-bot-identity.mjs';

const LIMIT = 1024 * 1024;
const DEFAULT_DISPLAY = name => name === 'default' ? 'Main' : name;

/** A display name is UI identity, never a profile directory or a credential. */
export function hermesDisplayName(value) {
  if (typeof value !== 'string') throw new HermesError(400, 'Enter a bot name.', 'INVALID_REQUEST');
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new HermesError(400, 'Bot names must be 1–64 printable characters.', 'INVALID_REQUEST');
  }
  return name;
}

const view = item => ({ name: item.name, displayName: item.displayName, display_name: item.displayName,
  tags: item.tags || [], ...(item.description !== undefined ? { description: item.description } : {}),
  identitySync: item.identitySync || 'pending', state: item.state, created_at: item.createdAt });
const sameLabel = (left, right) => left.toLowerCase() === right.toLowerCase();
/** Keep a suffixed candidate a valid profile id even when the stem is 64 characters. */
function suffixed(base, suffix) {
  const tail = `-${suffix}`;
  return base.slice(0, 64 - tail.length) + tail;
}
const sameToken = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  const a = Buffer.from(left, 'utf8'), b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

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
    const initial = { version: 3, bots: [{ name: 'default', displayName: 'Main', state: 'active', nativeCreated: true,
      apiKey: mainApiKey, relayKey: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() }] };
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
    let migrated = false;
    // Version 1 had no display names. Profiles keep their immutable internal
    // name; the UI label becomes a separate field so renaming is safe.
    if (data?.version === 1) {
      if (!Array.isArray(data.bots)) throw new Error('Invalid bot registry.');
      // Version 1 could contain a bot whose internal id is `main` (its workspace
      // is still `workspaces/bots/main`). Its derived label would now collide
      // with Main's coordination label case-insensitively, so migrate it to the
      // next free label rather than refusing to boot the whole roster.
      const used = new Set(['main']);
      data = { ...data, version: 2, bots: data.bots.map(item => {
        if (item.name === 'default') return { ...item, displayName: 'Main' };
        const base = typeof item.displayName === 'string' ? item.displayName : DEFAULT_DISPLAY(item.name);
        let displayName = base;
        if (item.state === 'revoked') return { ...item, displayName };
        for (let suffix = 2; used.has(displayName.toLowerCase()); suffix += 1) {
          const tail = ` ${suffix}`;
          displayName = `${base.slice(0, 64 - tail.length)}${tail}`;
        }
        used.add(displayName.toLowerCase());
        return { ...item, displayName };
      }) };
      migrated = true;
    }
    if (data?.version === 2 && Array.isArray(data.bots)) {
      data = { ...data, version: 3, bots: data.bots.map(item => ({ ...item, relayKey: randomBytes(32).toString('hex') })) };
      migrated = true;
    }
    if (data?.version !== 3 || !Array.isArray(data.bots) || data.bots.length > 500) throw new Error('Invalid bot registry.');
    const names = new Set();
    const keys = new Set();
    const activeLabels = new Set();
    for (const item of data.bots) {
      hermesProfile(item.name);
      const displayName = hermesDisplayName(item.displayName);
      if (!['active', 'setup_required', 'revoked'].includes(item.state) || names.has(item.name)
        || !/^[a-f0-9]{64}$/.test(item.apiKey || '') || keys.has(item.apiKey)
        || !/^[a-f0-9]{64}$/.test(item.relayKey || '') || keys.has(item.relayKey) || item.relayKey === item.apiKey
        || typeof item.nativeCreated !== 'boolean' || typeof item.createdAt !== 'string') throw new Error('Invalid bot registry.');
      item.displayName = displayName;
      item.tags = hermesBotTags(item.tags);
      if (item.state !== 'revoked') {
        const label = displayName.toLowerCase();
        if (activeLabels.has(label)) throw new Error('Invalid bot registry.');
        activeLabels.add(label);
      }
      names.add(item.name); keys.add(item.apiKey); keys.add(item.relayKey);
    }
    const main = data.bots.find(item => item.name === 'default');
    if (main?.state !== 'active' || main.apiKey !== mainApiKey) {
      throw new Error('Main bot registry and listener credentials disagree. Restore their matching backup.');
    }
    if (migrated) {
      const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600, flush: true });
        await rename(temporary, filename);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    return new HermesBotRegistry(filename, data);
  }

  list() { return this.#data.bots.filter(item => item.state !== 'revoked').map(view); }
  /** True for any record, including a revoked tombstone, so a name is never reused by accident. */
  hasRecord(name) {
    try { return this.#data.bots.some(item => item.name === hermesProfile(name)); }
    catch { return false; }
  }
  /** Resolve an agent credential to its dashboard identity. Only active bots may relay. */
  authenticate(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const item = this.#data.bots.find(item => item.state === 'active' && sameToken(item.relayKey, token));
    return item ? view(item) : null;
  }
  #labelTaken(data, displayName, exclude = '') {
    return data.bots.some(item => item.name !== exclude && item.state !== 'revoked'
      && sameLabel(item.displayName, displayName));
  }
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
  relayToken(name) {
    this.token(name); // Enforce the same active/revoked policy as native access.
    return this.#record(name).relayKey;
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
  /**
   * Reserve a dashboard record for a new bot.
   *
   * The requested name is a proposal, not the identity: if a revoked tombstone
   * (or an unrelated native profile) already uses it, the new bot receives the
   * next free internal id. Internal ids are never resurrected, which is what
   * lets a deleted display name be reused without pointing a new bot at old
   * browser profiles, sessions or credentials.
   */
  async reserve(name, { displayName, tags, description, taken = [] } = {}) {
    const base = hermesProfile(name);
    const label = hermesDisplayName(displayName ?? DEFAULT_DISPLAY(base));
    tags = hermesBotTags(tags);
    return this.#mutate(data => {
      if (this.#labelTaken(data, label)) {
        throw new HermesError(409, 'A bot with that name already exists. Choose another name.', 'BOT_EXISTS');
      }
      if (data.bots.length >= 500) throw new HermesError(409, 'The bot roster limit has been reached.', 'BOT_LIMIT');
      const unavailable = new Set([...data.bots.map(item => item.name), ...taken]);
      let internal = base;
      if (unavailable.has(internal)) {
        let suffix = 2;
        while (unavailable.has(internal = suffixed(base, suffix))) suffix += 1;
      }
      hermesProfile(internal);
      const item = { name: internal, displayName: label, tags, ...(description !== undefined ? { description } : {}), identitySync: 'pending', state: 'setup_required', nativeCreated: false,
        apiKey: randomBytes(32).toString('hex'), relayKey: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
      data.bots.push(item);
      return view(item);
    });
  }
  async rename(name, displayName) {
    const label = hermesDisplayName(displayName);
    return this.#mutate(data => {
      const item = data.bots.find(item => item.name === hermesProfile(name));
      if (!item || item.state === 'revoked') throw new HermesError(404, 'This bot is not in your dashboard.', 'BOT_NOT_FOUND');
      if (this.#labelTaken(data, label, item.name)) {
        throw new HermesError(409, 'Another bot already uses that name.', 'BOT_EXISTS');
      }
      item.displayName = label;
      return view(item);
    });
  }
  async update(name, patch) {
    return this.#mutate(data => {
      const item = data.bots.find(item => item.name === name);
      if (!item || (item.state === 'revoked' && patch.state !== 'revoked')) {
        throw new HermesError(404, 'This bot is not in your dashboard.', 'BOT_NOT_FOUND');
      }
      if ('displayName' in patch) {
        const label = hermesDisplayName(patch.displayName);
        if (this.#labelTaken(data, label, item.name)) {
          throw new HermesError(409, 'Another bot already uses that name.', 'BOT_EXISTS');
        }
      }
      if ('tags' in patch) patch = { ...patch, tags: hermesBotTags(patch.tags) };
      Object.assign(item, patch);
      return view(item);
    });
  }
}

export class HermesBots {
  #registry;
  #client;
  #workspaceRoot;
  #browser;
  #network;
  // Latest native profile metadata, merged into relay/roster views. It is only
  // presentation: identity and authorization always come from the registry.
  #metadata = new Map();
  #settingUp = new Set();
  #identityQueue = Promise.resolve();
  constructor({ registry, client, workspaceRoot, browser, network, relayUrl }) {
    this.#registry = registry; this.#client = client; this.#browser = browser;
    this.#workspaceRoot = path.resolve(workspaceRoot, 'bots');
    this.#network = network ?? (relayUrl ? new HermesBotNetwork({
      roster: () => this.list(),
      credential: name => this.#registry.relayToken(name),
      workspaceRoot: path.resolve(workspaceRoot),
      relayUrl,
    }) : null);
  }
  /**
   * Whether this bot exists, answered from the local roster. The browser routes
   * run on every status poll, so this must not be a Hermes round-trip.
   */
  has(name) {
    if (typeof name !== 'string') return false;
    return this.#registry.list().some(item => item.name === name);
  }
  /**
   * Point a bot's Hermes profile at its HOB-managed browser, so the agent's own
   * browser tools drive the persistent, takeover-aware Chromium instead of
   * spawning a throwaway one. Idempotent: the profile is only written when its
   * `cdp_url` actually differs, which means a user who wipes their config is
   * repaired rather than left with a browser the agent cannot reach.
   *
   * `backend: off` is required. It is the switch that stops Hermes from
   * substituting the Browser Use harness for its own browser tools; with it left
   * unset, `cdp_url` is ignored and the agent drives a different browser than the
   * one the human is watching.
   */
  async configureBrowser(name) {
    if (!this.#browser) return false;
    const record = await this.#browser.record(name);
    const cdpUrl = `http://127.0.0.1:${record.gatewayPort}/${record.gatewayToken}`;
    // Listen before the profile is told where to connect, so the URL is true the
    // moment Hermes reads it.
    await this.#browser.ensureEndpoint(name);
    // The profile is the *bound selector*: HermesClient appends it to the
    // dashboard URL itself and rejects a query embedded in a path. Passing
    // `?profile=` here made every bind throw before it could read the profile.
    const current = await this.#client.dashboard('/api/config', { profile: name });
    // `/api/config` answers with the profile's settings object itself, not a
    // `{ config }` envelope. Reading the envelope reported every bound profile as
    // unbound, so the dashboard showed a broken binding and boot rewrote it.
    const browser = current?.browser ?? {};
    if (browser.cdp_url === cdpUrl && browser.backend === 'off') return false;
    await this.#client.dashboard('/api/config', { profile: name, method: 'PUT',
      body: { profile: name, config: { browser: { backend: 'off', cdp_url: cdpUrl } } } });
    return true;
  }
  /**
   * Read-only view of a bot's browser binding for the dashboard's diagnostics.
   *
   * `browser.cdp_url` embeds the bot's gateway credential, so the report never
   * contains it: it compares the URL internally and exposes only the port and
   * the reason a binding does not match. `BROWSER_CDP_URL` is an environment
   * override that affects every profile, so it is reported separately without
   * its value.
   */
  async browserBinding(name) {
    const envOverride = Boolean(process.env.BROWSER_CDP_URL);
    const base = { profile: name, configured: false, backend: null, configuredPort: null, expectedPort: null, envOverride, reason: 'unavailable' };
    if (!this.#browser) return base;
    let record;
    try { record = await this.#browser.record(name); }
    catch (error) { return { ...base, error: error.message }; }
    const expectedUrl = `http://127.0.0.1:${record.gatewayPort}/${record.gatewayToken}`;
    try {
      const current = await this.#client.dashboard('/api/config', { profile: name });
      const browser = current?.browser ?? {};
      let configuredPort = null;
      try { configuredPort = Number(new URL(String(browser.cdp_url ?? '')).port) || null; } catch { /* not a URL */ }
      const configured = browser.cdp_url === expectedUrl && browser.backend === 'off';
      return {
        profile: name,
        configured,
        backend: typeof browser.backend === 'string' ? browser.backend : null,
        configuredPort,
        expectedPort: record.gatewayPort,
        envOverride,
        reason: configured ? 'bound'
          : !browser.cdp_url ? 'missing'
            : browser.backend !== 'off' ? 'backend'
              : 'stale-url',
      };
    } catch (error) {
      return { ...base, expectedPort: record.gatewayPort, reason: 'unreadable', error: error.message };
    }
  }
  /**
   * Point every active bot at its managed browser.
   *
   * Binding normally happens once, during setup, but bots that predate the
   * managed browser — and bots whose setup-time binding failed, which is
   * recorded as active anyway — would otherwise keep driving a throwaway Hermes
   * browser while the dashboard watched an idle HOB one. Boot calls this, so an
   * upgrade repairs those profiles without the operator recreating them.
   *
   * Failures stay per-bot: one profile the Hermes dashboard cannot read must not
   * leave every other bot unbound.
   */
  async reconcileBrowsers() {
    const result = { configured: [], unchanged: [], failed: [] };
    if (!this.#browser) return result;
    for (const { name, state } of this.#registry.list()) {
      if (state !== 'active') continue;
      try {
        if (await this.configureBrowser(name)) result.configured.push(name);
        else result.unchanged.push(name);
      } catch (error) {
        result.failed.push({ name, error: error.message });
      }
    }
    return result;
  }
  async list() {
    const native = await this.#client.dashboard('/api/profiles');
    if (!Array.isArray(native.profiles)) throw new HermesError(502, 'Hermes returned an invalid bot roster.', 'HERMES_PROTOCOL_ERROR');
    const profiles = this.#registry.list().map(item => {
      const profile = native.profiles.find(profile => profile.name === item.name);
      return { ...profile, ...item, display_name: item.displayName,
        ...(item.state === 'active' && !profile ? { state: 'unavailable' } : {}) };
    });
    this.#metadata = new Map(profiles.map(item => [item.name, item]));
    return { profiles };
  }
  /**
   * The relay's view of every active bot. Synchronous because the relay resolves
   * a recipient while admitting a message; native description/model metadata is
   * included when a recent `list()` has it.
   */
  roster() {
    return this.#registry.list().map(item => ({ ...this.#metadata.get(item.name), ...item, display_name: item.displayName }));
  }
  relayHelper(name) { return this.#network ? path.join(this.#network.workspace(name), '.hob', 'talk.mjs') : '.hob/talk.mjs'; }
  /** Resolve a relay-only credential to its bot identity; listener keys are refused. */
  authenticate(token) {
    const item = this.#registry.authenticate(token);
    return item ? { ...this.#metadata.get(item.name), ...item, display_name: item.displayName } : null;
  }
  /** Synchronize native personality files and every bot's roster, including at boot. */
  async syncNetwork() {
    const identities = await this.list();
    const failed = [];
    for (const bot of identities.profiles.filter(bot => bot.state === 'active')) {
      try { await this.saveSoul(bot.name); }
      catch (error) {
        await this.#registry.update(bot.name, { identitySync: 'pending' }).catch(() => undefined);
        failed.push({ name: bot.name, error: error.message });
      }
    }
    const network = this.#network ? await this.#network.sync() : { updated: [], failed: [] };
    return { updated: network.updated, failed: [...failed, ...network.failed] };
  }
  /** Serialize personality writes with identity edits, so an editor cannot erase the identity. */
  saveSoul(name, content) {
    const work = this.#identityQueue.then(async () => {
      const record = this.#registry.setup(name);
      const bot = { ...this.#metadata.get(name), ...record };
      const current = content === undefined ? await this.#client.dashboard(`/api/profiles/${name}/soul`, { profile: name }) : null;
      if (content === undefined && typeof current?.content !== 'string') throw new HermesError(502, 'Hermes did not return SOUL.md.', 'HERMES_PROTOCOL_ERROR');
      const next = withBotIdentity(content ?? current.content, bot);
      if (content !== undefined || next !== current.content) {
        const saved = await this.#client.dashboard(`/api/profiles/${name}/soul`, { profile: name, method: 'PUT', body: { content: next } });
        if (saved?.ok !== true) throw new HermesError(502, 'Hermes did not confirm the personality save.', 'HERMES_PROTOCOL_ERROR');
      }
      if (record.description !== undefined) {
        const saved = await this.#client.dashboard(`/api/profiles/${name}/description`, { profile: name, method: 'PUT', body: { description: record.description } });
        if (saved?.ok !== true) throw new HermesError(502, 'Hermes did not confirm the role save.', 'HERMES_PROTOCOL_ERROR');
      }
      await this.#registry.update(name, { identitySync: 'synced' });
      return { ok: true, content: next };
    });
    this.#identityQueue = work.catch(() => undefined);
    return work;
  }
  async #afterChange() {
    try { return await this.syncNetwork(); }
    catch (error) { return { updated: [], failed: [{ name: '*', error: error.message }] }; }
  }
  async create(proposal) {
    hermesBotTags(proposal.tags);
    if (proposal.description !== undefined && (typeof proposal.description !== 'string' || proposal.description.length > 2000)) throw new HermesError(400, 'Enter a role under 2,000 characters.', 'INVALID_REQUEST');
    const native = await this.#client.dashboard('/api/profiles');
    if (!Array.isArray(native.profiles)) throw new HermesError(502, 'Hermes returned an invalid bot roster.', 'HERMES_PROTOCOL_ERROR');
    const requested = hermesProfile(proposal.name);
    if (requested === 'default') throw new HermesError(400, 'The Main profile already exists.', 'INVALID_PROFILE');
    const nativeNames = new Set(native.profiles.map(item => item.name));
    // An unregistered native profile is somebody else's state. Creating a bot
    // must never adopt it silently, and must not hide it behind a suffixed id.
    if (nativeNames.has(requested) && !this.#registry.hasRecord(requested)) {
      throw new HermesError(409, 'A Hermes profile already uses that name. Choose a new bot name.', 'BOT_EXISTS');
    }
    const reserved = await this.#registry.reserve(requested, {
      displayName: proposal.displayName ?? DEFAULT_DISPLAY(requested),
      tags: proposal.tags, description: proposal.description,
      taken: [...nativeNames],
    });
    const name = reserved.name;
    const body = { name };
    for (const key of ['soul', 'description', 'provider', 'model']) {
      if (proposal[key] !== undefined) body[key] = proposal[key];
    }
    const created = await this.#client.dashboard('/api/profiles', { method: 'POST', body });
    if (created?.ok !== true || created.name !== name) {
      throw new HermesError(502, 'Hermes did not confirm this bot’s creation. Refresh the roster before taking further action.', 'BOT_CREATION_UNCERTAIN');
    }
    await this.#registry.update(name, { nativeCreated: true });
    return this.finishSetup(name);
  }
  async finishSetup(name, { confirmExisting = false } = {}) {
    const record = this.#registry.setup(name);
    if (record.state === 'active') return { ok: true, name, displayName: record.displayName, state: 'active' };
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
      await this.configureBrowser(name);
      await this.#registry.update(name, { nativeCreated: true, state: 'active' });
      const sync = await this.#afterChange();
      return { ok: true, name, displayName: record.displayName, state: 'active', sync };
    } finally { this.#settingUp.delete(name); }
  }
  /** Change the label people see; the internal profile id and its state stay put. */
  async rename(name, displayName) { return this.updateIdentity(name, { displayName }); }
  async updateIdentity(name, input) {
    const patch = { identitySync: 'pending' };
    if ('displayName' in input) patch.displayName = hermesDisplayName(input.displayName);
    if ('tags' in input) patch.tags = hermesBotTags(input.tags);
    if ('description' in input) {
      if (typeof input.description !== 'string' || input.description.length > 2000) throw new HermesError(400, 'Enter a role under 2,000 characters.', 'INVALID_REQUEST');
      patch.description = input.description.trim();
    }
    const result = await this.#registry.update(name, patch);
    const sync = await this.#afterChange();
    return { ok: true, ...result, identitySync: sync.failed.some(item => item.name === name || item.name === '*') ? 'pending' : 'synced', sync };
  }
  async remove(name) {
    if (name === 'default') throw new HermesError(400, 'The Main bot cannot be deleted.', 'INVALID_PROFILE');
    await this.#registry.update(name, { state: 'revoked' });
    await this.#afterChange();
    await this.#browser?.remove(name);
    return this.#client.dashboard(`/api/profiles/${hermesProfile(name)}`, { method: 'DELETE' });
  }
}
