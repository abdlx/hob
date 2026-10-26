import { HermesError } from './hermes-client.mjs';

export function hermesBotTags(value = []) {
  if (!Array.isArray(value) || value.length > 8) throw new HermesError(400, 'Use up to eight bot labels.', 'INVALID_REQUEST');
  const tags = value.map(tag => {
    if (typeof tag !== 'string' || /[\u0000-\u001f\u007f]/.test(tag)) throw new HermesError(400, 'Labels must be printable text.', 'INVALID_REQUEST');
    const clean = tag.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 32) throw new HermesError(400, 'Each label must contain 1–32 characters.', 'INVALID_REQUEST');
    return clean;
  });
  return tags.filter((tag, index) => tags.findIndex(other => other.toLowerCase() === tag.toLowerCase()) === index);
}

const clean = value => String(value || '').replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim();
/** Preserve authored personality text; only this marked identity block is managed. */
export function withBotIdentity(content, bot) {
  if (typeof content !== 'string' || content.length > 512 * 1024) throw new HermesError(400, 'SOUL.md must be text under 512 KB.', 'INVALID_REQUEST');
  const start = '<!-- HOB:BOT-IDENTITY:START -->', end = '<!-- HOB:BOT-IDENTITY:END -->';
  const block = [start, '## Bot identity', `Name: ${clean(bot.displayName)}`, `Labels: ${(bot.tags || []).map(clean).join(', ') || '(none)'}`,
    `Role: ${clean(bot.description) || (bot.name === 'default' ? 'Coordinate the team and own the user’s outcome.' : 'Help with work appropriate to your instructions.')}`,
    `Stable profile id: ${bot.name}`, end].join('\n');
  if (content.includes(start) !== content.includes(end)) throw new HermesError(409, 'Repair the incomplete managed identity block in SOUL.md before saving.', 'IDENTITY_BLOCK_INVALID');
  return content.includes(start) ? content.replace(/<!-- HOB:BOT-IDENTITY:START -->[\s\S]*?<!-- HOB:BOT-IDENTITY:END -->/g, () => block)
    : `${content.trimEnd()}${content.trim() ? '\n\n' : ''}${block}\n`;
}
