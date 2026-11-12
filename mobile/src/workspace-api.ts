import { fetch } from 'expo/fetch';
import { instanceRequest } from './api';
import type { Connection } from './connection';
import { sameInstance } from './connection';
import { readTurnStream } from './turn-stream';
import type { ChatMessage, TurnActivity } from './workspace-types';

/** A client captures its owner. Switching bots cannot redirect an in-flight write. */
export function workspaceApi(connection: Connection, profile: string) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Select a valid bot.');
  const request = <T,>(path: string, method = 'GET', value?: unknown, signal?: AbortSignal) =>
    instanceRequest<T>(connection.origin, path, { token: connection.token, profile, method, value, signal });
  const path = (operation: string, query: Record<string, string> = {}) =>
    `/api/hermes/workspace/${operation}?${new URLSearchParams({ ...query, profile })}`;
  return {
    request, path,
    workspace: <T,>(operation: string, method = 'GET', value?: unknown, query?: Record<string, string>, signal?: AbortSignal) => request<T>(path(operation, query), method, value, signal),
    async send(id: string, content: string, attachments: string[], requestKey: string, signal: AbortSignal,
      onChunk: (text: string, replace?: boolean) => void, onActivity: (activity: TurnActivity) => void, onAccepted: (id: string) => void): Promise<ChatMessage> {
      // No timeout or automatic replay: the bot may work for minutes after admission.
      const response = await fetch(`${connection.origin}/api/sessions/${encodeURIComponent(id)}/turns`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${connection.token}`, 'X-Hob-Profile': profile, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ content, attachments, idempotencyKey: requestKey }),
      });
      if (!sameInstance(response.url || connection.origin, connection.origin)) throw new Error('The server redirected to another instance.');
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error?.message || body.error || body.message || `The instance returned HTTP ${response.status}.`);
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('The instance did not return a live reply. Check history before resending.');
      return readTurnStream(response.body, onChunk, onActivity, onAccepted);
    },
  };
}
