const IMAGE_KINDS = new Set(['image', 'image_url', 'input_image']);
const TEXT_KINDS = new Set(['text', 'input_text', 'output_text']);

function imageUrl(part) {
  for (const value of [part?.image_url, part?.url, part?.source?.url]) {
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object' && typeof value.url === 'string' && value.url) return value.url;
  }
  return '';
}

function partText(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (TEXT_KINDS.has(part.type) || (!part.type && typeof part.text === 'string')) {
    return typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : '';
  }
  if (IMAGE_KINDS.has(part.type)) {
    const url = imageUrl(part);
    return url ? `![image](${url})` : '';
  }
  return '';
}

/**
 * Project stored Hermes content to display text. Text parts survive, and image
 * parts become Markdown so history bubbles show the same media the live turn
 * already renders. When a persisted user message already carries its
 * `@image:` references, the native image parts are not repeated.
 */
export function messageContentText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const parts = value.filter(part => !(part && typeof part === 'object' && part.type === 'text' && !part.text && !part.content));
  const text = parts.map(partText).filter(Boolean).join('\n').trim();
  if (!text) return '';
  const hasImageRefs = parts.some(part => typeof part === 'string' && /(?:^|\n)\s*@image:|(?:^|\n)\s*MEDIA:/i.test(part))
    || parts.some(part => part?.type === 'text' && /(?:^|\n)\s*(?:@image:|MEDIA:)/i.test(part.text || ''));
  if (hasImageRefs) return parts.map(part => typeof part === 'string' ? part : TEXT_KINDS.has(part?.type) ? partText(part) : '').filter(Boolean).join('\n').trim();
  return text;
}
