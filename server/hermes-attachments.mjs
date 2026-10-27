import { createHmac, timingSafeEqual } from 'node:crypto';
import { HermesError } from './hermes-client.mjs';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const invalid = message => new HermesError(400, message, 'INVALID_ATTACHMENT');
const imageMime = bytes => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
  : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) ? 'image/gif'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;

/** Native staging + session-bound signed references, never caller-selected paths. */
export function createHermesAttachments({ bridge, client, secret, now = Date.now }) {
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  async function upload(owner, sessionKey, input) {
    if (!input || Object.keys(input).some(key => !['name', 'mime', 'base64'].includes(key))
      || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160 || /[\\/\u0000-\u001f]/.test(input.name)
      || typeof input.mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(input.mime)
      || typeof input.base64 !== 'string' || !input.base64.length || input.base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
      || input.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) throw invalid('Choose a file up to 5 MB with a valid name and content type.');
    const bytes = Buffer.from(input.base64, 'base64');
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== input.base64) throw invalid('Choose a nonempty file up to 5 MB.');
    const mime = imageMime(bytes);
    if (input.mime.startsWith('image/') && !mime) throw invalid('Use a PNG, JPEG, GIF or WebP image.');
    await client.credentialBinding(owner.profile);
    await bridge.rpc(owner.profile, 'session.resume', { session_id: owner.sessionId });
    const staged = await bridge.rpc(owner.profile, mime ? 'image.attach_bytes' : 'file.attach', {
      session_id: owner.sessionId, ...(mime ? { content_base64: input.base64, filename: input.name }
        : { data_url: `data:${input.mime};base64,${input.base64}`, name: input.name }),
    });
    if (staged.attached !== true || (mime ? typeof staged.path !== 'string' || staged.mime !== mime : typeof staged.ref_text !== 'string' || !staged.ref_text.startsWith('@file:'))) {
      throw new HermesError(502, 'Hermes did not confirm the uploaded attachment.', 'HERMES_PROTOCOL_ERROR');
    }
    const payload = Buffer.from(JSON.stringify({ sessionKey, expires: now() + 30 * 60_000,
      ...(mime ? { image: { path: staged.path, mime } } : { reference: staged.ref_text }) })).toString('base64url');
    return { id: `${payload}.${sign(payload)}`, name: input.name, mime: mime || input.mime, size: bytes.length };
  }
  function resolve(sessionKey, ids) {
    if (ids === undefined) return { images: [], references: [] };
    if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length) throw invalid('Attach up to 10 different files.');
    const images = [], references = [];
    for (const id of ids) {
      if (typeof id !== 'string' || id.length > 16000) throw invalid('Invalid attachment reference.');
      const parts = id.split('.'), [payload, signature] = parts, expected = sign(payload || '');
      if (parts.length !== 2 || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw invalid('This attachment is not valid for this instance.');
      let value;
      try { value = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw invalid('Invalid attachment reference.'); }
      if (value.sessionKey !== sessionKey || !Number.isFinite(value.expires) || value.expires < now()) throw invalid('This attachment expired or belongs to another conversation. Attach it again.');
      if (value.image) images.push(value.image); else if (value.reference) references.push(value.reference); else throw invalid('Invalid attachment reference.');
    }
    return { images, references };
  }
  return { upload, resolve };
}
