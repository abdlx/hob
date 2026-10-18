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
        className="fixed inset-0 bg-black/30 backdrop-blur-xs transition-opacity"
        onClick={toggleLeftDrawer}
      />

      {/* Drawer content: full width on mobile, w-80 on sm+ */}
      <div className="relative w-full sm:w-80 bg-[#FAFAFA] border-r border-[rgba(25,35,50,0.08)] h-full flex flex-col z-50 shadow-2xl animate-in slide-in-from-left duration-200">
        {/* Header */}
        <div className="p-4 border-b border-[rgba(25,35,50,0.08)] flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <MessageSquare size={19} className="text-[#1677FF]" />
            <h2 className="text-base font-semibold text-[#17191D]">Conversations</h2>
          </div>
          <button
            onClick={toggleLeftDrawer}
            className="p-1.5 rounded-full text-[#8792A1] hover:text-[#17191D] hover:bg-[#F0F0F0] transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* New chat button */}
        <div className="p-3.5">
          <button
            onClick={createNewSession}
            disabled={isCreatingConversation}
            className="w-full flex items-center justify-center space-x-2 py-2.5 px-4 bg-[#1677FF] hover:bg-[#0D6CE5] text-white text-sm font-semibold rounded-full transition-colors cursor-pointer shadow-xs active:scale-[0.98]"
          >
            <Plus size={16} strokeWidth={2.2} />
            <span>New Chat</span>
          </button>
        </div>

        {/* Search */}
        <div className="px-3.5 pb-2.5">
          <div className="relative flex items-center">
            <Search
              size={15}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#8792A1]"
            />
            <input
              type="text"
              placeholder="Search chats..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-[#F0F0F0] text-sm text-[#17191D] pl-9.5 pr-4 py-2 rounded-full border border-transparent focus:outline-none focus:border-[#1677FF]/40 placeholder-[#8792A1]"
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
                className={`w-full text-left p-3 rounded-2xl transition-all flex flex-col space-y-1 cursor-pointer ${
                  isActive
                    ? 'bg-[#E5EEFB] text-[#17202E] shadow-xs'
                    : 'text-[#17191D] hover:bg-[#F0F0F0]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate text-[#17191D]">
                    {session.title}
                  </span>
                  <span className="text-xs text-[#8792A1] shrink-0">
                    {session.createdAt}
                  </span>
                </div>
                {session.lastMessageSnippet && (
                  <p className="text-xs text-[#687588] truncate">
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
