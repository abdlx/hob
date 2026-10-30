import type { ActivityFeed, AgentProfile, AgentListItem, ChatMessage, ChatSession, SecurityApproval, SystemStats, TaskItem } from '../types/chat';
import { activityFeed } from './activity.ts';
import { readTurnStream } from './stream.ts';

const baseUrl = (import.meta.env?.VITE_API_BASE_URL || '').replace(/\/$/, '');
let activeProfile = 'default';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

// Provider/MCP authentication failures do not imply the Hob login expired.
let sessionCheck: Promise<void> | null = null;
async function checkSession() {
  if (!sessionCheck) sessionCheck = (async () => {
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (response.ok && (await response.json()).authenticated === false) window.dispatchEvent(new Event('hob:unauthorized'));
    } catch { /* A failed connectivity check is not proof of an expired login. */ }
  })().finally(() => { sessionCheck = null; });
  await sessionCheck;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('X-Hob-Profile')) headers.set('X-Hob-Profile', activeProfile);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new ApiError(body?.error?.message || body?.error || body?.message || `Request failed (${response.status})`, response.status);
    if (response.status === 401 && !/^\/api\/auth\/(?:login|status)(?:[?]|$)/.test(path)) await checkSession();
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

class ChatApiClient {
  private profile?: string;
  constructor(profile?: string) { this.profile = profile; }
  getProfile = () => this.profile ?? activeProfile;
  forProfile = (profile = this.getProfile()) => {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Select a valid bot.');
    return new ChatApiClient(profile);
  };
  private request = <T,>(path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('X-Hob-Profile', this.getProfile());
    return apiFetch<T>(path, { ...init, headers });
  };
  setProfile = (profile: string) => {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Select a valid bot.');
    activeProfile = profile;
  };
  getAgents = () => this.request<{ agents: AgentListItem[] }>('/api/agents');
  getReadiness = () => this.request<{ ready: boolean; status: string }>('/api/readiness');
  getSessions = () => this.request<ChatSession[]>('/api/sessions');
  createSession = (title = 'New Conversation') => this.request<ChatSession>('/api/sessions', { method: 'POST', body: JSON.stringify({ title }) });
  getMessages = (id: string) => this.request<ChatMessage[]>(`/api/sessions/${encodeURIComponent(id)}/messages`);
  getAgentProfile = () => this.request<AgentProfile>('/api/agent');
  updateAgentProfile = (updates: Partial<AgentProfile>) => this.request<AgentProfile>('/api/agent', { method: 'PATCH', body: JSON.stringify(updates) });
  getTasks = () => this.request<TaskItem[]>('/api/tasks');
  getTaskFeed = async () => activityFeed(await this.request<TaskItem[] | ActivityFeed>('/api/tasks?format=timeline'));
  getSecurityApprovals = () => this.request<SecurityApproval[]>('/api/security/approvals');
  getSystemStats = () => this.request<SystemStats>('/api/stats');
  resolveSecurityApproval = (id: string, decision: 'approved' | 'rejected') => this.request<void>(`/api/security/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ decision }) });
  async sendMessage(id: string, content: string, onChunk?: (text: string, replace?: boolean) => void, requestKey?: string, attachments?: string[]): Promise<ChatMessage> {
    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/turns`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Hob-Profile': this.getProfile() },
      body: JSON.stringify({ content, ...(requestKey ? { idempotencyKey: requestKey } : {}), ...(attachments?.length ? { attachments } : {}) }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      if (response.status === 401) await checkSession();
      throw new ApiError(body?.error?.message || body?.error || body?.message || `Agent request failed (${response.status})`, response.status);
    }
    if (!response.body) throw new Error('The server did not return an agent response.');
    if (!response.headers.get('Content-Type')?.includes('text/event-stream')) return response.json();
    return readTurnStream(response.body, onChunk);
  }
  subscribe(onEvent: (event: { event: string; payload: unknown }) => void, onConnection: (connected: boolean) => void) {
    const source = new EventSource(`${baseUrl}/api/events`);
    source.onerror = () => onConnection(false);
    source.addEventListener('connection', (event) => {
      try { onConnection(JSON.parse((event as MessageEvent).data).connected === true); } catch { /* Malformed connection event. */ }
    });
    source.addEventListener('gateway', (event) => {
      try { onEvent(JSON.parse((event as MessageEvent).data)); } catch { /* Malformed gateway event. */ }
    });
    source.onmessage = (event) => {
      try { onEvent(JSON.parse(event.data)); } catch { /* Ignore keepalive and incomplete upstream events. */ }
    };
    return () => source.close();
  }
}

export const chatApi = new ChatApiClient();
