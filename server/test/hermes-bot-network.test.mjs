import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HermesBotNetwork } from '../hermes-bot-network.mjs';

const ENDPOINT = 'https://hob.example.com/api/hermes/bot-relay';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-bot-network-'));
  try { await run(root); }
  finally {
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith('hob-bot-network-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('bot network writes the roster and relay client into each active workspace', async () => fixture(async root => {
  const profiles = [
    { name: 'default', displayName: 'Main', state: 'active' },
    { name: 'writer', displayName: 'Writer', state: 'active', description: 'Writes the documentation.' },
    { name: 'pending', displayName: 'Pending', state: 'setup_required' },
  ];
  const network = new HermesBotNetwork({ roster: async () => ({ profiles }), workspaceRoot: root, relayUrl: `${ENDPOINT}/` });
  assert.equal(network.workspace('default'), path.join(root, 'main'));
  assert.equal(network.workspace('writer'), path.join(root, 'bots', 'writer'));

  // An operator's own AGENTS.md content must survive the managed block.
  await mkdir(path.join(root, 'main'), { recursive: true });
  await writeFile(path.join(root, 'main', 'AGENTS.md'), '# House rules\n\nKeep this note.\n');

  const result = await network.sync();
  assert.deepEqual(result, { updated: ['default', 'writer'], failed: [] });

  const main = await readFile(path.join(root, 'main', 'AGENTS.md'), 'utf8');
  assert.match(main, /# House rules/);
  assert.match(main, /Keep this note\./);
  assert.match(main, /You are Main, the coordinator/);
  assert.match(main, /Writer — id: `writer` — Writes the documentation\./);
  assert.match(main, /node \.hob\/talk\.mjs send <bot-id>/);
  assert.match(main, /You may message any active bot/);
  assert.doesNotMatch(main, /Pending/);
  assert.equal(main.match(/<!-- HOB:BOT-ROSTER:START -->/g).length, 1);

  const writer = await readFile(path.join(root, 'bots', 'writer', 'AGENTS.md'), 'utf8');
  assert.match(writer, /You are Writer \(stable id: `writer`\)\./);
  assert.match(writer, /Route cross-bot work through Main/);
  assert.doesNotMatch(writer, /You may message any active bot/);
  assert.match(writer, /Main — id: `default` \(Main coordinator\)/);

  const helper = await readFile(path.join(root, 'bots', 'writer', '.hob', 'talk.mjs'), 'utf8');
  assert.match(helper, new RegExp(`const endpoint = "${ENDPOINT.replace(/[/.]/g, '\\$&')}";`));
  assert.match(helper, /process\.env\.HOB_TALK_TOKEN \|\| process\.env\.API_SERVER_KEY/);

  // A setup-required bot has no workspace and must not receive a roster.
  await assert.rejects(readFile(path.join(root, 'bots', 'pending', 'AGENTS.md')), { code: 'ENOENT' });
}));

test('bot network replaces its block in place when a display name changes', async () => fixture(async root => {
  const profiles = [
    { name: 'default', displayName: 'Main', state: 'active' },
    { name: 'writer', displayName: 'Writer', state: 'active' },
  ];
  const network = new HermesBotNetwork({ roster: async () => ({ profiles }), workspaceRoot: root, relayUrl: ENDPOINT });
  await network.sync();

  const filename = path.join(root, 'bots', 'writer', 'AGENTS.md');
  await writeFile(filename, `Operator notes before.\n\n${await readFile(filename, 'utf8')}\nOperator notes after.\n`);
  profiles[1] = { ...profiles[1], displayName: 'Scribe' };
  const result = await network.sync();
  assert.deepEqual(result, { updated: ['default', 'writer'], failed: [] });

  const updated = await readFile(filename, 'utf8');
  assert.match(updated, /Operator notes before\./);
  assert.match(updated, /Operator notes after\./);
  assert.match(updated, /You are Scribe \(stable id: `writer`\)\./);
  assert.match(updated, /Scribe — id: `writer`/);
  assert.doesNotMatch(updated, /Writer/);
  assert.equal(updated.match(/<!-- HOB:BOT-ROSTER:START -->/g).length, 1,
    'a second sync must not append another managed block');
}));

test('bot network treats labels as literal text', async () => fixture(async root => {
  const profiles = [
    { name: 'default', displayName: 'Main', state: 'active' },
    // `$&` is a replacement pattern and `-->` would close the managed block.
    { name: 'writer', displayName: 'Writer $& -->', state: 'active', description: 'Costs $1, not <!-- an instruction --> at all.' },
  ];
  const network = new HermesBotNetwork({ roster: async () => ({ profiles }), workspaceRoot: root, relayUrl: ENDPOINT });
  await network.sync();
  const filename = path.join(root, 'bots', 'writer', 'AGENTS.md');
  const first = await readFile(filename, 'utf8');
  assert.match(first, /You are Writer \$& \(stable id: `writer`\)\./);
  assert.match(first, /Costs \$1, not an instruction at all\./);

  // A second sync must still find exactly one intact block, not the literal
  // replacement of the previous block.
  profiles[1] = { ...profiles[1], displayName: 'Scribe $&' };
  await network.sync();
  const updated = await readFile(filename, 'utf8');
  assert.match(updated, /You are Scribe \$& \(stable id: `writer`\)\./);
  assert.equal(updated.match(/<!-- HOB:BOT-ROSTER:START -->/g).length, 1);
  assert.equal(updated.match(/<!-- HOB:BOT-ROSTER:END -->/g).length, 1);
}));

test('bot network refuses an invalid relay endpoint', () => {
  for (const relayUrl of ['', 'not a url', 'ftp://hob.example.com/relay', 'file:///tmp/relay']) {
    assert.throws(() => new HermesBotNetwork({
      roster: async () => ({ profiles: [] }), workspaceRoot: '.', relayUrl,
    }), /relay URL|valid bot relay URL/);
  }
});
