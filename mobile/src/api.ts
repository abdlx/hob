import { fetch } from 'expo/fetch';
import { sameInstance, validateInstance } from './connection';
import type { Connection, Instance } from './connection';

export class LoginExpired extends Error {}
export async function instanceRequest<T>(origin: string, path: string, { token, method = 'GET', value }: { token?: string; method?: string; value?: unknown } = {}): Promise<T> {
  const response = await fetch(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json', ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
  if (!sameInstance(response.url || origin, origin)) throw new Error('The server redirected to another address. Enter the final hob URL.');
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The server did not return a hob API response. Check the instance URL.');
  const text = await response.text(); if (text.length > 65536) throw new Error('The instance returned an unexpected response.');
  const body = JSON.parse(text);
  if (!response.ok) {
    if (response.status === 401) throw new LoginExpired(token ? 'Your login expired. Sign in again.' : 'That password was not accepted.');
    throw new Error(typeof body.error === 'string' ? body.error.slice(0, 300) : `The instance returned HTTP ${response.status}.`);
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
