import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hermesWorkspaceApi, jsonWrite } from '../services/hermes-workspace';
import { buttonClass, inputClass, Notice, Skeleton } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface Proposal { id: string; summary: string; revision: string; origin: string }
interface Queue { items: Proposal[]; nextOffset: number | null; unresolvedDecisions?: number; claims?: Proposal[] }
interface Detail { id: string; summary: string; revision: string; diff: string; claimed?: boolean }

export function HermesReviewQueue({ profile, subsystem }: { profile: string; subsystem: 'memory' | 'skills' }) {
  const api = useMemo(() => hermesWorkspaceApi(profile), [profile]);
  const [queue, setQueue] = useState<Queue | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [search, setSearch] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false), [history, setHistory] = useState<unknown>(null);
  const [observed, setObserved] = useState(false);
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
  async function inspect(item: Proposal, claimed = false) {
    if (operation.current) return;
    const current = ++generation.current;
    setBusy(true); setDetail(null); setError(''); setMessage(''); setObserved(false); decisionId.current = '';
    try {
      const result = await api<Detail>(claimed ? `review-claims/${subsystem}/${encodeURIComponent(item.id)}/${item.revision}` : `reviews/${subsystem}/${encodeURIComponent(item.id)}`);
      if (current === generation.current) {
        if (result.id !== item.id || !/^[a-f0-9]{64}$/.test(result.revision) || typeof result.diff !== 'string') throw new Error('Hermes returned another proposal or an invalid revision.');
        setDetail({ ...result, claimed });
        if (result.revision !== item.revision) setMessage('The proposal changed since the queue loaded. Review the current diff below.');
      }
    } catch (cause) { if (current === generation.current) setError(errorText(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function decide(action: 'approve' | 'reject' | 'observed_applied' | 'abandoned') {
    if (!detail || operation.current) return;
    if (Boolean(detail.claimed) !== ['observed_applied', 'abandoned'].includes(action) || (detail.claimed && !observed)) return;
    operation.current = true; setBusy(true); setError(''); setMessage('');
    const current = generation.current;
    decisionId.current ||= crypto.randomUUID();
    try {
      const result = await api<{ ok: boolean; decision?: { status: string } }>(`${detail.claimed ? 'review-claims' : 'reviews'}/${subsystem}`, jsonWrite('POST', { id: detail.id, revision: detail.revision, action, requestId: decisionId.current, confirm: true }));
      if (current !== generation.current) return;
      if (result.ok !== true) throw new Error('The native owner did not confirm this decision. Refresh before retrying.');
      if (detail.claimed && result.decision?.status !== 'operator_reconciled') throw new Error('The native owner did not confirm this operator observation.');
      setDetail(null); decisionId.current = ''; setMessage(detail.claimed ? 'Operator observation recorded. No changes were applied or undone.' : action === 'approve' ? 'The reviewed revision was approved by Hermes.' : 'The reviewed revision was rejected.');
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
    {!!queue?.claims?.length && <div className="space-y-2"><h4 className="text-sm font-medium text-ink">Unconfirmed decisions</h4><p className="text-xs text-muted">Inspect the retained proposal and current native state. Recording an observation clears the claim without applying, retrying or undoing its change.</p>{queue.claims.map(item => <button key={`${item.id}:${item.revision}`} type="button" className={`${buttonClass} w-full justify-start text-left`} disabled={busy} onClick={() => void inspect(item, true)}>Inspect uncertain {item.summary || item.id}</button>)}</div>}
    {detail && <div className="space-y-3"><p className="break-all text-[11px] text-muted">Revision: {detail.revision}</p><pre tabIndex={0} aria-label="Proposal diff" className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-panel p-3 font-mono text-xs text-ink select-text">{detail.diff}</pre>
      {detail.claimed ? <><Notice>These actions record your observation only. They do not apply or undo memory/skills. Abandoning a claim also preserves any change that already occurred.</Notice><label className="flex min-h-11 items-center gap-2 text-xs text-ink"><input type="checkbox" checked={observed} disabled={busy} onChange={event => setObserved(event.target.checked)} />I compared this proposal with the current native state.</label><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy || !observed} onClick={() => void decide('observed_applied')}>Record observed application</button><button className={buttonClass} disabled={busy || !observed} onClick={() => void decide('abandoned')}>Abandon unresolved proposal</button></div></> : <><p className="text-xs text-muted">Approve applies exactly this proposed change through Hermes. Reject removes this pending proposal.</p><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy} onClick={() => void decide('approve')}>Approve reviewed revision</button><button className={buttonClass} disabled={busy} onClick={() => void decide('reject')}>Reject reviewed revision</button></div></>}
    </div>}
    <button className={buttonClass} disabled={busy} onClick={async () => { try { setHistory(await api('review-history')); } catch (cause) { setError(errorText(cause)); } }}>Review decision history</button>
    {history !== null && <div><button className={buttonClass} onClick={() => setHistory(null)}>Close decision history</button><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-xs text-muted">{JSON.stringify(history, null, 2)}</pre></div>}
  </section>;
}
