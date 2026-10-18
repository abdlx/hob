import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/api';
import { requestId } from '../services/id';
import { useChat } from '../context/ChatContext';
import { MarkdownView } from '../components/MarkdownView';
import { buttonClass, cardClass, ConfirmButton, Field, inputClass, Notice } from '../components/WorkspaceUI';
import { errorText } from '../components/workspaceUtils';

interface Member { id: string; profile: string; name: string; handle: string }
interface Group { id: string; name: string; members: Member[]; disbanded: boolean }
interface Event { id: string; seq: number; kind: string; member: string; text: string; timestamp: number }
interface GroupAction { id: string; kind: 'approval' | 'retry' | 'discard'; member: string; description: string; command?: string }
interface GroupState { group: Group; unavailableMembers: string[]; driver: { running: boolean; working: boolean; blocked: boolean }; actions: GroupAction[] }
const api = <T,>(route = '', init: RequestInit = {}) => apiFetch<T>(`/api/hermes/groups${route}`, { ...init, headers: { 'X-Hob-Profile': 'default' } });
const post = (value: unknown) => ({ method: 'POST', body: JSON.stringify(value) });

function GroupConversation({ group, onChanged }: { group: Group; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<GroupState | null>(null), [events, setEvents] = useState<Event[]>([]), [draft, setDraft] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [name, setName] = useState(group.name), [renaming, setRenaming] = useState(false), [uncertain, setUncertain] = useState(false);
  const cursor = useRef(0), pending = useRef(false), mounted = useRef(true), sending = useRef(false), request = useRef<string | null>(null);
  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const [next, log] = await Promise.all([api<GroupState>(`/${group.id}`), api<{ events: Event[]; cursor: number }>(`/${group.id}/events?since=${cursor.current}`)]);
      if (!mounted.current) return;
      setState(next); setEvents(previous => [...new Map([...previous, ...log.events].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq)); cursor.current = log.cursor;
    } catch (error) { if (mounted.current) setError(errorText(error)); }
    finally { pending.current = false; }
  }, [group.id]);
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
    try { await api(`/${group.id}/messages`, post({ text: content, requestId: request.current })); if (mounted.current) setDraft(''); request.current = null; }
    catch (error) { if (mounted.current) setUncertain(true); throw error; }
  });
  const current = state?.group || group;
  return <section className="space-y-3"><div className="flex items-center justify-between gap-2"><h2 className="text-sm text-ink">{current.name}</h2><button className={buttonClass} onClick={() => { setError(''); void load(); }}>Refresh conversation</button></div>
    <p className="text-xs text-muted">{current.members.map(member => `${member.name} (@${member.handle})`).join(' · ')}</p><Notice>Only messages in this group are shared. Each member has a separate room session; private chat transcripts are not copied. Mention a bot to direct a turn, or address the group. Hermes bounds discussion to prevent endless bot loops.</Notice>
    {error && <Notice error>{error}</Notice>}{uncertain && <Notice>The send outcome was not confirmed. Refresh and inspect the shared history before sending again. <button className={buttonClass} disabled={busy} onClick={() => { setUncertain(false); request.current = null; }}>I checked the history</button></Notice>}
    {state?.unavailableMembers.length ? <Notice error>Unavailable members: {state.unavailableMembers.join(', ')}. New work is blocked.</Notice> : null}
    {state && <p role="status" className="text-xs text-muted">{current.disbanded ? 'Disbanded · retained history' : !state.driver.running ? 'Group worker unavailable' : state.driver.blocked ? 'Waiting for a decision' : state.driver.working ? 'Members are working…' : 'Ready'}</p>}
    <div className="space-y-3">{events.filter(event => event.text).map(event => <article key={event.id} className={`${cardClass} space-y-2`}><p className="text-[11px] text-muted">{current.members.find(member => member.profile === event.member)?.name || event.member}{event.timestamp ? ` · ${new Date(event.timestamp * 1000).toLocaleTimeString()}` : ''}</p><MarkdownView content={event.text} /></article>)}</div>
    {state?.actions.map(item => <div key={item.id} className={`${cardClass} space-y-2`}><p className="text-xs text-soft">{item.member}: {item.description}</p>{item.command && <pre className="text-xs whitespace-pre-wrap break-words select-text max-h-96 overflow-auto text-soft">{item.command}</pre>}{item.kind === 'approval' ? <div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => action(() => api(`/${group.id}/actions`, post({ id: item.id, choice: 'once', confirm: true })))}>Approve once</button><button className={buttonClass} disabled={busy} onClick={() => action(() => api(`/${group.id}/actions`, post({ id: item.id, choice: 'deny', confirm: true })))}>Deny</button></div> : <button className={buttonClass} disabled={busy} onClick={() => action(() => api(`/${group.id}/actions`, post({ id: item.id, choice: item.kind, confirm: true })))}>{item.kind === 'retry' ? 'Explicitly retry deferred work' : 'Discard uncertain work without replay'}</button>}</div>)}
    {!current.disbanded && <><Field label="Group message"><textarea className={`${inputClass} min-h-24`} value={draft} disabled={busy || uncertain} onChange={event => setDraft(event.target.value)} /></Field><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy || uncertain || !draft.trim() || !state?.driver.running || Boolean(state?.unavailableMembers.length)} onClick={send}>Send to group</button><button className={buttonClass} disabled={busy} onClick={() => action(() => api(`/${group.id}/stop`, post({})))}>Stop group work</button><button className={buttonClass} disabled={busy} onClick={() => { setName(current.name); setRenaming(true); }}>Rename group</button><ConfirmButton className={buttonClass} disabled={busy} tone="danger" confirmLabel="Disband" message="Disband this group and cancel its work? Its retained history remains readable under Hermes’s retention policy." onConfirm={() => { void action(async () => { await api(`/${group.id}/disband`, post({ confirm: true })); }); }}>Disband group</ConfirmButton></div></>}
    {renaming && <div className="space-y-2"><Field label="Group name"><input className={inputClass} value={name} onChange={event => setName(event.target.value)} /></Field><button className={buttonClass} disabled={busy || !name.trim()} onClick={() => action(async () => { await api(`/${group.id}/rename`, post({ name: name.trim(), requestId: requestId() })); setRenaming(false); })}>Save group name</button> <button className={buttonClass} onClick={() => setRenaming(false)}>Cancel rename</button></div>}
  </section>;
}

export function HermesGroups() {
  const { agents, setActiveNav } = useChat();
  const [groups, setGroups] = useState<Group[]>([]), [selected, setSelected] = useState(''), [error, setError] = useState('');
  const [name, setName] = useState(''), [members, setMembers] = useState<string[]>([]), [creating, setCreating] = useState(false), [form, setForm] = useState(false);
  const createId = useRef<string | null>(null), sequence = useRef(0), createBusy = useRef(false);
  const invalidate = useCallback(() => { sequence.current++; }, []);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try { const result = await api<{ groups: Group[] }>(); if (current === sequence.current) { setGroups(result.groups); setError(''); } }
    catch (error) { if (current === sequence.current) setError(errorText(error)); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => { invalidate(); window.clearTimeout(timer); }; }, [load, invalidate]);
  const create = async () => {
    if (createBusy.current) return;
    createBusy.current = true; setCreating(true); setError(''); createId.current ??= requestId();
    try { const result = await api<{ group: Group }>('', post({ requestId: createId.current, name: name.trim(), members, confirm: true })); setSelected(result.group.id); setForm(false); setName(''); setMembers([]); createId.current = null; await load(); }
    catch (error) { setError(errorText(error)); }
    finally { createBusy.current = false; setCreating(false); }
  };
  const current = groups.find(group => group.id === selected);
  return <div className="space-y-5"><div className="flex justify-between gap-2"><h2 className="text-sm text-ink">Group conversations</h2><div className="flex gap-2"><button className={buttonClass} onClick={load}>Refresh groups</button><button className={buttonClass} disabled={creating || agents.length < 2} onClick={() => setForm(true)}>New group</button></div></div>{error && <Notice error>{error}</Notice>}{agents.length < 2 && <Notice>Create another bot in <button className="underline" onClick={() => setActiveNav('settings')}>Settings</button> before creating a collaboration group. No extra bots or groups are created automatically.</Notice>}
    {form && <section className={`${cardClass} space-y-3`}><Field label="New group name"><input className={inputClass} value={name} disabled={creating} onChange={event => setName(event.target.value)} /></Field><fieldset className="space-y-2"><legend className="text-xs text-muted mb-2">Choose two to six bots</legend>{agents.map(agent => <label key={agent.id} className="flex items-center gap-2 text-xs text-soft"><input type="checkbox" checked={members.includes(agent.id)} disabled={creating || (members.length >= 6 && !members.includes(agent.id))} onChange={event => { const checked = event.target.checked; createId.current = null; setMembers(previous => checked ? [...previous, agent.id] : previous.filter(id => id !== agent.id)); }} />{agent.name}</label>)}</fieldset><Notice>These bots will collaborate only inside this new shared conversation. Their private conversations remain separate. Membership is frozen; create another group to change it.</Notice><button className={buttonClass} disabled={creating || !name.trim() || members.length < 2} onClick={create}>Create collaboration group</button> <button className={buttonClass} disabled={creating} onClick={() => setForm(false)}>Cancel</button></section>}
    {groups.length === 0 && !error && <Notice>No groups yet. Create one when you want your bots to collaborate.</Notice>}{groups.length > 0 && <Field label="Group"><select className={inputClass} value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose a group</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}{group.disbanded ? ' · disbanded' : ''}</option>)}</select></Field>}{current && <GroupConversation key={current.id} group={current} onChanged={load} />}
  </div>;
}
