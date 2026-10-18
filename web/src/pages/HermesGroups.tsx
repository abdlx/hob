import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/api';
import { requestId } from '../services/id';
import { useChat } from '../context/ChatContext';
import { MarkdownView } from '../components/MarkdownView';
import { buttonClass, cardClass, ConfirmButton, EmptyState, Field, inputClass, Notice, Skeleton } from '../components/WorkspaceUI';
import { errorText } from '../components/workspaceUtils';
import type { GroupSummary } from '../types/chat';

interface Event { id: string; seq: number; kind: string; member: string; text: string; timestamp: number }
interface GroupAction { id: string; kind: 'approval' | 'retry' | 'discard'; member: string; description: string; command?: string }
interface GroupState { group: GroupSummary; unavailableMembers: string[]; driver: { running: boolean; working: boolean; blocked: boolean }; actions: GroupAction[] }
const api = <T,>(route = '', init: RequestInit = {}) => apiFetch<T>(`/api/hermes/groups${route}`, { ...init, headers: { 'X-Hob-Profile': 'default' } });
const post = (value: unknown) => ({ method: 'POST', body: JSON.stringify(value) });

// Groups are created and disbanded in the Bots sidebar; this view follows the selected
// group's shared conversation.
function GroupConversation({ groupId, onChanged }: { groupId: string; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<GroupState | null>(null), [events, setEvents] = useState<Event[]>([]), [draft, setDraft] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [name, setName] = useState(''), [renaming, setRenaming] = useState(false), [uncertain, setUncertain] = useState(false);
  const cursor = useRef(0), pending = useRef(false), mounted = useRef(true), sending = useRef(false), request = useRef<string | null>(null);
  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const [next, log] = await Promise.all([api<GroupState>(`/${groupId}`), api<{ events: Event[]; cursor: number }>(`/${groupId}/events?since=${cursor.current}`)]);
      if (!mounted.current) return;
      setState(next); setEvents(previous => [...new Map([...previous, ...log.events].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq)); cursor.current = log.cursor;
    } catch (error) { if (mounted.current) setError(errorText(error)); }
    finally { pending.current = false; }
  }, [groupId]);
  useEffect(() => { mounted.current = true; const initial = window.setTimeout(load, 0), timer = window.setInterval(load, 2000); return () => { mounted.current = false; window.clearTimeout(initial); window.clearInterval(timer); }; }, [load]);
  const action = async (work: () => Promise<unknown>) => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try { await work(); if (mounted.current) { await load(); await onChanged(); } }
    catch (error) { if (mounted.current) setError(errorText(error)); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  };
  const send = () => action(async () => {
    const content = draft.trim(); if (!content) return;
    request.current ??= requestId();
    try { await api(`/${groupId}/messages`, post({ text: content, requestId: request.current })); if (mounted.current) setDraft(''); request.current = null; }
    catch (error) { if (mounted.current) setUncertain(true); throw error; }
  });
  const current = state?.group;
  if (!current) return <div className="space-y-3"><Skeleton className="h-6 w-1/3" /><Skeleton className="h-40 w-full" /></div>;
  return <section className="space-y-3"><div className="flex items-center justify-between gap-2"><h2 className="text-sm text-ink">{current.name}</h2><button className={buttonClass} onClick={() => { setError(''); void load(); }}>Refresh conversation</button></div>
    <p className="text-xs text-muted">{current.members.map(member => `${member.name} (@${member.handle})`).join(' · ')}</p><Notice>Only messages in this group are shared. Each member has a separate room session; private chat transcripts are not copied. Mention a bot to direct a turn, or address the group. Hermes bounds discussion to prevent endless bot loops.</Notice>
    {error && <Notice error>{error}</Notice>}{uncertain && <Notice>The send outcome was not confirmed. Refresh and inspect the shared history before sending again. <button className={buttonClass} disabled={busy} onClick={() => { setUncertain(false); request.current = null; }}>I checked the history</button></Notice>}
    {state?.unavailableMembers.length ? <Notice error>Unavailable members: {state.unavailableMembers.join(', ')}. New work is blocked.</Notice> : null}
    {state && <p role="status" className="text-xs text-muted">{current.disbanded ? 'Disbanded · retained history' : !state.driver.running ? 'Group worker unavailable' : state.driver.blocked ? 'Waiting for a decision' : state.driver.working ? 'Members are working…' : 'Ready'}</p>}
    <div className="space-y-3">{events.filter(event => event.text).map(event => <article key={event.id} className={`${cardClass} space-y-2`}><p className="text-[11px] text-muted">{current.members.find(member => member.profile === event.member)?.name || event.member}{event.timestamp ? ` · ${new Date(event.timestamp * 1000).toLocaleTimeString()}` : ''}</p><MarkdownView content={event.text} /></article>)}</div>
    {state?.actions.map(item => <div key={item.id} className={`${cardClass} space-y-2`}><p className="text-xs text-soft">{item.member}: {item.description}</p>{item.command && <pre className="text-xs whitespace-pre-wrap break-words select-text max-h-96 overflow-auto text-soft">{item.command}</pre>}{item.kind === 'approval' ? <div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => action(() => api(`/${groupId}/actions`, post({ id: item.id, choice: 'once', confirm: true })))}>Approve once</button><button className={buttonClass} disabled={busy} onClick={() => action(() => api(`/${groupId}/actions`, post({ id: item.id, choice: 'deny', confirm: true })))}>Deny</button></div> : <button className={buttonClass} disabled={busy} onClick={() => action(() => api(`/${groupId}/actions`, post({ id: item.id, choice: item.kind, confirm: true })))}>{item.kind === 'retry' ? 'Explicitly retry deferred work' : 'Discard uncertain work without replay'}</button>}</div>)}
    {!current.disbanded && <><Field label="Group message"><textarea className={`${inputClass} min-h-24`} value={draft} disabled={busy || uncertain} onChange={event => setDraft(event.target.value)} /></Field><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy || uncertain || !draft.trim() || !state?.driver.running || Boolean(state?.unavailableMembers.length)} onClick={send}>Send to group</button><button className={buttonClass} disabled={busy} onClick={() => action(() => api(`/${groupId}/stop`, post({})))}>Stop group work</button><button className={buttonClass} disabled={busy} onClick={() => { setName(current.name); setRenaming(true); }}>Rename group</button><ConfirmButton className={buttonClass} disabled={busy} tone="danger" confirmLabel="Disband" message="Disband this group and cancel its work? Its retained history remains readable under Hermes’s retention policy." onConfirm={() => { void action(async () => { await api(`/${groupId}/disband`, post({ confirm: true })); }); }}>Disband group</ConfirmButton></div></>}
    {renaming && <div className="space-y-2"><Field label="Group name"><input className={inputClass} value={name} onChange={event => setName(event.target.value)} /></Field><button className={buttonClass} disabled={busy || !name.trim()} onClick={() => action(async () => { await api(`/${groupId}/rename`, post({ name: name.trim(), requestId: requestId() })); setRenaming(false); })}>Save group name</button> <button className={buttonClass} onClick={() => setRenaming(false)}>Cancel rename</button></div>}
  </section>;
}

export function HermesGroups() {
  const { groups, loadGroups, selectedGroupId, setActiveNav } = useChat();
  const [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadGroups().catch(cause => { if (alive) setError(errorText(cause)); }).finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [loadGroups]);
  const current = groups.find(group => group.id === selectedGroupId);
  if (!current) {
    return <div className="space-y-5">{error && <Notice error>{error}</Notice>}
      {!loaded ? <div className="space-y-3"><Skeleton className="h-6 w-1/3" /><Skeleton className="h-40 w-full" /></div>
        : <EmptyState title="No group selected" description="Create and pick groups in the Bots sidebar. Open one to follow its shared conversation here." />}
      <p className="text-xs text-muted">Groups are managed beside your bots. <button className="underline text-accent" onClick={() => setActiveNav('chat')}>Back to chat</button></p>
    </div>;
  }
  return <div className="space-y-5">{error && <Notice error>{error}</Notice>}<GroupConversation key={current.id} groupId={current.id} onChanged={loadGroups} /></div>;
}
