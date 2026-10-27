export interface Instance { app: 'hob'; protocol: 1; instanceId: string; configured: boolean; capabilities: { attachments: boolean; push: boolean; maxAttachmentBytes: number }; version: { commit: string } }
export interface Connection { origin: string; token: string; deviceId: string; instanceId: string; expiresAt: number }
export function normalizeInstance(value: string, development = false): string {
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`); }
  catch { throw new Error('Enter your hob instance URL, for example https://hob.example.com.'); }
  const local = ['localhost', '127.0.0.1', '[::1]', '10.0.2.2'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(development && local && url.protocol === 'http:')) || !url.hostname || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Use the HTTPS address of your hob instance, without a path, password, or query string.');
  }
  return url.origin;
}
export function sameInstance(value: string, origin: string): boolean {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password && ['https:', 'http:'].includes(url.protocol); } catch { return false; }
}
export function validateInstance(value: unknown): Instance {
  const row = value as Partial<Instance> | null;
  if (row?.app !== 'hob' || row.protocol !== 1 || typeof row.instanceId !== 'string' || row.instanceId.length > 100 || !row.capabilities || typeof row.capabilities.attachments !== 'boolean' || typeof row.capabilities.push !== 'boolean') {
    throw new Error('This address did not identify itself as a compatible hob instance. Update hob on your server, then try again.');
  }
  if (!row.configured) throw new Error('This hob instance has no login password configured yet.');
  return row as Instance;
}
export function notificationTarget(data: Record<string, unknown>, connection: Connection): { profile: string; sessionKey: string } | null {
  if (data.instanceId !== connection.instanceId || typeof data.profile !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(data.profile)
    || typeof data.sessionKey !== 'string' || data.sessionKey.length > 1024 || !/^[a-zA-Z0-9_-]+$/.test(data.sessionKey)) return null;
  return { profile: data.profile, sessionKey: data.sessionKey };
}
