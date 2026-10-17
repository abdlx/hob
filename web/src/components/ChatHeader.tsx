import { Menu, PanelRight, Bot } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { Brand } from './Brand';

export function ChatHeader() {
  const { toggleLeftDrawer, toggleRightPanel, isRightPanelOpen, connected, isPreparing, agent, isBotsSidebarOpen, toggleBotsSidebar } = useChat();
  return <header className="hob-chat-header">
    <div className="flex items-center gap-2">
      <button onClick={toggleLeftDrawer} className="hob-header-button" aria-label="Conversations" title="Conversations">
        <Menu size={20} />
        <span className="hidden sm:inline font-medium">Conversations</span>
      </button>
      {!isBotsSidebarOpen && (
        <button
          onClick={toggleBotsSidebar}
          className="hob-header-button text-xs md:text-sm font-medium flex items-center gap-2 px-3 py-1.5 rounded-xl border border-[#382c20] bg-[#1a1510] text-[#eee4d5] hover:bg-[#251e16] hover:border-[#ff965c]/40 transition-colors cursor-pointer"
          aria-label="Open bots list"
          title="Open bots list"
        >
          <Bot size={16} className="text-[#ff965c]" />
          <span className="hidden sm:inline">{agent?.name || 'Bots'}</span>
        </button>
      )}
    </div>
    <Brand className="md:hidden" />
    <div className="flex items-center gap-3.5">
      <span className="hob-connection font-medium">
        <span data-connected={connected && !isPreparing} />
        {isPreparing ? 'Preparing' : connected ? 'Connected' : 'Offline'}
      </span>
      <button
        onClick={toggleRightPanel}
        className="hob-header-button"
        aria-label={isRightPanelOpen ? 'Close agent panel' : 'Open agent panel'}
        aria-expanded={isRightPanelOpen}
        title="Agent panel"
      >
        <PanelRight size={20} />
      </button>
    </div>
  </header>;
}
