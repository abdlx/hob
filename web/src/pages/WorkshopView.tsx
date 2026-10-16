import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { apiFetch } from '../services/api';
import { buttonClass, cardClass, Notice } from '../components/WorkspaceUI';
import { errorText } from '../components/workspaceUtils';

interface Proposal { id: string; status: string; kind: string; description: string; target?: { skillName?: string }; revisionHash?: string }
interface Detail { record: Proposal & { scan?: unknown; evaluation?: unknown; collection?: unknown }; revisionHash?: string; content: string; supportFiles?: { path: string; content: string; delete?: true }[] }
const rpc = <T,>(method: string, params: Record<string, unknown>) => apiFetch<T>('/api/rpc', { method: 'POST', body: JSON.stringify({ method, params }) });

export function WorkshopView() {
  const { agent, setActiveNav } = useChat();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [before, setBefore] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const request = useRef(0);
  const invalidate = useCallback(() => { request.current++; }, []);
  const agentId = agent?.id;
  const load = useCallback(async () => {
    if (!agentId) return;
    const current = request.current;
    setLoading(true); setError('');
    try { const result = await rpc<{ proposals: Proposal[] }>('skills.proposals.list', { agentId }); if (current === request.current) setProposals(result.proposals); }
    catch (error) { if (current === request.current) setError(errorText(error)); }
    finally { if (current === request.current) setLoading(false); }
  }, [agentId]);
  useEffect(() => { const timer = window.setTimeout(() => { setDetail(null); setBusy(false); setConfirmed(false); setStatus(''); setBefore(''); void load(); }, 0); return () => { window.clearTimeout(timer); invalidate(); }; }, [load, invalidate]);
  const inspect = async (id: string) => {
    const current = ++request.current;
    setBusy(true); setError(''); setDetail(null); setBefore(''); setConfirmed(false); setStatus('');
    try {
      const result = await rpc<Detail>('skills.proposals.inspect', { agentId, proposalId: id });
      if (current !== request.current) return;
      setDetail(result);
      if (!result.record.collection && result.record.kind === 'update') {
        const existing = await rpc<{ content: string }>('skills.workshop.read', { agentId, name: result.record.target?.skillName });
        if (current === request.current) setBefore(existing.content);
      }
    } catch (error) { if (current === request.current) { setDetail(null); setError(errorText(error)); } }
    finally { if (current === request.current) setBusy(false); }
  };
  const decide = async (action: 'evaluate' | 'apply' | 'reject') => {
    if (!detail?.revisionHash || !agentId) return;
    const id = detail.record.id;
    const current = request.current;
    setBusy(true); setError(''); setConfirmed(false);
    try {
      await rpc(`skills.proposals.${action}`, { agentId, proposalId: id, expectedRevisionHash: detail.revisionHash });
      if (current !== request.current) return;
      await load(); await inspect(id);
      if (action === 'evaluate') setStatus('Validation finished. Review the updated results before activation.');
      if (action === 'apply') setStatus('Proposal activated through Workshop.');
      if (action === 'reject') setStatus('Proposal rejected. Active skills are unchanged.');
    } catch (error) { if (current === request.current) setError(errorText(error)); }
    finally { if (current === request.current) setBusy(false); }
  };
  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-3"><div><p className="text-sm text-[#c5b29f]">Experience becomes knowledge. You choose what stays.</p><p className="mt-2 text-xs text-[#968575]">Proposals are staged by default. Validation and trust checks run before activation.</p></div><button aria-label="Refresh proposals" className={buttonClass} disabled={busy} onClick={load}><RefreshCw size={14} /></button></div>
    {error && <Notice error>{error}</Notice>}{status && <Notice>{status}</Notice>}
    {detail ? <section className={`${cardClass} space-y-4`}>
      <div className="flex flex-wrap gap-3 justify-between"><button className={buttonClass} onClick={() => { request.current++; setDetail(null); setBusy(false); setConfirmed(false); }}><ArrowLeft size={12} />All proposals</button><span className="text-xs capitalize text-[#d6b48f]">{detail.record.status}</span></div>
      <h2 className="text-lg font-medium">{detail.record.description || detail.record.target?.skillName}</h2><p className="font-mono break-all text-[10px] text-[#9d8c79]">Revision {detail.revisionHash || 'Unavailable — activation is disabled'}</p>
      {detail.record.collection ? <details open><summary className="text-xs cursor-pointer text-[#d6b48f]">Complete collection change set (before and after)</summary><pre className="mt-3 text-[11px] overflow-auto max-h-[520px] whitespace-pre-wrap break-words select-text">{detail.content}</pre></details> : <div className="grid lg:grid-cols-2 gap-3">{[{ title: 'Current skill', content: before || (detail.record.kind === 'create' ? 'New skill — no previous content.' : 'Current content unavailable.') }, { title: 'Proposed skill', content: detail.content }].map(item => <div key={item.title}><h3 className="text-xs text-[#b5987d] mb-2">{item.title}</h3><pre className="bg-[#12100e] border border-[#30271f] rounded-xl p-3 text-[11px] max-h-[420px] overflow-auto whitespace-pre-wrap break-words select-text">{item.content}</pre></div>)}</div>}
      {detail.supportFiles?.map(file => <details key={file.path}><summary className="text-xs cursor-pointer">{file.delete ? 'Delete' : 'Proposed supporting file'}: {file.path}</summary><pre className="mt-2 text-[11px] max-h-64 overflow-auto whitespace-pre-wrap break-words select-text">{file.delete ? 'This supporting file will be removed.' : file.content}</pre></details>)}
      <details><summary className="text-xs cursor-pointer text-[#c2a589]">Validation and scan evidence</summary><pre className="text-[11px] mt-2 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ scan: detail.record.scan, evaluation: detail.record.evaluation }, null, 2)}</pre></details>
      {detail.record.status === 'pending' && <><label className="flex gap-2 text-xs leading-relaxed text-[#c2b2a0]"><input type="checkbox" checked={confirmed} disabled={busy || !detail.revisionHash} onChange={event => setConfirmed(event.target.checked)} />I reviewed this exact revision and want to activate it.</label><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy || !detail.revisionHash} onClick={() => decide('evaluate')}><ShieldCheck size={13} />Validate</button><button className={buttonClass} disabled={busy || !confirmed || !detail.revisionHash} onClick={() => decide('apply')}><Check size={13} />Activate reviewed revision</button><button className={buttonClass} disabled={busy || !detail.revisionHash} onClick={() => decide('reject')}><X size={13} />Reject</button></div></>}
    </section> : loading ? <Notice>Loading Workshop proposals…</Notice> : proposals.length === 0 ? <div className={`${cardClass} py-12 text-center`}><BookOpen className="mx-auto text-[#c89b72] mb-4" size={28} /><h2 className="text-lg text-[#e0cbb5]">A little wiser, with your say.</h2><p className="text-xs text-[#a08c77] max-w-md mx-auto leading-relaxed mt-3">Your agent’s learning proposals will appear here. Nothing is activated merely because a setting is missing.</p><button className={`${buttonClass} mt-5`} onClick={() => setActiveNav('settings')}>Learning settings</button></div> : <div className="space-y-3">{proposals.map(proposal => <button key={proposal.id} disabled={busy} onClick={() => inspect(proposal.id)} className={`${cardClass} w-full text-left hover:border-[#92633e]`}><span className="text-[10px] uppercase tracking-wider text-[#c19a74]">{proposal.status} · {proposal.kind}</span><h2 className="mt-2 text-sm">{proposal.description || proposal.target?.skillName}</h2><p className="mt-2 font-mono text-[10px] text-[#8e7c69]">{proposal.id}</p></button>)}</div>}
  </div>;
}
