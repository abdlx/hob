import React from 'react';
import {
  MessageCircle,
  Search,
  Newspaper,
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
  { key: 'chat', icon: MessageCircle, label: 'Chat' },
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

  const middleItems = sidebarNavItems.slice(0, 6);
  const settingsItem = sidebarNavItems[6];

  return (
    <aside className="hob-sidebar hidden md:flex w-[76px] flex-col items-center justify-between py-5 select-none shrink-0 z-20 border-r border-[#25211e]" aria-label="Main navigation">
      <button aria-label="hob home" title="hob home" onClick={() => handleNavClick('chat')}><Brand compact /></button>

      {/* Middle icon cluster centered vertically */}
      <div className="flex-1 flex flex-col items-center justify-center space-y-3">
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
              className={`hob-nav-button p-2 rounded-xl transition-colors duration-150 cursor-pointer flex items-center justify-center ${
                isActive
                  ? 'bg-[#2e241e] text-[#ffad79]'
                  : 'text-[#a19a92] hover:bg-[#211d19] hover:text-[#eee5dc]'
              }`}
            >
              <Icon size={18} strokeWidth={1.55} />
            </button>
          );
        })}
      </div>

      {/* Bottom icon: settings with Equal icon */}
      <div className="flex flex-col items-center mb-1">
        <button
          onClick={() => handleNavClick(settingsItem.key)}
          title={settingsItem.label}
          aria-label={settingsItem.label}
          className={`p-2 rounded-full transition-colors duration-150 cursor-pointer flex items-center justify-center text-white ${
            current === settingsItem.key
              ? 'bg-[#1e1e1e]'
              : 'hover:bg-[#141414]'
          }`}
        >
          <Settings size={19} strokeWidth={1.8} />
        </button>
      </div>
    </aside>
  );
};
