import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { HermesError, hermesProfile } from './hermes-client.mjs';

const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');
const keyName = key => typeof key === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(key);
const idFor = (profile, provider, key) => createHash('sha256').update(JSON.stringify([profile, provider, key])).digest('hex');

/** Only metadata leaves this service. Native Hermes remains the credential owner. */
export function createSavedProviders(client, bots, { home, managedEnv }) {
  const verified = new Map(), pending = new Set();
  async function exclusive(profile, work) {
    if (pending.has(profile)) throw new HermesError(409, 'Another credential operation is running for this bot.', 'PROVIDER_BUSY');
    pending.add(profile);
    try { return await work(); } finally { pending.delete(profile); }
  }
  async function revision(profile) {
    if (!home) return null;
    const filename = path.join(home, ...(profile === 'default' ? [] : ['profiles', profile]), '.env');
    const info = await stat(filename, { bigint: true }).catch(() => null);
    return info?.isFile() ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : null;
  }
  async function inventory(profile) {
    await client.credentialBinding(profile);
    const [env, catalog] = await Promise.all([
      client.dashboard('/api/env', { profile }),
      client.dashboard('/api/model/options', { profile, query: { include_unconfigured: true, explicit_only: true } }),
    ]);
    if (!env || typeof env !== 'object' || !Array.isArray(catalog.providers)) throw new HermesError(502, 'Hermes returned an invalid provider inventory.', 'HERMES_PROTOCOL_ERROR');
    const rows = [];
    for (const provider of catalog.providers) {
      // OAuth accounts and custom endpoint definitions need their native setup
      // flows; copying their bare env values would create a broken connection.
      const key = provider.key_env;
      if (!keyName(key) || managedEnv.test(key) || /^HERMES_CUSTOM_/.test(key)
        || typeof provider.slug !== 'string' || !provider.slug || !env[key]?.is_set) continue;
      rows.push({ id: idFor(profile, provider.slug, key), provider: provider.slug,
        name: String(provider.name || provider.slug).slice(0, 128), key, sourceProfile: profile });
    }
    return { rows, env };
  }
  async function profiles() {
    const result = bots ? { profiles: bots.roster() } : await client.dashboard('/api/profiles');
    if (!Array.isArray(result.profiles)) throw new HermesError(502, 'Hermes returned an invalid bot inventory.', 'HERMES_PROTOCOL_ERROR');
    return result.profiles.filter(row => !row.state || row.state === 'active').map(row => ({
      name: hermesProfile(row.name || row.id), displayName: String(row.displayName || row.display_name || (row.name === 'default' ? 'Main' : row.name)).slice(0, 128),
    }));
  }
  async function list(target) {
    await client.credentialBinding(target);
    const roster = await profiles();
    if (!roster.some(row => row.name === target)) throw new HermesError(404, 'This bot no longer exists.', 'BOT_NOT_FOUND');
    const targetKeys = await client.dashboard('/api/env', { profile: target });
    const connections = [], unavailableProfiles = [];
    for (let offset = 0; offset < roster.length; offset += 4) {
      await Promise.all(roster.slice(offset, offset + 4).map(async source => {
        try {
          const { rows } = await inventory(source.name), currentRevision = await revision(source.name);
          for (const row of rows) {
            const proof = verified.get(row.id);
            const verifiedAt = proof && currentRevision && proof.revision === currentRevision && Date.now() - proof.time < 600_000 ? new Date(proof.time).toISOString() : null;
            connections.push({ ...row, sourceName: source.displayName, configured: targetKeys[row.key]?.is_set === true, verifiedAt });
          }
        } catch { unavailableProfiles.push(source.displayName); }
      }));
    }
    return { connections: connections.sort((a, b) => a.name.localeCompare(b.name) || a.sourceName.localeCompare(b.sourceName)), unavailableProfiles };
  }
  async function resolve(id, target) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw invalid('Select a saved provider.');
    const roster = await profiles();
    if (!roster.some(row => row.name === target)) throw new HermesError(404, 'This bot no longer exists.', 'BOT_NOT_FOUND');
    for (const source of roster) {
      const inventoryResult = await inventory(source.name).catch(() => null);
      if (!inventoryResult) continue;
      const { rows } = inventoryResult;
      const found = rows.find(row => row.id === id);
      if (found) return found;
    }
    throw new HermesError(404, 'That saved provider is no longer available. Refresh the cards.', 'PROVIDER_NOT_FOUND');
  }
  async function reveal(row) {
    const result = await client.dashboard('/api/env/reveal', { profile: row.sourceProfile, method: 'POST', body: { key: row.key, profile: row.sourceProfile } });
    if (result.key !== row.key || typeof result.value !== 'string' || !result.value.trim() || result.value.length > 64000) throw new HermesError(502, 'Hermes could not read that saved connection.', 'HERMES_PROTOCOL_ERROR');
    return result.value;
  }
  async function operate(target, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'action'].includes(key)) || !['connect', 'verify'].includes(input.action)) throw invalid('Select a saved provider action.');
    return exclusive(target, async () => {
      const row = await resolve(input.id, target);
      if (input.action === 'connect') {
        const targetKeys = await client.dashboard('/api/env', { profile: target });
        if (targetKeys[row.key]?.is_set) throw new HermesError(409, 'This provider is already configured for this bot. Its existing key was preserved.', 'PROVIDER_CONFIGURED');
        const value = await reveal(row);
        await client.credentialBinding(row.sourceProfile);
        await client.credentialBinding(target);
        const saved = await client.dashboard('/api/env', { profile: target, method: 'PUT', body: { key: row.key, value, profile: target } });
        if (saved.ok !== true) throw new HermesError(502, 'Hermes did not confirm the saved connection. Refresh before retrying.', 'HERMES_PROTOCOL_ERROR');
        // Never return the native write response, or update model/config here.
        return { ok: true, connected: true };
      }
      verified.delete(row.id);
      const before = await revision(row.sourceProfile), value = await reveal(row);
      const result = await client.dashboard('/api/providers/validate', { profile: row.sourceProfile, method: 'POST', body: { key: row.key, value, profile: row.sourceProfile } });
      const after = await revision(row.sourceProfile), accepted = result.ok === true && result.reachable === true;
      if (accepted && before && before === after) verified.set(row.id, { revision: after, time: Date.now() });
      return { ok: true, status: accepted ? 'verified' : result.reachable === true ? 'rejected' : 'unverified',
        message: accepted ? 'The provider accepted this key.' : result.reachable === true ? 'The provider did not accept this key.' : 'Hermes could not verify this provider. The saved key is unchanged.' };
    });
  }
  return { list, operate, exclusive };
}
