/** Display the computed instant in the bot's zone; retain an explicit offset for unknown zones. */
export function schedulePreviewTime(value: string, timezone: string, locale?: string) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return 'Unavailable';
  try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long', timeZone: timezone }).format(instant); }
  catch { return value; }
}
