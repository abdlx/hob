export interface PluginEntry {
  name: string; description: string; repo: string; sha: string; tier: string; maintainer: string;
  requires_hermes?: string; platforms?: string[]; docs_url?: string; installed: boolean;
  installed_sha?: string; update_available: boolean; runtime_status?: string;
  capabilities: { provides_tools: string[]; provides_hooks: string[]; provides_middleware: string[]; requires_env: string[] };
}
export interface InstalledPlugin {
  name: string; description: string; version: string; source: string; runtime_status: string;
  can_remove: boolean; can_update_git: boolean; auth_required: boolean; removed_reason?: string;
}
export interface PluginInventory { scope: string; entries: PluginEntry[]; installed: InstalledPlugin[]; removed: { name: string; reason: string }[] }
export type PluginOperation = 'install' | 'enable' | 'disable' | 'update' | 'remove';
export interface PluginResult { ok?: boolean; enabled?: boolean; consent_required?: boolean; restart_required?: boolean; warnings?: string[]; missing_env?: string[]; delta_lines?: string[] }

export function pluginResultMessage(operation: PluginOperation, result: PluginResult) {
  if (result.consent_required === true) return 'The update needs additional capabilities. Review the changes before continuing.';
  if (result.ok !== true) throw new Error('Hermes did not confirm the operation. Refresh the inventory before retrying.');
  const message = operation === 'install' ? 'Installed by Hermes. Review credentials, then enable the plugin when ready.'
    : operation === 'remove' ? 'Plugin removed by Hermes.'
      : operation === 'update' ? 'Plugin updated by Hermes.'
        : operation === 'enable' ? 'Plugin enabled in Hermes configuration.' : 'Plugin disabled in Hermes configuration.';
  return message + (result.restart_required ? ' A runtime restart is required before this change takes effect.' : ' Start a new conversation to load the changed configuration.');
}
