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
    <header
      className="hob-chat-header flex items-center justify-between px-3.5 sm:px-4 md:px-6 h-[78px] min-h-[78px] sm:h-[84px] sm:min-h-[84px] bg-transparent select-none shrink-0 border-none border-b-0 absolute top-0 left-0 right-0 z-20 pointer-events-none md:relative md:pointer-events-auto"
      style={{ background: 'transparent', backgroundColor: 'transparent', border: 'none', borderBottom: 'none', boxShadow: 'none' }}
    >
      {/* ========================================================
          DESKTOP HEADER LAYOUT (hidden on mobile, flex on md+)
         ======================================================== */}
      <div className="hidden md:flex items-center gap-3 py-1.5 px-3.5 rounded-full bg-surface/90 backdrop-blur-md border border-[rgba(0,0,0,0.06)] shadow-[0_2px_10px_rgba(0,0,0,0.04)] pointer-events-auto">
        <DogeshAvatar
          size={38}
          showEditBadge={false}
          avatarUrl={agent?.avatarUrl}
          status={connected && !isPreparing ? 'connected' : 'disconnected'}
          ringColor="ring-white"
        />

        <div className="flex flex-col">
          <button
            onClick={toggleBotsSidebar}
            className="flex items-center gap-1.5 group text-left cursor-pointer"
            title="Switch bot"
            aria-label="Switch bot"
          >
            <h1 className="text-[15px] font-semibold text-ink tracking-tight leading-tight group-hover:text-accent transition-colors">
              {agent?.name || 'Main'}{agent?.tags?.slice(0, 2).map(tag => <span key={tag} className="ml-1.5 rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">{tag}</span>)}
            </h1>
            <ChevronDown size={13} className="text-muted group-hover:text-accent transition-colors" />
          </button>

          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className={`w-1.5 h-1.5 rounded-full inline-block ${
                connected && !isPreparing ? 'bg-ok-dot' : 'bg-faint'
              }`}
            />
            <span className="text-[11px] font-medium text-muted">
              {isPreparing ? 'Preparing' : connected ? 'Connected' : 'Offline'}
            </span>
          </div>
        </div>
      </div>

      <div className="hidden md:flex items-center gap-2 pointer-events-auto">
        {/* ... More button */}
        <button
          onClick={toggleLeftDrawer}
          className="w-10 h-10 rounded-full bg-surface/90 backdrop-blur-md border border-[rgba(0,0,0,0.06)] shadow-[0_2px_10px_rgba(0,0,0,0.04)] hover:bg-surface text-code flex items-center justify-center transition-all cursor-pointer active:scale-95"
          aria-label="Conversations"
          title="Conversations"
        >
          <MoreHorizontal size={18} strokeWidth={2} />
        </button>

        {/* Panel toggle button */}
        <button
          onClick={toggleRightPanel}
          className={`w-10 h-10 rounded-full backdrop-blur-md border border-[rgba(0,0,0,0.06)] shadow-[0_2px_10px_rgba(0,0,0,0.04)] flex items-center justify-center transition-all cursor-pointer active:scale-95 ${
            isRightPanelOpen
              ? 'bg-accent-soft text-accent border-accent-line'
              : 'bg-surface/90 hover:bg-surface text-code'
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
          className="w-10 h-10 rounded-full bg-surface/90 backdrop-blur-md border border-[rgba(0,0,0,0.06)] shadow-[0_2px_10px_rgba(0,0,0,0.04)] hover:bg-surface text-code flex items-center justify-center transition-all cursor-pointer active:scale-95"
          aria-label="Toggle bots"
          title="Toggle bots"
        >
          <ChevronDown size={18} strokeWidth={2} />
        </button>
      </div>

      {/* ========================================================
          MOBILE HEADER LAYOUT (flex on mobile, hidden on md+)
         ======================================================== */}
      {/* Left: Floating back button to return to bots list */}
      <div className="md:hidden flex items-center pointer-events-auto">
        <button
          onClick={onBackToBots}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-surface/95 backdrop-blur-md shadow-[0_4px_14px_rgba(0,0,0,0.06)] border border-[rgba(0,0,0,0.06)] text-ink hover:bg-surface active:scale-95 transition-all cursor-pointer"
          aria-label="Back to bots"
          title="Back to bots"
        >
          <ChevronLeft size={22} strokeWidth={2.4} />
        </button>
      </div>

      {/* Middle: Floating oversized avatar overlapping on top of nametag */}
      <div
        onClick={toggleRightPanel}
        className="md:hidden absolute left-1/2 -translate-x-1/2 top-[19px] flex flex-col items-center cursor-pointer group z-20 pointer-events-auto"
        role="button"
        tabIndex={0}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleRightPanel(); } }}
        aria-label="Open agent details and activity"
      >
        {/* Avatar is in FRONT (z-20) and top edge lines up with left & right buttons; external circle and status dot removed */}
        <div className="relative z-20">
          <DogeshAvatar
            size={62}
            showEditBadge={false}
            avatarUrl={agent?.avatarUrl}
            hideBorder={true}
            hideStatusDot={true}
          />
        </div>

        {/* Nametag sits underneath (z-10), moved down by 2px (-mt-[12px] instead of -mt-3.5) */}
        <div className="relative z-10 -mt-[12px] px-4 py-1 rounded-full bg-surface/95 backdrop-blur-md border border-[rgba(0,0,0,0.08)] text-[13px] font-semibold text-code-strong shadow-[0_4px_14px_rgba(0,0,0,0.06)] flex items-center gap-1.5 group-hover:bg-hover transition-all">
          <span>{agent?.name || 'Main'}{agent?.tags?.slice(0, 2).map(tag => <span key={tag} className="ml-1.5 rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">{tag}</span>)}</span>
          <span
            className={`w-2 h-2 rounded-full inline-block ${
              connected && !isPreparing ? 'bg-ok-dot' : 'bg-faint'
            }`}
          />
        </div>
      </div>

      {/* Right: Floating more button */}
      <div className="md:hidden flex items-center gap-1 pointer-events-auto">
        <button
          onClick={toggleLeftDrawer}
          className="w-10 h-10 rounded-full bg-surface/95 backdrop-blur-md shadow-[0_4px_14px_rgba(0,0,0,0.06)] border border-[rgba(0,0,0,0.06)] text-code hover:bg-surface flex items-center justify-center active:scale-95 transition-all cursor-pointer"
          aria-label="Conversations"
          title="Conversations"
        >
          <MoreHorizontal size={18} strokeWidth={2} />
        </button>
      </div>
    </header>
  );
};
