// Executable discovery for the Linux production image. The Hermes image installs
// Chrome for Testing via Playwright, under a revisioned `chrome-linux64` directory;
// a resolver that only looks at the root of the tool store passes every Windows
// test and fails the actual deployment. These tests build the shipped layout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChromiumExecutable, linuxCandidates, resolveChromiumExecutable } from '../browser-executable.mjs';

async function executableAt(...segments) {
  const file = join(...segments);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o755);
  return file;
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'hob-launcher-'));
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = root;
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('the Linux candidate list includes the shipped chrome-linux64 revision directory', async () => {
  await withRoot(async root => {
    const executable = await executableAt(root, 'chromium-1208', 'chrome-linux64', 'chrome');
    assert.ok(linuxCandidates().includes(executable));
  });
});

test('resolves Chromium in the chrome-linux64 layout shipped by the production image',
  { skip: process.platform === 'win32' ? 'The Windows resolver has its own candidates.' : false },
  async () => {
    await withRoot(async root => {
      const executable = await executableAt(root, 'chromium-1208', 'chrome-linux64', 'chrome');
      assert.equal(await resolveChromiumExecutable(), executable);
    });
  });

test('falls back to a bounded search for an unknown layout', async () => {
  await withRoot(async root => {
    const executable = await executableAt(root, 'runtime', 'browsers', 'custom', 'chrome');
    // The fallback is asserted directly: on a host that also has Chromium in
    // /opt/hermes/tools, the fixed candidates correctly win before the fallback.
    assert.equal(findChromiumExecutable(root), executable);
  });
});
