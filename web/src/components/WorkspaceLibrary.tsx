import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronRight, Code2, Download, File, FileText, Folder, Image, RefreshCw, Search, Sheet, X } from 'lucide-react';
import { hermesWorkspaceApi } from '../services/hermes-workspace';
import { libraryKind, librarySize, libraryText } from '../services/library';
import type { LibraryEntry, LibraryKind, LibraryPreview } from '../services/library';
import { buttonClass, EmptyState, Notice, Skeleton } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

const filters: { id: LibraryKind; label: string }[] = [
  { id: 'all', label: 'All files' }, { id: 'images', label: 'Images' }, { id: 'documents', label: 'Documents' },
  { id: 'spreadsheets', label: 'Spreadsheets' }, { id: 'code', label: 'Code' }, { id: 'other', label: 'Other' },
];
const types = {
  images: { icon: Image, color: 'text-violet-600 bg-violet-50', label: 'Image' },
  documents: { icon: FileText, color: 'text-blue-600 bg-blue-50', label: 'Document' },
  spreadsheets: { icon: Sheet, color: 'text-emerald-600 bg-emerald-50', label: 'Spreadsheet' },
  code: { icon: Code2, color: 'text-amber-700 bg-amber-50', label: 'Code' },
  other: { icon: File, color: 'text-muted bg-neutral', label: 'File' },
};
type Reader = (file: LibraryEntry, signal?: AbortSignal) => Promise<LibraryPreview>;

function FileArtwork({ file, read }: { file: LibraryEntry; read: Reader }) {
  const kind = libraryKind(file.name), { icon: Icon, color } = types[kind];
  const element = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState(''), [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (kind !== 'images' || (file.size !== undefined && file.size > 2 * 1024 * 1024)) return;
    const controller = new AbortController();
    let requested = false;
    const load = () => {
      if (requested) return;
      requested = true;
      void read(file, controller.signal).then(result => {
        if (!controller.signal.aborted && /^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(result.mimeType)) setSource(result.dataUrl);
      }).catch(() => { if (!controller.signal.aborted) setUnavailable(true); });
    };
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { load(); observer.disconnect(); }
    }, { rootMargin: '120px' });
    if (element.current) observer.observe(element.current);
    return () => { controller.abort(); observer.disconnect(); };
  }, [file, kind, read]);
  return <div ref={element} className={`relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-2xl ${kind === 'images' ? 'bg-neutral' : 'bg-panel'}`}>
    {source && !unavailable ? <img src={source} alt="" decoding="async" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.035]" onError={() => setUnavailable(true)} />
      : <div className="flex flex-col items-center gap-3"><span className={`flex h-16 w-14 items-center justify-center rounded-2xl shadow-xs ${color}`}><Icon size={29} strokeWidth={1.5} /></span><span className="text-[10px] font-semibold uppercase tracking-widest text-faint">{unavailable ? 'Preview unavailable' : file.name.includes('.') ? file.name.split('.').at(-1)?.slice(0, 10) : 'File'}</span></div>}
    <span className="absolute bottom-2.5 right-2.5 rounded-md bg-canvas/90 px-2 py-1 text-[10px] font-medium text-muted backdrop-blur-sm">{librarySize(file.size)}</span>
  </div>;
}

function FileDialog({ file, read, close }: { file: LibraryEntry; read: Reader; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  const [preview, setPreview] = useState<LibraryPreview | null>(null), [error, setError] = useState('');
  useEffect(() => {
    const node = dialog.current, opener = document.activeElement;
    node?.showModal();
    const controller = new AbortController();
    void read(file, controller.signal).then(result => { if (!controller.signal.aborted) setPreview(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)); });
    return () => { controller.abort(); node?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, [file, read]);
  const text = preview ? libraryText(preview) : null;
  const { icon: Icon, color, label } = types[libraryKind(file.name)];
  return createPortal(<dialog ref={dialog} aria-labelledby={title}
    className="m-auto flex-col open:flex max-h-[92dvh] w-[calc(100%_-_1.5rem)] max-w-4xl overflow-hidden rounded-3xl border border-edge bg-canvas p-0 text-ink shadow-2xl backdrop:bg-black/45 backdrop:backdrop-blur-sm"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]')];
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    }}>
    <header className="flex shrink-0 items-center gap-3 border-b border-line p-4 sm:p-5">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${color}`}><Icon size={20} /></span>
      <div className="min-w-0 flex-1"><h2 id={title} className="truncate text-sm font-semibold sm:text-base">{file.name}</h2><p className="mt-0.5 text-xs text-muted">{label} · {librarySize(file.size)}</p></div>
      <button autoFocus type="button" onClick={close} aria-label="Close file preview" className="rounded-full p-2 text-muted transition-colors hover:bg-neutral hover:text-ink cursor-pointer"><X size={19} /></button>
    </header>
    <div className="min-h-48 min-w-0 flex-1 overflow-auto bg-panel p-4 sm:p-7">
      {error ? <Notice error>{error}</Notice> : !preview ? <Skeleton className="h-64 w-full rounded-2xl" />
        : /^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(preview.mimeType) ? <img src={preview.dataUrl} alt={file.name} className="mx-auto max-h-[62dvh] max-w-full rounded-xl object-contain" />
          : text !== null ? <pre tabIndex={0} aria-label="File contents" className="whitespace-pre-wrap break-words rounded-2xl border border-line bg-canvas p-5 font-mono text-xs leading-relaxed text-code select-text sm:text-sm">{text}</pre>
            : <div className="flex min-h-60 flex-col items-center justify-center gap-4 text-center"><Icon size={44} strokeWidth={1.3} className="text-faint" /><p className="max-w-xs text-sm text-muted">Download this file to open it in your preferred app.</p></div>}
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line p-4 sm:px-5">
      <span className="min-w-0 flex-1 truncate text-xs text-muted" title={file.path}>{file.path}</span>
      {preview && <a className={buttonClass} href={preview.dataUrl} download={preview.name}><Download size={15} />Download</a>}
    </footer>
  </dialog>, document.body);
}

export function WorkspaceLibrary({ profile, scope }: { profile: string; scope?: ReactNode }) {
  const api = useMemo(() => hermesWorkspaceApi(profile), [profile]);
  const [directory, setDirectory] = useState(''), [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [search, setSearch] = useState(''), [filter, setFilter] = useState<LibraryKind>('all');
  const [selected, setSelected] = useState<LibraryEntry | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [limit, setLimit] = useState(12), [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true); setError('');
    try {
      const result = await api<{ entries: LibraryEntry[] }>('files', {}, { path: directory });
      if (current === sequence.current) { setEntries(result.entries); setRevision(value => value + 1); }
    } catch (reason) { if (current === sequence.current) setError(errorText(reason)); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [api, directory]);
  useEffect(() => { const requests = sequence, timer = window.setTimeout(load, 0); return () => { requests.current++; window.clearTimeout(timer); }; }, [load]);
  const read = useCallback<Reader>((file, signal) => api<LibraryPreview>('file', { signal }, { path: file.path }), [api]);
  const navigate = (path: string) => { setDirectory(path); setSelected(null); setSearch(''); setFilter('all'); setLimit(12); };
  const files = entries.filter(file => !file.directory), folders = entries.filter(file => file.directory);
  const matches = entries.filter(file => (filter === 'all' || (!file.directory && libraryKind(file.name) === filter)) && file.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const crumbs = directory.split('/').filter(Boolean);
  return <section className="space-y-6" aria-label="File library">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">Your files</h2><p className="mt-1.5 text-sm text-muted">A place for everything your bot creates.</p></div><div className="flex items-center gap-2">{scope}<button type="button" className="rounded-full p-2.5 text-muted transition-colors hover:bg-neutral cursor-pointer disabled:opacity-40" disabled={loading} aria-label="Refresh library" onClick={() => void load()}><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button></div></div>
    <div className="sticky top-0 z-10 space-y-4 bg-canvas py-2">
      <div className="relative"><Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faint" /><input aria-label="Search library" placeholder="Search files in this folder" value={search} onChange={event => { setSearch(event.target.value); setLimit(12); }} className="h-12 w-full rounded-2xl border border-line bg-panel pl-11 pr-11 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-accent" />{search && <button type="button" aria-label="Clear library search" onClick={() => { setSearch(''); setLimit(12); }} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted hover:bg-neutral cursor-pointer"><X size={15} /></button>}</div>
      <div className="flex flex-wrap gap-2" aria-label="File types">{filters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setLimit(12); }} className={`rounded-full border px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer ${filter === item.id ? 'border-ink bg-ink text-canvas' : 'border-line text-muted hover:bg-neutral hover:text-ink'}`}>{item.label}</button>)}</div>
    </div>
    <div className="flex min-w-0 items-center justify-between gap-3"><nav aria-label="Library folders" className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs"><button type="button" className="rounded-lg px-1 py-1 text-muted hover:text-ink cursor-pointer" onClick={() => navigate('')}>Workspace</button>{crumbs.map((crumb, index) => <span key={index} className="flex min-w-0 items-center gap-1.5"><ChevronRight size={13} className="shrink-0 text-faint" /><button type="button" className="max-w-36 truncate rounded-lg px-1 py-1 text-muted hover:text-ink cursor-pointer" onClick={() => navigate(crumbs.slice(0, index + 1).join('/'))}>{crumb}</button></span>)}</nav><p className="shrink-0 text-[11px] text-faint">{loading ? 'Loading…' : search || filter !== 'all' ? `${matches.length} results` : `${files.length} file${files.length === 1 ? '' : 's'}${folders.length ? ` · ${folders.length} folder${folders.length === 1 ? '' : 's'}` : ''}`}</p></div>
    {error && <Notice error>{error}</Notice>}
    {loading ? <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="space-y-3"><Skeleton className="aspect-[4/3] rounded-2xl" /><Skeleton className="h-3 w-3/4" /></div>)}</div>
      : !matches.length ? <EmptyState icon={<Folder size={32} strokeWidth={1.3} />} title={search || filter !== 'all' ? 'No matching files' : 'Your next creation belongs here'} description={search || filter !== 'all' ? 'Try another name or choose a different file type.' : 'Images, documents, and other files your bot creates in this folder will appear here.'} action={search || filter !== 'all' ? <button className={buttonClass} onClick={() => { setSearch(''); setFilter('all'); }}>Clear filters</button> : undefined} />
        : <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4" aria-label="Library gallery">{matches.slice(0, limit).map(file => <button key={`${revision}:${file.path}`} type="button" aria-label={`${file.directory ? 'Open folder' : 'Preview'} ${file.name}`} onClick={() => file.directory ? navigate(file.path) : setSelected(file)} className="group min-w-0 rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-4 focus-visible:ring-offset-canvas cursor-pointer">
          {file.directory ? <div className="flex aspect-[4/3] items-center justify-center rounded-2xl border border-line bg-panel transition-colors group-hover:bg-neutral"><Folder size={48} strokeWidth={1.2} className="text-amber-500" /></div> : <FileArtwork file={file} read={read} />}
          <p className="mt-3 truncate px-0.5 text-[13px] font-medium text-ink" title={file.name}>{file.name}</p><p className="mt-1 px-0.5 text-[11px] text-faint">{file.directory ? 'Folder' : types[libraryKind(file.name)].label}</p>
        </button>)}</div>}
    {!loading && matches.length > limit && <div className="flex justify-center"><button className={buttonClass} onClick={() => setLimit(value => value + 12)}>Show more · {matches.length - limit} remaining</button></div>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-[11px] text-faint"><span>Files stay in this bot’s workspace.</span><span>Previews and downloads up to 2 MB</span></div>
    {directory && <button className="inline-flex items-center gap-2 text-xs text-muted hover:text-ink cursor-pointer" onClick={() => navigate(crumbs.slice(0, -1).join('/'))}><ArrowLeft size={14} />Parent folder</button>}
    {selected && <FileDialog key={selected.path} file={selected} read={read} close={() => setSelected(null)} />}
  </section>;
}
