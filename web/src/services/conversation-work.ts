import type { ChatMessage } from '../types/chat';
import type { ChatAttachment } from './attachments';

export interface QueuedPrompt {
  id: string;
  profile: string;
  sessionId: string;
  content: string;
  attachments?: ChatAttachment[];
  timestamp: string;
  message: ChatMessage;
}

interface Work {
  profile: string;
  sessionId: string;
  user: ChatMessage;
  reply: ChatMessage;
  historyIds: Set<string>;
  runId?: string;
}

/** Browser presentation only. Hermes remains the authority for running work. */
export class ConversationWork {
  private active = new Map<string, Work>();
  private errors = new Map<string, string>();
  private versions = new Map<string, number>();
  private drafts = new Map<string, string>();
  private draftListeners = new Map<string, Set<() => void>>();
  private queues = new Map<string, QueuedPrompt[]>();
  private queueListeners = new Map<string, Set<() => void>>();
  private outgoing = new Map<string, Map<string, { message: ChatMessage; historyIds: Set<string> }>>();

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

  setRunId(sessionId: string, runId: string) {
    const work = this.active.get(sessionId);
    if (work) work.runId = runId;
  }
  getRunId(sessionId: string) {
    return this.active.get(sessionId)?.runId;
  }

  presentUser(profile: string, sessionId: string, content: string, id: string, timestamp: string, history: ChatMessage[]) {
    const pending = this.outgoing.get(sessionId) || new Map();
    pending.set(id, { message: { id, profile, role: 'user', content, timestamp, status: 'sending' }, historyIds: new Set(history.map(row => row.id)) });
    this.outgoing.set(sessionId, pending);
    this.versions.set(sessionId, this.version(sessionId) + 1);
  }

  settleUser(sessionId: string, id: string, status: 'complete' | 'error' | 'unconfirmed') {
    const pending = this.outgoing.get(sessionId)?.get(id);
    if (pending) {
      pending.message.status = status;
      this.versions.set(sessionId, this.version(sessionId) + 1);
    }
  }

  getQueue(sessionId: string): QueuedPrompt[] {
    return [...(this.queues.get(sessionId) || [])];
  }
  subscribeQueue(sessionId: string, listener: () => void) {
    const listeners = this.queueListeners.get(sessionId) || new Set<() => void>();
    listeners.add(listener); this.queueListeners.set(sessionId, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.queueListeners.delete(sessionId); };
  }
  private notifyQueue(sessionId: string) {
    for (const listener of this.queueListeners.get(sessionId) || []) listener();
  }

  enqueue(profile: string, sessionId: string, content: string, id: string, timestamp: string, attachments?: ChatAttachment[]): QueuedPrompt {
    const message: ChatMessage = {
      id,
      role: 'user',
      content,
      timestamp,
      status: 'queued',
      profile,
    };
    const item: QueuedPrompt = { id, profile, sessionId, content, attachments, timestamp, message };
    const list = this.queues.get(sessionId) || [];
    list.push(item);
    this.queues.set(sessionId, list);
    this.versions.set(sessionId, this.version(sessionId) + 1);
    this.notifyQueue(sessionId);
    return item;
  }

  dequeue(sessionId: string): QueuedPrompt | undefined {
    const list = this.queues.get(sessionId);
    if (!list || !list.length) return undefined;
    const item = list.shift();
    if (!list.length) this.queues.delete(sessionId);
    this.versions.set(sessionId, this.version(sessionId) + 1);
    this.notifyQueue(sessionId);
    return item;
  }

  removeQueued(sessionId: string, id: string): boolean {
    const list = this.queues.get(sessionId);
    if (!list) return false;
    const filtered = list.filter(item => item.id !== id);
    if (filtered.length !== list.length) {
      if (filtered.length) this.queues.set(sessionId, filtered);
      else this.queues.delete(sessionId);
      this.versions.set(sessionId, this.version(sessionId) + 1);
      this.notifyQueue(sessionId);
      return true;
    }
    return false;
  }

  clearQueue(sessionId: string) {
    this.queues.delete(sessionId);
    this.versions.set(sessionId, this.version(sessionId) + 1);
    this.notifyQueue(sessionId);
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
    const queued = this.queues.get(sessionId) || [];
    const pending = this.outgoing.get(sessionId);
    if (!work && !queued.length && !pending?.size && !history.some(message => message.status === 'queued')) return history;
    const localIds = new Set(pending?.keys());
    const result = history.filter(message => message.status !== 'queued' && !localIds.has(message.id) && (!work || (message.id !== work.user.id && message.id !== work.reply.id)) && !queued.some(q => q.id === message.id));
    if (work) {
      const admitted = result.some(message => message.role === 'user' && message.content === work.user.content && !work.historyIds.has(message.id));
      if (!admitted) result.push({ ...work.user });
      if (work.reply.content) result.push({ ...work.reply });
    }
    for (const item of queued) {
      if (!result.some(message => message.id === item.id)) {
        result.push({ ...item.message });
      }
    }
    for (const [id, item] of pending || []) {
      const admitted = result.find(row => row.role === 'user' && row.id !== work?.user.id
        && !localIds.has(row.id) && row.content === item.message.content && !item.historyIds.has(row.id));
      if (admitted) {
        pending!.delete(id);
        // One saved message acknowledges one send, even for repeated text.
        for (const other of pending!.values()) other.historyIds.add(admitted.id);
      } else result.push({ ...item.message });
    }
    if (pending && !pending.size) this.outgoing.delete(sessionId);
    return result;
  }
}
