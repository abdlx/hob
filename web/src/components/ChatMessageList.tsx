import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CalendarClock, Check, FolderOpen, MessageCircle, MoonStar, ShieldAlert, X } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { ChatMessageItem } from './ChatMessageItem';
import { HermesRunPanel } from './HermesRunPanel';
import { useRuntime } from '../context/RuntimeContext';
import { errorText } from './workspaceUtils';
import type { SecurityApproval } from '../types/chat';
import { HLogo } from './HLogo';

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
      className="hob-chat-prompt my-3 max-w-[88%] rounded-2xl bg-white border border-[rgba(25,35,50,0.08)] shadow-sm p-4 text-sm"
      role="dialog"
      aria-label="Permission request"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-[#1677FF]" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[#17191D]">Permission needed</p>
          <p className="mt-1 leading-relaxed text-[#687588]">
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
          <div key={approval.id} className="rounded-xl bg-[#F8F9FA] border border-[rgba(25,35,50,0.06)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#687588]">
                {approval.type}
              </span>
              <span className="text-[10px] font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                Pending
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[#17191D]">{approval.description}</p>
            {approval.commandSnippet && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#F0F2F5] p-2.5 font-mono text-[11px] text-[#17191D]">
                {approval.commandSnippet}
              </pre>
            )}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#1677FF] hover:bg-[#0D6CE5] px-3 py-2 text-xs font-semibold text-white transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
                disabled={busyId !== null}
                onClick={() => void decide(approval, 'approved')}
              >
                <Check size={13} />
                Allow once
              </button>
              <button
                type="button"
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#F0F0F0] hover:bg-[#E5E5E5] px-3 py-2 text-xs font-medium text-[#17191D] transition-colors disabled:opacity-50 cursor-pointer"
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
  const visibleMessages = messages.filter((message) => message.content.trim());
  const bottomRef = useRef<HTMLDivElement>(null);
  const initial = useRef(true);

  useEffect(() => {
    if (initial.current) {
      initial.current = false;
      return;
    }
    if (messages.length) {
      bottomRef.current?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
    }
  }, [messages, isLoading]);

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
    <div className="hob-conversation flex-1 overflow-y-auto px-4 md:px-6 pb-4 bg-[#FAFAFA]">
      <div
        className={`w-full max-w-[840px] mx-auto flex flex-col min-h-full ${
          visibleMessages.length ? 'justify-start pt-4' : 'justify-center'
        }`}
      >
        {/* Date separator at top of conversation */}
        {visibleMessages.length > 0 && (
          <div className="flex items-center justify-center my-4">
            <span className="text-[12px] font-medium text-[#687588]">Today</span>
          </div>
        )}

        {visibleMessages.length === 0 && (
          <section className="hob-welcome py-8 px-4 text-center max-w-xl mx-auto" aria-label="Welcome to hob">
            <div className="hob-welcome-mark flex justify-center mb-5">
              <div className="w-20 h-20 rounded-full bg-[#DDE3EA] flex items-center justify-center shadow-xs">
                <HLogo size={40} color="#17191D" />
              </div>
            </div>
            <p className="hob-eyebrow flex items-center justify-center gap-1.5 text-[11px] font-semibold tracking-wider text-[#687588] mb-3">
              <MoonStar size={14} className="text-[#1677FF]" /> A LITTLE HELP. A LITTLE MORE LIFE.
            </p>
            <h1 className="text-3xl md:text-4xl font-semibold text-[#17191D] tracking-tight leading-tight">
              Leave the little things<br />to <span className="text-[#1677FF]">hob.</span>
            </h1>
            <p className="hob-welcome-copy text-[#687588] text-[15px] leading-relaxed my-4">
              A thoughtful companion for your everyday.<br className="hidden sm:block" /> Give it a task. Make space for everything else.
            </p>
            <div className="hob-shortcuts grid grid-cols-1 sm:grid-cols-3 gap-3.5 mt-6 text-left">
              {shortcuts.map(({ title, description, icon: Icon, action }) => (
                <button
                  key={title}
                  onClick={action}
                  disabled={isPreparing}
                  className="p-4 rounded-2xl bg-white border border-[rgba(25,35,50,0.08)] hover:border-[#1677FF]/40 hover:shadow-xs transition-all cursor-pointer flex flex-col justify-between min-h-[130px]"
                >
                  <span className="flex justify-between items-center text-[#1677FF] mb-3">
                    <Icon size={20} strokeWidth={1.8} />
                    <ArrowUpRight size={16} className="text-[#8792A1]" />
                  </span>
                  <div>
                    <strong className="block text-[13.5px] font-semibold text-[#17191D] mb-0.5">
                      {title}
                    </strong>
                    <span className="text-[12px] text-[#687588] leading-snug block">
                      {description}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {visibleMessages.map((message) => (
          <ChatMessageItem key={message.id} message={message} />
        ))}

        <InlineApprovalPrompt />

        {runtime === 'hermes' && activeSessionId && (
          <HermesRunPanel key={`inline-controls:${activeSessionId}`} sessionId={activeSessionId} inline />
        )}

        {isLoading && visibleMessages.at(-1)?.role === 'user' && (
          <div className="flex items-center gap-2.5 text-[13px] text-[#687588] my-3 ml-2" role="status">
            <span className="w-2 h-2 rounded-full bg-[#1677FF] animate-pulse" />
            <span>{agent?.name || 'hob'} is thinking...</span>
          </div>
        )}

        <div ref={bottomRef} className="h-1 shrink-0" />
      </div>
    </div>
  );
}
