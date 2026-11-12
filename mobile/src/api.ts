import { fetch } from 'expo/fetch';
import { sameInstance, validateInstance } from './connection';
import type { Connection, Instance } from './connection';

export class LoginExpired extends Error {}
export async function instanceRequest<T>(origin: string, path: string, { token, method = 'GET', value, profile, signal, maxBytes = 8 * 1024 * 1024 }: { token?: string; method?: string; value?: unknown; profile?: string; signal?: AbortSignal; maxBytes?: number } = {}): Promise<T> {
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Use a hob API path.');
  if (profile && !/^[a-z][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Select a valid bot.');
  const response = await fetch(origin + path, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(profile ? { 'X-Hob-Profile': profile } : {}) },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
  if (!sameInstance(response.url || origin, origin)) throw new Error('The server redirected to another address. Enter the final hob URL.');
  if (response.status === 204) return undefined as T;
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The server did not return a hob API response. Check the instance URL.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The instance returned an empty response.');
  const decoder = new TextDecoder(); let text = '', bytes = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error('The instance returned a response that is too large.');
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const body = JSON.parse(text);
  if (!response.ok) {
    if (response.status === 401) throw new LoginExpired(token ? 'Your login expired. Sign in again.' : 'That password was not accepted.');
    const detail = body.error?.message || body.error || body.message;
    throw new Error(typeof detail === 'string' ? detail.slice(0, 400) : `The instance returned HTTP ${response.status}.`);
  }
  return body as T;
}
export const discover = async (origin: string): Promise<Instance> => validateInstance(await instanceRequest(origin, '/api/mobile/discovery'));
export async function login(origin: string, password: string, deviceName: string): Promise<Connection> {
  const instance = await discover(origin);
  const result = await instanceRequest<Connection>(origin, '/api/mobile/login', { method: 'POST', value: { password, deviceName } });
  if (result.instanceId !== instance.instanceId || !/^hobm_[a-f0-9]{64}$/.test(result.token) || typeof result.deviceId !== 'string' || !Number.isFinite(result.expiresAt)) throw new Error('The instance returned an invalid mobile session.');
  return { ...result, origin };
}
export const deviceRequest = <T,>(connection: Connection, path: string, method = 'GET', value?: unknown) => instanceRequest<T>(connection.origin, '/api/mobile/' + path, { token: connection.token, method, value });
