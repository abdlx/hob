import React from 'react';
import { useChat } from '../context/ChatContext';
import { Menu, Gift } from 'lucide-react';
import { DogeshAvatar } from './DogeshAvatar';

export const ChatHeader: React.FC = () => {
  const { toggleLeftDrawer, toggleRightPanel, isRightPanelOpen, agent } = useChat();

  return (
    <header className="absolute top-0 left-0 right-0 z-20 pointer-events-none h-[78px] select-none">
      {/* Very light gradual blur backdrop: mostly transparent, fading to transparent at the bottom */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backdropFilter: 'blur(5px)',
          WebkitBackdropFilter: 'blur(5px)',
          background:
            'linear-gradient(to bottom, rgba(0, 0, 0, 0.35) 0%, rgba(0, 0, 0, 0.08) 55%, transparent 100%)',
          maskImage:
            'linear-gradient(to bottom, rgba(0, 0, 0, 0.8) 0%, rgba(0, 0, 0, 0.3) 50%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, rgba(0, 0, 0, 0.8) 0%, rgba(0, 0, 0, 0.3) 50%, transparent 100%)',
        }}
      />

      {/* Button controls & center avatar row */}
      <div className="relative z-10 px-3 pt-3 flex items-center justify-between">
        {/* Left button: = Chats */}
        <div className="pointer-events-auto">
          <button
            onClick={toggleLeftDrawer}
            title="Chats"
            className="flex items-center justify-center p-2 md:px-3.5 md:py-1.5 md:space-x-2 rounded-full bg-[#161616] hover:bg-[#202020] text-white border border-[#262626] transition-colors text-xs font-medium cursor-pointer shadow-xs"
          >
            <Menu size={13} className="text-white" strokeWidth={2.2} />
            <span className="hidden md:inline">Chats</span>
          </button>
        </div>

        {/* Center: Dogesh Avatar & Name Tag */}
        <div className="pointer-events-auto absolute left-1/2 -translate-x-1/2 top-3 flex flex-col items-center">
          <button
            onClick={toggleRightPanel}
            title={isRightPanelOpen ? 'Close agent panel' : 'Open agent panel'}
            className="flex flex-col items-center cursor-pointer group focus:outline-none transition-transform active:scale-95"
          >
            <div className="relative z-10">
              <DogeshAvatar size={46} showEditBadge={false} avatarUrl={agent?.avatarUrl} />
            </div>
            <span className="relative z-0 -mt-3 h-[27px] px-2.5 inline-flex items-center justify-center rounded-full bg-[#181818] group-hover:bg-[#222222] text-white text-[12px] font-medium tracking-tight shadow-xs border border-[#282828] transition-colors leading-none text-center">
              {agent?.name || 'OpenClaw'}
            </span>
          </button>
        </div>

        {/* Right button: Invite */}
        <div className="pointer-events-auto">
          <button
            onClick={() => {
              navigator.clipboard?.writeText(window.location.href);
              alert('Session link copied to clipboard!');
            }}
            className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-full bg-[#161616] hover:bg-[#202020] text-white border border-[#262626] transition-colors text-xs font-medium cursor-pointer shadow-xs"
          >
            <Gift size={13} className="text-white" strokeWidth={2} />
            <span>Invite</span>
          </button>
        </div>
      </div>
    </header>
  );
};
