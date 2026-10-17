import React, { useState } from 'react';
import { useChat } from '../context/ChatContext';
import { Plus, Search, MessageSquare, X } from 'lucide-react';

export const ChatsDrawer: React.FC = () => {
  const {
    sessions,
    activeSessionId,
    selectSession,
    createNewSession,
    isLeftDrawerOpen,
    toggleLeftDrawer,
    isCreatingConversation,
  } = useChat();

  const [search, setSearch] = useState('');

  if (!isLeftDrawerOpen) return null;

  const filtered = sessions.filter((s) =>
    s.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity"
        onClick={toggleLeftDrawer}
      />

      {/* Drawer content */}
      <div className="relative w-80 max-w-full bg-[#13100e] border-r border-[#27211a] h-full flex flex-col z-50 shadow-2xl animate-in slide-in-from-left duration-200">
        {/* Header */}
        <div className="p-4 border-b border-[#241e18] flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <MessageSquare size={19} className="text-[#ff9e63]" />
            <h2 className="text-base font-semibold text-[#f2ebe2]">Conversations</h2>
          </div>
          <button
            onClick={toggleLeftDrawer}
            className="p-1.5 rounded-xl text-[#9f9282] hover:text-white hover:bg-[#231c16] transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* New chat button */}
        <div className="p-3.5">
          <button
            onClick={createNewSession}
            disabled={isCreatingConversation}
            className="w-full flex items-center justify-center space-x-2 py-2.5 px-4 bg-[#221b15] hover:bg-[#2e241d] text-[#f4eee5] text-sm font-medium rounded-xl border border-[#3b2f23] transition-colors cursor-pointer shadow-xs active:scale-[0.98]"
          >
            <Plus size={16} className="text-[#ff9e63]" />
            <span>New Chat</span>
          </button>
        </div>

        {/* Search */}
        <div className="px-3.5 pb-2.5">
          <div className="relative">
            <Search
              size={16}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#8e8272]"
            />
            <input
              type="text"
              placeholder="Search chats..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-[#191511] text-sm text-[#eee4d5] pl-10 pr-4 py-2.5 rounded-xl border border-[#2d251d] focus:outline-none focus:border-[#ff965c] placeholder-[#766c5f]"
            />
          </div>
        </div>

        {/* Sessions list */}
        <div className="flex-1 overflow-y-auto px-2.5 py-1.5 space-y-1">
          {filtered.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <button
                key={session.id}
                onClick={() => selectSession(session.id)}
                className={`w-full text-left p-3 rounded-xl transition-all flex flex-col space-y-1 cursor-pointer ${
                  isActive
                    ? 'bg-[#251e17] border border-[#443323] text-white shadow-xs'
                    : 'text-[#aaa092] hover:bg-[#1a1511] border border-transparent'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate text-[#eae1d4]">
                    {session.title}
                  </span>
                  <span className="text-xs text-[#736858] shrink-0">
                    {session.createdAt}
                  </span>
                </div>
                {session.lastMessageSnippet && (
                  <p className="text-xs text-[#958877] truncate">
                    {session.lastMessageSnippet}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
