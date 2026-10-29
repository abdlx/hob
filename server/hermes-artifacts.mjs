import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HermesError, hermesProfile } from './hermes-client.mjs';
import { readObservedFile } from './bounded-file.mjs';

const formats = /\.(?:png|jpe?g|gif|webp|avif|bmp|pdf|docx|xlsx|pptx|csv|tsv|txt|md|json|html|css|js|ts|py|zip)$/i;
const sensitive = /(?:^|[\\/])(?:\.env(?:\..*)?|\.hob|auth(?:\.json)?|credentials?|secrets?|config\.ya?ml|state\.db|node_modules|\.git)(?:[\\/]|$)|(?:\.pem|\.key)$/i;
const within = (root, item) => { const relative = path.relative(root, item); return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
const denied = () => new HermesError(400, 'Only generated, non-sensitive files belonging to this bot can be published.', 'ARTIFACT_UNAVAILABLE');

export function resultFileReferences(content) {
  const literal = String(content || '').split(/(```[\s\S]*?```)/g).filter((_, index) => index % 2 === 0).join('\n');
  const references = new Set();
  for (const match of literal.matchAll(/(?:MEDIA:|@image:)\s*(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|([^\s]+))|!?\[[^\]]*\]\(([^)\n]+)\)/gi)) {
    const value = match.slice(1).find(Boolean)?.trim();
    if (value && !/^[a-z]+:\/\//i.test(value) && formats.test(value) && references.size < 100) references.add(value);
  }
  return [...references];
}

/** Durable copies in the existing workspace. The manifest is delivery metadata, not task authority. */
export function createArtifactPublisher({ home, workspaceRoot, stateDir, authorize }) {
  const queues = new Map();
  async function publish(profile, source, runId) {
    hermesProfile(profile); await authorize(profile);
    if (!home || !workspaceRoot || !stateDir || typeof runId !== 'string' || !runId || runId.length > 1024 || typeof source !== 'string' || source.length > 8192 || /[\x00-\x1f]/.test(source) || !formats.test(source) || sensitive.test(source)) throw denied();
    const sharedRoot = await realpath(workspaceRoot);
    const assigned = path.join(sharedRoot, profile === 'default' ? 'main' : path.join('bots', profile));
    const workspace = await realpath(assigned);
    if (workspace !== assigned) throw denied();
    const nativeRoot = await realpath(profile === 'default' ? home : path.join(home, 'profiles', profile));
    const roots = [workspace, nativeRoot];
    let filename;
    for (const root of roots) {
      const candidate = path.resolve(root, source);
      if (!within(root, candidate) || sensitive.test(path.relative(root, candidate))) continue;
      const resolved = await realpath(candidate).catch(() => null);
      if (!resolved || !within(root, resolved) || sensitive.test(path.relative(root, resolved))) continue;
      if (profile === 'default' && (within(path.join(nativeRoot, 'profiles'), resolved) || within(path.join(sharedRoot, 'bots'), resolved))) continue;
      filename = resolved; break;
    }
    if (!filename) throw denied();
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 25 * 1024 * 1024) throw denied();
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.nlink !== 1 || current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size) throw denied();
      bytes = await readObservedFile(handle, info.size);
      const after = await handle.stat();
      if (bytes.length !== info.size || after.mtimeMs !== current.mtimeMs || after.size !== current.size) throw denied();
    } finally { await handle.close(); }
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await authorize(profile);
    const folder = path.join(workspace, 'artifacts');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (await realpath(folder) !== folder) throw denied();
    const name = path.dirname(filename) === folder ? path.basename(filename) : `${checksum.slice(0, 16)}-${path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120)}`;
    const destination = path.join(folder, name);
    const staged = path.join(folder, `.${randomUUID()}.tmp`);
    try {
      const target = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
      try { await target.writeFile(bytes); await target.sync(); } finally { await target.close(); }
      await link(staged, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const status = await existing.stat();
        if (!status.isFile() || status.nlink !== 1 || status.size !== bytes.length || createHash('sha256').update(await readObservedFile(existing, bytes.length)).digest('hex') !== checksum) throw denied();
      } finally { await existing.close(); }
    } finally { await unlink(staged).catch(() => undefined); }
    await authorize(profile);
    const manifestRoot = path.join(stateDir, 'artifacts', profile);
    await mkdir(manifestRoot, { recursive: true, mode: 0o700 });
    const record = { version: 1, profile, runId, path: `artifacts/${name}`, name: path.basename(filename), checksum, size: bytes.length, status: 'published', at: new Date().toISOString() };
    const temporary = path.join(manifestRoot, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    const receiptId = createHash('sha256').update(JSON.stringify([profile, runId, checksum, record.path])).digest('hex');
    await rename(temporary, path.join(manifestRoot, `${receiptId}.json`));
    const failedId = createHash('sha256').update(JSON.stringify([runId, source])).digest('hex');
    if (failedId !== receiptId) await unlink(path.join(manifestRoot, `${failedId}.json`)).catch(() => undefined);
    return record;
  }
  return {
    async list(profile) {
      hermesProfile(profile); await authorize(profile);
      const folder = path.join(stateDir, 'artifacts', profile);
      const names = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      const records = [];
      for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/.test(value))) {
        const item = await readFile(path.join(folder, name), 'utf8').then(JSON.parse).catch(() => null);
        if (item?.profile === profile && ['published', 'failed'].includes(item.status)) records.push(item);
      }
      return records.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 100);
    },
    publish(profile, source, runId) {
      const work = (queues.get(profile) || Promise.resolve()).catch(() => undefined).then(() => publish(profile, source, runId)).catch(async error => {
        if (stateDir) {
          const folder = path.join(stateDir, 'artifacts', hermesProfile(profile));
          await authorize(profile);
          await mkdir(folder, { recursive: true, mode: 0o700 });
          const id = createHash('sha256').update(JSON.stringify([runId, source])).digest('hex');
          const record = { profile, runId, name: path.basename(String(source)).slice(0, 255), status: 'failed', at: new Date().toISOString(), message: 'Publication failed. The original file was preserved; ask the bot to save a copy in its workspace artifacts folder.' };
          const temporary = path.join(folder, `${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
            await rename(temporary, path.join(folder, `${id}.json`));
          } finally { await unlink(temporary).catch(() => undefined); }
        }
        throw error;
      });
      queues.set(profile, work); void work.finally(() => { if (queues.get(profile) === work) queues.delete(profile); }).catch(() => undefined);
      return work;
    },
  };
}
