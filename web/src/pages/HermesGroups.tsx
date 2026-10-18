import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Pencil, RotateCcw, ShieldAlert, Square, Users, X } from 'lucide-react';
import { apiFetch } from '../services/api';
import { requestId } from '../services/id';
import { useChat } from '../context/ChatContext';
import { ChatMessageItem } from '../components/ChatMessageItem';
import { ChatComposer } from '../components/ChatComposer';
import { buttonClass, ConfirmButton, EmptyState, inputClass, Notice, Skeleton } from '../components/WorkspaceUI';
import { errorText } from '../components/workspaceUtils';
import type { ChatMessage, GroupSummary } from '../types/chat';

interface Event { id: string; seq: number; kind: string; member: string; text: string; timestamp: number }
interface GroupAction { id: string; kind: 'approval' | 'retry' | 'discard'; member: string; description: string; command?: string }
interface GroupState { group: GroupSummary; unavailableMembers: string[]; driver: { running: boolean; working: boolean; blocked: boolean }; actions: GroupAction[] }
const api = <T,>(route = '', init: RequestInit = {}) => apiFetch<T>(`/api/hermes/groups${route}`, { ...init, headers: { 'X-Hob-Profile': 'default' } });
const post = (value: unknown) => ({ method: 'POST', body: JSON.stringify(value) });
const iconButton = 'w-9 h-9 rounded-full border border-[rgba(0,0,0,0.06)] bg-surface text-code hover:bg-sunken flex items-center justify-center transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed active:scale-95';

const ACTION_ICON = { approval: ShieldAlert, retry: RotateCcw, discard: AlertTriangle } as const;

function ActionPrompt({ item, member, busy, onDecide }: { item: GroupAction; member: string; busy: boolean; onDecide: (choice: string) => void }) {
  const Icon = ACTION_ICON[item.kind];
  return (
    <div className="my-3 max-w-[88%] rounded-2xl bg-surface border border-hair shadow-sm p-4 text-sm" role="dialog" aria-label={`${item.kind} decision for ${member}`}>
      <div className="flex items-start gap-3">
        <Icon size={18} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">{member}</p>
          <p className="mt-1 leading-relaxed text-muted">{item.description}</p>
        </div>
      </div>
      {item.command && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code-soft p-2.5 font-mono text-[11px] text-ink select-text">{item.command}</pre>
      )}
      <div className="mt-3 flex gap-2">
        {item.kind === 'approval' ? (
          <>
            <button type="button" className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent hover:bg-accent-strong px-3 py-2 text-xs font-semibold text-white transition-colors disabled:opacity-50 cursor-pointer shadow-xs" disabled={busy} onClick={() => onDecide('once')}>
              <Check size={13} /> Allow once
            </button>
            <button type="button" className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-neutral hover:bg-neutral-strong px-3 py-2 text-xs font-medium text-ink transition-colors disabled:opacity-50 cursor-pointer" disabled={busy} onClick={() => onDecide('deny')}>
              <X size={13} /> Deny
            </button>
          </>
        ) : (
          <button type="button" className={buttonClass} disabled={busy} onClick={() => onDecide(item.kind)}>
            {item.kind === 'retry' ? 'Retry the deferred work' : 'Discard the uncertain work'}
          </button>
        )}
      </div>
    </div>
  );
}

// Groups are created and disbanded in the Bots sidebar; this pane is the group's chat.
// One message goes to every member, and each member answers here under its own name.
function GroupConversation({ groupId }: { groupId: string }) {
  const { loadGroups, setActiveNav } = useChat();
  const [state, setState] = useState<GroupState | null>(null), [events, setEvents] = useState<Event[]>([]), [draft, setDraft] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [name, setName] = useState(''), [renaming, setRenaming] = useState(false), [uncertain, setUncertain] = useState(false);
  const cursor = useRef(0), pending = useRef(false), mounted = useRef(true), sending = useRef(false), request = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const [next, log] = await Promise.all([api<GroupState>(`/${groupId}`), api<{ events: Event[]; cursor: number }>(`/${groupId}/events?since=${cursor.current}`)]);
      if (!mounted.current) return;
      setState(next); setEvents(previous => [...new Map([...previous, ...log.events].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq)); cursor.current = log.cursor;
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { pending.current = false; }
  }, [groupId]);
  useEffect(() => { mounted.current = true; const initial = window.setTimeout(load, 0), timer = window.setInterval(load, 2000); return () => { mounted.current = false; window.clearTimeout(initial); window.clearInterval(timer); }; }, [load]);

  const action = async (work: () => Promise<unknown>) => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try { await work(); if (mounted.current) { await load(); await loadGroups(); } }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  };

  const send = () => {
    const content = draft.trim();
    if (!content) return;
    void action(async () => {
      request.current ??= requestId();
      try {
        await api(`/${groupId}/messages`, post({ text: content, requestId: request.current }));
        if (mounted.current) { setDraft(''); request.current = null; }
      } catch (cause) { if (mounted.current) setUncertain(true); throw cause; }
    });
  };

  const members = useMemo(() => state?.group.members || [], [state]);
  const memberName = useCallback((profile: string) => members.find((member) => member.profile === profile)?.name || profile, [members]);

  // Room history already carries author and kind; render it exactly like a chat transcript.
  const messages = useMemo<ChatMessage[]>(() => events.filter((event) => event.text).map((event) => ({
    id: event.id,
    role: event.kind === 'message.user' || event.member === 'You' ? 'user' : 'assistant',
    content: event.text,
    timestamp: event.timestamp ? new Date(event.timestamp * 1000).toISOString() : '',
    status: 'complete',
    ...(event.kind === 'message.user' || event.member === 'You' ? {} : { sender: memberName(event.member) }),
  })), [events, memberName]);

  const messageCount = messages.length;
  useEffect(() => { if (messageCount) bottom.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }, [messageCount]);

  const current = state?.group;
  if (!current) return <div className="flex-1 min-h-0 p-4 sm:p-6 md:p-8"><div className="mx-auto max-w-[840px] space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-40 w-full" /></div></div>;

  const blocked = current.disbanded || Boolean(state?.unavailableMembers.length) || state?.driver.running !== true;
  const names = current.members.map((member) => member.name).join(', ');
  const status = current.disbanded ? 'Disbanded · history is read-only'
    : state?.unavailableMembers.length ? 'A member is unavailable'
    : state?.driver.running !== true ? 'Group worker unavailable'
    : state?.driver.blocked ? `${names} · waiting for a decision`
    : state?.driver.working ? `${names} · working…`
    : names;

  return (
    <div className="flex-1 min-h-0 flex flex-col h-full bg-transparent">
      <header className="flex items-center justify-between gap-3 px-4 md:px-6 h-[78px] min-h-[78px] sm:h-[84px] sm:min-h-[84px] shrink-0 border-b border-line bg-canvas select-none">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-accent-soft flex items-center justify-center text-accent shrink-0"><Users size={18} strokeWidth={1.9} /></div>
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold text-ink tracking-tight truncate">{current.name}</h1>
            <p className="text-[11px] font-medium text-muted truncate">{status}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" className={iconButton} title="Refresh conversation" aria-label="Refresh conversation" disabled={busy} onClick={() => { setError(''); void load(); }}>
            <RotateCcw size={16} strokeWidth={1.9} />
          </button>
          <button type="button" className={iconButton} title="Rename group" aria-label="Rename group" disabled={busy || current.disbanded} onClick={() => { setName(current.name); setRenaming(true); }}>
            <Pencil size={15} strokeWidth={1.9} />
          </button>
          <button type="button" className={iconButton} title="Stop group work" aria-label="Stop group work" disabled={busy || current.disbanded} onClick={() => void action(() => api(`/${groupId}/stop`, post({})))}>
            <Square size={14} strokeWidth={2.2} />
          </button>
          <ConfirmButton className={buttonClass} disabled={busy || current.disbanded} tone="danger" confirmLabel="Disband" drop="down"
            message="Disband this group and cancel its work? Its retained history remains readable under Hermes's retention policy."
            onConfirm={() => { void action(async () => { await api(`/${groupId}/disband`, post({ confirm: true })); }); }}>Disband</ConfirmButton>
        </div>
      </header>

      {renaming && (
        <div className="flex items-center gap-2 px-4 md:px-6 py-2 shrink-0 bg-panel border-b border-line">
          <input className={inputClass} value={name} autoFocus aria-label="Group name" onChange={(event) => setName(event.target.value)} />
          <button type="button" className={buttonClass} disabled={busy || !name.trim()}
            onClick={() => void action(async () => { await api(`/${groupId}/rename`, post({ name: name.trim(), requestId: requestId() })); setRenaming(false); })}>Save</button>
          <button type="button" className={buttonClass} onClick={() => setRenaming(false)}>Cancel</button>
        </div>
      )}

      <div className="hob-conversation flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pt-4 pb-2 bg-transparent">
        <div className={`w-full max-w-[840px] mx-auto flex flex-col min-h-full ${messageCount ? 'justify-start pt-4' : 'justify-center'}`}>
          {messageCount > 0 && (
            <div className="flex items-center justify-center my-4"><span className="text-[12px] font-medium text-muted">Today</span></div>
          )}

          {messageCount === 0 && (
            <section className="py-8 px-4 text-center max-w-xl mx-auto" aria-label={`${current.name} conversation`}>
              <div className="flex justify-center mb-5">
                <div className="w-20 h-20 rounded-full bg-surface flex items-center justify-center shadow-xs border border-line text-accent"><Users size={30} strokeWidth={1.6} /></div>
              </div>
              <h1 className="text-2xl md:text-3xl font-semibold text-ink tracking-tight leading-tight">{current.name}</h1>
              <p className="text-muted text-[15px] leading-relaxed my-4">One message goes to every member. Each one answers here under its own name when it has something to add.</p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {current.members.map((member) => (
                  <span key={member.profile} className="px-3 py-1.5 rounded-full bg-surface border border-hair text-[13px] font-medium text-ink">{member.name}</span>
                ))}
              </div>
            </section>
          )}

          {messages.map((message) => <ChatMessageItem key={message.id} message={message} />)}

          {state?.driver.working && (
            <div className="flex items-center gap-2.5 text-[13px] text-muted my-3 ml-2" role="status">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
              <span>{current.name} is working...</span>
            </div>
          )}

          {state?.actions.map((item) => (
            <ActionPrompt key={item.id} item={item} member={memberName(item.member)} busy={busy}
              onDecide={(choice) => void action(() => api(`/${groupId}/actions`, post({ id: item.id, choice, confirm: true })))} />
          ))}

          <div ref={bottom} className="h-1 shrink-0" />
        </div>
      </div>

      <div className="shrink-0 w-full px-3 sm:px-4 md:px-6 pt-2">
        <div className="mx-auto w-full max-w-[840px] space-y-2">
          {error && <Notice error>{error}</Notice>}
          {state?.unavailableMembers.length ? <Notice error>A member is unavailable, so new messages are paused. {state.unavailableMembers.join(', ')}.</Notice> : null}
          {uncertain && (
            <Notice>
              That message was not confirmed. Check the history before sending again.{' '}
              <button type="button" className="underline text-accent cursor-pointer" disabled={busy} onClick={() => { setUncertain(false); request.current = null; }}>I checked the history</button>
            </Notice>
          )}
        </div>
      </div>

      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSubmit={send}
        disabled={current.disbanded || uncertain}
        canSend={!busy && !blocked}
        placeholder={current.disbanded ? 'This group has been disbanded' : `Message ${current.name}...`}
        onAddContext={() => setActiveNav('library')}
        showMobileDock={false}
      />
    </div>
  );
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
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 md:p-8">
        <div className="mx-auto max-w-[840px] space-y-5">
          {error && <Notice error>{error}</Notice>}
          {!loaded ? <div className="space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-40 w-full" /></div>
            : <EmptyState title="No group selected" description="Create and pick groups in the Bots sidebar. Open one to join its shared conversation here." />}
          <p className="text-xs text-muted">Groups are managed beside your bots. <button className="underline text-accent cursor-pointer" onClick={() => setActiveNav('chat')}>Back to chat</button></p>
        </div>
      </div>
    );
  }
  return (
    <>
      {error && <div className="shrink-0 px-4 md:px-6 pt-3"><div className="mx-auto max-w-[840px]"><Notice error>{error}</Notice></div></div>}
      <GroupConversation key={current.id} groupId={current.id} />
    </>
  );
}
