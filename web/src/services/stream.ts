import type { ChatMessage } from '../types/chat';

// Decode complete SSE frames rather than treating network reads as messages.
export async function readTurnStream(body: ReadableStream<Uint8Array>, onChunk?: (text: string, replace?: boolean) => void): Promise<ChatMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let message: ChatMessage | undefined;
  const consume = (frame: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const payload = JSON.parse(data.join('\n'));
    if (event === 'delta' && typeof payload.text === 'string') onChunk?.(payload.text, payload.replace === true);
    if (event === 'done') message = payload.message;
    if (event === 'error') throw new Error(payload.message || 'The agent turn failed.');
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!message || typeof message.content !== 'string') throw new Error('The connection ended before the agent finished. Check Activity before retrying.');
    return message;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
