import { apiFetch } from './api';

export interface ChatAttachment { id: string; name: string; mime: string; size: number; uploadId?: string; preview?: string }
export interface PickedFile { name: string; mime: string; base64: string }
const EMPTY: ChatAttachment[] = [];
const drafts = new Map<string, ChatAttachment[]>(), listeners = new Map<string, Set<() => void>>();
const uploading = new Set<string>();
export const attachmentsUploading = (session: string) => uploading.has(session);
export const setAttachmentsUploading = (session: string, value: boolean) => {
  if (value) uploading.add(session); else uploading.delete(session);
  for (const listener of listeners.get(session) || []) listener();
};
export const attachmentDraft = (session: string) => {
  if (!drafts.has(session)) {
    try {
      const value = JSON.parse(localStorage.getItem('hob:attached:' + session) || '[]');
      if (Array.isArray(value) && value.length && value.every(f => typeof f?.id === 'string' && typeof f?.name === 'string')) drafts.set(session, value);
    } catch { /* Keep the in-memory draft. */ }
  }
  return drafts.get(session) || EMPTY;
};
export const setAttachmentDraft = (session: string, files: ChatAttachment[]) => {
  try {
    if (files.length) localStorage.setItem('hob:attached:' + session, JSON.stringify(files.map(({ id, name, size, mime, uploadId }) => ({ id, name, size, mime, uploadId }))));
    else localStorage.removeItem('hob:attached:' + session);
  } catch { /* Keep the in-memory draft. */ }
  for (const old of drafts.get(session) || []) {
    if (old.preview?.startsWith('blob:') && !files.some(f => f.id === old.id)) URL.revokeObjectURL(old.preview);
  }
  if (files.length) drafts.set(session, files); else drafts.delete(session);
  for (const listener of listeners.get(session) || []) listener();
};
export function subscribeAttachments(session: string, listener: () => void) {
  const set = listeners.get(session) || new Set<() => void>(); set.add(listener); listeners.set(session, set);
  return () => { set.delete(listener); if (!set.size && listeners.get(session) === set) listeners.delete(session); };
}
declare global { interface Window { ReactNativeWebView?: { postMessage: (value: string) => void }; __hobPendingConversation?: { profile: string; sessionKey: string } } }

export function pickNativeMedia(): Promise<PickedFile[]> {
  const bridge = window.ReactNativeWebView;
  if (!bridge) return Promise.reject(new Error('The phone media picker is available in the hob mobile app.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (value?: PickedFile[], error?: string) => { window.removeEventListener('hob:native-response', receive); clearTimeout(timer); if (error) reject(new Error(error)); else resolve(value || []); };
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.id !== id) return;
      if (detail.error) { finish(undefined, String(detail.error)); return; }
      if (!Array.isArray(detail.files) || detail.files.length > 10 || detail.files.some((file: PickedFile) => typeof file.name !== 'string' || typeof file.mime !== 'string' || typeof file.base64 !== 'string' || file.base64.length > 7_000_000)) { finish(undefined, 'The media picker returned invalid files.'); return; }
      finish(detail.files);
    };
    const timer = setTimeout(() => finish(undefined, 'The media picker timed out. Try attaching again.'), 5 * 60_000);
    window.addEventListener('hob:native-response', receive);
    bridge.postMessage(JSON.stringify({ type: 'pick-media', id }));
  });
}
interface BrowserEntry { kind: 'directory' | 'file'; name: string; values(): AsyncIterable<BrowserEntry>; getFile(): Promise<File> }
export interface UploadEntry { path: string; size: number; file?: File; directory?: boolean }
export async function pickBrowserFiles(folder = false): Promise<UploadEntry[]> {
  const picker = (window as Window & { showDirectoryPicker?: () => Promise<BrowserEntry> }).showDirectoryPicker;
  if (folder && picker) {
    const entries: UploadEntry[] = [];
    async function visit(handle: BrowserEntry, path: string) {
      if (handle.kind === 'directory') {
        entries.push({ path, directory: true, size: 0 });
        for await (const child of handle.values()) await visit(child, path + '/' + child.name);
      } else {
        const file = await handle.getFile();
        entries.push({ path, file, size: file.size });
      }
    }
    try { const dir = await picker.call(window); await visit(dir, dir.name); return entries; }
    catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return []; throw error; }
  }
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = folder;
    input.onchange = () => resolve(Array.from(input.files || [], file => ({ path: file.webkitRelativePath || file.name, size: file.size, file })));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function uploadAttachment(profile: string, session: string, file: PickedFile): Promise<ChatAttachment> {
  const result = await apiFetch<ChatAttachment>(`/api/sessions/${encodeURIComponent(session)}/attachments`, {
    method: 'POST', headers: { 'X-Hob-Profile': profile }, body: JSON.stringify(file),
  });
  return { ...result, ...(result.mime.startsWith('image/') ? { preview: `data:${result.mime};base64,${file.base64}` } : {}) };
}
