import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserRegistry, preferredPortFor, validBotId } from '../browser-registry.mjs';

// The unit tests never touch real ports: the probe is injected so a busy machine
// (or a parallel test process holding a bot's port) cannot change the result.
const freePort = () => true;

async function withState(run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'hob-browser-registry-'));
  try { await run(stateDir); } finally { await rm(stateDir, { recursive: true, force: true }); }
}

test('registry: a bot gets a stable profile id, port and token, persisted across reopen', async () => {
  await withState(async stateDir => {
    const registry = await BrowserRegistry.open({ stateDir });
    const created = await registry.getOrCreate('alpha', { portFree: freePort });
    assert.match(created.browserProfileId, /^br-[a-f0-9]{16}$/);
    assert.match(created.gatewayToken, /^[a-f0-9]{32}$/);
    assert.equal(created.gatewayPort, preferredPortFor('alpha', stateDir));

    const reopened = await BrowserRegistry.open({ stateDir });
    const again = await reopened.getOrCreate('alpha', { portFree: freePort });
    assert.deepEqual(again, created, 'the same bot must keep the same port and token');

    // Asking twice must not create a second roster entry.
    assert.equal(reopened.list().length, 1);
  });
});

test('registry: a port that is already taken is walked past, not fought over', async () => {
  await withState(async stateDir => {
    const registry = await BrowserRegistry.open({ stateDir });
    const preferred = preferredPortFor('alpha', stateDir);
    // Something else already holds this bot's preferred port: another HOB
    // instance, a leftover process, or an unrelated service.
    const busy = new Set([preferred]);
    const record = await registry.getOrCreate('alpha', { portFree: async port => !busy.has(port) });
    assert.notEqual(record.gatewayPort, preferred, 'a taken port must not be chosen');
    assert.ok(record.gatewayPort >= 32100 && record.gatewayPort <= 32999);
    // The chosen port is what the bot keeps: it is not re-decided on every read.
    assert.equal((await registry.getOrCreate('alpha', { portFree: async () => false })).gatewayPort, record.gatewayPort);
  });
});

test('registry: two installs prefer different ports for the same bot name', async () => {
  // Otherwise a development tree and a deployed tree would both start their search
  // at the same port for their shared `default` bot and race for it.
  const first = preferredPortFor('default', 'C:\\state\\one');
  const second = preferredPortFor('default', 'C:\\state\\two');
  assert.notEqual(first, second);
  // Stable within one install, which is what the profile's `cdp_url` depends on.
  assert.equal(preferredPortFor('default', 'C:\\state\\one'), first);
});

test('registry: the file is written atomically, owner-only, and holds no page data', async () => {
  await withState(async stateDir => {
    const registry = await BrowserRegistry.open({ stateDir });
    await registry.getOrCreate('alpha');
    const filename = join(stateDir, 'browsers.json');
    const info = await stat(filename);
    if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
    const raw = await readFile(filename, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.browsers.length, 1);
    assert.deepEqual(Object.keys(parsed.browsers[0]).sort(),
      ['bot', 'browserProfileId', 'createdAt', 'gatewayPort', 'gatewayToken', 'lastActiveAt', 'storageVersion']);
  });
});

test('registry: only lastActiveAt is writable, and unknown bots are rejected', async () => {
  await withState(async stateDir => {
    const registry = await BrowserRegistry.open({ stateDir });
    await registry.getOrCreate('alpha');
    const updated = await registry.update('alpha', { lastActiveAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(updated.lastActiveAt, '2026-01-01T00:00:00.000Z');
    await assert.rejects(() => registry.update('alpha', { gatewayPort: 1 }), /not writable/);
    await assert.rejects(() => registry.update('missing', { lastActiveAt: null }), /no browser record/);
    assert.equal(registry.get('missing'), null);
  });
});

test('registry: a recreated bot name receives a new, non-inheriting profile path', async () => {
  await withState(async stateDir => {
    const registry = await BrowserRegistry.open({ stateDir });
    const first = await registry.getOrCreate('alpha');
    const firstPath = registry.profileDir(stateDir, 'alpha');
    assert.equal(firstPath, join(stateDir, 'browsers', 'alpha', first.browserProfileId, 'chromium'));
    assert.equal(await registry.remove('alpha'), true);
    assert.equal(await registry.remove('alpha'), false);
    assert.equal(registry.list().length, 0);
    assert.throws(() => registry.profileDir(stateDir, 'alpha'), /no browser record/);

    const second = await registry.getOrCreate('alpha');
    const secondPath = registry.profileDir(stateDir, 'alpha');
    assert.notEqual(second.browserProfileId, first.browserProfileId);
    assert.notEqual(secondPath, firstPath, 'name reuse must not reuse the deleted bot\'s browser data');
  });
});

test('registry: existing version-1 records keep their legacy profile path', async () => {
  await withState(async stateDir => {
    const filename = join(stateDir, 'browsers.json');
    const registry = await BrowserRegistry.open({ stateDir });
    await registry.getOrCreate('alpha');
    const parsed = JSON.parse(await readFile(filename, 'utf8'));
    delete parsed.browsers[0].storageVersion;
    await writeFile(filename, JSON.stringify(parsed));

    const reopened = await BrowserRegistry.open({ stateDir });
    assert.equal(reopened.profileDir(stateDir, 'alpha'), join(stateDir, 'browsers', 'alpha', 'chromium'));
  });
});

test('registry: bot ids are validated before they can become a path', () => {
  for (const good of ['alpha', 'bot-1', 'a_b', '0x', 'a'.repeat(64)]) assert.equal(validBotId(good), true, good);
  for (const bad of ['..', '../../etc', 'a/b', 'a\\b', '.hidden', 'a b', '', 'A', 'a'.repeat(65), null, 42, 'a\nb']) {
    assert.equal(validBotId(bad), false, String(bad));
  }
});

test('registry: a tampered record is refused rather than trusted', async () => {
  await withState(async stateDir => {
    const filename = join(stateDir, 'browsers.json');
    const registry = await BrowserRegistry.open({ stateDir });
    await registry.getOrCreate('alpha');
    const parsed = JSON.parse(await readFile(filename, 'utf8'));

    const cases = [
      { ...parsed, browsers: [{ ...parsed.browsers[0], bot: '../../escape' }] },
      { ...parsed, browsers: [{ ...parsed.browsers[0], gatewayToken: 'short' }] },
      { ...parsed, browsers: [{ ...parsed.browsers[0], gatewayPort: 99999 }] },
      { ...parsed, browsers: [{ ...parsed.browsers[0], storageVersion: 99 }] },
      { ...parsed, browsers: [parsed.browsers[0], parsed.browsers[0]] },
      { ...parsed, version: 2 },
      { ...parsed, browsers: 'nope' },
    ];
    for (const tampered of cases) {
      await writeFile(filename, JSON.stringify(tampered));
      await assert.rejects(() => BrowserRegistry.open({ stateDir }), /Invalid browser registry/, JSON.stringify(tampered).slice(0, 80));
    }
  });
});

test('registry: distinct bots get distinct ports and tokens', async () => {
  await withState(async stateDir => {
    const registry = await BrowserRegistry.open({ stateDir });
    const bots = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const records = await Promise.all(bots.map(bot => registry.getOrCreate(bot)));
    assert.equal(new Set(records.map(record => record.gatewayPort)).size, bots.length);
    assert.equal(new Set(records.map(record => record.gatewayToken)).size, bots.length);
    assert.equal(new Set(records.map(record => record.browserProfileId)).size, bots.length);
  });
});

test('registry: concurrent allocations resolve preferred-port collisions', async () => {
  await withState(async stateDir => {
    const registry = await BrowserRegistry.open({ stateDir });
    const candidates = new Map();
    let collision;
    for (let index = 0; index <= 900; index += 1) {
      const bot = `bot-${index}`;
      const port = preferredPortFor(bot, stateDir);
      if (candidates.has(port)) { collision = [candidates.get(port), bot]; break; }
      candidates.set(port, bot);
    }
    assert.ok(collision);
    const records = await Promise.all(collision.map(bot => registry.getOrCreate(bot, { portFree: freePort })));
    assert.notEqual(records[0].gatewayPort, records[1].gatewayPort);
  });
});

test('registry: a profile path cannot redirect into another bot through a junction or symlink', async () => {
  await withState(async stateDir => {
    const registry = await BrowserRegistry.open({ stateDir });
    await registry.getOrCreate('alpha', { portFree: freePort });
    await registry.getOrCreate('beta', { portFree: freePort });
    await registry.prepareProfile('beta');
    const root = join(stateDir, 'browsers');
    await symlink(join(root, 'beta'), join(root, 'alpha'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => registry.prepareProfile('alpha'), /independent directory/);
  });
});
