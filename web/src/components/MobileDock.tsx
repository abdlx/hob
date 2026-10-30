import { MessageCircle, PanelsTopLeft, Lightbulb, SquareCheck, Shapes } from 'lucide-react';
import { useChat } from '../context/ChatContext';

interface MobileDockProps {
  currentMobileView?: 'bots' | 'chat';
  onNavigateBots?: () => void;
  onOpenActivity?: () => void;
  onNavigate?: () => void;
}
const items = [
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'activity', label: 'Activity', icon: PanelsTopLeft },
  { id: 'idea', label: 'Workshop', icon: Lightbulb },
  { id: 'goals', label: 'Goals', icon: SquareCheck },
  { id: 'library', label: 'Library', icon: Shapes },
];
export function MobileDock({ onOpenActivity, onNavigate }: MobileDockProps) {
  const { activeNav, setActiveNav } = useChat();
  return <nav className="hob-mobile-dock md:hidden" aria-label="Mobile navigation">
    {items.map(({ id, label, icon: Icon }) => {
      const active = activeNav === id || (id === 'chat' && ['search', 'groups'].includes(activeNav));
      return <button key={id} type="button" title={label} aria-label={label} aria-current={active ? 'page' : undefined}
        onClick={() => { onNavigate?.(); setActiveNav(id); if (id === 'activity') onOpenActivity?.(); }}>
        <Icon size={25} strokeWidth={1.9} />
      </button>;
    })}
  </nav>;
}
