import { useEffect, useRef } from 'react';
import { ArrowUpRight, CalendarClock, FolderOpen, MessageCircle, MoonStar } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { ChatMessageItem } from './ChatMessageItem';

export function ChatMessageList() {
  const { messages, isLoading, agent, setActiveNav, isPreparing } = useChat();
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
    <div className={`w-full max-w-[820px] mx-auto flex flex-col min-h-full ${messages.length ? 'justify-start pt-6 md:pt-8' : 'justify-center'}`}>
      {messages.length === 0 && <section className="hob-welcome" aria-label="Welcome to hob">
        <div className="hob-welcome-mark"><img src="/brand/hob-mark.png" alt="hob, your helpful household spirit" width="104" height="104" /></div>
        <p className="hob-eyebrow"><MoonStar size={15} /> A LITTLE HELP. A LITTLE MORE LIFE.</p>
        <h1>Leave the little things<br />to <span>hob.</span></h1>
        <p className="hob-welcome-copy">A thoughtful companion for your everyday.<br className="hidden sm:block" /> Give it a task. Make space for everything else.</p>
        <div className="hob-shortcuts">{shortcuts.map(({ title, description, icon: Icon, action }) => <button key={title} onClick={action} disabled={isPreparing} className="hob-shortcut"><span className="flex justify-between items-center"><Icon size={22} strokeWidth={1.8} /><ArrowUpRight size={17} /></span><strong>{title}</strong><span>{description}</span></button>)}</div>
      </section>}
      {messages.map(message => <ChatMessageItem key={message.id} message={message} />)}
      {isLoading && messages.at(-1)?.role === 'user' && <div className="hob-thinking" role="status"><span />{agent?.name || 'hob'} is thinking...</div>}
      <div ref={bottomRef} className="h-1 shrink-0" />
    </div>
  </div>;
}
