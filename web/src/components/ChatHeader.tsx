import { Menu, PanelRight } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { Brand } from './Brand';

export function ChatHeader() {
  const { toggleLeftDrawer, toggleRightPanel, isRightPanelOpen, connected, isPreparing, isLoading, agents, agent, selectAgent } = useChat();
  return <header className="hob-chat-header">
    <button onClick={toggleLeftDrawer} className="hob-header-button" aria-label="Conversations" title="Conversations"><Menu size={18} /><span className="hidden sm:inline">Conversations</span></button>
    <Brand className="md:hidden" />
    <div className="flex items-center gap-3">
      {agents.length > 0 && <select aria-label="Active bot" className="rounded-lg border border-[#302a23] bg-[#111] px-2 py-1 text-xs text-[#d8c4a8]" value={agent?.id || ''} disabled={isPreparing || isLoading} onChange={event => void selectAgent(event.target.value)}>
        {!agent && <option value="">Select bot</option>}{agents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>}
      <span className="hob-connection"><span data-connected={connected && !isPreparing} />{isPreparing ? 'Preparing' : connected ? 'Connected' : 'Offline'}</span>
      <button onClick={toggleRightPanel} className="hob-header-button" aria-label={isRightPanelOpen ? 'Close agent panel' : 'Open agent panel'} aria-expanded={isRightPanelOpen} title="Agent panel"><PanelRight size={18} /></button>
    </div>
  </header>;
}
