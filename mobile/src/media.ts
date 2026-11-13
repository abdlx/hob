import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { getResolvedSharedPayloadsAsync } from 'expo-sharing';
import { fetch } from 'expo/fetch';
import { instanceRequest } from './api';
import type { Connection } from './connection';
import type { Attachment } from './workspace-types';

interface Entry { path: string; size: number; file?: File; directory?: boolean }
export type Picker = 'library' | 'camera' | 'files' | 'folder' | 'shared';
export async function pickMedia(kind: Picker): Promise<Entry[]> {
  if (kind === 'shared') {
    return (await getResolvedSharedPayloadsAsync()).flatMap(item => {
      if (!item.contentUri || !/^(file|content):/.test(item.contentUri)) return [];
      const file = new File(item.contentUri);
      return [{ file, path: item.originalName || file.name, size: item.contentSize ?? file.size }];
    });
  }
  if (kind === 'folder') {
    const folder = await Directory.pickDirectoryAsync();
    const entries: Entry[] = [];
    function visit(dir: Directory, path: string) {
      entries.push({ path, size: 0, directory: true });
      for (const item of dir.list()) {
        const name = path + '/' + item.name;
        if (item instanceof Directory) visit(item, name);
        else entries.push({ path: name, size: item.size, file: item });
      }
    }
    visit(folder, folder.name);
    return entries;
  }
  if (kind === 'files') {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: false });
    return result.canceled ? [] : result.assets.map(asset => {
      const file = new File(asset.uri);
      return { path: asset.name, size: file.size, file };
    });
  }
  if (kind === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) throw new Error('Allow camera access in phone settings.');
  const result = kind === 'camera' ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'] })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: 0 });
  return result.canceled ? [] : result.assets.map(asset => {
    const file = new File(asset.uri);
    return { path: asset.fileName || file.name, size: file.size, file };
  });
}

export async function uploadFiles(connection: Connection, profile: string, session: string, entries: Entry[], signal: AbortSignal, progress: (label: string) => void) {
  const base = '/api/sessions/' + encodeURIComponent(session) + '/uploads';
  const options = { token: connection.token, profile, signal };
  const folder = new Directory(Paths.document, 'uploads', connection.instanceId, profile);
  folder.create({ intermediates: true, idempotent: true });
  const checkpoint = new File(folder, session + '.json');
  const selection = JSON.stringify(entries.map(e => [e.path, e.size, e.file?.modificationTime]));
  let saved: {selection: string; id: string; chunkSize: number} | null = null;
  try { saved = JSON.parse(checkpoint.textSync()); } catch { /* First transfer. */ }
  let resumed = saved?.selection === selection ? saved : null;
  if (resumed) {
    try { await instanceRequest(connection.origin, base + '?id=' + resumed.id, options); }
    catch (err) { if ((err as { status?: number }).status === 404) resumed = null; else throw err; }
  }
  const batch = resumed || await instanceRequest<{ id: string; chunkSize: number }>(connection.origin, base, { ...options, method: 'POST', value: { entries: entries.map(({ path, size, directory }) => ({ path, size, directory })) } });
  checkpoint.write(JSON.stringify({ ...batch, selection }));
  const url = base + '?id=' + batch.id;
  try {
    for (const [index, entry] of entries.entries()) {
      if (!entry.file || !entry.size) continue;
      const handle = entry.file.open(FileMode.ReadOnly);
      const part = url + '&entry=' + index;
      try {
        let offset = resumed ? (await instanceRequest<{ offset: number }>(connection.origin, part, options)).offset : 0, retries = 0;
        while (offset < entry.size) {
          progress(entry.path + ' · ' + Math.floor(offset / entry.size * 100) + '%');
          handle.offset = offset;
          const chunk = await handle.readBytes(Math.min(entry.size - offset, batch.chunkSize));
          if (!chunk.length) throw new Error('File changed while uploading.');
          try {
            const response = await fetch(connection.origin + part + '&offset=' + offset, { method: 'PUT', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), headers: { Authorization: 'Bearer ' + connection.token, 'X-Hob-Profile': profile, 'Content-Type': 'application/octet-stream' }, body: chunk });
            if (!response.ok) throw new Error('Upload failed (HTTP ' + response.status + ').');
            offset = (await response.json()).offset;
            retries = 0;
          } catch (error) {
            if (signal.aborted || ++retries > 3) throw error;
            offset = (await instanceRequest<{ offset: number }>(connection.origin, part, options)).offset;
          }
        }
      } finally { handle.close(); }
    }
    const receipt = await instanceRequest<Attachment>(connection.origin, url, { ...options, method: 'POST' });
    checkpoint.delete();
    return receipt;
  } catch (error) {
    if (!signal.aborted) throw new Error(String(error) + ' Choose the same selection to resume.');
    checkpoint.delete();
    await instanceRequest(connection.origin, url, { ...options, signal: undefined, method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
}
