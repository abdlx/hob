import React from 'react';
import { MoreHorizontal, PanelRight, ChevronDown } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { DogeshAvatar } from './DogeshAvatar';

export const ChatHeader: React.FC = () => {
  const {
    toggleLeftDrawer,
    toggleRightPanel,
    isRightPanelOpen,
    connected,
    isPreparing,
    agent,
    toggleBotsSidebar,
  } = useChat();

  return (
    <header className="hob-chat-header flex items-center justify-between px-6 h-[82px] min-h-[82px] border-b border-[rgba(25,35,50,0.07)] bg-[#FAFAFA] select-none shrink-0">
      {/* Left: Avatar + Agent Name dropdown + Connected status */}
      <div className="flex items-center gap-3">
        <DogeshAvatar
          size={40}
          showEditBadge={false}
          avatarUrl={agent?.avatarUrl}
          status={connected && !isPreparing ? 'connected' : 'disconnected'}
          ringColor="ring-[#FAFAFA]"
        />

        <div className="flex flex-col">
          <button
            onClick={toggleBotsSidebar}
            className="flex items-center gap-1.5 group text-left cursor-pointer"
            title="Switch bot"
            aria-label="Switch bot"
          >
            <h1 className="text-[16px] font-semibold text-[#17191D] tracking-tight leading-tight group-hover:text-[#1677FF] transition-colors">
              {agent?.name || 'Main'}
            </h1>
            <ChevronDown size={14} className="text-[#687588] group-hover:text-[#1677FF] transition-colors" />
          </button>

          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className={`w-2 h-2 rounded-full inline-block ${
                connected && !isPreparing ? 'bg-[#16CC8A]' : 'bg-[#8792A1]'
              }`}
            />
            <span className="text-[12px] font-medium text-[#687588]">
              {isPreparing ? 'Preparing' : connected ? 'Connected' : 'Offline'}
            </span>
          </div>
        </div>
      </div>

      {/* Right: 3 round action buttons */}
      <div className="flex items-center gap-2">
        {/* ... More button (toggles chats drawer) */}
        <button
          onClick={toggleLeftDrawer}
          className="w-10 h-10 rounded-full bg-[#F0F0F0] hover:bg-[#E5E5E5] text-[#253041] flex items-center justify-center transition-colors cursor-pointer"
          aria-label="Conversations"
          title="Conversations"
        >
          <MoreHorizontal size={18} strokeWidth={2} />
        </button>

        {/* Panel toggle button */}
        <button
          onClick={toggleRightPanel}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
            isRightPanelOpen
              ? 'bg-[#E5EEFB] text-[#1677FF]'
              : 'bg-[#F0F0F0] hover:bg-[#E5E5E5] text-[#253041]'
          }`}
          aria-label={isRightPanelOpen ? 'Close agent panel' : 'Open agent panel'}
          aria-expanded={isRightPanelOpen}
          title="Agent panel"
        >
          <PanelRight size={18} strokeWidth={1.8} />
        </button>

        {/* Chevron down button */}
        <button
          onClick={toggleBotsSidebar}
          className="w-10 h-10 rounded-full bg-[#F0F0F0] hover:bg-[#E5E5E5] text-[#253041] flex items-center justify-center transition-colors cursor-pointer"
          aria-label="Toggle bots"
          title="Toggle bots"
        >
          <ChevronDown size={18} strokeWidth={2} />
        </button>
      </div>
    </header>
  );
};
