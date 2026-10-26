import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../services/api';
import { hermesWorkspaceApi, jsonWrite } from '../services/hermes-workspace';
import { buttonClass, cardClass, ConfirmButton, Field, inputClass, Notice, StatusPill } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface Conversation { id: string; title: string; transport?: string }
interface Heartbeat { status: string; prompt: string; interval_seconds: number; fire_count: number }
interface Goal { status: string; title: string; turns_used: number; max_turns: number; paused_reason?: string }
interface Snapshot { control: { revision: string; heartbeat: Heartbeat | null; goal: Goal | null }; output?: string }

export function HermesAutonomySettings({ profile }: { profile: string }) {
  const api = useMemo(() => hermesWorkspaceApi(profile), [profile]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sessionKey, setSessionKey] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState('15');
  const [prompt, setPrompt] = useState('Review outstanding approved work, check for overdue dependencies and blockers, and take the next permitted step. Report meaningful changes. If nothing needs attention, stop without inventing work.');
  const [goal, setGoal] = useState('');
  const pending = useRef(false), sequence = useRef(0);
  const invalidate = useCallback(() => { sequence.current++; }, []);
  useEffect(() => {
    let active = true;
    void apiFetch<Conversation[]>('/api/sessions', { headers: { 'X-Hob-Profile': profile } }).then(rows => {
      if (!active) return;
      const native = rows.filter(row => row.transport === 'canonical');
      setConversations(native); setSessionKey(native[0]?.id || '');
    }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; invalidate(); };
  }, [profile, invalidate]);
  const load = useCallback(async () => {
    if (!sessionKey) return;
    const current = ++sequence.current;
    try {
      const result = await api<Snapshot>('autonomy', {}, { sessionKey });
      if (current === sequence.current) { setSnapshot(result); setError(''); }
    } catch (cause) { if (current === sequence.current) setError(errorText(cause)); }
  }, [api, sessionKey]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => { if (!pending.current) void load(); }, 15000);
    return () => { invalidate(); window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load, invalidate]);
  const act = async (kind: 'heartbeat' | 'goal', action: 'set' | 'pause' | 'resume' | 'clear') => {
    if (pending.current || !sessionKey) return;
    pending.current = true; setBusy(true); setError('');
    const current = ++sequence.current;
    try {
      const result = await api<Snapshot>('autonomy', jsonWrite('POST', { sessionKey, kind, action,
        ...(action === 'set' ? { prompt: kind === 'heartbeat' ? prompt.trim() : goal.trim(), ...(kind === 'heartbeat' ? { intervalSeconds: Number(minutes) * 60 } : {}) } : {}) }));
      if (current === sequence.current) setSnapshot(result);
    } catch (cause) {
      if (current === sequence.current) setError(`${errorText(cause)} Refresh before retrying; the change may already have reached Hermes.`);
    } finally { pending.current = false; setBusy(false); }
  };
  const controls = (kind: 'heartbeat' | 'goal', status: string) => <div className="flex flex-wrap gap-2">
    <button className={buttonClass} disabled={busy} onClick={() => void act(kind, status === 'paused' ? 'resume' : 'pause')}>{status === 'paused' ? 'Resume' : 'Pause'} {kind}</button>
    <ConfirmButton className={buttonClass} disabled={busy} tone="danger" confirmLabel="Clear" message={`Clear this conversation's ${kind}?`} onConfirm={() => void act(kind, 'clear')}>Clear {kind}</ConfirmButton>
  </div>;
  const heartbeat = snapshot?.control.heartbeat, currentGoal = snapshot?.control.goal;
  return <section aria-label="Conversation automation" className={`${cardClass} space-y-4`}>
    <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-ink">Goals &amp; heartbeat</h2><button className={buttonClass} disabled={busy || !sessionKey} onClick={() => void load()}>Refresh automation</button></div>
    <p className="text-xs leading-relaxed text-muted">A goal guides continued work. A heartbeat periodically re-enters its conversation when idle. Hermes runs both while the gateway is online, with its normal approvals.</p>
    {error && <Notice error>{error}</Notice>}
    <Field label="Automation conversation"><select aria-label="Automation conversation" className={inputClass} value={sessionKey} disabled={busy} onChange={event => { sequence.current++; setSnapshot(null); setError(''); setSessionKey(event.target.value); }}>
      {!conversations.length && <option value="">Create a conversation with this bot first</option>}
      {conversations.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
    </select></Field>
    {sessionKey && <>
      <div className="space-y-3 rounded-xl border border-line p-4"><h3 className="text-xs font-semibold">Current goal</h3>
        {currentGoal && currentGoal.status !== 'cleared' ? <><StatusPill status={currentGoal.status} /><p className="text-sm text-soft break-words">{currentGoal.title}</p><p className="text-xs text-muted">{currentGoal.turns_used} of {currentGoal.max_turns} turns used{currentGoal.paused_reason ? ` · ${currentGoal.paused_reason}` : ''}</p>{controls('goal', currentGoal.status)}</> : <p className="text-xs text-muted">No goal is set in this conversation.</p>}
        <Field label="Goal outcome" hint="Describe what should be accomplished. Starting a goal admits its first turn with Hermes's normal budget and approvals."><textarea aria-label="Goal outcome" className={inputClass} maxLength={4000} value={goal} onChange={event => setGoal(event.target.value)} /></Field>
        <button className={buttonClass} disabled={busy || !snapshot || !goal.trim()} onClick={() => void act('goal', 'set')}>Start conversation goal</button>
      </div>
      <div className="space-y-3 rounded-xl border border-line p-4"><h3 className="text-xs font-semibold">Recurring heartbeat</h3>
        {heartbeat && heartbeat.status !== 'cleared' ? <><StatusPill status={heartbeat.status} /><p className="text-xs whitespace-pre-wrap break-words text-soft">{heartbeat.prompt}</p><p className="text-xs text-muted">Every {heartbeat.interval_seconds / 60} minutes · {heartbeat.fire_count} checks</p>{controls('heartbeat', heartbeat.status)}</> : <p className="text-xs text-muted">No heartbeat is set in this conversation.</p>}
        <Field label="Heartbeat instructions"><textarea aria-label="Heartbeat instructions" className={`${inputClass} min-h-28`} maxLength={4000} value={prompt} onChange={event => setPrompt(event.target.value)} /></Field>
        <Field label="Heartbeat interval (minutes)" hint="Minimum 1 minute. Start with 15 minutes to limit unnecessary model calls."><input aria-label="Heartbeat interval (minutes)" type="number" min="1" max="10080" step="1" className={inputClass} value={minutes} onChange={event => setMinutes(event.target.value)} /></Field>
        <button className={buttonClass} disabled={busy || !snapshot || !prompt.trim() || !Number.isInteger(Number(minutes)) || Number(minutes) < 1 || Number(minutes) > 10080} onClick={() => void act('heartbeat', 'set')}>Save heartbeat</button>
      </div>
      <p className="text-xs text-muted">Heartbeat settings persist in Hermes. Use a scheduled task below for a specific time such as 9 AM.</p>
    </>}
  </section>;
}
