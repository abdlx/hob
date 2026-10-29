import React from 'react';
import { Bot, Compass, BookOpen, SquareCheck, Shapes } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { BottomDock } from './BottomDock/BottomDock';
import type { DockItemConfig } from './BottomDock/types';

interface MobileDockProps {
  currentMobileView?: 'bots' | 'chat';
  onNavigateBots?: () => void;
  onOpenActivity?: () => void;
  onNavigate?: () => void;
}

const items: DockItemConfig[] = [
  { id: 'bots', label: 'Bots', icon: <Bot size={20} strokeWidth={2} /> },
  { id: 'activity', label: 'Activity', icon: <Compass size={20} strokeWidth={2} /> },
  { id: 'idea', label: 'Workshop', icon: <BookOpen size={20} strokeWidth={2} /> },
  { id: 'goals', label: 'Goals', icon: <SquareCheck size={20} strokeWidth={2} /> },
  { id: 'library', label: 'Library', icon: <Shapes size={20} strokeWidth={2} /> },
];

export const MobileDock: React.FC<MobileDockProps> = ({
  onNavigateBots,
  onOpenActivity,
  onNavigate,
}) => {
  const { activeNav, setActiveNav } = useChat();

  const handleDockChange = (id: string) => {
    onNavigate?.();
    if (id === 'bots') {
      if (onNavigateBots) onNavigateBots();
      setActiveNav('chat');
    } else if (id === 'activity') {
      setActiveNav('activity');
      if (onOpenActivity) onOpenActivity();
    } else {
      setActiveNav(id);
    }
  };

  const activeId = items.some(item => item.id === activeNav)
    ? activeNav
    : ['chat', 'search', 'groups'].includes(activeNav) ? 'bots' : '';

  return (
    <div className="md:hidden flex justify-center items-center w-full shrink-0" style={{ paddingBottom: 'max(4px, env(safe-area-inset-bottom))' }}>
      <BottomDock
        items={items}
        activeId={activeId}
        onChange={handleDockChange}
        showSearch={false}
      />
    </div>
  );
};
