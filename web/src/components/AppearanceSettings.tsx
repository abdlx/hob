import { useState } from 'react';
import { Laptop, Moon, Sun } from 'lucide-react';
import { readTheme, setTheme } from '../services/appearance';
import type { Theme } from '../services/appearance';
import { cardClass, Notice } from './WorkspaceUI';

export function AppearanceSettings() {
  const [theme, choose] = useState(readTheme);
  const [error, setError] = useState('');
  return <section className={`${cardClass} space-y-4`}>
    <div><h3 className="text-sm font-semibold text-ink">Appearance</h3><p className="mt-1 text-xs text-muted">Saved in this browser. Your bots’ runtime configuration stays in Hermes.</p></div>
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Color theme">
      {([{ id: 'light', label: 'Light', Icon: Sun }, { id: 'dark', label: 'Dark', Icon: Moon }, { id: 'system', label: 'System', Icon: Laptop }] as const).map(({ id, label, Icon }) => <button key={id} aria-pressed={theme === id} className={`rounded-xl border px-3 py-4 text-xs font-medium flex flex-col items-center gap-3 transition-colors ${theme === id ? 'border-accent bg-accent-soft text-accent' : 'border-edge bg-panel text-soft hover:bg-hover'}`} onClick={() => { choose(id as Theme); setError(setTheme(id) ? '' : 'This browser could not save your preference. The theme applies for this page only.'); }}><Icon size={19} />{label}</button>)}
    </div>
    {error && <Notice error>{error}</Notice>}
    <p className="text-xs leading-relaxed text-muted">System follows your device’s appearance. Motion follows your device’s reduced-motion preference.</p>
  </section>;
}
