const IMAGE_EXT = 'png|jpe?g|gif|webp|avif|bmp';
const IMAGE_PATH = new RegExp(`\\.(?:${IMAGE_EXT})$`, 'i');
const ANCHORED = `(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:${IMAGE_EXT})(?=[\\s\`"'*_,;:)\\]}]|MEDIA:|$)`;
const BARE = `[^\\s\`"]+`;
const VALUE = `(?:\`[^\`\\n]+\`|"[^"\\n]+"|'[^'\\n]+'|${ANCHORED}|${BARE})`;
const MEDIA_LINE = new RegExp(`(^|\\n)[\\t ]*[\`"']?MEDIA:\\s*(${VALUE})[\`"']?[\\t ]*(\\n|$)`, 'g');
const MEDIA_TAG = new RegExp(`[\`"']?MEDIA:\\s*(${VALUE})[\`"']?`, 'g');
const IMAGE_LINE = new RegExp(`(^|\\n)[\\t ]*@image:\\s*(${VALUE})[\\t ]*(\\n|$)`, 'gi');
const IMAGE_TAG = new RegExp(`@image:\\s*(${VALUE})`, 'gi');
const MEDIA_LINK = /\[([^\]]+)\]\(#media:([^)]+)\)/g;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)]+)\)/g;

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function isImagePath(value: string): boolean {
  return IMAGE_PATH.test(value.replace(/^file:/i, '').split(/[?#]/, 1)[0]);
}

export function isSafeImageSource(value: string): boolean {
  return /^(?:data:image\/|https?:\/\/|blob:|\/api\/hermes\/media\?)/i.test(value.trim());
}

export function isFileMediaPath(value: string): boolean {
  return /^(?:file:|\/|~\/|[a-z]:[\\/]|\\\\)/i.test(value.trim());
}

export function mediaName(value: string): string {
  const clean = decode(value).split(/[?#]/, 1)[0];
  return clean.split(/[\\/]/).filter(Boolean).pop() || 'image';
}

/** Local image paths go through hob's authenticated reader; the browser never
 * receives a host filesystem path as a URL. */
export function mediaUrl(value: string, profile = 'default'): string {
  const query = new URLSearchParams({ profile: profile || 'default', path: value });
  return `/api/hermes/media?${query.toString()}`;
}

function plausible(value: string): boolean {
  return value.includes('/') || value.includes('\\') || /\.[^.]/.test(value);
}

function splitTrailingPunctuation(value: string): { path: string; punctuation: string } {
  let end = value.length;
  while (end > 0 && '.,;:!?'.includes(value[end - 1])) {
    if (!plausible(value.slice(0, end - 1))) break;
    end--;
  }
  return { path: value.slice(0, end), punctuation: value.slice(end) };
}

function directive(value: string): { path: string; punctuation: string } | null {
  const raw = value.trim();
  if (!raw) return null;
  const quote = raw[0];
  const quoted = raw.length > 1 && quote === raw[raw.length - 1] && (quote === '"' || quote === "'" || quote === '`');
  let path = quoted ? raw.slice(1, -1) : raw;
  if (!quoted && (path.endsWith('`') || path.endsWith('"'))) path = path.slice(0, -1);
  if (!path || !plausible(path)) return null;
  return quoted ? { path, punctuation: '' } : splitTrailingPunctuation(path);
}

function imageMarkdown(value: string, profile: string, alt?: string): string {
  const label = (alt || mediaName(value)).replace(/[[\]\r\n]/g, ' ').trim() || 'image';
  return `![${label}](${mediaUrl(value, profile)})`;
}

function resolveMarkdownSource(value: string, profile: string): string | null {
  const source = value.trim();
  if (!source) return null;
  if (isSafeImageSource(source)) return source;
  return isFileMediaPath(source) && isImagePath(source) ? mediaUrl(source, profile) : null;
}

/**
 * Turn Hermes' delivery directives and local Markdown image paths into image
 * nodes the chat renderer can show. Non-image MEDIA tags stay untouched; this
 * endpoint only serves images.
 */
function transform(content: string, profile: string): string {
  const mediaLine = (match: string, lead: string, value: string, trailer: string) => {
    const parsed = directive(value);
    return parsed && isImagePath(parsed.path)
      ? `${lead}${imageMarkdown(parsed.path, profile)}${parsed.punctuation}${trailer}`
      : match;
  };
  const mediaTag = (match: string, value: string) => {
    const parsed = directive(value);
    return parsed && isImagePath(parsed.path) ? `${imageMarkdown(parsed.path, profile)}${parsed.punctuation}` : match;
  };
  const imageLine = (match: string, lead: string, value: string, trailer: string) => {
    const parsed = directive(value);
    return parsed && isImagePath(parsed.path)
      ? `${lead}${imageMarkdown(parsed.path, profile, `Image: ${mediaName(parsed.path)}`)}${parsed.punctuation}${trailer}`
      : match;
  };
  const imageTag = (match: string, value: string) => {
    const parsed = directive(value);
    return parsed && isImagePath(parsed.path) ? `${imageMarkdown(parsed.path, profile)}${parsed.punctuation}` : match;
  };
  return content
    .replace(MEDIA_LINE, mediaLine)
    .replace(MEDIA_TAG, mediaTag)
    .replace(IMAGE_LINE, imageLine)
    .replace(IMAGE_TAG, imageTag)
    .replace(MEDIA_LINK, (match, label: string, href: string) => {
      const path = decode(href);
      return isImagePath(path) ? imageMarkdown(path, profile, label) : match;
    })
    .replace(MARKDOWN_IMAGE, (match, alt: string, src: string) => {
      const resolved = resolveMarkdownSource(src, profile);
      return resolved ? `![${alt}](${resolved})` : match;
    });
}

export function renderMediaDirectives(content: string, profile = 'default'): string {
  if (!content) return content;
  // Fenced examples are literal text, never live media directives.
  return content.split(/(```[\s\S]*?```)/g)
    .map((chunk, index) => index % 2 ? chunk : transform(chunk, profile))
    .join('');
}
