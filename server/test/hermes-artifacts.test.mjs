import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link, cp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createArtifactPublisher, resultFileReferences } from '../hermes-artifacts.mjs';

test('20 generated files reopen after publisher restart, deduplicate, and retain scoped delivery receipts', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), workspaceRoot = path.join(home, 'workspaces'), stateDir = path.join(root, 'state');
  await mkdir(path.join(home, 'profiles', 'writer', 'cache'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'bots', 'writer'), { recursive: true });
  const options = { home, workspaceRoot, stateDir, authorize: async profile => { assert.equal(profile, 'writer'); } };
  const publisher = createArtifactPublisher(options), receipts = [];
  for (let index = 0; index < 20; index++) {
    const source = path.join(home, 'profiles', 'writer', 'cache', `report-${index}.txt`);
    await writeFile(source, `result-${index}`);
    const receipt = await publisher.publish('writer', source, `run-${index}`); receipts.push(receipt);
    assert.equal((await publisher.publish('writer', source, `run-${index}`)).path, receipt.path);
  }
  const restarted = createArtifactPublisher(options);
  assert.equal((await restarted.list('writer')).length, 20);
  assert.equal((await readdir(path.join(workspaceRoot, 'bots', 'writer', 'artifacts'))).length, 20);
  for (const [index, receipt] of receipts.entries()) assert.equal(await readFile(path.join(workspaceRoot, 'bots', 'writer', receipt.path), 'utf8'), `result-${index}`);
  const restored = path.join(root, 'restored');
  await cp(workspaceRoot, path.join(restored, 'workspaces'), { recursive: true });
  await cp(stateDir, path.join(restored, 'state'), { recursive: true });
  const restoredPublisher = createArtifactPublisher({ ...options, workspaceRoot: path.join(restored, 'workspaces'), stateDir: path.join(restored, 'state') });
  assert.equal((await restoredPublisher.list('writer')).length, 20);
  for (const [index, receipt] of receipts.entries()) assert.equal(await readFile(path.join(restored, 'workspaces', 'bots', 'writer', receipt.path), 'utf8'), `result-${index}`);
  await mkdir(path.join(home, 'profiles', 'other'), { recursive: true });
  const secret = path.join(home, 'profiles', 'other', 'secret.txt'); await writeFile(secret, 'other-bot');
  await assert.rejects(publisher.publish('writer', secret, 'wrong-bot'));
  const linked = path.join(home, 'profiles', 'writer', 'cache', 'linked.txt'); await link(secret, linked);
  await assert.rejects(publisher.publish('writer', linked, 'linked'));
  assert.ok((await restarted.list('writer')).some(item => item.status === 'failed'));
});

test('result discovery ignores fenced examples and remote links', () => {
  assert.deepEqual(resultFileReferences('MEDIA: report.png\n[Download](report.pdf)\n```\nMEDIA: private.png\n```\n![remote](https://example.com/a.png)'), ['report.png', 'report.pdf']);
});
