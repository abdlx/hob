import { messageContentText } from './hermes-content.mjs';

const CHAT_SOURCES = new Set(['api', 'api_server', 'gui', 'desktop', 'local', 'cli', 'tui']);
const activity = row => Number(row.last_active || row.started_at) || Date.parse(row.last_active || row.started_at) || 0;

/** Stored text for the directory only; never admits, resumes, or recovers a turn. */
export function createHermesChatPreviews(client) {
  const pending = new Map();
  const cached = new Map();
  return profile => {
    if (pending.has(profile)) return pending.get(profile);
    const work = (async () => {
      const result = await client.runtime('/api/sessions', { profile, query: { limit: 200 }, timeoutMs: 4000 });
      if (!Array.isArray(result.data)) throw new Error('Invalid conversation list.');
      const session = result.data
        .filter(row => (!row.source || CHAT_SOURCES.has(row.source)) && !row.hidden && !row.archived && row.message_count !== 0)
        .sort((a, b) => activity(b) - activity(a))[0];
      if (!session) { cached.delete(profile); return ''; }
      const signature = JSON.stringify([session.id, session.last_active, session.message_count]);
      const previous = cached.get(profile);
      // Also expire the text periodically: older runtimes omit activity/count,
      // and an edited message can leave the count unchanged.
      if (previous?.signature === signature && Date.now() - previous.at < 5000) return previous.text;
      const history = await client.runtime(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
        profile, query: { limit: 500, order: 'latest' }, timeoutMs: 4000,
      });
      if (!Array.isArray(history.data)) throw new Error('Invalid conversation messages.');
      const last = history.data.findLast(row => ['user', 'assistant'].includes(row.role) && messageContentText(row.content).trim());
      const text = last ? messageContentText(last.content)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, label) => label || 'Image')
        .replace(/(?:^|\n)\s*(?:@image:|MEDIA:)[^\n]+/gi, ' Image ')
        .slice(0, 1000) : '';
      cached.set(profile, { signature, at: Date.now(), text });
      return text;
    })();
    pending.set(profile, work);
    work.finally(() => pending.delete(profile)).catch(() => {});
    return work;
  };
}
