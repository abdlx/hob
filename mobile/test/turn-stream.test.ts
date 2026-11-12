import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTurnStream } from '../src/turn-stream.ts';

function body(text: string, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close(); } });
}
test('native replies decode fragmented UTF-8 and CRLF frames, acceptance, activity, replacements, and completion', async () => {
  const frames = ': keepalive\r\n\r\nevent: accepted\r\ndata: {"runId":"run-1"}\r\n\r\nevent: activity\r\ndata: {"label":"Searching…"}\r\n\r\nevent: delta\r\ndata: {"text":"Hello 🌿"}\r\n\r\nevent: delta\r\ndata: {"text":"Final","replace":true}\r\n\r\nevent: done\r\ndata: {"message":{"id":"reply","role":"assistant","content":"Final","timestamp":""}}\r\n\r\n';
  const chunks: unknown[] = [], activity: string[] = [], accepted: string[] = [];
  const result = await readTurnStream(body(frames), (text, replace) => chunks.push([text, replace]), value => activity.push(value.label), id => accepted.push(id));
  assert.equal(result.content, 'Final'); assert.deepEqual(chunks, [['Hello 🌿', false], ['Final', true]]); assert.deepEqual(activity, ['Searching…']); assert.deepEqual(accepted, ['run-1']);
});
test('an interrupted or failed stream is never reported as a successful empty reply', async () => {
  await assert.rejects(readTurnStream(body('event: delta\ndata: {"text":"partial"}\n\n')), /refresh history/i);
  await assert.rejects(readTurnStream(body('event: error\ndata: {"message":"Approval denied"}\n\n')), /Approval denied/);
  await assert.rejects(readTurnStream(body('event: done\ndata: {"message":{}}\n\n')), /refresh history/i);
});
