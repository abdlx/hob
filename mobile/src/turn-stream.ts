import type { ChatMessage, TurnActivity } from './workspace-types';

export async function readTurnStream(body: ReadableStream<Uint8Array>, onChunk?: (text: string, replace?: boolean) => void,
  onActivity?: (activity: TurnActivity) => void, onAccepted?: (id: string) => void): Promise<ChatMessage> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', message: ChatMessage | undefined;
  const consume = (frame: string) => {
    let event = 'message'; const data: string[] = [];
    for (const raw of frame.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const payload = JSON.parse(data.join('\n'));
    if (event === 'accepted' && typeof payload.runId === 'string') onAccepted?.(payload.runId);
    if (event === 'activity' && typeof payload.label === 'string') onActivity?.(payload);
    if (event === 'delta' && typeof payload.text === 'string') onChunk?.(payload.text, payload.replace === true);
    if (event === 'done') message = payload.message;
    if (event === 'error') throw new Error(payload.message || 'The agent turn failed.');
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (buffer.length > 2 * 1024 * 1024) throw new Error('The live reply frame is too large. Refresh history.');
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!message || typeof message.content !== 'string') throw new Error('The live connection ended. Your bot may still be working; refresh history before resending.');
    return message;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
