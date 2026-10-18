import { apiFetch } from './api.ts';

// Device uploads land back where Hermes keeps the bot's native avatar asset, so the
// dashboard/desktop rosters see the same picture. Bounded to what the native handler
// accepts: PNG/JPEG/WebP, <= 2 MiB, sniffed by content.
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;

function route(name: string) {
  if (!NAME.test(name)) throw new Error('Select a valid bot.');
  return `/api/hermes/profiles/${encodeURIComponent(name)}/avatar`;
}

export const getBotAvatar = (name: string) => apiFetch<{ found: boolean; mime?: string; size?: number }>(route(name));

export const setBotAvatar = (name: string, data: string) =>
  apiFetch<{ ok: boolean; size: number; mime: string }>(route(name), { method: 'PUT', body: JSON.stringify({ data }) });

export const clearBotAvatar = (name: string) =>
  apiFetch<{ ok: boolean; removed: number }>(route(name), { method: 'DELETE' });

export function readAvatarFile(file: File): Promise<string> {
  if (!AVATAR_TYPES.includes(file.type as (typeof AVATAR_TYPES)[number])) {
    return Promise.reject(new Error('Choose a PNG, JPEG, or WebP image.'));
  }
  if (!file.size || file.size > AVATAR_MAX_BYTES) {
    return Promise.reject(new Error('Choose an image up to 2 MB.'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That image could not be read.'));
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('That image could not be read.'));
    reader.readAsDataURL(file);
  });
}
