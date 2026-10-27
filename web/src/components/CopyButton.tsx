import { useEffect, useRef, useState } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';

export function CopyButton({ text, label = 'Copy message', compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  return <button type="button" aria-label={status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed. Select the text to copy it.' : label} title={status === 'failed' ? 'Copy failed. Select the text to copy it.' : status === 'copied' ? 'Copied' : label}
    className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-ink cursor-pointer"
    onClick={async () => {
      clearTimeout(timer.current);
      try { await navigator.clipboard.writeText(text); if (alive.current) setStatus('copied'); }
      catch { if (alive.current) setStatus('failed'); }
      if (alive.current) timer.current = setTimeout(() => setStatus('idle'), 2200);
    }}>{status === 'copied' ? <Check size={14} /> : status === 'failed' ? <TriangleAlert size={14} className="text-bad" /> : <Copy size={14} />}{!compact && <span>{status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy'}</span>}<span className="sr-only" role="status">{compact ? status === 'copied' ? 'Copied to clipboard' : status === 'failed' ? 'Copy failed. Select the text to copy it.' : '' : ''}</span></button>;
}
