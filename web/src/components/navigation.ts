import { MessageCircle, PanelsTopLeft, Lightbulb, SquareCheck, Shapes } from 'lucide-react';

export const primaryNavigation = [
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'activity', label: 'Activity', icon: PanelsTopLeft },
  { id: 'idea', label: 'Workshop', icon: Lightbulb },
  { id: 'goals', label: 'Goals', icon: SquareCheck },
  { id: 'library', label: 'Library', icon: Shapes },
];
export const navigationSelected = (page: string, id: string) => page === id || (id === 'chat' && ['search', 'groups'].includes(page));
