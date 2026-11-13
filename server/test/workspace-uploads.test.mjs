import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { workspaceUploads } from '../workspace-uploads.mjs';

test('a restarted uploader resumes a folder above the legacy limit, scopes reads and publishes once', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hob-uploads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspaces');
  await mkdir(path.join(workspaceRoot, 'bots', 'dex'), { recursive: true });
  const options = { stateDir: root, workspaceRoot, reference: (key, filename, name, size) => ({ key, filename, name, size }) };
  let handler = workspaceUploads(options);
  const call = (method, query, value, key = 'chat1') => {
    const req = Readable.from(Buffer.isBuffer(value) ? [value] : []);
    req.method = method;
    return handler({ req, url: new URL('http://test/uploads?' + query), owner: { profile: 'dex' }, key,
      body: async () => value, json: (_res, _status, result) => result });
  };
  await assert.rejects(call('POST', '', { entries: [{ path: '../secret', size: 0 }] }), /path/);
  const block = Buffer.alloc(1024 * 1024, 87);
  const other = ['ai', 'xls', 'svg', 'pdf', 'docx', 'bin', 'txt', 'md', 'png', 'webp', 'xyz'].map(ext => ({ path: 'Design/a.' + ext, size: 0 }));
  const { id } = await call('POST', '', { entries: [{ path: 'Design/nested/art.psd', size: block.length * 6 }, ...other] });
  const query = 'id=' + id, entry = query + '&entry=0';
  await call('PUT', entry + '&offset=0', block);
  handler = workspaceUploads(options);
  assert.equal((await call('GET', entry)).offset, block.length);
  await assert.rejects(call('GET', entry, null, 'chat2'), /unavailable/);
  await assert.rejects(call('PUT', entry + '&offset=0', block), /offset/);
  await assert.rejects(call('POST', query), /incomplete/);
  for (let i = 1; i < 6; i++) await call('PUT', entry + '&offset=' + block.length * i, block);
  const receipt = await call('POST', query);
  assert.equal(receipt.name, 'Design');
  assert.deepEqual(await readFile(path.join(receipt.filename, 'nested/art.psd')), Buffer.alloc(6 * block.length, 87));
  assert.equal((await readFile(path.join(receipt.filename, 'a.xyz'))).length, 0);
  assert.deepEqual(await call('POST', query), receipt);
  const storage = await call('GET', '');
  assert.equal(storage.items[0].bytes, block.length * 6);
  assert.equal((await call('GET', query + '&details=1')).entries.length, 12);
  const pieces = [];
  const res = new Writable({ write(chunk, _, next) { pieces.push(chunk); next(); } });
  res.writeHead = (status, headers) => { assert.equal(status, 200); assert.match(headers['Content-Disposition'], /art.psd/); };
  await handler({ req: { method: 'GET' }, res, url: new URL('http://test/uploads?' + query + '&download=0'), owner: { profile: 'dex' }, key: 'chat1' });
  assert.deepEqual(Buffer.concat(pieces), Buffer.alloc(6 * block.length, 87));
  await assert.rejects(call('DELETE', query), /published/);
  await call('DELETE', query + '&remove=1');
  assert.deepEqual((await call('GET', '')).items, []);
});

