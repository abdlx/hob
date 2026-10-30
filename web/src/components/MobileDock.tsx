import { primaryNavigation, navigationSelected } from './navigation';
import { useChat } from '../context/ChatContext';

interface MobileDockProps {
  hidden?: boolean;
  onNavigate?: (id: string) => void;
}
export function MobileDock({ hidden = false, onNavigate }: MobileDockProps) {
  const { activeNav, setActiveNav } = useChat();
  return <nav hidden={hidden} className="hob-mobile-dock" aria-label="Mobile navigation">
    {primaryNavigation.map(({ id, label, icon: Icon }) => {
      const active = navigationSelected(activeNav, id);
      return <button key={id} type="button" title={label} aria-label={label} aria-current={active ? 'page' : undefined}
        onClick={() => { onNavigate?.(id); setActiveNav(id); }}>
        <Icon size={25} strokeWidth={1.9} />
      </button>;
    })}
  </nav>;
}
