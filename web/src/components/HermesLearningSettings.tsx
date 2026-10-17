import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hermesSetupApi } from '../services/hermes-setup';
import { learningControls, learningEdits } from '../services/hermes-learning';
import type { LearningDraft, LearningStatus } from '../services/hermes-learning';
import { buttonClass, cardClass, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

export function HermesLearningSettings({ profile }: { profile: string }) {
  const api = useMemo(() => hermesSetupApi(profile), [profile]);
  const [data, setData] = useState<LearningStatus | null>(null), [draft, setDraft] = useState<LearningDraft>({});
  const [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const mounted = useRef(false), revision = useRef(0), pending = useRef(false);
  const load = useCallback(async () => {
    const generation = ++revision.current;
    const result = await api<LearningStatus>('learning');
    if (mounted.current && generation === revision.current) { setData(result); setDraft({}); setConfirm(false); }
  }, [api]);
  useEffect(() => {
    const generation = revision;
    mounted.current = true;
    void load().catch(error => { if (mounted.current) setError(errorText(error)); });
    return () => { mounted.current = false; generation.current++; };
  }, [load]);
  const changes = data ? learningEdits(data, draft) : {};
  const apply = async () => {
    if (pending.current || !confirm || !Object.keys(changes).length) return;
    pending.current = true; revision.current++; setBusy(true); setConfirm(false); setError(''); setStatus('');
    try {
      const result = await api<LearningStatus>('learning', { method: 'PUT', body: JSON.stringify({ changes, confirm: true }) });
      if (mounted.current) { setData(result); setDraft({}); setStatus('Hermes saved these settings for this bot. Existing sessions or reviews may need finishing/restarting; no in-flight work was cancelled by this action.'); }
    } catch (error) {
      if (mounted.current) setError(errorText(error) + ' Settings may have been saved. Refresh and inspect before retrying.');
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className={`${cardClass} space-y-3`}><div className="flex justify-between gap-2"><h2 className="text-sm text-[#dfd1bd]">Learning & write approvals</h2>
    <button className={buttonClass} disabled={busy} onClick={() => { setError(''); setStatus(''); void load().catch(error => { if (mounted.current) setError(errorText(error)); }); }}>Refresh learning settings</button></div>
    <Notice>These are independent Hermes controls. Turning off background review does not block all memory or skill changes. Built-in memory approval does not govern external-provider writes. Existing saved memories and pending proposals are preserved.</Notice>
    <Notice>Review skill proposals in Workshop. Built-in memory decisions are not available here yet; pending memory writes need a supported native Hermes review surface.</Notice>
    {error && <Notice error>{error}</Notice>}{status && <Notice>{status}</Notice>}{!data && !error && <Notice>Loading native learning settings…</Notice>}
    <fieldset disabled={busy || !data} className="space-y-3">{learningControls.map(control => {
      const current = data?.controls[control.id];
      const value = Object.hasOwn(draft, control.id) ? draft[control.id] : current?.value;
      return <Field key={control.id} label={control.label} hint={`${control.hint} ${current?.source === 'default' ? 'Hermes default.' : current?.source === 'invalid' ? 'Native value is not a boolean; choose an explicit value to repair it.' : ''}`}>
        <select className={inputClass} value={typeof value === 'boolean' ? String(value) : ''} onChange={event => { revision.current++; setConfirm(false); setStatus(''); setDraft(previous => ({ ...previous, [control.id]: event.target.value === 'true' })); }}>
          <option value="" disabled>Choose an explicit value</option><option value="true">On</option><option value="false">Off</option>
        </select></Field>;
    })}</fieldset>
    <button className={buttonClass} disabled={busy || !data || !Object.keys(changes).length} onClick={() => setConfirm(true)}>Review learning changes</button>
    {confirm && <div role="status" className="space-y-2 rounded-xl border border-[#24211d] bg-[#111] p-3 text-[11px] text-[#928a7d]"><p>Apply these changes to this bot?</p><ul className="list-disc pl-4">{learningControls.filter(control => Object.hasOwn(changes, control.id)).map(control => <li key={control.id}>{control.label}: {changes[control.id] ? 'On' : 'Off'}</li>)}</ul>
      {(changes.memoryApproval === false || changes.skillApproval === false) && <p>Turning off a write-approval gate permits the corresponding agent writes to apply without that gate.</p>}
      {changes.backgroundReview === true && <p>Background review can use additional model calls and propose or apply changes according to the native write gates.</p>}
      <button className={buttonClass} disabled={busy} onClick={apply}>Confirm learning changes</button>{' '}<button className={buttonClass} disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
    </div>}
  </section>;
}
