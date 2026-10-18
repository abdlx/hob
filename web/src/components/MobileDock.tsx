import React from 'react';
import { Bot, Compass, BookOpen, SquareCheck, Shapes } from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { BottomDock } from './BottomDock/BottomDock';
import type { DockItemConfig } from './BottomDock/types';

interface MobileDockProps {
  currentMobileView?: 'bots' | 'chat';
  onNavigateBots?: () => void;
  onOpenActivity?: () => void;
}

const items: DockItemConfig[] = [
  { id: 'bots', label: 'Bots', icon: <Bot size={20} strokeWidth={2} /> },
  { id: 'activity', label: 'Activity', icon: <Compass size={20} strokeWidth={2} /> },
  { id: 'idea', label: 'Workshop', icon: <BookOpen size={20} strokeWidth={2} /> },
  { id: 'goals', label: 'Goals', icon: <SquareCheck size={20} strokeWidth={2} /> },
  { id: 'library', label: 'Library', icon: <Shapes size={20} strokeWidth={2} /> },
];

export const MobileDock: React.FC<MobileDockProps> = ({
  currentMobileView = 'chat',
  onNavigateBots,
  onOpenActivity,
}) => {
  const { activeNav, setActiveNav, isRightPanelOpen, toggleRightPanel } = useChat();

  const handleDockChange = (id: string) => {
    if (id === 'bots') {
      if (onNavigateBots) onNavigateBots();
      setActiveNav('chat');
    } else if (id === 'activity') {
      if (onOpenActivity) onOpenActivity();
      else if (!isRightPanelOpen) toggleRightPanel();
    } else {
      setActiveNav(id);
    }
  };

  const activeId = isRightPanelOpen
    ? 'activity'
    : currentMobileView === 'bots'
    ? 'bots'
    : activeNav === 'idea'
    ? 'idea'
    : activeNav === 'goals'
    ? 'goals'
    : activeNav === 'library'
    ? 'library'
    : 'bots';

  return (
    <div className="md:hidden pt-1.5 pb-1 flex justify-center items-center w-full shrink-0">
      <BottomDock
        items={items}
        activeId={activeId}
        onChange={handleDockChange}
        showSearch={false}
      />
    </div>
  );
};
