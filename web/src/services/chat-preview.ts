/** Keep the directory readable when the latest bubble contains Markdown or media. */
export function chatPreview(content: string | null | undefined): string {
  if (content === null) return 'Preview unavailable';
  const text = (content || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, label: string) => label || 'Image')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/(?:^|\n)\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/g, ' ')
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/[*_~`]/g, '')
    .trim();
  if (!text) return 'No messages yet';
  const words = text.split(/\s+/);
  return words.slice(0, 5).join(' ') + (words.length > 5 ? '…' : '');
}
