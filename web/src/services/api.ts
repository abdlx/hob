import type { AgentProfile, ChatMessage, ChatSession, SecurityApproval, SystemStats, TaskItem } from '../types/chat';
import { readTurnStream } from './stream';

const baseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new ApiError(body?.error?.message || body?.error || body?.message || `Request failed (${response.status})`, response.status);
    if (response.status === 401) window.dispatchEvent(new Event('muse:unauthorized'));
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

class ChatApiClient {
  getReadiness = () => apiFetch<{ ready: boolean; status: string }>('/api/readiness');
  getSessions = () => apiFetch<ChatSession[]>('/api/sessions');
  createSession = (title = 'New Conversation') => apiFetch<ChatSession>('/api/sessions', { method: 'POST', body: JSON.stringify({ title }) });
  getMessages = (id: string) => apiFetch<ChatMessage[]>(`/api/sessions/${encodeURIComponent(id)}/messages`);
  getAgentProfile = () => apiFetch<AgentProfile>('/api/agent');
  updateAgentProfile = (updates: Partial<AgentProfile>) => apiFetch<AgentProfile>('/api/agent', { method: 'PATCH', body: JSON.stringify(updates) });
  getTasks = () => apiFetch<TaskItem[]>('/api/tasks');
  getSecurityApprovals = () => apiFetch<SecurityApproval[]>('/api/security/approvals');
  getSystemStats = () => apiFetch<SystemStats>('/api/stats');
  resolveSecurityApproval = (id: string, decision: 'approved' | 'rejected') => apiFetch<void>(`/api/security/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ decision }) });
  async sendMessage(id: string, content: string, onChunk?: (text: string, replace?: boolean) => void): Promise<ChatMessage> {
    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/turns`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      if (response.status === 401) window.dispatchEvent(new Event('muse:unauthorized'));
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
