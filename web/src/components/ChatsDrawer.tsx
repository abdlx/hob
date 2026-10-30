import React, { useEffect, useRef, useState } from 'react';
import { conversationDate } from '../services/conversation-date';
import { apiFetch } from '../services/api';
import { useChat } from '../context/ChatContext';
import { Users, Search, MessageSquare, X, Pencil, Settings } from 'lucide-react';

export const ChatsDrawer: React.FC = () => {
  const {
    sessions,
    activeSessionId,
    selectSession,
    isLeftDrawerOpen,
    toggleLeftDrawer,
    refresh,
    setActiveNav,
    setBotsSidebarOpen,
  } = useChat();

  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ id: string; profile: string; title: string; revision: number } | null>(null);
  const [renameBusy, setRenameBusy] = useState(false), [renameError, setRenameError] = useState('');
  const drawer = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const close = useRef(toggleLeftDrawer);
  useEffect(() => { close.current = toggleLeftDrawer; }, [toggleLeftDrawer]);
  useEffect(() => {
    if (!isLeftDrawerOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchInput.current?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const targets = Array.from(drawer.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || []).filter(item => item.getClientRects().length);
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keys);
    return () => { document.removeEventListener('keydown', keys); opener?.focus(); };
  }, [isLeftDrawerOpen]);

  if (!isLeftDrawerOpen) return null;

  const filtered = sessions.filter((s) =>
    s.title.toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-xs transition-opacity"
        onClick={toggleLeftDrawer}
      />

      {/* Drawer content: full width on mobile, w-80 on sm+ */}
      <div ref={drawer} role="dialog" aria-modal="true" aria-label="Conversations" className="relative w-full sm:w-80 bg-canvas border-r border-hair h-full flex flex-col z-50 shadow-2xl animate-in slide-in-from-left duration-200">
        {/* Header */}
        <div className="p-4 border-b border-hair flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2.5">
            <MessageSquare size={19} className="text-accent" />
            <h2 className="text-base font-semibold text-ink">Conversations</h2>
          </div>
          <button
            onClick={toggleLeftDrawer}
            aria-label="Close conversations"
            className="p-1.5 rounded-full text-faint hover:text-ink hover:bg-neutral transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {editing && <div className="space-y-2 border-b border-hair p-3.5">
          <label className="block text-xs text-muted">Conversation title<input aria-label="Conversation title" className="mt-1 w-full rounded-xl border border-edge bg-surface p-2 text-base text-ink" value={editing.title} maxLength={500} disabled={renameBusy} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label>
          {renameError && <p role="alert" className="text-xs text-bad">{renameError}</p>}
          <div className="flex gap-2"><button type="button" disabled={renameBusy || !editing.title.trim()} className="rounded-xl bg-accent-soft px-3 py-2 text-xs text-accent disabled:opacity-40" onClick={async () => {
            setRenameBusy(true); setRenameError('');
            try { await apiFetch(`/api/sessions/${encodeURIComponent(editing.id)}/title`, { method: 'POST', headers: { 'X-Hob-Profile': editing.profile }, body: JSON.stringify({ title: editing.title.trim(), revision: editing.revision, requestId: crypto.randomUUID() }) }); setEditing(null); await refresh(); }
            catch (cause) { setRenameError(cause instanceof Error ? cause.message : 'Could not rename this conversation.'); }
            finally { setRenameBusy(false); }
          }}>Save title</button><button type="button" disabled={renameBusy} className="px-3 py-2 text-xs text-muted" onClick={() => setEditing(null)}>Cancel title edit</button></div>
        </div>}
        {renameError && !editing && <p role="alert" className="px-3.5 text-xs text-bad">{renameError}</p>}
        <div className="p-3.5 shrink-0"><button type="button" className="hob-sidebar-bots flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-base text-ink hover:bg-neutral" onClick={() => { toggleLeftDrawer(); setBotsSidebarOpen(true); setActiveNav('chat'); window.dispatchEvent(new Event('hob:open-bots')); }}><Users size={21} />Bots</button></div>

        {/* Search */}
        <div className="px-3.5 pb-2.5 shrink-0">
          <div className="relative flex items-center">
            <Search
              size={15}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint"
            />
            <input
              ref={searchInput}
              type="text"
              placeholder="Search chats..."
              aria-label="Search conversations"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-neutral text-sm text-ink pl-9.5 pr-4 py-2 rounded-full border border-transparent focus:outline-none placeholder-faint"
            />
          </div>
        </div>

        {/* Sessions list */}
        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-1.5 space-y-1">
          {filtered.length === 0 && <div className="px-4 py-10 text-center">
            <MessageSquare size={24} className="mx-auto mb-3 text-muted" />
            <p className="text-sm font-medium text-ink">{search.trim() ? 'No matching conversations' : 'No conversations yet'}</p>
            <p className="mt-2 text-xs text-muted">{search.trim() ? 'Try another title or clear your search.' : 'Start a new chat with this bot to begin.'}</p>
            {search && <button className="mt-3 text-xs text-accent cursor-pointer" onClick={() => setSearch('')}>Clear search</button>}
          </div>}
          {filtered.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <div key={session.id} className="relative">
              <button
                key={session.id}
                onClick={() => selectSession(session.id)}
                className={`w-full text-left p-3 pr-11 rounded-2xl transition-all flex flex-col space-y-1 cursor-pointer ${
                  isActive
                    ? 'bg-accent-soft text-code-strong shadow-xs'
                    : 'text-ink hover:bg-neutral'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate text-ink">
                    {session.title}
                  </span>
                  <time dateTime={Number.isNaN(Date.parse(session.createdAt)) ? undefined : session.createdAt} title={session.createdAt} className="text-xs text-faint shrink-0 max-w-[40%] truncate">{conversationDate(session.createdAt)}</time>
                </div>
                {session.lastMessageSnippet && (
                  <p className="text-xs text-muted truncate">
                    {session.lastMessageSnippet}
                  </p>
                )}
              </button>
              {!session.readOnly && session.transport === 'canonical' && <button type="button" aria-label={`Rename ${session.title}`} disabled={renameBusy} className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-hover cursor-pointer" onClick={async () => {
                setRenameBusy(true); setRenameError('');
                try { const result = await apiFetch<{ title: string; revision: number }>(`/api/sessions/${encodeURIComponent(session.id)}/title`, { headers: { 'X-Hob-Profile': session.agentId } }); setEditing({ id: session.id, profile: session.agentId, title: result.title || session.title, revision: result.revision }); }
                catch (cause) { setRenameError(cause instanceof Error ? cause.message : 'Could not open this title.'); }
                finally { setRenameBusy(false); }
              }}><Pencil size={14} /></button>}
              </div>
            );
          })}
        </div>
        <footer className="hob-conversation-sidebar-footer shrink-0 border-t border-hair p-3.5">
          <button type="button" onClick={() => { toggleLeftDrawer(); setActiveNav('settings'); }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm text-ink hover:bg-neutral">
            <Settings size={21} strokeWidth={1.8} />Settings
          </button>
        </footer>
      </div>
    </div>
  );
};
