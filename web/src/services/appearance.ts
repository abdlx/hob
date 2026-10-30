import { preference, savePreference } from './settings-navigation.ts';

export type Theme = 'light' | 'dark' | 'system';
export const readTheme = (): Theme => {
  const value = preference('hob:theme', 'dark');
  return value === 'light' || value === 'dark' ? value : 'system';
};
export function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#060605' : '#FAFAFA');
}
export function setTheme(theme: Theme) {
  const saved = savePreference('hob:theme', theme);
  applyTheme(theme);
  return saved;
}
export function initializeAppearance() {
  applyTheme(readTheme());
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', () => applyTheme(readTheme()));
  window.addEventListener('storage', event => { if (event.key === 'hob:theme' || event.key === null) applyTheme(readTheme()); });
  if (preference('hob-contrast', '') === 'high') document.documentElement.style.filter = 'contrast(1.15)';
}
