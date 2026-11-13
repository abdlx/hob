import { useState } from 'react';
import { apiFetch } from '../services/api';
import { File, X } from 'lucide-react';
import type { ChatAttachment } from '../services/attachments';

export function ComposerAttachments({ files, remove, disabled, session, profile }: { session: string; profile: string; files: ChatAttachment[]; remove: (id: string) => void; disabled: boolean }) {
  const [details, setDetails] = useState<{ path: string; url: string }[]>([]), [error, setError] = useState('');
  async function inspect(id: string) {
    const url = '/api/sessions/' + encodeURIComponent(session) + '/uploads?id=' + id + '&profile=' + encodeURIComponent(profile);
    try {
      const data = await apiFetch<{entries: {path: string; directory: boolean}[]}>(url + '&details=1', { headers: { 'X-Hob-Profile': profile } });
      setDetails(data.entries.flatMap((e, i) => e.directory ? [] : [{ path: e.path, url: url + '&download=' + i }]));
      setError('');
    } catch { setError('Could not load attachment details.'); }
  }
  return <><div aria-label="Prompt attachments" className="hob-attachments flex gap-2 overflow-x-auto p-3 pb-0">{files.map(file => <div key={file.id} className="relative flex w-40 shrink-0 items-center gap-2 rounded-2xl border border-hair bg-panel p-2 pr-7">
    {file.preview ? <img src={file.preview} alt="" className="h-12 w-12 shrink-0 rounded-xl object-cover" /> : <span className="flex h-12 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral text-muted"><File size={21} /></span>}
    <div className="min-w-0"><p className="truncate text-xs font-medium text-ink" title={file.name}>{file.uploadId ? <button onClick={() => void inspect(file.uploadId!)}>{file.name}</button> : file.name}</p><p className="mt-1 text-[10px] text-muted">{file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(file.size / 1024)} KB`}</p></div>
    <button type="button" disabled={disabled} aria-label={`Remove attachment ${file.name}`} onClick={() => remove(file.id)} className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink disabled:opacity-40 cursor-pointer"><X size={13} /></button>
  </div>)}</div>{details.length > 0 && <div className="mx-3 max-h-36 overflow-auto p-2 text-xs"><button onClick={() => setDetails([])}>Close details</button>{details.map(item => <a className="block py-1 text-accent" key={item.url} href={item.url} download>{item.path}</a>)}</div>}{error && <p role="alert">{error}</p>}</>;
}
