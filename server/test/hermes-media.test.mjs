import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHermesRoutes } from '../hermes-routes.mjs';
import { resolveMediaFile, serveHermesMedia } from '../hermes-media.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
let root, home, workspaces, stateDir;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'hob-media-'));
  home = path.join(root, 'hermes');
  workspaces = path.join(home, 'workspaces');
  stateDir = path.join(root, 'hob');
  await mkdir(path.join(home, 'cache', 'generated', 'images'), { recursive: true });
  await mkdir(path.join(home, 'profiles', 'scout', 'cache', 'screenshots'), { recursive: true });
  await mkdir(path.join(home, 'profiles', 'other'), { recursive: true });
  await mkdir(path.join(workspaces, 'main'), { recursive: true });
  await mkdir(path.join(workspaces, 'bots', 'scout'), { recursive: true });
  await mkdir(path.join(stateDir, 'media', 'browser'), { recursive: true });
  await writeFile(path.join(home, 'cache', 'generated', 'images', 'main.png'), PNG);
  await writeFile(path.join(home, 'profiles', 'scout', 'cache', 'screenshots', 'shot.png'), PNG);
  await writeFile(path.join(home, 'profiles', 'other', 'private.png'), PNG);
  await writeFile(path.join(workspaces, 'bots', 'scout', 'workspace.png'), PNG);
  await writeFile(path.join(workspaces, 'main', 'main-workspace.png'), PNG);
  await writeFile(path.join(stateDir, 'media', 'browser', 'capture.png'), PNG);
  await writeFile(path.join(home, 'profiles', 'scout', 'notes.txt'), 'not an image');
});

after(async () => { await rm(root, { recursive: true, force: true }); });

const options = value => ({ home, workspaces, stateDir, profile: 'scout', value });

test('resolves images in the selected profile home and its workspace', async () => {
  const homeShot = await resolveMediaFile(options(path.join(home, 'profiles', 'scout', 'cache', 'screenshots', 'shot.png')));
  assert.equal(homeShot.mime, 'image/png');
  assert.deepEqual(await readFile(homeShot.filename), PNG);
  const workspaceShot = await resolveMediaFile(options('workspace.png'));
  assert.equal(workspaceShot.filename, path.join(workspaces, 'bots', 'scout', 'workspace.png'));
});

test('resolves file URLs and HOB browser captures', async () => {
  const viaUrl = await resolveMediaFile(options(pathToFileURL(path.join(home, 'profiles', 'scout', 'cache', 'screenshots', 'shot.png')).href));
  assert.equal(viaUrl.name, 'shot.png');
  const capture = await resolveMediaFile(options(path.join(stateDir, 'media', 'browser', 'capture.png')));
  assert.equal(capture.name, 'capture.png');
});

test('default profile uses the main workspace and cannot read another profile through its home', async () => {
  const main = await resolveMediaFile({ home, workspaces, stateDir, profile: 'default', value: 'main-workspace.png' });
  assert.equal(main.name, 'main-workspace.png');
  const generated = await resolveMediaFile({ home, workspaces, stateDir, profile: 'default', value: 'cache/generated/images/main.png' });
  assert.equal(generated.name, 'main.png');
  await assert.rejects(() => resolveMediaFile({ home, workspaces, stateDir, profile: 'default',
    value: path.join(home, 'profiles', 'scout', 'cache', 'screenshots', 'shot.png') }), /unavailable/);
});

test('rejects another profile, traversal, non-images and missing files', async () => {
  await assert.rejects(() => resolveMediaFile(options(path.join(home, 'profiles', 'other', 'private.png'))), /unavailable/);
  await assert.rejects(() => resolveMediaFile(options('../../profiles/other/private.png')), /unavailable/);
  await assert.rejects(() => resolveMediaFile(options(path.join(home, 'profiles', 'scout', 'notes.txt'))), /unavailable/);
  await assert.rejects(() => resolveMediaFile(options('missing.png')), /unavailable/);
});

test('rejects a symlink that leaves the selected root', async (t) => {
  const link = path.join(home, 'profiles', 'scout', 'escape.png');
  try { await symlink(path.join(home, 'profiles', 'other', 'private.png'), link); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Symlinks are not available to this user.'); return; } throw error; }
  await assert.rejects(() => resolveMediaFile(options(link)), /unavailable/);
});

test('serves image bytes with private, non-sniffing headers', async () => {
  const res = { status: 0, headers: {}, body: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  await serveHermesMedia({ method: 'GET' }, res, options(path.join(home, 'profiles', 'scout', 'cache', 'screenshots', 'shot.png')));
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(res.headers['Cache-Control'], /private/);
  assert.equal(res.headers['Content-Security-Policy'], "default-src 'none'; sandbox");
  assert.deepEqual(res.body, PNG);
});

test('the authenticated Hermes route binds media to the selected profile', async () => {
  const route = createHermesRoutes({}, { has: name => name === 'scout' }, { home, stateDir });
  const res = { status: 0, headers: {}, body: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  const url = new URL(`http://hob.local/api/hermes/media?profile=scout&path=${encodeURIComponent('workspace.png')}`);
  await route({ method: 'GET' }, res, url, { json() {}, body() {}, startEvents() {}, sendEvent() {} });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, PNG);
  await assert.rejects(() => route({ method: 'GET' }, { writeHead() {}, end() {} },
    new URL('http://hob.local/api/hermes/media?profile=other&path=workspace.png'),
    { json() {}, body() {}, startEvents() {}, sendEvent() {} }), /no longer exists/);
});


test('media follows external isolated workspaces while keeping bot ownership',async()=>{
 const external=path.join(root,'isolated-workspaces');
 await mkdir(path.join(external,'bots','scout'),{recursive:true});
 const image=path.join(external,'bots','scout','proof.png'); await writeFile(image,PNG);
 const route=createHermesRoutes({}, {has:name=>name==='scout'}, {home,stateDir,workspaces:external});
 const res={writeHead(status){this.status=status;},end(bytes){this.bytes=bytes;}};
 await route({method:'GET'},res,new URL('http://local/api/hermes/media?profile=scout&path='+encodeURIComponent(image)),{json(){}});
 assert.equal(res.status,200); assert.deepEqual(res.bytes,PNG);
 await assert.rejects(resolveMediaFile({home,stateDir,workspaces:external,profile:'default',value:image}),/unavailable/);
 await assert.rejects(resolveMediaFile({home,stateDir,workspaces,profile:'default',value:path.join(workspaces,'bots','scout','workspace.png')}),/unavailable/);
});
