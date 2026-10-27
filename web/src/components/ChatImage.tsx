import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ExternalLink, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';

function ImagePreview({ src, alt, close }: { src: string; alt: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  const [zoomed, setZoomed] = useState(false), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const local = src.startsWith('/') || src.startsWith('data:');
  useEffect(() => {
    const node = dialog.current, opener = document.activeElement;
    node?.showModal();
    return () => { node?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} aria-labelledby={title}
    className="m-auto max-h-[94dvh] w-[calc(100%_-_1rem)] max-w-6xl overflow-hidden rounded-2xl border border-edge bg-canvas p-0 text-ink shadow-2xl backdrop:bg-black/65 backdrop:backdrop-blur-sm open:flex open:flex-col sm:rounded-3xl"
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
    <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 sm:px-5"><div className="min-w-0 flex-1"><h2 id={title} className="truncate text-sm font-semibold">{alt || 'Image preview'}</h2><p className="mt-0.5 text-[11px] text-muted">{size ? `${size.width} × ${size.height}` : failed ? 'Preview unavailable' : 'Loading image…'}</p></div>
      <button autoFocus type="button" aria-label="Close image preview" title="Close (Esc)" onClick={close} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-neutral hover:text-ink cursor-pointer"><X size={20} /></button></header>
    <div tabIndex={0} aria-label="Image canvas" className="min-h-48 min-w-0 flex-1 overflow-auto bg-panel p-3 sm:p-6">
      {failed ? <div className="flex min-h-60 flex-col items-center justify-center gap-3 text-center"><p role="alert" className="text-sm text-muted">This image could not be loaded.</p><button type="button" className="inline-flex items-center gap-2 rounded-xl border border-edge bg-surface px-3 py-2 text-sm cursor-pointer" onClick={() => { setFailed(false); setSize(null); setAttempt(value => value + 1); }}><RotateCcw size={15} />Try again</button></div>
        : <img key={attempt} src={src} alt={alt || 'Attached image'} referrerPolicy="no-referrer" decoding="async" onError={() => setFailed(true)} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={zoomed && size ? { width: size.width, height: size.height, maxWidth: 'none' } : undefined}
          className={zoomed ? 'mx-auto block rounded-lg' : 'mx-auto block max-h-[68dvh] max-w-full rounded-lg object-contain'} />}
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 sm:px-5"><button type="button" disabled={!size || failed} aria-pressed={zoomed} className="inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs text-muted hover:bg-hover hover:text-ink disabled:opacity-40 cursor-pointer" onClick={() => setZoomed(value => !value)}>{zoomed ? <ZoomOut size={16} /> : <ZoomIn size={16} />}{zoomed ? 'Fit to screen' : 'Actual size'}</button>
      <a className="inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs text-muted hover:bg-hover hover:text-ink" href={src} {...(local ? { download: (alt || 'image').replace(/[/\\]/g, '-') } : { target: '_blank', rel: 'noreferrer' })}>{local ? <Download size={16} /> : <ExternalLink size={16} />}{local ? 'Download image' : 'Open original'}</a></footer>
  </dialog>, document.body);
}

export function ChatImage({ src, alt }: { src: string; alt: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null), [opened, setOpened] = useState(false);
  if (failedSource === src) return <span className="my-2 inline-flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-xs text-muted">{alt || 'Image'} is unavailable.<button type="button" className="underline underline-offset-2 cursor-pointer" onClick={() => setFailedSource(null)}>Retry image</button></span>;
  return <><button type="button" aria-label={`Preview image: ${alt || 'Attached image'}`} onClick={() => setOpened(true)} className="group relative my-2 block max-w-full overflow-hidden rounded-2xl border border-hair bg-canvas cursor-zoom-in">
    <img src={src} alt={alt || 'Attached image'} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedSource(src)} className="block max-h-[420px] max-w-full object-contain md:max-h-[520px]" />
    <span aria-hidden="true" className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-canvas/90 text-ink shadow-xs transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-visible:opacity-100"><Maximize2 size={15} /></span>
  </button>{opened && <ImagePreview key={src} src={src} alt={alt} close={() => setOpened(false)} />}</>;
}
