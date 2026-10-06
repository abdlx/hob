import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTurnStream } from '../src/services/stream.ts';

const finalMessage = { id: 'answer', role: 'assistant', content: 'Hello 🌍', timestamp: '', status: 'complete' };
function stream(bytes, step = bytes.length) {
  return new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.slice(i, i + step)); controller.close(); } });
}
test('incremental SSE frames, UTF-8, CRLF and replacement survive one-byte network reads', async () => {
  const frames = ': heartbeat\r\n\r\nevent: accepted\r\ndata: {"runId":"r"}\r\n\r\nevent: delta\r\ndata: {"text":"Old"}\r\n\r\nevent: delta\r\ndata: {"text":"Hello 🌍","replace":true}\r\n\r\nevent: done\r\ndata: ' + JSON.stringify({ message: finalMessage }) + '\r\n\r\n';
  const chunks = [];
  const result = await readTurnStream(stream(new TextEncoder().encode(frames), 1), (text, replace) => chunks.push({ text, replace }));
  assert.deepEqual(chunks, [{ text: 'Old', replace: false }, { text: 'Hello 🌍', replace: true }]);
  assert.deepEqual(result, finalMessage);
});
test('an upstream error fails the turn and releases the stream reader', async () => {
  const body = stream(new TextEncoder().encode('event: error\ndata: {"message":"Provider credential missing"}\n\n'));
  await assert.rejects(readTurnStream(body), /Provider credential missing/);
  assert.equal(body.locked, false);
});
test('a dropped connection cannot report a partial answer as completed', async () => {
  await assert.rejects(readTurnStream(stream(new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'))), /before the agent finished/);
});
