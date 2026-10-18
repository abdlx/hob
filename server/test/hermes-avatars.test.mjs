import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../app.mjs';
import { HermesClient } from '../hermes-client.mjs';
import { avatarUrl, clearAvatar, readAvatar, setAvatar } from '../hermes-avatars.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic')]);
const dataUrl = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`;

let root, app, upstream, origin, cookie, previousHome;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hob-avatar-'));
  await mkdir(path.join(root, 'profiles', 'coder'), { recursive: true });
  previousHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = root;
  upstream = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${upstream.address().port}`;
  const hermes = new HermesClient({ runtimeUrl: url, dashboardUrl: url, apiKey: 'runtime-secret', dashboardToken: 'dashboard-secret' });
  const gateway = new EventEmitter();
  gateway.connected = false;
  gateway.request = () => { throw new Error('Avatar routes must not call OpenClaw RPC.'); };
  app = createApp({ gateway, hermes, password: 'synthetic-hob-login' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'synthetic-hob-login' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  for (const server of [app, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (previousHome === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

test('avatar assets are written to the native per-profile location with a sniffed extension', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'hob-avatar-home-'));
  try {
    await mkdir(path.join(home, 'profiles', 'coder'), { recursive: true });
    assert.equal(await readAvatar(home, 'coder'), null);
    await setAvatar(home, 'coder', dataUrl('image/png', PNG));
    assert.deepEqual((await readFile(path.join(home, 'profiles', 'coder', 'assets', 'avatar.png'))), PNG);
    const stored = await readAvatar(home, 'coder');
    assert.equal(stored.ext, 'png');
    assert.equal(stored.filename, path.join(home, 'profiles', 'coder', 'assets', 'avatar.png'));
    assert.equal(stored.size, PNG.length);
    assert.equal(stored.mime, 'image/png');
    // A second format replaces the first; the stale file never lingers.
    await setAvatar(home, 'coder', dataUrl('image/jpeg', JPEG));
    assert.match(await avatarUrl(home, 'coder'), /^\/api\/hermes\/profiles\/coder\/avatar\/image\?v=\d+$/);
    await assert.rejects(readFile(path.join(home, 'profiles', 'coder', 'assets', 'avatar.png')), { code: 'ENOENT' });
    assert.equal((await clearAvatar(home, 'coder')).removed, 1);
    assert.equal(await readAvatar(home, 'coder'), null);
    // The default profile owns its asset directly under the home, not under profiles/.
    await setAvatar(home, 'default', dataUrl('image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])));
    assert.equal((await readAvatar(home, 'default')).ext, 'webp');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('avatar writes refuse non-images, oversize payloads, and unknown bots', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'hob-avatar-reject-'));
  try {
    await mkdir(path.join(home, 'profiles', 'coder'), { recursive: true });
    for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('not an image')]) {
      await assert.rejects(setAvatar(home, 'coder', dataUrl('image/png', bytes)), { code: 'INVALID_AVATAR' });
    }
    await assert.rejects(setAvatar(home, 'coder', `data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024).toString('base64')}`), { code: 'INVALID_AVATAR' });
    await assert.rejects(setAvatar(home, 'ghost', dataUrl('image/png', PNG)), { code: 'BOT_NOT_FOUND' });
    assert.equal(await avatarUrl(home, 'coder'), '');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('avatar routes require authentication and origin checks before any write', async () => {
  assert.equal((await fetch(`${origin}/api/hermes/profiles/coder/avatar`)).status, 401);
  const cross = await fetch(`${origin}/api/hermes/profiles/coder/avatar`, {
    method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
    body: JSON.stringify({ data: dataUrl('image/png', PNG) }),
  });
  assert.equal(cross.status, 403);
  assert.equal((await readAvatar(root, 'coder')), null);
});

test('avatar routes round-trip a device upload for the selected bot', async () => {
  const put = await fetch(`${origin}/api/hermes/profiles/coder/avatar`, {
    method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ data: dataUrl('image/png', PNG) }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).mime, 'image/png');
  const meta = await (await fetch(`${origin}/api/hermes/profiles/coder/avatar`, { headers: { Cookie: cookie } })).json();
  assert.equal(meta.found, true);
  const image = await fetch(`${origin}/api/hermes/profiles/coder/avatar/image`, { headers: { Cookie: cookie } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  const removed = await fetch(`${origin}/api/hermes/profiles/coder/avatar`, { method: 'DELETE', headers: { Cookie: cookie, Origin: origin } });
  assert.equal((await removed.json()).removed, 1);
  assert.equal((await fetch(`${origin}/api/hermes/profiles/coder/avatar/image`, { headers: { Cookie: cookie } })).status, 404);
});
