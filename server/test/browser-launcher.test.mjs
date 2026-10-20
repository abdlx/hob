// Executable discovery for the Linux production image. The Hermes image installs
// Chromium through Playwright, under a revisioned directory; a resolver that only
// looks at the root of the tool store passes every Windows test and fails the
// actual deployment. These tests build the shipped layout and assert discovery.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxCandidates, resolveChromiumExecutable } from '../browser-executable.mjs';

async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'hob-launcher-'));
  await mkdir(join(root, 'chromium-1194', 'chrome-linux'), { recursive: true });
  const executable = join(root, 'chromium-1194', 'chrome-linux', 'chrome');
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o755);
  return { root, executable };
}

test('the Linux candidate list includes the Playwright revision directory', async () => {
  const { root, executable } = await layout();
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = root;
  try {
    assert.ok(linuxCandidates().includes(executable));
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves Chromium in the Playwright layout used by the production image',
  { skip: process.platform === 'win32' ? 'The Windows resolver has its own candidates.' : false },
  async () => {
    const { root, executable } = await layout();
    const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = root;
    try {
      assert.equal(await resolveChromiumExecutable(), executable);
    } finally {
      if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
