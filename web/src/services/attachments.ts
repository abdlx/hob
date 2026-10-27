import { apiFetch } from './api';

export interface ChatAttachment { id: string; name: string; mime: string; size: number; preview?: string }
export interface PickedFile { name: string; mime: string; base64: string }
const EMPTY: ChatAttachment[] = [];
const drafts = new Map<string, ChatAttachment[]>(), listeners = new Map<string, Set<() => void>>();
const uploading = new Set<string>();
export const attachmentsUploading = (session: string) => uploading.has(session);
export const setAttachmentsUploading = (session: string, value: boolean) => {
  if (value) uploading.add(session); else uploading.delete(session);
  for (const listener of listeners.get(session) || []) listener();
};
export const attachmentDraft = (session: string) => drafts.get(session) || EMPTY;
export const setAttachmentDraft = (session: string, files: ChatAttachment[]) => {
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
export function pickBrowserFiles(): Promise<PickedFile[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.style.display = 'none';
    document.body.append(input);
    const finish = () => { clearTimeout(timer); input.remove(); };
    const timer = setTimeout(() => { finish(); reject(new Error('File selection timed out.')); }, 5 * 60_000);
    input.oncancel = () => { finish(); resolve([]); };
    input.onchange = async () => {
      try {
        const files = [...(input.files || [])];
        if (files.length > 10 || files.some(file => file.size > 5 * 1024 * 1024 || !file.size)) throw new Error('Choose up to 10 files, each up to 5 MB.');
        const selected = await Promise.all(files.map(file => new Promise<PickedFile>((yes, no) => {
          const reader = new FileReader(); reader.onerror = () => no(new Error(`Could not read ${file.name}.`));
          reader.onload = () => yes({ name: file.name, mime: file.type || 'application/octet-stream', base64: String(reader.result).split(',')[1] }); reader.readAsDataURL(file);
        })));
        finish(); resolve(selected);
      } catch (error) { finish(); reject(error); }
    };
    input.click();
  });
}
export async function uploadAttachment(profile: string, session: string, file: PickedFile): Promise<ChatAttachment> {
  const result = await apiFetch<ChatAttachment>(`/api/sessions/${encodeURIComponent(session)}/attachments`, {
    method: 'POST', headers: { 'X-Hob-Profile': profile }, body: JSON.stringify(file),
  });
  return { ...result, ...(result.mime.startsWith('image/') ? { preview: `data:${result.mime};base64,${file.base64}` } : {}) };
}
