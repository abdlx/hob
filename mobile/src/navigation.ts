export const destinations = [
  { name: 'Bots', label: 'Bots' },
  { name: 'Chat', label: 'Chat' },
  { name: 'Conversations', label: 'Conversations' },
  { name: 'Activity', label: 'Activity' },
  { name: 'Workshop', label: 'Workshop' },
  { name: 'Goals', label: 'Goals' },
  { name: 'Library', label: 'Library' },
  { name: 'Skills', label: 'Skills' },
  { name: 'Memory', label: 'Memory' },
  { name: 'Identity', label: 'Identity' },
  { name: 'Tools', label: 'Tools' },
  { name: 'Browser', label: 'Browser' },
  { name: 'Settings', label: 'Settings' },
] as const;
export function runBusy(status?: string) { return Boolean(status && !['completed', 'cancelled', 'failed', 'interrupted'].includes(status)); }
/** Pushes preserve visited pages and their bot scope for Android Back. */
export function openPage(name: string, profile: string, params: Record<string, unknown> = {}) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Select a valid bot.');
  return { type: 'PUSH' as const, payload: { name, params: { ...params, profile } } };
}
// Session/turn/review IDs are deduplication keys, never credentials.
export function requestId() { return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`; }
