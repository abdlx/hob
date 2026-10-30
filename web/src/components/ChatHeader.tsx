import { useEffect, useRef, useState } from 'react';
import { Menu, MoreHorizontal, PanelRight, Settings, Users, MessagesSquare, Plus, X } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { AgentAvatar } from './AgentAvatar';

export function ChatHeader({ onBackToBots, workspace = false }: { onBackToBots?: () => void; workspace?: boolean }) {
  const { toggleLeftDrawer, toggleRightPanel, isRightPanelOpen, agent, setActiveNav, activeNav, createNewSession } = useChat();
  const [menu, setMenu] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (menu) dialog.current?.showModal(); else dialog.current?.close(); }, [menu]);
  const action = (work: () => void) => { setMenu(false); work(); };
  return <>
    <header className={`hob-chat-header hob-reference-header ${workspace ? 'hob-workspace-profile' : ''}`}>
      <button className="hob-round-button hob-menu-button" aria-label="Open navigation" onClick={() => setMenu(true)}><Menu size={22} strokeWidth={1.5} /><i /></button>
      <button className="hob-profile-button" aria-label="Open agent details and activity" onClick={toggleRightPanel}>
        <AgentAvatar size={88} showEditBadge={false} avatarUrl={agent?.avatarUrl} hideBorder hideStatusDot />
        <span className="hob-profile-name"><span role="heading" aria-level={1}>{agent?.name || 'Main'}{agent?.tags?.slice(0, 2).map(tag => <small className="hob-bot-tag" key={tag}>{tag}</small>)}</span></span>
      </button>
      <button className="hob-round-button" aria-label={workspace ? activeNav === 'library' ? 'Library options' : 'More options' : 'Conversations'} title={workspace ? 'More options' : 'Conversations'} onClick={() => { if (workspace && activeNav === 'library') window.dispatchEvent(new Event('hob:library-options')); else if (workspace) setMenu(true); else toggleLeftDrawer(); }}><MoreHorizontal size={25} /></button>
      <button className="hob-desktop-panel-toggle hob-round-button" onClick={toggleRightPanel} aria-label={isRightPanelOpen ? 'Close agent panel' : 'Open agent panel'} aria-expanded={isRightPanelOpen}><PanelRight size={21} /></button>
    </header>
    <dialog ref={dialog} className="hob-navigation-sheet" aria-label="Navigation" onCancel={event => { event.preventDefault(); setMenu(false); }} onClick={event => { if (event.target === event.currentTarget) setMenu(false); }}>
      <div className="hob-sheet-heading"><h2>hob</h2><button className="hob-round-button" aria-label="Close navigation" onClick={() => setMenu(false)}><X size={22} /></button></div>
      <button onClick={() => action(() => { setActiveNav('chat'); if (onBackToBots) onBackToBots(); else window.dispatchEvent(new Event('hob:open-bots')); })}><Users />Bots</button>
      <button onClick={() => action(toggleLeftDrawer)}><MessagesSquare />Conversations</button>
      <button onClick={() => action(() => { setActiveNav('chat'); void createNewSession(); })}><Plus />New conversation</button>
      <button onClick={() => action(() => setActiveNav('settings'))}><Settings />Settings</button>
    </dialog>
  </>;
}
