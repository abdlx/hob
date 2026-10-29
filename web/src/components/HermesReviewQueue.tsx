import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hermesWorkspaceApi, jsonWrite } from '../services/hermes-workspace';
import { buttonClass, inputClass, Notice, Skeleton } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface Proposal { id: string; summary: string; revision: string; origin: string }
interface Queue { items: Proposal[]; nextOffset: number | null; unresolvedDecisions?: number }
interface Detail { id: string; summary: string; revision: string; diff: string }

export function HermesReviewQueue({ profile, subsystem }: { profile: string; subsystem: 'memory' | 'skills' }) {
  const api = useMemo(() => hermesWorkspaceApi(profile), [profile]);
  const [queue, setQueue] = useState<Queue | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [search, setSearch] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false), [history, setHistory] = useState<unknown>(null);
  const generation = useRef(0), operation = useRef(false), decisionId = useRef('');
  const load = useCallback(async (offset = 0) => {
    const current = ++generation.current;
    try {
      const result = await api<Queue>(`reviews/${subsystem}`, {}, { offset: String(offset) });
      if (!Array.isArray(result.items)) throw new Error('The native review queue returned an invalid response.');
      if (current !== generation.current) return;
      setQueue(previous => offset && previous ? { ...result, items: [...previous.items, ...result.items] } : result); setError('');
    } catch (cause) { if (current === generation.current) setError(`${errorText(cause)} Versioned review requires the updated hob runtime image.`); }
  }, [api, subsystem]);
  useEffect(() => {
    let active = true;
    const current = generation;
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; current.current++; };
  }, [load]);
  async function inspect(item: Proposal) {
    if (operation.current) return;
    const current = ++generation.current;
    setBusy(true); setDetail(null); setError(''); setMessage(''); decisionId.current = '';
    try {
      const result = await api<Detail>(`reviews/${subsystem}/${encodeURIComponent(item.id)}`);
      if (current === generation.current) {
        if (result.id !== item.id || !/^[a-f0-9]{64}$/.test(result.revision) || typeof result.diff !== 'string') throw new Error('Hermes returned another proposal or an invalid revision.');
        setDetail(result);
        if (result.revision !== item.revision) setMessage('The proposal changed since the queue loaded. Review the current diff below.');
      }
    } catch (cause) { if (current === generation.current) setError(errorText(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function decide(action: 'approve' | 'reject') {
    if (!detail || operation.current) return;
    operation.current = true; setBusy(true); setError(''); setMessage('');
    const current = generation.current;
    decisionId.current ||= crypto.randomUUID();
    try {
      const result = await api<{ ok: boolean }>(`reviews/${subsystem}`, jsonWrite('POST', { id: detail.id, revision: detail.revision, action, requestId: decisionId.current, confirm: true }));
      if (current !== generation.current) return;
      if (result.ok !== true) throw new Error('The native owner did not confirm this decision. Refresh before retrying.');
      setDetail(null); decisionId.current = ''; setMessage(action === 'approve' ? 'The reviewed revision was approved by Hermes.' : 'The reviewed revision was rejected.');
      await load();
    } catch (cause) { if (current === generation.current) setError(`${errorText(cause)} Refresh and inspect the native state before making another decision.`); }
    finally { operation.current = false; setBusy(false); }
  }
  const matches = queue?.items.filter(item => `${item.summary} ${item.id}`.toLowerCase().includes(search.trim().toLowerCase())) || [];
  return <section aria-label={`${subsystem === 'memory' ? 'Memory' : 'Skill'} review queue`} className="space-y-3 rounded-2xl border border-hair bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-ink">Pending {subsystem === 'memory' ? 'memory writes' : 'skill proposals'}</h3><button className={buttonClass} disabled={busy} onClick={() => { setDetail(null); void load(); }}>Refresh proposals</button></div>
    <p className="text-xs leading-relaxed text-muted">Review the complete native proposal before deciding. Each decision is bound to this bot and the displayed revision. Existing conversations may retain earlier memory snapshots.</p>
    {error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
    {!!queue?.unresolvedDecisions && <Notice error>A previous decision was interrupted. Inspect native memory/skills and review history before reconciling it; it will not be replayed automatically.</Notice>}
    {!queue && !error && <Skeleton className="h-24 w-full" />}
    {queue && <><input aria-label={`Search ${subsystem} proposals`} className={inputClass} placeholder="Find a proposal" value={search} disabled={busy} onChange={event => setSearch(event.target.value)} />
      {!matches.length && <p className="py-3 text-xs text-muted">{search ? 'No matching proposals. Clear your search to see the queue.' : 'No pending proposals for this bot.'}</p>}
      <div className="max-h-72 overflow-y-auto space-y-1">{matches.map(item => <button type="button" key={item.id} disabled={busy} aria-pressed={detail?.id === item.id} className={`w-full rounded-xl border p-3 text-left text-xs cursor-pointer disabled:opacity-40 ${detail?.id === item.id ? 'border-accent bg-accent-soft' : 'border-hair hover:bg-hover'}`} onClick={() => void inspect(item)}><span className="block font-medium text-ink">{item.summary || item.id}</span><span className="mt-1 block text-muted">{item.id} · {item.origin}</span></button>)}</div>
      {queue.nextOffset !== null && <button className={buttonClass} disabled={busy} onClick={() => void load(queue.nextOffset!)}>Load more proposals</button>}
    </>}
    {detail && <div className="space-y-3"><p className="break-all text-[11px] text-muted">Revision: {detail.revision}</p><pre tabIndex={0} aria-label="Proposal diff" className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-panel p-3 font-mono text-xs text-ink select-text">{detail.diff}</pre><p className="text-xs text-muted">Approve applies exactly this proposed change through Hermes. Reject removes this pending proposal.</p><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy} onClick={() => void decide('approve')}>Approve reviewed revision</button><button className={buttonClass} disabled={busy} onClick={() => void decide('reject')}>Reject reviewed revision</button></div></div>}
    <button className={buttonClass} disabled={busy} onClick={async () => { try { setHistory(await api('review-history')); } catch (cause) { setError(errorText(cause)); } }}>Review decision history</button>
    {history !== null && <div><button className={buttonClass} onClick={() => setHistory(null)}>Close decision history</button><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-xs text-muted">{JSON.stringify(history, null, 2)}</pre></div>}
  </section>;
}
