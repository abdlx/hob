import type { ChatMessage } from '../types/chat';

interface Work {
  profile: string;
  sessionId: string;
  user: ChatMessage;
  reply: ChatMessage;
  historyIds: Set<string>;
}

/** Browser presentation only. Hermes remains the authority for running work. */
export class ConversationWork {
  private active = new Map<string, Work>();
  private errors = new Map<string, string>();
  private versions = new Map<string, number>();
  private drafts = new Map<string, string>();
  private draftListeners = new Map<string, Set<() => void>>();

  busy(sessionId: string) { return this.active.has(sessionId); }
  version(sessionId: string) { return this.versions.get(sessionId) || 0; }
  error(sessionId: string) { return this.errors.get(sessionId) || null; }
  clearError(sessionId: string) { this.errors.delete(sessionId); }
  draft(sessionId: string) { return this.drafts.get(sessionId) || ''; }
  setDraft(sessionId: string, text: string) {
    if (this.draft(sessionId) === text) return;
    if (text) this.drafts.set(sessionId, text); else this.drafts.delete(sessionId);
    for (const listener of this.draftListeners.get(sessionId) || []) listener();
  }
  subscribeDraft(sessionId: string, listener: () => void) {
    const listeners = this.draftListeners.get(sessionId) || new Set<() => void>();
    listeners.add(listener); this.draftListeners.set(sessionId, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.draftListeners.delete(sessionId); };
  }

  begin(profile: string, sessionId: string, content: string, userId: string, replyId: string, timestamp: string, history: ChatMessage[]) {
    if (this.active.has(sessionId)) throw new Error('This conversation already has a response in progress.');
    const work: Work = { profile, sessionId, user: { id: userId, role: 'user', content, timestamp, status: 'sending', profile },
      reply: { id: replyId, role: 'assistant', content: '', timestamp, status: 'streaming', profile }, historyIds: new Set(history.map(message => message.id)) };
    this.active.set(sessionId, work); this.errors.delete(sessionId);
    this.versions.set(sessionId, this.version(sessionId) + 1);
    return work;
  }

  append(work: Work, chunk: string, replace = false) {
    if (this.active.get(work.sessionId) !== work) return false;
    work.reply.content = replace ? chunk : work.reply.content + chunk;
    return true;
  }

  finish(work: Work, error?: string) {
    if (this.active.get(work.sessionId) !== work) return false;
    this.active.delete(work.sessionId);
    this.versions.set(work.sessionId, this.version(work.sessionId) + 1);
    if (error) this.errors.set(work.sessionId, error);
    return true;
  }

  project(sessionId: string, history: ChatMessage[]) {
    const work = this.active.get(sessionId);
    if (!work) return history;
    const result = history.filter(message => message.id !== work.user.id && message.id !== work.reply.id);
    // Native history may already contain the admitted user row, whose stored
    // ID differs from our optimistic ID. An identical OLD prompt is not a match.
    const admitted = result.some(message => message.role === 'user' && message.content === work.user.content && !work.historyIds.has(message.id));
    if (!admitted) result.push({ ...work.user });
    if (work.reply.content) result.push({ ...work.reply });
    return result;
  }
}
