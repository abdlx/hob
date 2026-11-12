import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { HermesError, hermesProfile } from './hermes-client.mjs';

// Only the application reads the owner key. Agents receive profile-bound MCP
// tokens; the browser uses HOB's session-authenticated VNC proxy.
export class NativePortal {
  #queues = new Map();
  constructor({ home, url, hermesHome, client, fetchImpl = fetch }) {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error('Bundled Portal must use a loopback endpoint');
    this.home = home; this.url = endpoint.origin; this.hermesHome = hermesHome; this.client = client; this.fetch = fetchImpl;
  }
  async request(route, method = 'GET', value) {
    try {
      const token = (await readFile(path.join(this.home, 'owner-token.txt'), 'utf8')).trim();
      if (!/^portal_owner_[a-f0-9]{48}$/.test(token)) throw new Error('Invalid owner key');
      const response = await this.fetch(this.url + route, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      if (!response.ok) {
        await response.body?.cancel();
        if (route.startsWith('/api/ui/vault/') && [400, 404].includes(response.status)) throw new HermesError(response.status, 'The credential request was rejected. Check its fields and refresh the vault.', 'VAULT_REQUEST_REJECTED');
        throw new Error('Portal refused request');
      }
      return await response.json();
    } catch (error) {
      if (error instanceof HermesError) throw error;
      throw new HermesError(503, 'The bundled computer service is unavailable. Refresh before retrying.', 'PORTAL_UNAVAILABLE');
    }
  }
  async #config(profile) {
    const root = await realpath(this.hermesHome);
    const expected = profile === 'default' ? root : path.join(root, 'profiles', profile);
    const home = await realpath(expected);
    if (home !== expected) throw new Error('Invalid bot home');
    const filename = await realpath(path.join(home, 'config.yaml'));
    if (path.dirname(filename) !== home || (await stat(filename)).size > 1024 * 1024) throw new Error('Invalid bot configuration');
    const doc = parseDocument(await readFile(filename, 'utf8'), { uniqueKeys: true });
    if (doc.errors.length) throw new Error('Invalid bot configuration');
    return doc.toJS({ maxAliasCount: 50 }) || {};
  }
  managed(cfg) { return cfg?.mcpUrl === this.url + '/mcp'; }
  #serialize(profile, action) {
    hermesProfile(profile);
    const work = (this.#queues.get(profile) || Promise.resolve()).then(action);
    const tail = work.catch(() => {});
    this.#queues.set(profile, tail);
    void tail.then(() => { if (this.#queues.get(profile) === tail) this.#queues.delete(profile); });
    return work;
  }
  assign(profile) {
    return this.#serialize(profile, async () => {
      const config = await this.#config(profile);
      if (config.terminal?.backend && config.terminal.backend !== 'local') throw new HermesError(409, 'The bundled computer requires this bot to execute locally in its HOB working directory.', 'PORTAL_WORKSPACE_MISMATCH');
      const existing = config.mcp_servers?.portal;
      if (existing?.enabled !== false && existing?.url && existing.url !== this.url + '/mcp') throw new HermesError(409, 'This bot already has an external Portal connection. Remove that connection before assigning the bundled computer.', 'PORTAL_ALREADY_CONFIGURED');
      const result = await this.request('/api/ui/hob/bots/' + profile, 'PUT', { name: profile === 'default' ? 'Main' : profile });
      if (config.terminal?.cwd && path.resolve(config.terminal.cwd) !== path.resolve(result.workspace)) throw new HermesError(409, 'This bot has a custom execution directory. Align its HOB working directory before assigning the bundled computer.', 'PORTAL_WORKSPACE_MISMATCH');
      await this.client.dashboard('/api/config', { profile, method: 'PUT', body: { profile, config: {
        mcp_servers: { portal: { url: this.url + '/mcp', bearer_token: result.plaintext, enabled: true } },
      } } });
      return { ok: true, workspace: result.workspace };
    });
  }
  unassign(profile) {
    return this.#serialize(profile, async () => {
      const config = await this.#config(profile);
      if (config.mcp_servers?.portal?.url !== this.url + '/mcp') throw new HermesError(409, 'This bot is not assigned to the bundled computer.', 'PORTAL_NOT_ASSIGNED');
      // Revoke first: a settings outage must not leave an agent with access.
      await this.revoke(profile);
      await this.client.dashboard('/api/config', { profile, method: 'PUT', body: { profile, config: {
        mcp_servers: { portal: { url: this.url + '/mcp', enabled: false, bearer_token: '' } },
      } } });
      return { ok: true };
    });
  }
  revoke(profile) { return this.request('/api/ui/hob/bots/' + hermesProfile(profile), 'DELETE'); }
  async remove(profile) {
    hermesProfile(profile);
    // Unassigned bots do not depend on Portal being online for deletion.
    // Read only; the service remains the sole writer of its store.
    const state = JSON.parse(await readFile(path.join(this.home, 'store.json'), 'utf8'));
    if (!state.tokens.some(token => token.profileSlug === profile && !token.revoked)) return { ok: true };
    return this.revoke(profile);
  }
  async instructions(profile) {
    const config = await this.#config(profile);
    const portal = config.mcp_servers?.portal;
    if (portal?.enabled === false || portal?.url !== this.url + '/mcp') return '';
    return '## Assigned computer\n\nUse the portal MCP server for browser interaction on your assigned computer. Its persistent browser profile, cookies and tabs belong to this bot. Portal files, downloads and terminal tools operate on the same HOB working directory as your native terminal; its sandbox exposes that directory at /tmp/workspace. Use profile_current to inspect the binding. When human takeover is active, wait for control to return before browsing.\n';
  }
  control(profile, mode) { return this.request('/api/ui/viewer-control/' + hermesProfile(profile), 'POST', { mode }); }
  async vault(profile, method = 'GET', input, id) {
    const route = '/api/ui/vault/' + hermesProfile(profile) + (id ? '/' + encodeURIComponent(id) : '');
    const result = await this.request(route, method, input);
    // Treat the service boundary as write-only for passwords, even if its
    // response shape changes. HOB returns only display metadata.
    const metadata = item => Object.fromEntries(['id', 'name', 'origin', 'username', 'updatedAt'].map(key => [key, item[key]]));
    if (method === 'GET') return { profile, items: result.items.map(metadata) };
    if (method === 'POST') return { item: metadata(result.item) };
    return { deleted: result.deleted === true, id };
  }
  viewer(profile) {
    return this.request('/api/ui/viewer-control/' + hermesProfile(profile));
  }
  async vncConfig(profile) {
    const token = (await readFile(path.join(this.home, 'owner-token.txt'), 'utf8')).trim();
    return { origin: this.url, token, profile };
  }
}

export function nativePortalFromEnv({ client, env = process.env } = {}) {
  if (!env.HOB_PORTAL_HOME || !env.HOB_PORTAL_URL || !env.HERMES_HOME) return null;
  return new NativePortal({ home: env.HOB_PORTAL_HOME, url: env.HOB_PORTAL_URL, hermesHome: env.HERMES_HOME, client });
}
