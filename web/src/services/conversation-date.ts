export function conversationDate(value: string, now = new Date()) {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return value ? 'Unknown date' : 'No date';
  return at.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}
