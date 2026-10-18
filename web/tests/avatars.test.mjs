import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AVATAR_MAX_BYTES, clearBotAvatar, getBotAvatar, readAvatarFile, setBotAvatar } from '../src/services/avatars.ts';

test('a device upload addresses the native per-bot avatar asset exactly once', async t => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    return new Response('{"found":true,"ok":true,"size":4,"mime":"image/png","removed":1}', { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  await setBotAvatar('coder', 'data:image/png;base64,iVBORw0KGgo=');
  await getBotAvatar('coder');
  await clearBotAvatar('coder');
  assert.deepEqual(calls.map(call => [call.method, new URL(call.url, 'http://hob.test').pathname]), [
    ['PUT', '/api/hermes/profiles/coder/avatar'],
    ['GET', '/api/hermes/profiles/coder/avatar'],
    ['DELETE', '/api/hermes/profiles/coder/avatar'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].body), { data: 'data:image/png;base64,iVBORw0KGgo=' });
});

test('a malformed bot name is refused before any request leaves the app', async t => {
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); };
  t.after(() => { globalThis.fetch = original; });
  assert.throws(() => setBotAvatar('../etc/passwd', 'data:image/png;base64,AAAA'), /Select a valid bot\./);
  assert.throws(() => getBotAvatar('coder/../default'), /Select a valid bot\./);
  assert.throws(() => clearBotAvatar('Coder'), /Select a valid bot\./);
  assert.equal(called, 0);
});

test('device uploads stay inside the formats and size the native asset store accepts', async () => {
  await assert.rejects(readAvatarFile(new File([new Uint8Array(4)], 'a.svg', { type: 'image/svg+xml' })), /PNG, JPEG, or WebP/);
  await assert.rejects(readAvatarFile(new File([new Uint8Array(4)], 'a.gif', { type: 'image/gif' })), /PNG, JPEG, or WebP/);
  await assert.rejects(readAvatarFile(new File([new Uint8Array(AVATAR_MAX_BYTES + 1)], 'big.png', { type: 'image/png' })), /up to 2 MB/);
  await assert.rejects(readAvatarFile(new File([], 'empty.png', { type: 'image/png' })), /up to 2 MB/);
});
