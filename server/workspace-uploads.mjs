import path from 'node:path';
import { constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { imageMime } from './hermes-attachments.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { HermesError } from './hermes-client.mjs';

const fail = (message, status = 400) => new HermesError(status, message, 'UPLOAD_ERROR');
const chunkSize = 1024 * 1024;
function validateEntry(entry) {
  if (!entry || typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0) throw fail('Invalid upload entry.');
  if (entry.directory && entry.size !== 0) throw fail('Folders do not carry file bytes.');
  const parts = entry.path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.length > 255 || /[\\:\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw fail('Unsupported file path.');
  return { path: entry.path, size: entry.size, directory: entry.directory === true };
}

// Staging and metadata are private to the server. Only a complete batch is published.
export function workspaceUploads({ stateDir, workspaceRoot, reference }) {
  const active = new Set();
  return async ({ req, url, owner, key, body, json, res }) => {
    if (!stateDir || !workspaceRoot) throw fail('The workspace upload volume is unavailable.', 503);
    const root = path.join(stateDir, 'uploads', createHash('sha256').update(key).digest('hex'));
    const id = url.searchParams.get('id');
    if (!id && req.method === 'GET') {
      const items = [];
      for (const entry of await readdir(root, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        const dir = path.join(root, entry.name);
        const manifest = await readFile(path.join(dir, 'manifest.json'), 'utf8').catch(() => null);
        if (!manifest) continue;
        const entries = JSON.parse(manifest);
        const complete = Boolean(await stat(path.join(dir, 'receipt.json')).catch(() => null));
        let bytes = 0;
        for (const file of entries) if (!file.directory) bytes += complete ? file.size : (await stat(path.join(dir, 'files', file.path)).catch(() => null))?.size || 0;
        items.push({ id: entry.name, name: entries[0].path.split('/')[0], bytes, complete });
      }
      return json(res, 200, { items });
    }
    if (!id && req.method === 'POST') {
      const input = await body(req, { maxBytes: 8 * 1024 * 1024 });
      if (!Array.isArray(input.entries) || !input.entries.length) throw fail('Choose files or a folder.');
      const entries = input.entries.map(validateEntry);
      const names = new Set(entries.map(e => e.path.toLowerCase()));
      if (names.size !== entries.length) throw fail('Duplicate file names in selection.');
      const upload = randomUUID(), dir = path.join(root, upload);
      await mkdir(path.join(dir, 'files'), { recursive: true, mode: 0o700 });
      try {
        for (const entry of entries) {
          const filename = path.join(dir, 'files', entry.path);
          await mkdir(entry.directory ? filename : path.dirname(filename), { recursive: true, mode: 0o700 });
          if (!entry.directory) await writeFile(filename, '', { flag: 'wx', mode: 0o600 });
        }
        await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(entries));
      } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
      return json(res, 201, { id: upload, chunkSize });
    }
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw fail('Invalid upload.');
    const dir = path.join(root, id);
    if (active.has(dir)) throw fail('Upload is busy.', 409);
    active.add(dir);
    try {
      const entries = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8').catch(() => { throw fail('Upload unavailable.', 404); }));
      if (url.searchParams.has('download') || url.searchParams.has('details')) {
        if (req.method !== 'GET') throw fail('Invalid download operation.');
        const receipt = JSON.parse(await readFile(path.join(dir, 'receipt.json'), 'utf8').catch(() => { throw fail('Upload is incomplete.', 409); }));
        if (url.searchParams.has('details')) return json(res, 200, { name: receipt.name, size: receipt.size, entries });
        const index = url.searchParams.get('download');
        const entry = /^\d+$/.test(index) && entries[Number(index)];
        if (!entry || entry.directory) throw fail('Select a file.');
        const assigned = path.join(await realpath(workspaceRoot), owner.profile === 'default' ? 'main' : path.join('bots', owner.profile));
        const filename = path.join(assigned, 'uploads', id, entry.path);
        if (await realpath(filename) !== filename) throw fail('File is unavailable.', 404);
        const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.nlink !== 1) throw fail('File is unavailable.', 404);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(filename)), 'Content-Length': info.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          await pipeline(handle.createReadStream(), res);
        } finally { await handle.close(); }
        return;
      }
      if (req.method === 'DELETE') {
        if (await stat(path.join(dir, 'receipt.json')).catch(() => null)) {
          if (url.searchParams.get('remove') !== '1') throw fail('File has already been published.', 409);
          const assigned = path.join(await realpath(workspaceRoot), owner.profile === 'default' ? 'main' : path.join('bots', owner.profile));
          const parent = path.join(assigned, 'uploads');
          if (await realpath(parent) !== parent) throw fail('Invalid workspace.');
          await rm(path.join(parent, id), { recursive: true, force: true });
        }
        await rm(dir, { recursive: true, force: true });
        return json(res, 200, { cancelled: true });
      }
      if (req.method === 'GET' && !url.searchParams.has('entry')) return json(res, 200, { exists: true });
      if (url.searchParams.has('entry')) {
        const index = url.searchParams.get('entry');
        const entry = /^\d+$/.test(index) && entries[Number(index)];
        if (!entry || typeof entry.path !== 'string' || entry.directory) throw fail('Invalid upload entry.');
        const file = path.join(dir, 'files', entry.path);
        if (req.method === 'GET' && await stat(path.join(dir, 'receipt.json')).catch(() => null)) return json(res, 200, { offset: entry.size });
        const offset = (await stat(file)).size;
        if (req.method === 'GET') return json(res, 200, { offset });
        if (req.method !== 'PUT' || String(offset) !== url.searchParams.get('offset')) throw fail('Refresh the upload offset.', 409);
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > chunkSize || size + offset > entry.size) throw fail('Invalid chunk size.', 413);
          chunks.push(chunk);
        }
        if (!size) throw fail('Empty upload chunk.');
        const handle = await open(file, 'a');
        try { await handle.writeFile(Buffer.concat(chunks)); } finally { await handle.close(); }
        return json(res, 200, { offset: offset + size });
      }
      if (req.method !== 'POST') throw fail('Invalid upload operation.');
      const assigned = path.join(await realpath(workspaceRoot), owner.profile === 'default' ? 'main' : path.join('bots', owner.profile));
      if (await realpath(assigned) !== assigned) throw fail('Invalid workspace.');
      const target = path.join(assigned, 'uploads');
      await mkdir(target, { recursive: true });
      if (await realpath(target) !== target) throw fail('Invalid upload directory.');
      const destination = path.join(target, id);
      const receipt = await readFile(path.join(dir, 'receipt.json'), 'utf8').catch(() => null);
      if (receipt) return json(res, 200, JSON.parse(receipt));
      const source = path.join(dir, 'files');
      const published = await stat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!published) {
        for (const entry of entries) {
          if (!entry.directory && (await stat(path.join(source, entry.path))).size !== entry.size) throw fail('Upload is incomplete.', 409);
        }
        try { await rename(source, destination); }
        catch (error) {
          if (error.code !== 'EXDEV') throw error;
          const temporary = path.join(target, '.upload-' + randomUUID());
          try {
            await cp(source, temporary, { recursive: true, force: false, errorOnExist: true });
            await rename(temporary, destination);
          } finally { await rm(temporary, { recursive: true, force: true }); }
        }
      }
      const single = entries.length === 1 && !entries[0].directory;
      const roots = new Set(entries.map(e => e.path.split('/')[0]));
      const rootName = roots.size === 1 ? entries[0].path.split('/')[0] : '';
      const name = single ? entries[0].path : rootName || entries.length + ' entries';
      const filename = path.join(destination, single ? entries[0].path : rootName);
      let image;
      if (single && entries[0].size <= 5 * 1024 * 1024) {
        const handle = await open(filename, 'r');
        try { const prefix = Buffer.alloc(12); await handle.read(prefix); image = imageMime(prefix); } finally { await handle.close(); }
      }
      const result = reference(key, filename, name, entries.reduce((n, e) => n + e.size, 0), image);
      result.uploadId = id;
      await writeFile(path.join(dir, 'receipt.tmp'), JSON.stringify(result));
      await rename(path.join(dir, 'receipt.tmp'), path.join(dir, 'receipt.json'));
      await rm(path.join(dir, 'files'), { recursive: true, force: true });
      return json(res, 200, result);
    } finally { active.delete(dir); }
  };
}
