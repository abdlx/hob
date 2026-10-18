import React from 'react';
import { MoreHorizontal, PanelRight, ChevronDown, ChevronLeft } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { DogeshAvatar } from './DogeshAvatar';

interface ChatHeaderProps {
  onBackToBots?: () => void;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({ onBackToBots }) => {
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
    <header className="hob-chat-header flex items-center justify-between px-4 md:px-6 h-[82px] min-h-[82px] border-b border-[rgba(25,35,50,0.07)] bg-[#FAFAFA] select-none shrink-0 relative">
      {/* ========================================================
          DESKTOP HEADER LAYOUT (hidden on mobile, flex on md+)
         ======================================================== */}
      <div className="hidden md:flex items-center gap-3">
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

      <div className="hidden md:flex items-center gap-2">
        {/* ... More button */}
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

      {/* ========================================================
          MOBILE HEADER LAYOUT (flex on mobile, hidden on md+)
         ======================================================== */}
      {/* Left: Back button to return to bots list */}
      <div className="md:hidden flex items-center">
        <button
          onClick={onBackToBots}
          className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-black/5 text-[#17191D] transition-colors cursor-pointer"
          aria-label="Back to bots"
          title="Back to bots"
        >
          <ChevronLeft size={24} strokeWidth={2.4} />
        </button>
      </div>

      {/* Middle: Oversized avatar + nametag whose top edge is slightly under avatar */}
      <div
        onClick={toggleRightPanel}
        className="md:hidden absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 flex flex-col items-center cursor-pointer group"
        role="button"
        tabIndex={0}
        aria-label="Open agent details and activity"
      >
        <div className="relative">
          <DogeshAvatar
            size={52}
            showEditBadge={false}
            avatarUrl={agent?.avatarUrl}
            status={connected && !isPreparing ? 'connected' : 'disconnected'}
            ringColor="ring-[#FAFAFA]"
          />
        </div>
        <div className="-mt-2.5 z-10 px-3 py-0.5 rounded-full bg-[#E5EEFB] border border-[#BBD5F8] text-[11px] font-semibold text-[#17202E] shadow-xs flex items-center gap-1 group-hover:bg-[#D5E5FA] transition-colors">
          <span>{agent?.name || 'Main'}</span>
          <span
            className={`w-1.5 h-1.5 rounded-full inline-block ${
              connected && !isPreparing ? 'bg-[#16CC8A]' : 'bg-[#8792A1]'
            }`}
          />
        </div>
      </div>

      {/* Right: More button */}
      <div className="md:hidden flex items-center gap-1">
        <button
          onClick={toggleLeftDrawer}
          className="w-10 h-10 rounded-full bg-[#F0F0F0] hover:bg-[#E5E5E5] text-[#253041] flex items-center justify-center transition-colors cursor-pointer"
          aria-label="Conversations"
          title="Conversations"
        >
          <MoreHorizontal size={18} strokeWidth={2} />
        </button>
      </div>
    </header>
  );
};
