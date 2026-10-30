import { Menu, MoreHorizontal } from 'lucide-react';
import { useChat } from '../context/ChatContext';

export function WorkspaceHeader() {
  const { activeNav, toggleLeftDrawer } = useChat();
  return <header className="hob-workspace-header">
    <button type="button" className="hob-round-button" aria-label="Open navigation" onClick={toggleLeftDrawer}><Menu size={22} strokeWidth={1.5} /></button>
    {activeNav === 'library' && <button type="button" className="hob-round-button" aria-label="Library options" onClick={() => window.dispatchEvent(new Event('hob:library-options'))}><MoreHorizontal size={25} /></button>}
  </header>;
}
