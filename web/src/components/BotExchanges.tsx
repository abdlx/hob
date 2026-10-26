import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, MessagesSquare, X } from 'lucide-react';
import { apiFetch } from '../services/api';
import { HermesRunPanel } from './HermesRunPanel';
import type { SecurityApproval } from '../types/chat';

export interface BotExchange {
  id: string; fromName: string; toName: string; status: string; createdAt: number;
  message?: string; reply?: string; replyTruncated?: boolean; error?: string; observationError?: string; sessionKey?: string; to?: string;
  wakeups?: { id: string; profile: string; status: string; error?: string | null }[];
}
interface ExchangePage { exchanges: BotExchange[]; nextBefore: number | null }
const failure = (error: unknown) => error instanceof Error ? error.message : 'Could not load bot exchanges.';
const endpoint = (profile: string, path = '') => `/api/hermes/exchanges${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`;

function ExchangeApprovals({ record }: { record: BotExchange }) {
  const [approvals, setApprovals] = useState<SecurityApproval[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await apiFetch<{ approvals: SecurityApproval[] }>(`/api/sessions/${record.sessionKey}/approvals`, { headers: { 'X-Hob-Profile': record.to! } });
      setApprovals(result.approvals); setError('');
    } catch (error) { setError(failure(error)); }
  }, [record.sessionKey, record.to]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 5000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [load]);
  const decide = async (id: string, decision: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/security/approvals/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'X-Hob-Profile': record.to! }, body: JSON.stringify({ decision }) });
      await load();
    } catch (error) { setError(failure(error)); } finally { setBusy(false); }
  };
  return <div className="space-y-2">
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {approvals.map(approval => <section key={approval.id} className="rounded-xl border border-line bg-panel p-3" aria-label={`Permission for ${record.toName}`}>
      <p className="font-semibold text-ink">{record.toName} needs permission</p><p className="mt-1 text-muted">{approval.description}</p>
      {approval.commandSnippet && <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">{approval.commandSnippet}</pre>}
      <div className="mt-2 flex gap-2"><button type="button" disabled={busy} onClick={() => void decide(approval.id, 'approved')} className="rounded-lg bg-accent px-3 py-2 text-white">Allow once</button><button type="button" disabled={busy} onClick={() => void decide(approval.id, 'rejected')} className="rounded-lg bg-neutral px-3 py-2 text-ink">Deny</button></div>
    </section>)}
  </div>;
}

export function BotExchangeNotice({ exchange, profile }: { exchange: BotExchange; profile: string }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<BotExchange | null>(null);
  const [transcript, setTranscript] = useState<unknown>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    const load = () => { void Promise.allSettled([
      apiFetch<BotExchange>(endpoint(profile, `/${exchange.id}`)),
      apiFetch<{ messages: unknown[] }>(endpoint(profile, `/${exchange.id}/transcript`)),
    ]).then(([record, messages]) => {
      if (stopped) return;
      if (record.status === 'fulfilled') setDetail(record.value);
      if (messages.status === 'fulfilled') setTranscript(messages.value.messages);
      setError(record.status === 'rejected' ? failure(record.reason) : messages.status === 'rejected' ? failure(messages.reason) : '');
    }); };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [exchange.id, exchange.status, profile, open]);
  const record = detail || exchange;
  return <div className="my-2 rounded-xl border border-line bg-surface/70 text-xs" data-exchange-id={exchange.id}>
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-muted hover:bg-neutral cursor-pointer">
      <MessagesSquare size={14} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1">{exchange.fromName} talked with {exchange.toName}</span>
      <span className="text-[10px] capitalize">{record.status.replaceAll('_', ' ')}</span>
      <time className="hidden sm:inline text-[10px]" dateTime={new Date(exchange.createdAt).toISOString()}>{new Date(exchange.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      <ChevronDown size={13} className={open ? 'rotate-180' : ''} />
    </button>
    {open && <div className="space-y-3 border-t border-line p-4">
      <p className="text-[10px] text-faint">{new Date(exchange.createdAt).toLocaleString()} · Exchange {exchange.id.slice(0, 8)}</p>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      {!detail && !error && <p role="status" className="text-muted">Loading exchange…</p>}
      {detail && <>
        <div><p className="mb-1 font-semibold text-ink">{record.fromName} sent</p><p className="whitespace-pre-wrap break-words text-muted">{record.message}</p></div>
        <div><p className="mb-1 font-semibold text-ink">{record.toName} replied</p><p className="whitespace-pre-wrap break-words text-muted">{record.reply || (record.status === 'completed' ? 'No text reply. Inspect the native transcript below.' : 'No reply yet.')}</p></div>
        {record.replyTruncated && <p className="text-amber-700">This reply preview is truncated. Open the native messages below to inspect the full reply.</p>}
        {(record.error || record.observationError) && <p role="status" className="text-amber-700">{record.error || record.observationError}</p>}
        {!!record.wakeups?.length && <div className="space-y-1 rounded-lg border border-line p-3"><p className="font-medium text-ink">Automatic follow-up</p>{record.wakeups.map(wake => <p key={wake.id} className="text-muted">{wake.profile === 'default' ? 'Main' : wake.profile}: {wake.status.replaceAll('_', ' ')}{wake.error ? ` · ${wake.error}` : ''}</p>)}</div>}
        {transcript !== null && <details><summary className="cursor-pointer font-medium text-ink">Native messages and tool activity</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-panel p-3 text-[11px]">{JSON.stringify(transcript, null, 2)}</pre></details>}
        {record.sessionKey && !['completed', 'failed', 'cancelled', 'interrupted'].includes(record.status) && <>
          <HermesRunPanel key={record.sessionKey} sessionId={record.sessionKey} />
          {record.to && <ExchangeApprovals key={record.sessionKey} record={record} />}
        </>}
      </>}
    </div>}
  </div>;
}

/** Paginated archive makes every exchange reachable without copying history into new chats. */
export function BotExchangeHistory({ profile }: { profile: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BotExchange[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async (before?: number) => {
    setBusy(true); setError('');
    try {
      const result = await apiFetch<ExchangePage>(endpoint(profile, before ? `?before=${before}` : ''));
      setRows(previous => before ? [...previous, ...result.exchanges] : result.exchanges); setCursor(result.nextBefore);
    } catch (error) { setError(failure(error)); } finally { setBusy(false); }
  }, [profile]);
  return <>
    <button type="button" className="mb-2 self-center rounded-lg px-3 py-1.5 text-[11px] text-muted hover:bg-neutral cursor-pointer" onClick={() => { setOpen(true); void load(); }}>Bot exchange history</button>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setOpen(false)}>
      <section role="dialog" aria-modal="true" aria-label="Bot exchange history" className="flex max-h-[85dvh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-canvas p-5 shadow-xl" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-ink">Bot exchange history</h2><button type="button" aria-label="Close exchange history" onClick={() => setOpen(false)} className="rounded-lg p-2 hover:bg-neutral cursor-pointer"><X size={16} /></button></div>
        <div className="min-h-0 overflow-y-auto">
          {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
          {rows.map(row => <BotExchangeNotice key={row.id} exchange={row} profile={profile} />)}
          {!busy && !rows.length && !error && <p className="py-8 text-center text-sm text-muted">No bot exchanges yet.</p>}
          {busy && <p role="status" className="p-3 text-xs text-muted">Loading exchanges…</p>}
          {cursor !== null && <button type="button" disabled={busy} className="mt-2 rounded-lg bg-neutral px-3 py-2 text-xs text-ink" onClick={() => void load(cursor)}>Load earlier exchanges</button>}
        </div>
      </section>
    </div>}
  </>;
}
