import { useState } from 'react';
import { apiFetch } from '../services/api';
import { buttonClass, cardClass, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';
import { HermesTeamExecutionSettings } from './HermesTeamExecutionSettings';

interface Policy { revision: number; coordinatorOnly: boolean; shareDocuments: boolean; coreBudget: number; sessionWindow: number; ordinaryPromotions: 'user' }
interface Proposal { id: string; base: number; content: string; digest: string; author: string; evidence: string }
interface TeamState {
  draftError?: string;
  policy: Policy; core: { revision: number; content: string }; proposals: Proposal[];
  bots: { id: string; name: string; revision?: number; status?: string; error?: string; skipped?: { path: string; reason: string }[] }[];
  sync?: { updated: string[]; failed: { name: string; error: string }[] };
}

export function HermesTeamSettings() {
  const [opened, setOpened] = useState(false), [state, setState] = useState<TeamState | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null), [content, setContent] = useState(''), [base, setBase] = useState(0), [evidence, setEvidence] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [history, setHistory] = useState<{ revision: number; content: string; committed: number }[] | null>(null);
  const read = async () => {
    const value = await apiFetch<TeamState>('/api/hermes/team');
    setState(value); setPolicy(value.policy); setBase(value.core.revision); setContent(value.core.content); setReviewed(null);
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await work(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  const mutate = async (path: string, value: unknown, method = 'POST') => {
    const next = await apiFetch<TeamState>(`/api/hermes/team/${path}`, { method, body: JSON.stringify(value) });
    setState(next); setPolicy(next.policy); setReviewed(null);
    const failed = next.sync?.failed || [];
    if (failed.length) setError(`The change was saved, but synchronization failed for: ${failed.map(item => item.name).join(', ')}. Review the bot status and retry synchronization.`);
    else setMessage('Saved and synchronized. This does not mark the employee team live.');
  };
  return <section className={`${cardClass} space-y-3`} aria-label="Shared team core and documents">
    <h2 className="text-sm text-ink">Shared team core & documents</h2>
    <p className="text-xs text-muted">Review shared facts before distributing them. Private bot memory stays separate.</p>
    <button className={buttonClass} aria-expanded={opened} disabled={busy} onClick={() => { if (!opened && !state) void run(read); setOpened(!opened); }}>{opened ? 'Close team controls' : 'Open team controls'}</button>
    {opened && <div className="space-y-4">
      <Notice>These controls manage core approvals, document copies, and coordinator-only relay. Session-only memory, private group context, and native isolation still need verification before the employee team can be marked live. Guarded model routes require your review; team execution remains inactive pending complete native checks. No messaging account is connected here.</Notice>
      {error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
      {state?.draftError && <Notice error>{state.draftError}</Notice>}
      <button className={buttonClass} disabled={busy} onClick={() => void run(read)}>Refresh team status</button>
      {state && policy && <>
        <fieldset disabled={busy} className="space-y-3">
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={policy.coordinatorOnly} onChange={event => setPolicy({ ...policy, coordinatorOnly: event.target.checked })} /><span>Route worker requests through the coordinator</span></label>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={policy.shareDocuments} onChange={event => setPolicy({ ...policy, shareDocuments: event.target.checked })} /><span>Synchronize eligible documents from the coordinator’s shared/ folder</span></label>
          <Field label="Injected team core budget" hint="Unicode characters, including the managed block. Oversized core is rejected, never silently truncated."><input className={inputClass} type="number" min={500} max={16000} value={policy.coreBudget} onChange={event => setPolicy({ ...policy, coreBudget: Number(event.target.value) })} /></Field>
          <p className="text-xs text-muted">Every core promotion requires your approval. The requested {policy.sessionWindow}-turn session window is not active until native context support is verified.</p>
          <button className={buttonClass} onClick={() => void run(() => mutate('settings', { revision: policy.revision, coordinatorOnly: policy.coordinatorOnly, shareDocuments: policy.shareDocuments, coreBudget: policy.coreBudget, sessionWindow: policy.sessionWindow, confirm: true }, 'PUT'))}>Save team distribution settings</button>
        </fieldset>
        <HermesTeamExecutionSettings bots={state.bots} />
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Published core · revision {state.core.revision}</h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-panel p-3 text-xs" aria-label="Published team core">{state.core.content || 'No core has been approved.'}</pre>
          <button className={buttonClass} disabled={busy} onClick={() => void run(async () => { const value = await apiFetch<{ revisions: { revision: number; content: string; committed: number }[] }>('/api/hermes/team/history'); setHistory(value.revisions); })}>Load core revision history</button>
          {history && <div className="space-y-2" aria-label="Core revision history">{history.length === 0 && <p className="text-xs text-muted">No core revisions yet.</p>}{history.map(item => <div className="flex flex-wrap items-center gap-2 text-xs" key={item.revision}><span>Revision {item.revision} · {new Date(item.committed).toLocaleString()}</span><button className={buttonClass} disabled={busy} onClick={() => { setContent(item.content); setBase(state.core.revision); setEvidence(`Proposed restoration of core revision ${item.revision}; review against the current revision before approving.`); }}>Restore revision {item.revision} as a proposal</button></div>)}</div>}
          <Field label="Proposed team core" hint="Optional sections: # Essential for injection and # Reference for retrieval-only details."><textarea className={inputClass} rows={7} value={content} disabled={busy} onChange={event => { setContent(event.target.value); setReviewed(null); }} /></Field>
          <Field label="Promotion evidence"><textarea className={inputClass} rows={2} maxLength={4000} value={evidence} disabled={busy} onChange={event => setEvidence(event.target.value)} /></Field>
          <div className="flex flex-wrap gap-2">
            <button className={buttonClass} disabled={busy} onClick={() => void run(async () => { const draft = await apiFetch<{ content: string; base: number }>('/api/hermes/team/draft'); setContent(draft.content); setBase(draft.base); })}>Load coordinator’s TEAM_CORE.md draft</button>
            <button className={buttonClass} disabled={busy || !content.trim()} onClick={() => void run(async () => {
              await apiFetch('/api/hermes/team/proposals', { method: 'POST', body: JSON.stringify({ content, base, evidence }) });
              await read(); setEvidence(''); setMessage('Proposal staged for review. No new core has been distributed.');
            })}>Stage core proposal</button>
          </div>
        </div>
        {state.proposals.map(proposal => <div key={proposal.id} className="space-y-3 rounded-xl border border-hair p-3" aria-label="Core promotion proposal">
          <p className="text-xs">Proposed by {proposal.author} against revision {proposal.base}</p>
          <p className="text-xs text-muted">{proposal.evidence || 'No additional evidence supplied.'}</p>
          <div className="grid gap-3 lg:grid-cols-2"><div><h4 className="text-xs font-medium">Current</h4><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{state.core.content || '(empty)'}</pre></div><div><h4 className="text-xs font-medium">Proposed</h4><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{proposal.content}</pre></div></div>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={reviewed === proposal.id} disabled={busy || proposal.base !== state.core.revision} onChange={event => setReviewed(event.target.checked ? proposal.id : null)} /><span>I reviewed this exact core change and its evidence.</span></label>
          <div className="flex flex-wrap gap-2">{(['approve', 'reject'] as const).map(decision => <button key={decision} className={buttonClass} disabled={busy || decision === 'approve' && (proposal.base !== state.core.revision || reviewed !== proposal.id)} onClick={() => void run(async () => {
            await mutate('decisions', { id: proposal.id, base: proposal.base, digest: proposal.digest, decision, confirm: true });
            setBase(proposal.base + (decision === 'approve' ? 1 : 0));
          })}>{decision === 'approve' ? 'Approve and distribute core' : 'Reject core proposal'}</button>)}</div>
          {proposal.base !== state.core.revision && <p className="text-xs text-warn">This proposal is stale. Create a new proposal against the published revision.</p>}
        </div>)}
        <div className="space-y-2"><h3 className="text-sm font-medium">Distribution status</h3>{state.bots.map(bot => <div key={bot.id} className="rounded-xl border border-hair p-3 text-xs"><p>{bot.name} · {bot.status || 'not synchronized'} · core revision {bot.revision ?? 'unknown'}</p>{bot.error && <p className="mt-1 text-bad">{bot.error}</p>}{bot.skipped?.map((item, i) => <p key={i} className="mt-1 text-muted">Excluded: {item.path} ({item.reason})</p>)}</div>)}</div>
        <button className={buttonClass} disabled={busy} onClick={() => void run(() => mutate('sync', { confirm: true }))}>Reconcile core draft and synchronize</button>
      </>}
    </div>}
  </section>;
}
