import React from 'react';
import {
  MessageCircle,
  Search,
  Newspaper,
  BookOpen,
  SquareCheck,
  Shapes,
  Settings,
  Users,
} from 'lucide-react';
import { useChat } from '../context/ChatContext';
import { Brand } from './Brand';

export interface NavItemConfig {
  key: string;
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  label: string;
}

const sidebarNavItems: NavItemConfig[] = [
  { key: 'chat', icon: MessageCircle, label: 'Chat' },
  { key: 'groups', icon: Users, label: 'Groups' },
  { key: 'search', icon: Search, label: 'Search' },
  { key: 'feed', icon: Newspaper, label: 'Feed' },
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

  const middleItems = sidebarNavItems.filter(item => item.key !== 'settings');
  const settingsItem = sidebarNavItems.find(item => item.key === 'settings')!;

  return (
    <aside className="hob-sidebar hidden md:flex w-[82px] flex-col items-center justify-between py-6 select-none shrink-0 z-20 border-r border-[#27211a]" aria-label="Main navigation">
      <button aria-label="hob home" title="hob home" onClick={() => handleNavClick('chat')} className="hover:opacity-90 transition-opacity"><Brand compact /></button>

      {/* Middle icon cluster centered vertically */}
      <div className="flex-1 flex flex-col items-center justify-center space-y-3.5">
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
              className={`hob-nav-button p-2.5 rounded-2xl transition-all duration-150 cursor-pointer flex items-center justify-center ${
                isActive
                  ? 'bg-[#2f2218] text-[#ff9e63] shadow-inner border border-[#4e3623]'
                  : 'text-[#9f9486] hover:bg-[#201a14] hover:text-[#f8eee4] border border-transparent'
              }`}
            >
              <Icon size={20} strokeWidth={1.75} />
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
          className={`hob-nav-button p-2.5 rounded-2xl transition-all duration-150 cursor-pointer flex items-center justify-center ${
            current === settingsItem.key
              ? 'bg-[#2f2218] text-[#ff9e63] border border-[#4e3623]'
              : 'text-[#9f9486] hover:bg-[#201a14] hover:text-[#f8eee4] border border-transparent'
          }`}
        >
          <Settings size={20} strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  );
};
