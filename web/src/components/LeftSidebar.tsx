import { Settings } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { Brand } from './Brand';
import { primaryNavigation, navigationSelected } from './navigation';

export function LeftSidebar() {
  const { activeNav, setActiveNav } = useChat();
  return <aside className="hob-sidebar flex w-[76px] flex-col items-center justify-between py-6 shrink-0 border-r border-line bg-canvas h-full" aria-label="Main navigation">
    <div className="mt-1"><Brand compact /></div>
    <nav className="flex-1 flex flex-col items-center justify-center gap-3.5 my-4" aria-label="Primary navigation">
      {primaryNavigation.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setActiveNav(id)} title={label} aria-label={label} aria-current={navigationSelected(activeNav, id) ? 'page' : undefined} className="hob-sidebar-nav-button"><Icon size={23} strokeWidth={1.8} /></button>)}
    </nav>
    <button onClick={() => setActiveNav('settings')} title="Settings" aria-label="Settings" aria-current={activeNav === 'settings' ? 'page' : undefined} className="hob-sidebar-nav-button mb-1"><Settings size={23} strokeWidth={1.8} /></button>
  </aside>;
}
