/** Migrate preferences without exposing old product identifiers to UI code. */
export function migrateHobPreferences() {
  try {
    for (const [oldKey, newKey] of [
      ['mused-bots-sidebar-open', 'hob-bots-sidebar-open'],
      ['mused-notifications', 'hob-notifications'],
      ['mused-contrast', 'hob-contrast'],
    ]) {
      const previous = localStorage.getItem(oldKey);
      if (previous !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, previous);
      if (previous !== null) localStorage.removeItem(oldKey);
    }
  } catch { /* Browser storage can be unavailable; defaults still work. */ }
}
