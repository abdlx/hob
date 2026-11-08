import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/api';
import { requestId } from '../services/id';
import { isConnectionError } from '../services/errors';
import { buttonClass, cardClass, Field, inputClass, Notice, Skeleton } from './WorkspaceUI';
import { errorText } from './workspaceUtils';
import { HermesRunPanel } from './HermesRunPanel';

const endpoint = '/api/hermes/team/work';
interface Task { id: string; owner: string; title: string; outcome: string; output: string; status: string; nativeStatus?: string; result?: string; reviewSession?: string | null; reviewIssue?: string | null; verification: string; revision: number; updatedAt: number; exchangeId: string | null; steps: { title: string; status: string }[] }
interface Followup { id: string; owner: string; title: string; outcome: string; deadline: string | null; revision: number; status: string; lastChecked: number | null; source: { kind: string; taskId?: string } }
interface Candidate { id: string; owner: string; fact: string; evidence: string; status: string; revision: number; tier: string; conflicts: string[] }
interface Preferences { revision: number; dailyCap: number; timezone: string; quietStart: string; quietEnd: string; neverOffer: string[] }
interface WorkState { enabled: boolean; tasks: Task[]; followups: Followup[]; candidates: Candidate[]; preferences: Preferences; maintenance: { day: string; staleCandidates: number } | null }
interface InboxNotice { id: string; title: string; message: string; createdAt: number; acknowledgedAt?: number; taskId: string | null; verification: string; output?: string | null }

export function HobTeamWorkspace({ profile = 'default' }: { profile?: string }) {
  const [opened, setOpened] = useState(false), [state, setState] = useState<WorkState | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [syncIssue, setSyncIssue] = useState('');
  const [tab, setTab] = useState<'tasks' | 'followups' | 'memory' | 'preferences'>('tasks');
  const [preferences, setPreferences] = useState<Preferences | null>(null), [coreRevision, setCoreRevision] = useState(0);
  const [episodes, setEpisodes] = useState<{ id: string; summary: string; createdAt: number; evidence?: string }[]>([]);
  const [evidence, setEvidence] = useState('');
  const [reviewControls, setReviewControls] = useState<string | null>(null);
  const lock = useRef(false), pending = useRef(new Map<string, string>());
  const load = useCallback(async (signal?: AbortSignal, resetPreferences = true) => {
    const [next, core, log] = await Promise.all([
      apiFetch<WorkState>(endpoint, { signal }),
      apiFetch<{ core: { revision: number } }>('/api/hermes/team', { signal }),
      apiFetch<{ items: typeof episodes }>(`${endpoint}/episodes?profile=${encodeURIComponent(profile)}`, { signal }),
    ]);
    if (signal?.aborted) return;
    setState(next); if (resetPreferences) setPreferences(next.preferences); setCoreRevision(core.core.revision); setEpisodes(log.items); setError(''); setSyncIssue('');
  }, [profile]);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    let reading = false;
    const read = async (reset = false) => {
      if (reading || lock.current || document.hidden) return;
      reading = true;
      try { await load(controller.signal, reset); } catch (cause) { if (!controller.signal.aborted) { if (isConnectionError(cause)) setSyncIssue('Reconnecting to team state. Your tasks remain in place.'); else setError(errorText(cause)); } } finally { reading = false; }
    };
    const initial = setTimeout(() => { void read(true); }, 0), timer = setInterval(() => { void read(); }, 30000);
    const changed = () => { void read(); };
    window.addEventListener('hob:team-changed', changed);
    return () => { controller.abort(); clearTimeout(initial); clearInterval(timer); window.removeEventListener('hob:team-changed', changed); };
  }, [opened, load]);
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); setMessage(''); setSyncIssue('');
    try { await work(); } catch (cause) { if (isConnectionError(cause)) setSyncIssue(errorText(cause)); else setError(errorText(cause)); } finally { lock.current = false; setBusy(false); }
  };
  const mutate = async (path: string, input: object) => {
    const key = path + JSON.stringify(input), identity = pending.current.get(key) || requestId(); pending.current.set(key, identity);
    await apiFetch(`${endpoint}/${path}`, { method: 'POST', body: JSON.stringify({ ...input, requestId: identity }) });
    pending.current.delete(key); await load(); setMessage('Saved. Current team state refreshed.');
  };
  const tasks = state?.tasks.filter(item => profile === 'default' || item.owner === profile) || [];
  const followups = state?.followups.filter(item => profile === 'default' || item.owner === profile) || [];
  return <section className={`${cardClass} space-y-3 min-w-0`} aria-label="HOB team workspace">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-medium">Team workspace</h2><p className="text-xs text-muted">Plans, reviewed results, commitments and memory.</p></div><button className={buttonClass} aria-expanded={opened} onClick={() => setOpened(!opened)}>{opened ? 'Close team workspace' : 'Open team workspace'}</button></div>
    {opened && <div className="space-y-4 hob-view-enter">
      {error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
      {syncIssue && <Notice>{syncIssue}</Notice>}
      {!state && !error && !syncIssue && <Skeleton className="h-32 w-full" />}
      <button className={buttonClass} disabled={busy} onClick={() => void run(() => load())}>Refresh team workspace</button>
      {state && <>
        {!state.enabled && <Notice>HOB team architecture is disabled. Enable it in Settings → Memory → Team controls.</Notice>}
        <p className="text-xs text-muted">Hermes runs the bots. HOB tracks commitments and reviews. Automatic bookkeeping uses no model calls. Showing the most recent 100 items per collection.</p>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Team workspace sections">{(['tasks', 'followups', 'memory', 'preferences'] as const).map(value => <button key={value} className={buttonClass} role="tab" id={`team-tab-${value}`} aria-controls="team-work-content" aria-selected={tab === value} onClick={() => setTab(value)}>{({ tasks: 'Tasks', followups: 'Follow-ups', memory: 'Memory', preferences: 'Delivery preferences' })[value]}</button>)}</div>
        <div role="tabpanel" id="team-work-content" aria-labelledby={`team-tab-${tab}`} key={tab} className="space-y-3 hob-view-enter">
          {tab === 'tasks' && <>
            {!tasks.length && <p className="text-xs text-muted">No team tasks yet. Main will register a step plan before assigning work to a bot.</p>}
            {tasks.map(task => <article className="rounded-xl border border-hair p-3 space-y-2 break-words" key={task.id}>
              <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-medium">{task.title}</h3><span className="text-xs">{task.status.replaceAll('_', ' ')}</span></div>
              <p className="text-xs text-muted">{task.owner} · {task.id} · revision {task.revision}</p><p className="text-xs">{task.outcome}</p>
              <ol className="space-y-1 list-decimal pl-5 text-xs">{task.steps.map((step, index) => <li key={index}>{step.title} · {step.status.replaceAll('_', ' ')}</li>)}</ol>
              <p className="text-xs text-muted">Verification: {task.verification}. Output: {task.output}.</p>
              {task.nativeStatus && <p className="text-xs text-muted">Native execution: {task.nativeStatus}.</p>}
              {task.reviewIssue && <Notice>{task.reviewIssue}</Notice>}
              {task.status === 'done' && task.verification === 'coordinator-reviewed' && task.output !== 'none' && <a className={buttonClass} href={`${endpoint}/output/${encodeURIComponent(task.id)}`} target="_blank" rel="noreferrer">Download reviewed output</a>}
              {task.result && <details><summary className="cursor-pointer text-xs">Worker result · self-reported until reviewed</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{task.result}</pre></details>}
              {task.exchangeId && <p className="text-xs text-muted">Exchange {task.exchangeId}. Open the bot-to-bot thread in chat for the native result and review status.</p>}
              {task.status === 'review_pending' && task.output === 'none' && <><Field label={`Review evidence for ${task.title}`}><textarea className={inputClass} value={evidence} onChange={event => setEvidence(event.target.value)} maxLength={2000} /></Field><button className={buttonClass} disabled={busy || !state.enabled || !evidence.trim()} onClick={() => void run(() => mutate('text-review', { id: task.id, revision: task.revision, confirm: true, evidence }))}>I checked this text result; mark reviewed</button></>}
              {task.status === 'review_pending' && task.output !== 'none' && <p className="text-xs text-muted">Waiting for Main to inspect the nominated file and record checks against its exact snapshot hash.</p>}
              {task.reviewSession && <><button className={buttonClass} aria-expanded={reviewControls === task.id} onClick={() => setReviewControls(reviewControls === task.id ? null : task.id)}>Coordinator review controls</button>{reviewControls === task.id && <HermesRunPanel key={task.reviewSession} sessionId={task.reviewSession} profile="default" />}</>}
            </article>)}
          </>}
          {tab === 'followups' && <>
            <Notice>Detected promises are drafts until you approve them. Task-linked reminders recheck task state. External or conversation-only reminders need your current-state check before delivery.</Notice>
            <Field label="Current-state evidence" hint="Required when approving, confirming still open, or marking done. Do not include secrets."><textarea className={inputClass} maxLength={2000} value={evidence} onChange={event => setEvidence(event.target.value)} /></Field>
            {!followups.length && <p className="text-xs text-muted">No commitments captured yet.</p>}
            {followups.map(item => <article key={item.id} className="rounded-xl border border-hair p-3 space-y-2 break-words"><h3 className="text-sm">{item.title}</h3><p className="text-xs">{item.outcome}</p><p className="text-xs text-muted">{item.owner} · {item.status} · {item.deadline ? new Date(item.deadline).toLocaleString() : 'No deadline'} · {item.lastChecked ? `Checked ${new Date(item.lastChecked).toLocaleString()}` : 'Not checked'}</p>
              {!['done', 'closed', 'delivered'].includes(item.status) && <div className="flex flex-wrap gap-2">{(item.status === 'draft' ? ['approve', 'dismiss'] : ['still-open', 'done', 'dismiss']).map(decision => <button className={buttonClass} key={decision} disabled={busy || !state.enabled || decision !== 'dismiss' && !evidence.trim()} onClick={() => void run(() => mutate('followups/decide', { id: item.id, revision: item.revision, decision, confirm: true, evidence }))}>{({ approve: 'Approve commitment', 'still-open': 'I checked: still open', done: 'Already done', dismiss: 'Dismiss; never offer again' })[decision]}</button>)}</div>}
            </article>)}
          </>}
          {tab === 'memory' && <>
            <h3 className="text-sm">Shared-memory candidates</h3><p className="text-xs text-muted">Staging creates a proposal for review in Team controls. It does not publish a fact. Standing rules and preferences use the same operator approval gate.</p>
            {!state.candidates.length && <p className="text-xs text-muted">No candidates awaiting review.</p>}
            {state.candidates.map(item => <article key={item.id} className="rounded-xl border border-hair p-3 space-y-2 break-words"><p className="text-sm">{item.fact}</p><p className="text-xs text-muted">{item.owner} · {item.tier} · {item.status}</p><p className="text-xs">{item.evidence}</p>{item.conflicts.length > 0 && <Notice>Possible overlap with current core: {item.conflicts.join(' | ')}</Notice>}{item.status === 'pending' && <div className="flex flex-wrap gap-2">{['stage', 'reject'].map(decision => <button className={buttonClass} key={decision} disabled={busy || !state.enabled} onClick={() => void run(() => mutate('candidates/decide', { id: item.id, revision: item.revision, decision, base: coreRevision, confirm: true }))}>{decision === 'stage' ? 'Stage for core review' : 'Reject candidate'}</button>)}</div>}</article>)}
            <h3 className="text-sm">Private work log · {profile}</h3><p className="text-xs text-muted">This operator view shows the selected bot’s log. Bot credentials can only read their own log. Raw transcripts stay in Hermes.</p>
            {!episodes.length && <p className="text-xs text-muted">No private work-log entries yet.</p>}
            {episodes.map(item => <article key={item.id} className="rounded-xl border border-hair p-3 text-xs break-words"><time className="text-muted">{new Date(item.createdAt).toLocaleString()}</time><p className="mt-1 whitespace-pre-wrap">{item.summary}</p>{item.evidence && <p className="mt-1 text-muted">{item.evidence}</p>}</article>)}
            {state.maintenance && <p className="text-xs text-muted">Daily consolidation: {state.maintenance.day}. {state.maintenance.staleCandidates} candidates older than 90 days need review. No automatic core changes.</p>}
          </>}
          {tab === 'preferences' && preferences && <fieldset disabled={busy || !state.enabled} className="space-y-3">
            <Notice>Delivery stays in your HOB inbox. Default quiet hours use UTC; choose your timezone. A cap of zero pauses proactive delivery.</Notice>
            <Field label="Daily delivery cap"><input className={inputClass} type="number" min={0} max={50} value={preferences.dailyCap} onChange={event => setPreferences({ ...preferences, dailyCap: Number(event.target.value) })} /></Field>
            <Field label="Timezone"><input className={inputClass} value={preferences.timezone} placeholder="Asia/Karachi" onChange={event => setPreferences({ ...preferences, timezone: event.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2"><Field label="Quiet hours start"><input className={inputClass} type="time" value={preferences.quietStart} onChange={event => setPreferences({ ...preferences, quietStart: event.target.value })} /></Field><Field label="Quiet hours end"><input className={inputClass} type="time" value={preferences.quietEnd} onChange={event => setPreferences({ ...preferences, quietEnd: event.target.value })} /></Field></div>
            <Field label="Never offer again" hint="One commitment ID or exact title per line."><textarea className={inputClass} rows={3} value={preferences.neverOffer.join('\n')} onChange={event => setPreferences({ ...preferences, neverOffer: event.target.value.split('\n') })} /></Field>
            <button className={buttonClass} onClick={() => void run(() => mutate('preferences', { revision: preferences.revision, dailyCap: preferences.dailyCap, timezone: preferences.timezone, quietStart: preferences.quietStart, quietEnd: preferences.quietEnd, neverOffer: preferences.neverOffer.filter(Boolean), confirm: true }))}>Save delivery preferences</button>
          </fieldset>}
        </div>
      </>}
    </div>}
  </section>;
}

export function HobTeamInbox({ profile }: { profile: string }) {
  const [items, setItems] = useState<InboxNotice[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const value = await apiFetch<{ items: InboxNotice[] }>(`${endpoint}/inbox?profile=${encodeURIComponent(profile)}`, { signal });
    if (!Array.isArray(value.items)) throw new Error('HOB returned an invalid inbox response.');
    if (!signal?.aborted) { setItems(value.items); setError(''); }
  }, [profile]);
  useEffect(() => {
    const controller = new AbortController(); let working = false;
    const poll = async () => { if (working || document.hidden) return; working = true; try { await load(controller.signal); } catch { if (!controller.signal.aborted) setError('Inbox will refresh when the connection returns.'); } finally { working = false; } };
    const initial = setTimeout(() => { void poll(); }, 0), timer = setInterval(() => { void poll(); }, 30000);
    window.addEventListener('focus', poll);
    window.addEventListener('hob:team-changed', poll);
    return () => { controller.abort(); clearTimeout(initial); clearInterval(timer); window.removeEventListener('focus', poll); window.removeEventListener('hob:team-changed', poll); };
  }, [load]);
  if (!items.length && !error) return null;
  return <section aria-label="HOB inbox" className="my-3 rounded-xl border border-hair bg-panel p-3 text-xs space-y-2">
    <button className={buttonClass} aria-expanded={opened} onClick={() => setOpened(!opened)}>HOB inbox · {items.filter(item => !item.acknowledgedAt).length} unread</button>
    {opened && <div className="max-h-80 overflow-auto space-y-3 hob-view-enter">{error && <p className="text-muted" role="status">{error}</p>}{items.map(item => <article key={item.id} className="space-y-1 break-words"><h3 className="font-medium">{item.title}</h3><p>{item.message}</p><p className="text-muted">{new Date(item.createdAt).toLocaleString()} · {item.verification}</p>{item.taskId && item.output && item.output !== 'none' && <a className={buttonClass} href={`${endpoint}/output/${encodeURIComponent(item.taskId)}`} target="_blank" rel="noreferrer">Download reviewed output</a>}{!item.acknowledgedAt && <button className={buttonClass} disabled={busy} onClick={() => { setBusy(true); void apiFetch(`${endpoint}/inbox/read`, { method: 'POST', body: JSON.stringify({ id: item.id, requestId: `read-${item.id}` }) }).then(() => load()).catch(cause => setError(errorText(cause))).finally(() => setBusy(false)); }}>Mark read</button>}</article>)}</div>}
  </section>;
}
