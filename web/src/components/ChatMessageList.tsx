import { Fragment, useState } from 'react';
import { ArrowDown, ArrowUpRight, CalendarClock, Check, FolderOpen, MessageCircle, MoonStar, ShieldAlert, X } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { ChatMessageItem } from './ChatMessageItem';
import { HermesRunPanel } from './HermesRunPanel';
import { useBotExchanges } from '../hooks/useBotExchanges';
import { BotExchangeHistory, BotExchangeNotice } from './BotExchanges';
import { useRuntime } from '../context/RuntimeContext';
import { errorText } from './workspaceUtils';
import type { SecurityApproval } from '../types/chat';
import { useConversationScroll } from '../hooks/useConversationScroll';

function InlineApprovalPrompt() {
  const { approvals, resolveApproval } = useChat();
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (!pending.length) return null;

  const decide = async (approval: SecurityApproval, decision: 'approved' | 'rejected') => {
    setBusyId(approval.id);
    setError('');
    try {
      await resolveApproval(approval.id, decision);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="hob-chat-prompt my-3 max-w-[88%] rounded-2xl bg-surface border border-hair shadow-sm p-4 text-sm"
      role="dialog"
      aria-label="Permission request"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">Permission needed</p>
          <p className="mt-1 leading-relaxed text-muted">
            The agent is waiting for your approval before continuing.
          </p>
        </div>
      </div>
      {error && (
        <p className="mt-3 rounded-xl bg-red-50 p-2.5 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
      <div className="mt-3 space-y-3">
        {pending.map((approval) => (
          <div key={approval.id} className="rounded-xl bg-panel border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                {approval.type}
              </span>
              <span className="text-[10px] font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                Pending
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink">{approval.description}</p>
            {approval.commandSnippet && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code-soft p-2.5 font-mono text-[11px] text-ink">
                {approval.commandSnippet}
              </pre>
            )}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent hover:bg-accent-strong px-3 py-2 text-xs font-semibold text-white transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
                disabled={busyId !== null}
                onClick={() => void decide(approval, 'approved')}
              >
                <Check size={13} />
                Allow once
              </button>
              <button
                type="button"
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-neutral hover:bg-neutral-strong px-3 py-2 text-xs font-medium text-ink transition-colors disabled:opacity-50 cursor-pointer"
                disabled={busyId !== null}
                onClick={() => void decide(approval, 'rejected')}
              >
                <X size={13} />
                Deny
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChatMessageList() {
  const { messages, isLoading, agent, setActiveNav, isPreparing, activeSessionId } = useChat();
  const runtime = useRuntime();
  const exchanges = useBotExchanges(agent?.id, activeSessionId, runtime === 'hermes');
  const visibleMessages = messages.filter((message) => message.content.trim());
  const timeline = [
    ...visibleMessages.map(message => ({ id: message.id, at: Date.parse(message.timestamp) || 0, node: <ChatMessageItem message={message} /> })),
    ...exchanges.rows.map(exchange => ({ id: exchange.id, at: exchange.createdAt, node: <BotExchangeNotice exchange={exchange} profile={agent!.id} /> })),
  ].sort((left, right) => left.at - right.at);
  const day = (at: number) => at ? new Date(at).toLocaleDateString() : '';
  const submission = messages.findLast(message => message.role === 'user' && message.status === 'sending')?.id;
  const { viewport: viewportRef, content: contentRef, onScroll, away, latest } = useConversationScroll(activeSessionId, messages, submission);

  const shortcuts = [
    {
      title: 'Make a little room',
      description: 'Talk through what needs doing.',
      icon: MessageCircle,
      action: () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
    },
    {
      title: 'Put it on autopilot',
      description: 'Schedule a task for later.',
      icon: CalendarClock,
      action: () => setActiveNav('goals'),
    },
    {
      title: 'See what is taking shape',
      description: 'Browse your agent files.',
      icon: FolderOpen,
      action: () => setActiveNav('library'),
    },
  ];

  return (
    <div className="relative flex-1 min-h-0">
    <div ref={viewportRef} onScroll={onScroll} role="region" aria-label="Conversation messages" tabIndex={0} className="hob-conversation h-full min-h-0 overflow-y-auto overscroll-contain px-4 md:px-6 pb-10 bg-transparent [overflow-anchor:none]">
      <div
        ref={contentRef}
        className={`w-full max-w-[840px] mx-auto flex flex-col min-h-full ${
          visibleMessages.length || exchanges.rows.length ? 'justify-start pt-[88px] md:pt-[94px]' : 'justify-center pt-[88px] md:pt-[94px]'
        }`}
      >
        {visibleMessages.length === 0 && exchanges.rows.length === 0 && (
          <section className="hob-welcome py-8 px-4 text-center max-w-xl mx-auto" aria-label="Welcome to hob">
            <div className="hob-welcome-mark flex justify-center mb-5">
              <div className="w-20 h-20 rounded-full bg-surface flex items-center justify-center shadow-xs border border-line p-3">
                <img src="/brand/hob-mark.png" alt="hob" className="w-full h-full object-contain" />
              </div>
            </div>
            <p className="hob-eyebrow flex items-center justify-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted mb-3">
              <MoonStar size={14} className="text-accent" /> A LITTLE HELP. A LITTLE MORE LIFE.
            </p>
            <h1 className="text-3xl md:text-4xl font-semibold text-ink tracking-tight leading-tight">
              Leave the little things<br />to <span className="text-accent">hob.</span>
            </h1>
            <p className="hob-welcome-copy text-muted text-[15px] leading-relaxed my-4">
              A thoughtful companion for your everyday.<br className="hidden sm:block" /> Give it a task. Make space for everything else.
            </p>
            <div className="hob-shortcuts grid grid-cols-1 sm:grid-cols-3 gap-3.5 mt-6 text-left">
              {shortcuts.map(({ title, description, icon: Icon, action }) => (
                <button
                  key={title}
                  onClick={action}
                  disabled={isPreparing}
                  className="p-4 rounded-2xl bg-surface border border-hair hover:border-accent/40 hover:shadow-xs transition-all cursor-pointer flex flex-col justify-between min-h-[130px]"
                >
                  <span className="flex justify-between items-center text-accent mb-3">
                    <Icon size={20} strokeWidth={1.8} />
                    <ArrowUpRight size={16} className="text-faint" />
                  </span>
                  <div>
                    <strong className="block text-[13.5px] font-semibold text-ink mb-0.5">
                      {title}
                    </strong>
                    <span className="text-[12px] text-muted leading-snug block">
                      {description}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {runtime === 'hermes' && agent && <BotExchangeHistory key={agent.id} profile={agent.id} />}
        {exchanges.earlier && <p className="mb-2 text-center text-xs text-muted">Showing the latest 100 exchanges. Earlier exchanges are in Bot exchange history.</p>}
        {exchanges.error && <p className="my-2 text-xs text-red-600" role="alert">Bot exchanges: {exchanges.error}</p>}
        {timeline.map((item, index) => <Fragment key={item.id}>
          {day(item.at) && (index === 0 || day(timeline[index - 1].at) !== day(item.at)) && <div className="my-4 text-center text-xs text-muted">{new Date(item.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>}
          {item.node}
        </Fragment>)}

        <InlineApprovalPrompt />

        {runtime === 'hermes' && activeSessionId && (
          <HermesRunPanel key={`inline-controls:${activeSessionId}`} sessionId={activeSessionId} inline />
        )}

        {isLoading && visibleMessages.at(-1)?.role === 'user' && (
          <div className="flex items-center gap-2.5 text-[13px] text-muted my-3 ml-2" role="status">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span>{agent?.name || 'hob'} is thinking...</span>
          </div>
        )}

        <div className="h-1 shrink-0" />
      </div>
    </div>
    {away && <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center"><button type="button" onClick={latest} className="pointer-events-auto inline-flex min-h-10 items-center gap-2 rounded-full border border-edge bg-surface px-4 text-xs font-medium text-ink shadow-md hover:bg-hover cursor-pointer"><ArrowDown size={15} />Latest messages</button></div>}
    </div>
  );
}
