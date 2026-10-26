import { HermesError } from './hermes-client.mjs';

const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');
const protocol = () => new HermesError(502, 'Hermes returned an invalid plugin inventory.', 'HERMES_PROTOCOL_ERROR');
const fields = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 256) : [];

// The pinned dashboard installer uses its launch home, regardless of ?profile.
// Fail closed for named bots instead of silently writing to Main on their behalf.
// Hermes remains the only installer/config owner. No shell or custom URL input.
export function createHermesPluginsRoutes() {
  let mutating = false;
  return async (route, method, { profile, dashboard, input, json, res }) => {
    if (profile !== 'default') throw new HermesError(409,
      'This Hermes version manages plugins for Main only. Select Main to manage plugins; use per-bot MCP and skills for other bots.', 'PLUGIN_PROFILE_UNSUPPORTED');
    const inventory = async () => {
      const [catalog, hub] = await Promise.all([
        dashboard('/api/dashboard/plugins/catalog'), dashboard('/api/dashboard/plugins/hub'),
      ]);
      if (!Array.isArray(catalog?.entries) || !Array.isArray(catalog?.removed) || !Array.isArray(hub?.plugins)) throw protocol();
      return { catalog, hub };
    };
    if (route === 'plugins' && method === 'GET') {
      const { catalog, hub } = await inventory();
      return json(res, 200, {
        scope: 'default', generated_at: catalog.generated_at,
        entries: catalog.entries.map(entry => ({
          ...fields(entry, ['name', 'description', 'repo', 'sha', 'tier', 'maintainer', 'requires_hermes', 'platforms', 'docs_url', 'installed', 'installed_sha', 'update_available', 'runtime_status']),
          capabilities: Object.fromEntries(['provides_tools', 'provides_hooks', 'provides_middleware', 'requires_env'].map(key => [key, strings(entry.capabilities?.[key])])),
        })),
        installed: hub.plugins.map(entry => fields(entry, ['name', 'description', 'version', 'source', 'runtime_status', 'can_remove', 'can_update_git', 'auth_required', 'removed_reason'])),
        removed: catalog.removed.map(entry => fields(entry, ['name', 'reason', 'date'])),
      });
    }
    const match = /^plugins\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/(install|enable|disable|update|remove)$/.exec(route);
    if (!match || method !== 'POST') throw new HermesError(404, 'Unknown plugin operation.', 'NOT_FOUND');
    const [, name, operation] = match;
    const value = await input(['confirm', 'expectedSha', 'acceptCapabilities']);
    if (value.confirm !== true || (value.acceptCapabilities !== undefined && typeof value.acceptCapabilities !== 'boolean')) throw invalid('Review the plugin requirements and confirm this operation.');
    if (operation !== 'update' && value.acceptCapabilities !== undefined) throw invalid('Capability consent applies only to an update.');
    if (operation !== 'install' && value.expectedSha !== undefined) throw invalid('A catalog pin applies only to installation.');
    if (mutating) throw new HermesError(409, 'Another plugin operation is running. Refresh its status before retrying.', 'PLUGIN_OPERATION_ACTIVE');
    mutating = true;
    try {
      const { catalog, hub } = await inventory();
      const entry = catalog.entries.find(item => item.name === name);
      const installed = hub.plugins.find(item => item.name === name);
      if (operation !== 'remove' && (catalog.removed.some(item => item.name === name) || installed?.removed_reason)) throw invalid('Hermes has removed this plugin from its catalog. It can only be removed.');
      let result;
      if (operation === 'install') {
        if (!entry || !namePattern.test(entry.name) || !/^[a-f0-9]{40}$/.test(entry.sha || '')) throw invalid('Select a pinned entry from the Hermes catalog.');
        if (value.expectedSha !== entry.sha) throw new HermesError(409, 'The catalog pin changed. Refresh and review the new version before installing.', 'PLUGIN_CATALOG_CHANGED');
        if (entry.installed) throw new HermesError(409, 'This catalog plugin is already installed. Refresh its status.', 'PLUGIN_ALREADY_INSTALLED');
        result = await dashboard('/api/dashboard/agent-plugins/install', { method: 'POST', timeoutMs: 300000,
          body: { identifier: '', catalog_name: name, ref: entry.sha, force: false, enable: false } });
      } else {
        if (!installed) throw new HermesError(404, 'This plugin is not installed. Refresh the inventory.', 'PLUGIN_NOT_FOUND');
        if (operation === 'remove' && installed.can_remove !== true) throw invalid('This built-in plugin cannot be removed.');
        if (operation === 'update' && (!entry || entry.installed !== true || installed.can_update_git !== true)) throw invalid('Only installed catalog plugins can be updated here.');
        result = await dashboard(`/api/dashboard/agent-plugins/${name}${operation === 'remove' ? '' : '/' + operation}`, {
          method: operation === 'remove' ? 'DELETE' : 'POST', timeoutMs: 300000,
          ...(operation === 'update' ? { body: { accept_capabilities: value.acceptCapabilities === true } } : {}),
        });
      }
      if (result?.consent_required !== true && result?.ok !== true) throw new HermesError(502,
        'Hermes did not confirm the operation. Refresh the inventory before retrying.', 'PLUGIN_UNCONFIRMED');
      // No native paths, shell commands, dependency output, tokens or raw logs.
      return json(res, 200, {
        ...fields(result, ['ok', 'plugin_name', 'name', 'enabled', 'unchanged', 'restart_required', 'consent_required', 'sha']),
        warnings: strings(result.warnings), missing_env: strings(result.missing_env), delta_lines: strings(result.delta_lines),
      });
    } finally { mutating = false; }
  };
}
