import { MessageCircle, Newspaper, BookOpen, SquareCheck, Shapes, Settings, Users } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { BottomDock } from './BottomDock/BottomDock';
import type { DockItemConfig } from './BottomDock/types';

const items: DockItemConfig[] = [
  { id: 'chat', label: 'Chat', icon: <MessageCircle size={20} strokeWidth={2} /> },
  { id: 'feed', label: 'Feed', icon: <Newspaper size={20} strokeWidth={2} /> },
  { id: 'idea', label: 'Workshop', icon: <BookOpen size={20} strokeWidth={2} /> },
  { id: 'goals', label: 'Goals', icon: <SquareCheck size={20} strokeWidth={2} /> },
  { id: 'library', label: 'Library', icon: <Shapes size={20} strokeWidth={2} /> },
];

export function MobileDock() {
  const { activeNav, setActiveNav } = useChat();
  return <div className="md:hidden pt-2 pb-1 flex justify-center items-center gap-1">
    <BottomDock items={items} activeId={activeNav} onChange={setActiveNav} showSearch={false} />
    <button type="button" aria-label="Groups" onClick={() => setActiveNav('groups')} className={`rounded-full p-2.5 border border-[rgba(25,35,50,0.1)] shadow-xs transition-colors ${activeNav === 'groups' ? 'bg-[#E5EEFB] text-[#1677FF]' : 'bg-white text-[#253041]'}`}><Users size={17} /></button>
    <button type="button" aria-label="Settings" onClick={() => setActiveNav('settings')} className={`rounded-full p-2.5 border border-[rgba(25,35,50,0.1)] shadow-xs transition-colors ${activeNav === 'settings' ? 'bg-[#E5EEFB] text-[#1677FF]' : 'bg-white text-[#253041]'}`}><Settings size={17} /></button>
  </div>;
}
