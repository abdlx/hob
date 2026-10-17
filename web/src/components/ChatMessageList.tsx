import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CalendarClock, Check, FolderOpen, MessageCircle, MoonStar, ShieldAlert, X } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { ChatMessageItem } from './ChatMessageItem';
import { HermesRunPanel } from './HermesRunPanel';
import { useRuntime } from '../context/RuntimeContext';
import { errorText } from './workspaceUtils';
import type { SecurityApproval } from '../types/chat';

function InlineApprovalPrompt() {
  const { approvals, resolveApproval } = useChat();
  const pending = approvals.filter(approval => approval.status === 'pending');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  if (!pending.length) return null;
  const decide = async (approval: SecurityApproval, decision: 'approved' | 'rejected') => {
    setBusyId(approval.id); setError('');
    try { await resolveApproval(approval.id, decision); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusyId(null); }
  };
  return <div className="hob-chat-prompt my-3 max-w-[88%] rounded-2xl bg-[#171d24] p-4 text-sm" role="dialog" aria-label="Permission request">
    <div className="flex items-start gap-3">
      <ShieldAlert size={18} className="mt-0.5 shrink-0 text-[#d9dee4]" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-[#eef1f4]">Permission needed</p>
        <p className="mt-1 leading-relaxed text-[#b6c0ca]">The agent is waiting for your approval before continuing.</p>
      </div>
    </div>
    {error && <p className="mt-3 rounded-lg bg-[#2b2224] p-2 text-xs text-[#f0caca]" role="alert">{error}</p>}
    <div className="mt-3 space-y-3">
      {pending.map(approval => <div key={approval.id} className="rounded-xl bg-[#11161c] p-3">
        <div className="flex items-center justify-between gap-2"><span className="text-[10px] font-semibold uppercase tracking-wider text-[#9ea9b4]">{approval.type}</span><span className="text-[10px] text-[#8f9aa5]">Pending</span></div>
        <p className="mt-2 text-xs leading-relaxed text-[#d5dbe1]">{approval.description}</p>
        {approval.commandSnippet && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#0b0f14] p-2.5 font-mono text-[11px] text-[#cbd2d9]">{approval.commandSnippet}</pre>}
        <div className="mt-3 flex gap-2">
          <button type="button" className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#d9dee4] px-3 py-2 text-xs font-semibold text-[#13181e] hover:bg-white disabled:opacity-50" disabled={busyId !== null} onClick={() => void decide(approval, 'approved')}><Check size={13} />Allow once</button>
          <button type="button" className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#252c34] px-3 py-2 text-xs font-medium text-[#d3dae1] hover:bg-[#303943] disabled:opacity-50" disabled={busyId !== null} onClick={() => void decide(approval, 'rejected')}><X size={13} />Deny</button>
        </div>
      </div>)}
    </div>
  </div>;
}

export function ChatMessageList() {
  const { messages, isLoading, agent, setActiveNav, isPreparing, activeSessionId } = useChat();
  const runtime = useRuntime();
  const visibleMessages = messages.filter(message => message.content.trim());
  const bottomRef = useRef<HTMLDivElement>(null);
  const initial = useRef(true);
  useEffect(() => {
    if (initial.current) { initial.current = false; return; }
    if (messages.length) bottomRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [messages, isLoading]);
  const shortcuts = [
    { title: 'Make a little room', description: 'Talk through what needs doing.', icon: MessageCircle, action: () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus() },
    { title: 'Put it on autopilot', description: 'Schedule a task for later.', icon: CalendarClock, action: () => setActiveNav('goals') },
    { title: 'See what is taking shape', description: 'Browse your agent files.', icon: FolderOpen, action: () => setActiveNav('library') },
  ];
  return <div className="hob-conversation flex-1 overflow-y-auto px-4 md:px-6 pb-4">
    <div className={`w-full max-w-[820px] mx-auto flex flex-col min-h-full ${visibleMessages.length ? 'justify-start pt-6 md:pt-8' : 'justify-center'}`}>
      {visibleMessages.length === 0 && <section className="hob-welcome" aria-label="Welcome to hob">
        <div className="hob-welcome-mark"><img src="/brand/hob-mark.png" alt="hob, your helpful household spirit" width="104" height="104" /></div>
        <p className="hob-eyebrow"><MoonStar size={15} /> A LITTLE HELP. A LITTLE MORE LIFE.</p>
        <h1>Leave the little things<br />to <span>hob.</span></h1>
        <p className="hob-welcome-copy">A thoughtful companion for your everyday.<br className="hidden sm:block" /> Give it a task. Make space for everything else.</p>
        <div className="hob-shortcuts">{shortcuts.map(({ title, description, icon: Icon, action }) => <button key={title} onClick={action} disabled={isPreparing} className="hob-shortcut"><span className="flex justify-between items-center"><Icon size={22} strokeWidth={1.8} /><ArrowUpRight size={17} /></span><strong>{title}</strong><span>{description}</span></button>)}</div>
      </section>}
      {visibleMessages.map(message => <ChatMessageItem key={message.id} message={message} />)}
      <InlineApprovalPrompt />
      {runtime === 'hermes' && activeSessionId && <HermesRunPanel key={`inline-controls:${activeSessionId}`} sessionId={activeSessionId} inline />}
      {isLoading && visibleMessages.at(-1)?.role === 'user' && <div className="hob-thinking" role="status"><span />{agent?.name || 'hob'} is thinking...</div>}
      <div ref={bottomRef} className="h-1 shrink-0" />
    </div>
  </div>;
}
