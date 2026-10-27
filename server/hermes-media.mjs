import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HermesError, hermesProfile } from './hermes-client.mjs';

const MAX = 25 * 1024 * 1024;
const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i;
const MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
]);

const unavailable = () => new HermesError(404, 'This media file is unavailable.', 'MEDIA_NOT_FOUND');
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};

function profileHome(home, profile) {
  const root = path.resolve(home);
  return profile === 'default' ? root : path.join(root, 'profiles', hermesProfile(profile));
}

function workspaceHome(workspaces, profile) {
  return path.join(path.resolve(workspaces), profile === 'default' ? 'main' : path.join('bots', profile));
}

function normalize(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw unavailable();
  let target = value.trim();
  if (/^file:/i.test(target)) {
    try { target = fileURLToPath(target); } catch { throw unavailable(); }
  }
  if (target.startsWith('~/') || target.startsWith('~\\')) target = path.join(homedir(), target.slice(2));
  return target;
}

/**
 * Resolve one image path the agent can legitimately have written for this bot.
 * Only a profile's own home, its workspace and HOB's managed browser media are
 * readable; realpath checks make symlinked escapes inaccessible.
 */
export async function resolveMediaFile({ home, workspaces, stateDir, profile = 'default', value }) {
  if (!home) throw new HermesError(503, 'The native profile home is unavailable.', 'MEDIA_UNAVAILABLE');
  const name = hermesProfile(profile);
  const target = normalize(value);
  if (!IMAGE.test(target)) throw unavailable();
  const roots = [profileHome(home, name)];
  if (workspaces) roots.push(workspaceHome(workspaces, name));
  if (stateDir) roots.push(path.join(path.resolve(stateDir), 'media', 'browser'));

  for (const root of roots) {
    let base;
    try { base = await realpath(root); } catch { continue; }
    const candidate = path.resolve(base, target);
    if (!within(base, candidate)) continue;
    // Main's home is the shared parent of every profile directory. Serving
    // through that root would make one bot's images readable as another's.
    if (name === 'default' && (within(path.join(base, 'profiles'), candidate)
      || within(path.join(path.resolve(workspaces || path.join(home, 'workspaces')), 'bots'), candidate))) continue;
    let entry;
    try { entry = await lstat(candidate); } catch { continue; }
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    let resolved;
    try { resolved = await realpath(candidate); } catch { continue; }
    if (!within(base, resolved) || !IMAGE.test(resolved)) continue;
    if (name === 'default' && (within(path.join(base, 'profiles'), resolved)
      || within(path.join(path.resolve(workspaces || path.join(home, 'workspaces')), 'bots'), resolved))) continue;
    let info;
    try { info = await stat(resolved); } catch { continue; }
    if (!info.isFile() || info.size <= 0 || info.size > MAX) continue;
    const mime = MIME.get(path.extname(resolved).toLowerCase());
    if (!mime) continue;
    return { filename: resolved, name: path.basename(resolved), size: info.size, mime, dev: info.dev, ino: info.ino };
  }
  throw unavailable();
}

export async function serveHermesMedia(req, res, options) {
  const found = await resolveMediaFile(options);
  const handle = await open(found.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== found.size || info.dev !== found.dev || info.ino !== found.ino) {
      throw new HermesError(409, 'This media file changed before it could be read.', 'MEDIA_CHANGED');
    }
    const headers = {
      'Content-Type': found.mime,
      'Content-Length': String(found.size),
      'Content-Disposition': `inline; filename="${found.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const bytes = await handle.readFile();
    if (bytes.length !== found.size) throw new HermesError(409, 'This media file changed while it was being read.', 'MEDIA_CHANGED');
    res.end(bytes);
  } finally { await handle.close(); }
}
