import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHermesAttachments, MAX_ATTACHMENT_BYTES } from '../hermes-attachments.mjs';

const owner = { profile: 'writer', sessionId: 'native-session' }, key = 'canonical-session-key';
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
function fixture() {
  const calls = [], client = { credentialBinding: async profile => { assert.equal(profile, 'writer'); } };
  const bridge = { rpc: async (profile, method, params) => {
    calls.push({ profile, method, params });
    if (method === 'session.resume') return {};
    if (method === 'image.attach_bytes') return { attached: true, path: '/native/writer/cache/images/upload.png', mime: 'image/png' };
    if (method === 'file.attach') return { attached: true, ref_text: '@file:"attachments/report.pdf"' };
    throw new Error('Unexpected method');
  } };
  let now = 100;
  return { calls, service: createHermesAttachments({ client, bridge, secret: 'server-only-key', now: () => now }), expire: () => { now += 31 * 60_000; } };
}
test('uploads stage through only the native owner and signed references cannot cross conversations or be tampered with', async () => {
  const f = fixture(), file = await f.service.upload(owner, key, { name: 'photo.png', mime: 'image/png', base64: image.toString('base64') });
  assert.equal(file.size, image.length); assert.equal(file.mime, 'image/png'); assert.equal(file.name, 'photo.png');
  assert.deepEqual(f.calls.map(call => [call.profile, call.method]), [['writer', 'session.resume'], ['writer', 'image.attach_bytes']]);
  assert.deepEqual(f.service.resolve(key, [file.id]), { images: [{ path: '/native/writer/cache/images/upload.png', mime: 'image/png' }], references: [] });
  for (const id of [file.id + '.', file.id + 'x', file.id.split('.')[0] + '.' + '😈'.repeat(43), file.id.replace(/^./, 'x')]) assert.throws(() => f.service.resolve(key, [id]), error => error.status === 400);
  assert.throws(() => f.service.resolve('another-session', [file.id]), error => error.status === 400);
  f.expire(); assert.throws(() => f.service.resolve(key, [file.id]), error => error.status === 400);
});
test('documents use native file.attach and return literal references, never caller paths', async () => {
  const f = fixture(), file = await f.service.upload(owner, key, { name: 'report.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-proof').toString('base64') });
  assert.deepEqual(f.service.resolve(key, [file.id]), { images: [], references: ['@file:"attachments/report.pdf"'] });
  assert.equal(f.calls[1].params.data_url, 'data:application/pdf;base64,' + Buffer.from('%PDF-proof').toString('base64'));
  assert.equal(f.calls[1].params.path, undefined);
});
test('attachment count, upload bounds, base64, unsupported images and path injection fail before native staging', async () => {
  const f = fixture();
  for (const value of [
    { name: '../secret', mime: 'text/plain', base64: 'dGVzdA==' }, { name: 'file', mime: 'text/plain', base64: '!!!=' },
    { name: 'fake.jpg', mime: 'image/jpeg', base64: Buffer.from('not an image').toString('base64') },
    { name: 'huge.pdf', mime: 'application/pdf', base64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') },
    { name: 'file', mime: 'text/plain', base64: 'dGVzdA==', path: '/private/secret' },
  ]) await assert.rejects(f.service.upload(owner, key, value), error => error.status === 400);
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.service.resolve(key, Array(11).fill('id')), error => error.status === 400);
});
