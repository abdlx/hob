import { Menu, Plus, MoreHorizontal } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { AgentAvatar } from './AgentAvatar';

export function ChatHeader({ workspace = false }: { workspace?: boolean }) {
  const { toggleLeftDrawer, toggleRightPanel, isRightPanelOpen, agent, activeNav, createNewSession, isPreparing, isCreatingConversation } = useChat();
  return <header className={`hob-chat-header hob-reference-header ${workspace ? 'hob-workspace-profile' : ''}`}>
    <button className="hob-round-button hob-menu-button" aria-label="Open navigation" onClick={toggleLeftDrawer}><Menu size={22} strokeWidth={1.5} /><i /></button>
    <button className="hob-profile-button" aria-label="Open agent details and activity" aria-expanded={isRightPanelOpen} onClick={toggleRightPanel}>
      <AgentAvatar size={88} showEditBadge={false} avatarUrl={agent?.avatarUrl} hideBorder hideStatusDot />
      <span className="hob-profile-name"><span role="heading" aria-level={1}>{agent?.name || 'Main'}{agent?.tags?.slice(0, 2).map(tag => <small className="hob-bot-tag" key={tag}>{tag}</small>)}</span></span>
    </button>
    {workspace ? activeNav === 'library' && <button className="hob-round-button" aria-label="Library options" title="Library options" onClick={() => window.dispatchEvent(new Event('hob:library-options'))}><MoreHorizontal size={25} /></button> :
      <button className="hob-round-button" aria-label="New conversation" title="New conversation" disabled={isPreparing || isCreatingConversation} onClick={() => void createNewSession()}><Plus size={24} strokeWidth={1.7} /></button>}
  </header>;
}
