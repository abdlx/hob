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
import { discoverExtensions, launchChromium } from '../browser-launcher.mjs';
import { EventEmitter } from 'node:events';

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

test('discoverExtensions returns empty array when directory does not exist or is empty', async () => {
  await withRoot(async root => {
    assert.deepEqual(await discoverExtensions(root), []);
    await mkdir(join(root, 'extensions'), { recursive: true });
    assert.deepEqual(await discoverExtensions(root), []);
  });
});

test('discoverExtensions discovers valid unpacked extensions and skips invalid ones', async () => {
  await withRoot(async root => {
    const extDir1 = join(root, 'extensions', 'ext1');
    const extDir2 = join(root, 'extensions', 'ext2');
    const invalidNoManifest = join(root, 'extensions', 'no-manifest');
    const invalidBadJson = join(root, 'extensions', 'bad-json');
    const invalidMissingFields = join(root, 'extensions', 'missing-fields');
    const hiddenDir = join(root, 'extensions', '.hidden-ext');

    await mkdir(extDir1, { recursive: true });
    await writeFile(join(extDir1, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Ext 1', version: '1.0' }));

    await mkdir(extDir2, { recursive: true });
    await writeFile(join(extDir2, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'Ext 2', version: '2.0' }));

    await mkdir(invalidNoManifest, { recursive: true });
    await writeFile(join(invalidNoManifest, 'readme.txt'), 'no manifest here');

    await mkdir(invalidBadJson, { recursive: true });
    await writeFile(join(invalidBadJson, 'manifest.json'), 'not json');

    await mkdir(invalidMissingFields, { recursive: true });
    await writeFile(join(invalidMissingFields, 'manifest.json'), JSON.stringify({ name: 'No version' }));

    await mkdir(hiddenDir, { recursive: true });
    await writeFile(join(hiddenDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Hidden', version: '1.0' }));

    const discovered = await discoverExtensions(root);
    assert.deepEqual(discovered, [extDir1, extDir2]);
  });
});

test('discoverExtensions discovers extension at the root of extensions directory', async () => {
  await withRoot(async root => {
    const extensionsDir = join(root, 'extensions');
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(join(extensionsDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Root Ext', version: '1.0' }));

    const discovered = await discoverExtensions(root);
    assert.deepEqual(discovered, [extensionsDir]);
  });
});

test('launchChromium uses --disable-extensions when no extensions exist', async () => {
  await withRoot(async root => {
    let capturedArgs = null;
    try {
      await launchChromium({
        profileDir: root,
        executablePath: '/bin/true',
        attempts: 1,
        transport: 'pipe',
        spawnChild: (_exe, args) => {
          capturedArgs = args;
          const child = new EventEmitter();
          child.exitCode = 1;
          child.signalCode = null;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          return child;
        },
      });
    } catch { /* expected launch failure */ }

    assert.ok(capturedArgs, 'spawnChild was called');
    assert.ok(capturedArgs.includes('--disable-extensions'));
    assert.ok(!capturedArgs.some(a => a.startsWith('--load-extension=')));
    assert.ok(!capturedArgs.some(a => a.startsWith('--disable-extensions-except=')));
  });
});

test('launchChromium omits --disable-extensions and adds extension flags when extensions exist', async () => {
  await withRoot(async root => {
    const ext1 = join(root, 'extensions', 'ext1');
    const ext2 = join(root, 'extensions', 'ext2');
    await mkdir(ext1, { recursive: true });
    await writeFile(join(ext1, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Ext 1', version: '1.0' }));
    await mkdir(ext2, { recursive: true });
    await writeFile(join(ext2, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Ext 2', version: '2.0' }));

    let capturedArgs = null;
    try {
      await launchChromium({
        profileDir: root,
        executablePath: '/bin/true',
        attempts: 1,
        transport: 'pipe',
        spawnChild: (_exe, args) => {
          capturedArgs = args;
          const child = new EventEmitter();
          child.exitCode = 1;
          child.signalCode = null;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          return child;
        },
      });
    } catch { /* expected launch failure */ }

    assert.ok(capturedArgs, 'spawnChild was called');
    assert.ok(!capturedArgs.includes('--disable-extensions'), '--disable-extensions should be omitted');
    const expectedList = `${ext1},${ext2}`;
    assert.ok(capturedArgs.includes(`--load-extension=${expectedList}`));
    assert.ok(capturedArgs.includes(`--disable-extensions-except=${expectedList}`));
  });
});

test('launchChromium maintains --disable-extensions when HOB_ENABLE_EXTENSIONS is "false"', async () => {
  await withRoot(async root => {
    const ext1 = join(root, 'extensions', 'ext1');
    await mkdir(ext1, { recursive: true });
    await writeFile(join(ext1, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Ext 1', version: '1.0' }));

    const previous = process.env.HOB_ENABLE_EXTENSIONS;
    process.env.HOB_ENABLE_EXTENSIONS = 'false';
    try {
      let capturedArgs = null;
      try {
        await launchChromium({
          profileDir: root,
          executablePath: '/bin/true',
          attempts: 1,
          transport: 'pipe',
          spawnChild: (_exe, args) => {
            capturedArgs = args;
            const child = new EventEmitter();
            child.exitCode = 1;
            child.signalCode = null;
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            return child;
          },
        });
      } catch { /* expected launch failure */ }

      assert.ok(capturedArgs, 'spawnChild was called');
      assert.ok(capturedArgs.includes('--disable-extensions'), '--disable-extensions must be maintained');
      assert.ok(!capturedArgs.some(a => a.startsWith('--load-extension=')));
      assert.ok(!capturedArgs.some(a => a.startsWith('--disable-extensions-except=')));
    } finally {
      if (previous === undefined) delete process.env.HOB_ENABLE_EXTENSIONS;
      else process.env.HOB_ENABLE_EXTENSIONS = previous;
    }
  });
});
