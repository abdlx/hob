import { apiFetch } from './api.ts';

/** Capture the bot once: an async action cannot follow a later selector change. */
export function hermesWorkspaceApi(profile: string) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Select a valid bot.');
  return <T,>(operation: string, init: RequestInit = {}, query: Record<string, string> = {}) => {
    const params = new URLSearchParams({ ...query, profile });
    const headers = new Headers(init.headers);
    headers.set('X-Hob-Profile', profile);
    return apiFetch<T>(`/api/hermes/workspace/${operation}?${params}`, { ...init, headers });
  };
}

export const jsonWrite = (method: string, value: unknown) => ({ method, body: JSON.stringify(value) });
