import { constants } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HermesError, hermesProfile } from './hermes-client.mjs';

// Hermes owns a profile's avatar as `assets/avatar.<ext>` (PNG/JPEG/WebP, <= 2 MiB):
// the same file `profiles.get_asset` serves and `has_avatar` reports. The app's control
// transports (the canonical `hermes-gateway-v1` bridge and the dashboard HTTP surface)
// expose no asset upload, so hob writes that exact native asset in place and reads it
// back. Hermes' own roster, `has_avatar` and `profiles.get_asset` observe the result.
const MAX = 2 * 1024 * 1024;
const ASSETS = 'assets';
// Magic bytes are sniffed, never the declared media type (mirrors the native handler).
const FORMATS = {
  png: { mime: 'image/png', probe: bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', probe: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  webp: { mime: 'image/webp', probe: bytes => bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' },
};
export const AVATAR_EXTENSIONS = Object.keys(FORMATS);

const invalid = message => new HermesError(400, message, 'INVALID_AVATAR');
const profileDir = (home, name) => hermesProfile(name) === 'default'
  ? path.resolve(home)
  : path.join(path.resolve(home), 'profiles', hermesProfile(name));

async function existingProfileDir(home, name) {
  const directory = profileDir(home, name);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw new HermesError(404, 'This bot no longer exists.', 'BOT_NOT_FOUND');
  return directory;
}

function decode(data) {
  if (typeof data !== 'string' || !data.trim()) throw invalid('Choose a PNG, JPEG, or WebP image up to 2 MB.');
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,(.*)$/is.exec(data.trim());
  const encoded = (match ? match[2] : data.trim()).replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw invalid('That image could not be read.');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX) throw invalid('Choose a PNG, JPEG, or WebP image up to 2 MB.');
  const ext = AVATAR_EXTENSIONS.find(extension => FORMATS[extension].probe(bytes));
  if (!ext) throw invalid('Choose a PNG, JPEG, or WebP image up to 2 MB.');
  return { bytes, ext };
}

// The order is fixed so an upload replaces any previously stored format.
export async function readAvatar(home, name) {
  const directory = await existingProfileDir(home, name);
  for (const ext of AVATAR_EXTENSIONS) {
    const filename = path.join(directory, ASSETS, `avatar.${ext}`);
    const info = await stat(filename).catch(() => null);
    if (info?.isFile() && info.size > 0 && info.size <= MAX) {
      return { ext, filename, size: info.size, mime: FORMATS[ext].mime, mtimeMs: info.mtimeMs };
    }
  }
  return null;
}

export async function avatarUrl(home, name) {
  if (!home) return '';
  const found = await readAvatar(home, name).catch(() => null);
  return found ? `/api/hermes/profiles/${encodeURIComponent(name)}/avatar/image?v=${Math.round(found.mtimeMs)}` : '';
}

export async function setAvatar(home, name, data) {
  const { bytes, ext } = decode(data);
  const directory = await existingProfileDir(home, name);
  const assets = path.join(directory, ASSETS);
  await mkdir(assets, { recursive: true, mode: 0o700 });
  const temporary = path.join(assets, `.avatar-${process.pid}-${Date.now()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path.join(assets, `avatar.${ext}`));
  await Promise.all(AVATAR_EXTENSIONS.filter(other => other !== ext)
    .map(other => unlink(path.join(assets, `avatar.${other}`)).catch(() => {})));
  return { ok: true, size: bytes.length, mime: FORMATS[ext].mime };
}

export async function clearAvatar(home, name) {
  const directory = await existingProfileDir(home, name);
  const removed = await Promise.all(AVATAR_EXTENSIONS
    .map(ext => unlink(path.join(directory, ASSETS, `avatar.${ext}`)).then(() => 1).catch(() => 0)));
  return { ok: true, removed: removed.reduce((total, count) => total + count, 0) };
}

// Streams a native asset without buffering the whole file into the event loop twice.
export async function streamAvatar(res, found) {
  const handle = await open(found.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== found.size) throw new HermesError(502, 'The bot avatar changed while it was being read.', 'AVATAR_UNAVAILABLE');
    const bytes = Buffer.alloc(info.size);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    res.writeHead(200, { 'Content-Type': found.mime, 'Content-Length': count, 'Cache-Control': 'private, max-age=60' });
    res.end(bytes.subarray(0, count));
  } finally { await handle.close(); }
}
