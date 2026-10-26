export const settingsSections = [
  { id: 'general', title: 'General', description: 'Appearance and local preferences', keywords: 'theme dark light system accessibility' },
  { id: 'models', title: 'Models & providers', description: 'Models, endpoints and credentials', keywords: 'api key account oauth login inference token' },
  { id: 'agents', title: 'Agents & bots', description: 'Create independent agent identities', keywords: 'profile personality soul instructions' },
  { id: 'tools', title: 'Tools & computer', description: 'Capabilities and execution access', keywords: 'browser terminal filesystem permissions dependencies' },
  { id: 'integrations', title: 'Plugins & integrations', description: 'Native plugins and MCP connections', keywords: 'catalog install update server oauth dependencies' },
  { id: 'skills', title: 'Skills', description: 'Reusable instructions and proposals', keywords: 'workshop skill.md discovery activation' },
  { id: 'memory', title: 'Memory & history', description: 'Memory providers and continuity', keywords: 'persistent context recall retention' },
  { id: 'learning', title: 'Learning & approvals', description: 'Control what your agent remembers', keywords: 'security review proposal permissions autonomous' },
  { id: 'automation', title: 'Automation', description: 'Scheduled goals and recurring work', keywords: 'cron routine job schedule background timezone' },
  { id: 'channels', title: 'Channels & messaging', description: 'Connect messaging platforms', keywords: 'telegram discord slack whatsapp notifications' },
  { id: 'advanced', title: 'Advanced configuration', description: 'Search every native Hermes setting', keywords: 'schema config json developer runtime diagnostics' },
] as const;

export type SettingsSection = typeof settingsSections[number]['id'];
export const settingsSection = (value: unknown): SettingsSection => settingsSections.find(item => item.id === value)?.id ?? 'models';
export const searchSettings = (query: string) => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return settingsSections.filter(item => words.every(word => `${item.title} ${item.description} ${item.keywords}`.toLowerCase().includes(word)));
};

export const preference = (key: string, fallback: string) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
export const savePreference = (key: string, value: string) => {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
};
