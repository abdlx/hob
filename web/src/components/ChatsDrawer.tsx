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
      <div className="relative w-72 max-w-full bg-black border-r border-[#161616] h-full flex flex-col z-50 shadow-2xl animate-in slide-in-from-left duration-200">
        {/* Header */}
        <div className="p-4 border-b border-[#161616] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <MessageSquare size={17} className="text-white" />
            <h2 className="text-sm font-semibold text-[#dedcd8]">Conversations</h2>
          </div>
          <button
            onClick={toggleLeftDrawer}
            className="p-1.5 rounded-full text-white hover:bg-[#161616] transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* New chat button */}
        <div className="p-3">
          <button
            onClick={createNewSession}
            className="w-full flex items-center justify-center space-x-2 py-2 px-4 bg-[#161616] hover:bg-[#222222] text-white text-sm font-medium rounded-full border border-[#262626] transition-colors cursor-pointer"
          >
            <Plus size={15} className="text-white" />
            <span>New Chat</span>
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white"
            />
            <input
              type="text"
              placeholder="Search chats..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-[#121212] text-xs text-[#dedcd8] pl-9 pr-3.5 py-2 rounded-full border border-[#222222] focus:outline-none focus:border-[#383838] placeholder-[#6b6965]"
            />
          </div>
        </div>

        {/* Sessions list */}
        <div className="flex-1 overflow-y-auto px-2 py-1 space-y-1">
          {filtered.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <button
                key={session.id}
                onClick={() => selectSession(session.id)}
                className={`w-full text-left p-2.5 rounded-xl transition-colors flex flex-col space-y-1 cursor-pointer ${
                  isActive
                    ? 'bg-[#181818] border border-[#282828] text-white'
                    : 'text-[#a09e99] hover:bg-[#121212] border border-transparent'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium truncate">
                    {session.title}
                  </span>
                  <span className="text-[10px] text-[#6b6965]">
                    {session.createdAt}
                  </span>
                </div>
                {session.lastMessageSnippet && (
                  <p className="text-[11px] text-[#706e69] truncate">
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
