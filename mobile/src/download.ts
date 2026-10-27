import { fetch } from 'expo/fetch';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { sameInstance } from './connection';
import type { Connection } from './connection';

export async function downloadFile(connection: Connection, url: string, name: string) {
  const file = new File(Paths.cache, `${Date.now()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'hob-file'}`);
  try {
    if (/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(url)) {
      const base64 = url.slice(url.indexOf(',') + 1);
      if (base64.length > 35_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('This download is too large or invalid.');
      await file.write(base64, { encoding: 'base64' });
    } else {
      if (!sameInstance(url, connection.origin)) throw new Error('Downloads must come from your connected hob instance.');
      const response = await fetch(url, { headers: { Authorization: `Bearer ${connection.token}` }, redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (!response.ok || !sameInstance(response.url || url, connection.origin)) throw new Error('The file could not be downloaded.');
      const reader = response.body?.getReader(); if (!reader) throw new Error('The download was empty.');
      const chunks: Uint8Array[] = []; let total = 0;
      try {
        while (true) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > 25 * 1024 * 1024) throw new Error('Downloads are limited to 25 MB.'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      await file.write(bytes);
    }
    if (!await Sharing.isAvailableAsync()) throw new Error('File sharing is unavailable on this device.');
    await Sharing.shareAsync(file.uri, { dialogTitle: 'Save or share your hob file' });
  } finally { if (file.exists) file.delete(); }
}
