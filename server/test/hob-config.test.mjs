import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hobEnv, hobLocalHome } from '../hob-config.mjs';

test('legacy configuration migrates without overriding an explicit hob value or leaking old keys', () => {
  const previous = { MUSE_PASSWORD: 'synthetic-old', MUSE_PORT: '4567', HOB_PASSWORD: 'synthetic-new', HERMES_HOME: '/private' };
  assert.deepEqual(hobEnv(previous), { HOB_PASSWORD: 'synthetic-new', HOB_PORT: '4567', HERMES_HOME: '/private' });
  assert.equal(previous.MUSE_PASSWORD, 'synthetic-old');
});

test('local data rename preserves contents and refuses ambiguous upgrade roots', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.muse-data', 'hermes'), { recursive: true });
  await writeFile(path.join(root, '.muse-data', 'hermes', 'state'), 'retained');
  assert.equal(await hobLocalHome(root), path.join(root, '.hob-data', 'hermes'));
  assert.equal(await readFile(path.join(root, '.hob-data', 'hermes', 'state'), 'utf8'), 'retained');
  await mkdir(path.join(root, '.muse-data'));
  await assert.rejects(hobLocalHome(root), /Two local data directories/);
});
