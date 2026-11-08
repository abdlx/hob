import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronRight, LockKeyhole, MessagesSquare, X } from 'lucide-react';
import { apiFetch } from '../services/api';
import { exchangeMessages, exchangePeer } from '../services/bot-exchanges';
import { ChatMessageItem } from './ChatMessageItem';
import { MarkdownView } from './MarkdownView';

export interface BotExchange {
  id: string; from: string; to: string; fromName: string; toName: string; status: string; createdAt: number; updatedAt?: number; replyAt?: number;
  message?: string; reply?: string; replyTruncated?: boolean; error?: string; observationError?: string; sessionKey?: string;
  failure?: Record<string, unknown>;
  teamTask?: { id: string };
  teamVerification?: 'unproven' | 'self-reported' | 'coordinator-reviewed' | 'coordinator-rejected';
  teamOutput?: { sha256: string; bytes: number; receivedAt: string };
}
interface ExchangePage { exchanges: BotExchange[]; nextBefore: number | null }
const failure = (error: unknown) => error instanceof Error ? error.message : 'Could not load bot conversations.';
const endpoint = (profile: string, path = '') => `/api/hermes/exchanges${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`;
const timestamp = (at: number) => new Date(at).toISOString();
const terminal = (status: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);

function ConversationDialog({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLElement>(null), close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const targets = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]') || [])].filter(node => node.getClientRects().length);
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keys);
    return () => { document.removeEventListener('keydown', keys); document.body.style.overflow = overflow; opener?.focus(); };
  }, []);
  return createPortal(<div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 sm:p-5" onClick={onClose}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-label={title} className="flex h-dvh max-h-dvh w-full min-w-0 flex-col overflow-hidden bg-canvas sm:h-[90dvh] sm:max-w-[840px] sm:rounded-2xl sm:border sm:border-line sm:shadow-xl" onClick={event => event.stopPropagation()}>
      <header className="flex shrink-0 items-center gap-3 border-b border-hair px-3 py-3 sm:px-5">
        <button type="button" aria-label={closeLabel} onClick={onClose} className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-neutral cursor-pointer"><ArrowLeft size={20} /></button>
        <div className="min-w-0 flex-1"><h2 className="break-words text-base font-semibold text-ink">{title}</h2><p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted"><LockKeyhole size={12} />Bot-to-bot · Read only</p></div>
      </header>
      {children}
    </section>
  </div>, document.body);
}

interface NativeMessage { role: string; name?: string; content: string | { type?: string; text?: string }[] }
const nativeText = (message: NativeMessage) => typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(part => part.text || '').join('\n') : '';
function NativeTranscript({ record, profile }: { record: BotExchange; profile: string }) {
  const [messages, setMessages] = useState<NativeMessage[] | null>(null), [error, setError] = useState('');
  const load = async () => {
    try { setMessages((await apiFetch<{ messages: NativeMessage[] }>(endpoint(profile, `/${record.id}/transcript`))).messages); setError(''); }
    catch (cause) { setError(failure(cause)); }
  };
  return <details className="mb-5 rounded-xl border border-hair p-3 text-xs text-muted" onToggle={event => { if (event.currentTarget.open && messages === null && !error) void load(); }}>
    <summary className="cursor-pointer">{record.replyTruncated ? 'Full reply and tool activity' : 'Tool activity and native transcript'}</summary>
    {error && <p role="alert" className="mt-2 text-bad">{error} <button type="button" onClick={() => void load()} className="underline">Retry</button></p>}
    {messages === null && !error && <p role="status" className="mt-2">Loading transcript…</p>}
    {messages?.filter(message => message.role !== 'user' && message.role !== 'system').map((message, index) => <div key={index} className="mt-3 min-w-0 break-words"><p className="mb-1 font-semibold text-ink">{message.role === 'assistant' ? record.toName : message.name || 'Tool'}</p>{message.role === 'assistant' ? <MarkdownView content={nativeText(message)} /> : <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{nativeText(message)}</pre>}</div>)}
    {messages?.length === 0 && <p className="mt-2">No native transcript was retained.</p>}
  </details>;
}

function ExchangeMessages({ record, profile, part, at }: { record: BotExchange; profile: string; part: 'request' | 'reply'; at: number }) {
  const bubble = (content: string, sender: string, name: string, suffix: string, at: number) => <>
    {sender === profile && <p className="mb-1 mr-2 text-right text-xs font-semibold text-muted">{name}</p>}
    <ChatMessageItem message={{ id: `${record.id}-${suffix}`, role: sender === profile ? 'user' : 'assistant', sender: name, profile: sender,
      content, timestamp: timestamp(at), status: 'complete' }} />
  </>;
  const review = !record.teamTask ? '' : record.teamVerification === 'coordinator-reviewed' ? `${record.fromName} reviewed the output and recorded passing checks.`
    : record.teamVerification === 'coordinator-rejected' ? `${record.fromName} reviewed the output and recorded failed checks.`
      : record.teamOutput ? 'The assigned output was received. Coordinator review is still pending.'
        : record.teamVerification === 'self-reported' ? 'The worker reported completion. Coordinator review is still pending.' : 'This result has not been verified.';
  if (part === 'request') return record.message ? <article className="min-w-0" data-exchange-message={`${record.id}-request`}>
    <div className="my-5 text-center text-[11px] text-faint"><time dateTime={timestamp(at)}>{new Date(at).toLocaleString()}</time></div>
    {bubble(record.message, record.from, record.fromName, 'request', at)}
  </article> : null;
  return <article data-exchange-message={`${record.id}-reply`} className="min-w-0">
    {record.reply ? bubble(record.reply, record.to, record.toName, 'reply', at)
      : <p role="status" className="mb-4 text-sm text-muted">{record.status === 'unknown' ? 'The outcome is unknown. Check again before retrying.' : terminal(record.status) ? 'No text reply was retained.' : `${record.toName} has not replied yet.`}</p>}
    <p className="mb-3 text-[11px] capitalize text-faint">{record.status.replaceAll('_', ' ')}{record.reply && ['failed', 'cancelled', 'interrupted'].includes(record.status) ? ' · Partial output' : ''}</p>
    {review && <p role="status" className="mb-3 text-xs text-muted">{review}</p>}
    {(record.error || record.observationError) && <p role="status" className="mb-3 whitespace-pre-wrap break-words text-xs text-amber-700">{record.error || record.observationError}</p>}
    {record.replyTruncated && <p className="mb-3 text-xs text-muted">Reply preview is shortened. Open the full reply below.</p>}
    <NativeTranscript record={record} profile={profile} />
  </article>;
}

function BotPairThread({ exchange, profile, onClose }: { exchange: BotExchange; profile: string; onClose: () => void }) {
  const peer = exchangePeer(exchange, profile);
  const [state, setState] = useState<{ rows: BotExchange[]; cursor: number | null; loading: boolean; error: string }>({ rows: [], cursor: null, loading: true, error: '' });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const viewport = useRef<HTMLDivElement>(null), following = useRef(true), anchor = useRef<{ height: number; top: number } | null>(null);
  const path = `/threads/${encodeURIComponent(peer)}`;
  useEffect(() => {
    let stopped = false, pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await apiFetch<ExchangePage>(endpoint(profile, path));
        if (!stopped) setState(previous => {
          const gap = previous.rows.length > 0 && result.exchanges.length > 0 && !result.exchanges.some(row => previous.rows.some(old => old.id === row.id));
          const merged = new Map(previous.rows.map(row => [row.id, row]));
          result.exchanges.forEach(row => merged.set(row.id, row));
          return { rows: [...merged.values()].sort((a, b) => a.createdAt - b.createdAt), cursor: !previous.rows.length || gap ? result.nextBefore : previous.cursor, loading: false, error: '' };
        });
      } catch (cause) { if (!stopped) setState(previous => ({ ...previous, loading: false, error: failure(cause) })); }
      finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
    const changed = () => void load();
    window.addEventListener('hob:bot-exchange', changed);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('hob:bot-exchange', changed); };
  }, [profile, path]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (anchor.current) { node.scrollTop = node.scrollHeight - anchor.current.height + anchor.current.top; anchor.current = null; }
    else if (following.current) node.scrollTop = node.scrollHeight;
  }, [state.rows]);
  const earlier = async () => {
    if (state.cursor === null || loadingEarlier) return;
    const before = state.cursor;
    setLoadingEarlier(true);
    try {
      const result = await apiFetch<ExchangePage>(endpoint(profile, `${path}?before=${before}`));
      const node = viewport.current;
      if (node) anchor.current = { height: node.scrollHeight, top: node.scrollTop };
      setState(previous => {
        const merged = new Map(result.exchanges.map(row => [row.id, row]));
        previous.rows.forEach(row => merged.set(row.id, row));
        return { ...previous, rows: [...merged.values()].sort((a, b) => a.createdAt - b.createdAt), cursor: previous.cursor === before ? result.nextBefore : previous.cursor, error: '' };
      });
    } catch (cause) { setState(previous => ({ ...previous, error: failure(cause) })); }
    finally { setLoadingEarlier(false); }
  };
  const names = exchange.from === profile ? [exchange.fromName, exchange.toName] : [exchange.toName, exchange.fromName];
  return <ConversationDialog title={`${names[0]} ↔ ${names[1]}`} closeLabel="Close bot conversation" onClose={onClose}>
    <div ref={viewport} role="region" aria-label="Bot conversation messages" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 sm:px-6 [overflow-anchor:none]" onScroll={() => { const node = viewport.current; if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
      {state.cursor !== null && <div className="py-4 text-center"><button type="button" disabled={loadingEarlier} onClick={() => void earlier()} className="min-h-11 rounded-xl bg-neutral px-4 text-xs text-ink disabled:opacity-50">{loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}</button></div>}
      {state.loading && <p role="status" className="py-8 text-center text-sm text-muted">Loading bot conversation…</p>}
      {state.error && <p role="alert" className="py-4 text-sm text-bad">{state.error}</p>}
      {!state.loading && !state.error && !state.rows.length && <p className="py-8 text-center text-sm text-muted">No messages between these bots yet.</p>}
      {exchangeMessages(state.rows).map(({ record, part, at }) => <ExchangeMessages key={`${record.id}-${part}`} record={record} part={part} at={at} profile={profile} />)}
    </div>
    <footer className="shrink-0 border-t border-hair px-4 py-4 text-center text-xs text-muted">Only these bots can send messages in this conversation.</footer>
  </ConversationDialog>;
}

export function BotExchangeNotice({ exchange, profile }: { exchange: BotExchange; profile: string }) {
  const [open, setOpen] = useState(false);
  return <div className="my-2 rounded-xl border border-line bg-surface/70 text-xs" data-exchange-id={exchange.id}>
    <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-muted hover:bg-neutral cursor-pointer">
      <MessagesSquare size={15} className="shrink-0 text-accent" /><span className="min-w-0 flex-1 break-words">{exchange.fromName} talked with {exchange.toName}</span><span className="text-[10px] capitalize">{exchange.status.replaceAll('_', ' ')}</span><ChevronRight size={14} className="shrink-0" />
    </button>
    {open && <BotPairThread key={`${profile}:${exchangePeer(exchange, profile)}`} exchange={exchange} profile={profile} onClose={() => setOpen(false)} />}
  </div>;
}

export function BotExchangeHistory({ profile }: { profile: string }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<BotExchange | null>(null);
  const [rows, setRows] = useState<BotExchange[]>([]), [cursor, setCursor] = useState<number | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = useCallback(async (before?: number) => {
    setBusy(true); setError('');
    try {
      const result = await apiFetch<ExchangePage>(endpoint(profile, `/threads${before === undefined ? '' : `?before=${before}`}`));
      setRows(previous => before === undefined ? result.exchanges : [...new Map([...previous, ...result.exchanges].map(row => [exchangePeer(row, profile), row])).values()]); setCursor(result.nextBefore);
    } catch (cause) { setError(failure(cause)); } finally { setBusy(false); }
  }, [profile]);
  return <>
    <button type="button" className="mb-2 min-h-11 self-center rounded-lg px-3 text-xs text-muted hover:bg-neutral cursor-pointer" onClick={() => { setOpen(true); void load(); }}>Bot conversations</button>
    {open && !selected && <ConversationDialog title="Bot conversations" closeLabel="Close bot conversations" onClose={() => setOpen(false)}>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
        {rows.map(row => <button type="button" key={exchangePeer(row, profile)} onClick={() => setSelected(row)} className="mb-2 flex min-h-14 w-full items-center gap-3 rounded-xl border border-hair p-3 text-left text-sm text-ink hover:bg-neutral"><MessagesSquare size={18} className="shrink-0 text-accent" /><span className="min-w-0 flex-1 break-words">{row.fromName} ↔ {row.toName}</span><ChevronRight size={16} /></button>)}
        {!busy && !rows.length && !error && <p className="py-8 text-center text-sm text-muted">No bot conversations yet.</p>}
        {busy && <p role="status" className="p-3 text-xs text-muted">Loading conversations…</p>}
        {cursor !== null && <button type="button" disabled={busy} className="min-h-11 rounded-lg bg-neutral px-3 text-xs text-ink" onClick={() => void load(cursor)}>Load more conversations</button>}
      </div>
      <button type="button" onClick={() => setOpen(false)} className="flex min-h-11 items-center justify-center gap-2 border-t border-hair text-xs text-muted"><X size={14} />Close</button>
    </ConversationDialog>}
    {open && selected && <BotPairThread key={`${profile}:${exchangePeer(selected, profile)}`} exchange={selected} profile={profile} onClose={() => setSelected(null)} />}
  </>;
}
