import React from 'react';
import {
  MessageSquare,
  Search,
  Compass,
  BookOpen,
  SquareCheck,
  Shapes,
  Settings,
} from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { Brand } from './Brand';

export interface NavItemConfig {
  key: string;
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  label: string;
}

const sidebarNavItems: NavItemConfig[] = [
  { key: 'chat', icon: MessageSquare, label: 'Chat' },
  { key: 'search', icon: Search, label: 'Search chats' },
  { key: 'activity', icon: Compass, label: 'Activity' },
  { key: 'idea', icon: BookOpen, label: 'Workshop' },
  { key: 'goals', icon: SquareCheck, label: 'Goals' },
  { key: 'library', icon: Shapes, label: 'Library' },
  { key: 'settings', icon: Settings, label: 'Settings' },
];

interface LeftSidebarProps {
  onSelectNav?: (key: string) => void;
  activeNav?: string;
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  onSelectNav,
  activeNav: propsActiveNav,
}) => {
  const { activeNav: contextNav, setActiveNav, toggleLeftDrawer, isLeftDrawerOpen } = useChat();
  const current = propsActiveNav !== undefined ? propsActiveNav : contextNav;

  const handleNavClick = (key: string) => {
    setActiveNav(key);
    if (key === 'search' && !isLeftDrawerOpen) toggleLeftDrawer();
    if (onSelectNav) onSelectNav(key);
  };

  const middleItems = sidebarNavItems.filter((item) => item.key !== 'settings');
  const settingsItem = sidebarNavItems.find((item) => item.key === 'settings')!;

  return (
    <aside
      className="hob-sidebar flex w-[76px] flex-col items-center justify-between py-6 select-none shrink-0 z-20 border-r border-line bg-canvas h-full"
      aria-label="Main navigation"
    >
      <button
        aria-label="hob home"
        title="hob home"
        onClick={() => handleNavClick('chat')}
        className="hover:opacity-85 transition-opacity cursor-pointer mt-1"
      >
        <Brand compact />
      </button>

      {/* Middle icon cluster centered vertically */}
      <div className="flex-1 flex flex-col items-center justify-center space-y-3.5 my-4">
        {middleItems.map((item) => {
          const Icon = item.icon;
          const isActive = current === item.key;
          return (
            <button
              key={item.key}
              onClick={() => handleNavClick(item.key)}
              title={item.label}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              className={`p-2.5 rounded-[14px] transition-all duration-150 cursor-pointer flex items-center justify-center ${
                isActive
                  ? 'bg-accent text-white shadow-xs'
                  : 'text-code hover:bg-black/[0.04] hover:text-ink'
              }`}
            >
              <Icon size={20} strokeWidth={1.8} />
            </button>
          );
        })}
      </div>

      {/* Bottom icon: settings */}
      <div className="flex flex-col items-center mb-1">
        <button
          onClick={() => handleNavClick(settingsItem.key)}
          title={settingsItem.label}
          aria-label={settingsItem.label}
          className={`p-2.5 rounded-[14px] transition-all duration-150 cursor-pointer flex items-center justify-center ${
            current === settingsItem.key
              ? 'bg-accent text-white shadow-xs'
              : 'text-code hover:bg-black/[0.04] hover:text-ink'
          }`}
        >
          <Settings size={20} strokeWidth={1.8} />
        </button>
      </div>
    </aside>
  );
};
