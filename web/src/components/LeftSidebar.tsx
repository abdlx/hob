import React from 'react';
import {
  MessageCircle,
  Search,
  Newspaper,
  Lightbulb,
  SquareCheck,
  Shapes,
  Equal,
} from 'lucide-react';
import { useChat } from '../context/ChatContext';

export interface NavItemConfig {
  key: string;
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  label: string;
}

const sidebarNavItems: NavItemConfig[] = [
  { key: 'chat', icon: MessageCircle, label: 'Chat' },
  { key: 'search', icon: Search, label: 'Search' },
  { key: 'feed', icon: Newspaper, label: 'Feed' },
  { key: 'idea', icon: Lightbulb, label: 'Idea' },
  { key: 'goals', icon: SquareCheck, label: 'Goals' },
  { key: 'library', icon: Shapes, label: 'Library' },
  { key: 'settings', icon: Equal, label: 'Settings' },
];

interface LeftSidebarProps {
  onSelectNav?: (key: string) => void;
  activeNav?: string;
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  onSelectNav,
  activeNav: propsActiveNav,
}) => {
  const { activeNav: contextNav, setActiveNav } = useChat();
  const current = propsActiveNav !== undefined ? propsActiveNav : contextNav;

  const handleNavClick = (key: string) => {
    setActiveNav(key);
    if (onSelectNav) onSelectNav(key);
  };

  const middleItems = sidebarNavItems.slice(0, 6);
  const settingsItem = sidebarNavItems[6];

  return (
    <aside className="hidden md:flex w-[60px] bg-black flex-col items-center justify-between py-5 select-none shrink-0 z-20 border-r border-[#161616]">
      {/* Top spacing */}
      <div className="h-6" />

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
              className={`p-2 rounded-full transition-colors duration-150 cursor-pointer flex items-center justify-center text-white ${
                isActive
                  ? 'bg-[#1e1e1e]'
                  : 'hover:bg-[#141414]'
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
          className={`p-2 rounded-full transition-colors duration-150 cursor-pointer flex items-center justify-center text-white ${
            current === settingsItem.key
              ? 'bg-[#1e1e1e]'
              : 'hover:bg-[#141414]'
          }`}
        >
          <Equal size={19} strokeWidth={1.8} />
        </button>
      </div>
    </aside>
  );
};
