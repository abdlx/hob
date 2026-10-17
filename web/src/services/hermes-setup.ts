import { apiFetch } from './api.ts';

export function setupLink(value?: string) {
  try { const url = new URL(value || ''); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

export function hermesSetupApi(profile: string) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(profile) || profile === 'all') throw new Error('Select one bot.');
  return <T,>(route: string, init: RequestInit = {}) => apiFetch<T>(`/api/hermes/setup/${route}?profile=${encodeURIComponent(profile)}`,
    { ...init, headers: { 'X-Hob-Profile': profile } });
}
