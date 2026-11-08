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
  assert.deepEqual(result, { updated: ['default', 'writer'], failed: [], shared: { updated: {}, deleted: {}, skipped: [] } });

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
  assert.deepEqual(result, { updated: ['default', 'writer'], failed: [], shared: { updated: {}, deleted: {}, skipped: [] } });

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

const teamProfiles = () => [
  { name: 'default', displayName: 'Main', state: 'active' },
  { name: 'writer', displayName: 'Writer', state: 'active', description: 'Writes the documentation.' },
];

test('team core block propagates to every bot from Main’s TEAM_CORE.md', async () => fixture(async root => {
  await mkdir(path.join(root, 'main'), { recursive: true });
  await writeFile(path.join(root, 'main', 'TEAM_CORE.md'), '# Team core\n\n- The user is singham, timezone Asia/Karachi.\n');
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: teamProfiles() }), workspaceRoot: root, relayUrl: ENDPOINT });
  const result = await network.sync();
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.shared, { updated: {}, deleted: {}, skipped: [] });

  for (const file of [path.join(root, 'main', 'AGENTS.md'), path.join(root, 'bots', 'writer', 'AGENTS.md')]) {
    const content = await readFile(file, 'utf8');
    assert.match(content, /The user is singham, timezone Asia\/Karachi\./);
    assert.equal(content.match(/<!-- HOB:TEAM-CORE:START -->/g).length, 1);
    assert.equal(content.match(/<!-- HOB:TEAM-CORE:END -->/g).length, 1);
    assert.match(content, /Edit the source via Main/);
  }
}));

test('a bot-local edit to the core block is overwritten on the next sync', async () => fixture(async root => {
  await mkdir(path.join(root, 'main'), { recursive: true });
  await writeFile(path.join(root, 'main', 'TEAM_CORE.md'), '# Team core\n\n- Durable fact one.\n');
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: teamProfiles() }), workspaceRoot: root, relayUrl: ENDPOINT });
  await network.sync();
  const filename = path.join(root, 'bots', 'writer', 'AGENTS.md');
  const synced = await readFile(filename, 'utf8');
  await writeFile(filename, synced.replace('Durable fact one.', 'A worker invented this.'));
  await network.sync();
  const restored = await readFile(filename, 'utf8');
  assert.match(restored, /Durable fact one\./);
  assert.doesNotMatch(restored, /A worker invented this/);
}));

test('team core over budget is truncated with a note, never silently', async () => fixture(async root => {
  await mkdir(path.join(root, 'main'), { recursive: true });
  await writeFile(path.join(root, 'main', 'TEAM_CORE.md'), `# Team core\n\n${'- A durable fact line.\n'.repeat(400)}`);
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: teamProfiles() }), workspaceRoot: root, relayUrl: ENDPOINT });
  await network.sync();
  const writer = await readFile(path.join(root, 'bots', 'writer', 'AGENTS.md'), 'utf8');
  assert.match(writer, /truncated at 4000 characters/);
  assert.match(writer, /ask Main for the rest/);
}));

test('shared docs sync-copy overwrites a worker’s local edit and carries the header', async () => fixture(async root => {
  const shared = path.join(root, 'main', 'shared');
  await mkdir(shared, { recursive: true });
  await writeFile(path.join(shared, 'plan.md'), '# Plan\n\nVersion one.\n');
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: teamProfiles() }), workspaceRoot: root, relayUrl: ENDPOINT });
  const first = await network.sync();
  assert.deepEqual(first.shared.updated, { writer: ['plan.md'] });
  const copy = path.join(root, 'bots', 'writer', 'shared', 'plan.md');
  const copied = await readFile(copy, 'utf8');
  assert.match(copied, /^> Synced copy of the shared docs\. Edit the source via Main\./);
  assert.match(copied, /Version one\./);

  await writeFile(copy, '# Plan\n\nA worker rewrote this.\n');
  const second = await network.sync();
  assert.deepEqual(second.shared.updated, { writer: ['plan.md'] });
  assert.match(await readFile(copy, 'utf8'), /Version one\./);
  assert.doesNotMatch(await readFile(copy, 'utf8'), /A worker rewrote this/);
}));

test('deleting a shared source file deletes the worker copies', async () => fixture(async root => {
  const shared = path.join(root, 'main', 'shared');
  await mkdir(shared, { recursive: true });
  await writeFile(path.join(shared, 'plan.md'), '# Plan\n\nKeep me.\n');
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: teamProfiles() }), workspaceRoot: root, relayUrl: ENDPOINT });
  await network.sync();
  assert.equal((await readFile(path.join(root, 'bots', 'writer', 'shared', 'plan.md'), 'utf8')).includes('Keep me.'), true);
  const { unlink } = await import('node:fs/promises');
  await unlink(path.join(shared, 'plan.md'));
  const result = await network.sync();
  assert.deepEqual(result.shared.deleted, { writer: ['plan.md'] });
  await assert.rejects(readFile(path.join(root, 'bots', 'writer', 'shared', 'plan.md')), { code: 'ENOENT' });
}));

test('shared sync skips sensitive files and files over 2 MB, and logs the skip', async () => fixture(async root => {
  const shared = path.join(root, 'main', 'shared');
  await mkdir(shared, { recursive: true });
  await writeFile(path.join(shared, 'notes.md'), '# Notes\n\nSafe.\n');
  await writeFile(path.join(shared, 'credentials.json'), '{"token": "never-sync-this"}');
  await writeFile(path.join(shared, '.env'), 'SECRET=never-sync-this');
  await writeFile(path.join(shared, 'api-token.txt'), 'never-sync-this');
  await writeFile(path.join(shared, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: teamProfiles() }), workspaceRoot: root, relayUrl: ENDPOINT });
  const result = await network.sync();
  assert.deepEqual(result.shared.updated, { writer: ['notes.md'] });
  const skipped = result.shared.skipped.map(entry => `${entry.path}:${entry.reason}`).sort();
  assert.deepEqual(skipped, [
    '.env:sensitive',
    'api-token.txt:sensitive',
    'big.bin:over 2 MB',
    'credentials.json:sensitive',
  ]);
  await assert.rejects(readFile(path.join(root, 'bots', 'writer', 'shared', 'credentials.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'bots', 'writer', 'shared', 'big.bin')), { code: 'ENOENT' });
}));

test('one bot’s sync failure does not block the others', async () => fixture(async root => {
  const profiles = [
    ...teamProfiles(),
    { name: 'broken', displayName: 'Broken', state: 'active' },
  ];
  // A directory where AGENTS.md should be makes that bot's write fail.
  await mkdir(path.join(root, 'bots', 'broken', 'AGENTS.md'), { recursive: true });
  const network = new HermesBotNetwork({ roster: async () => ({ profiles }), workspaceRoot: root, relayUrl: ENDPOINT });
  const result = await network.sync();
  assert.deepEqual(result.updated, ['default', 'writer']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, 'broken');
  assert.match(await readFile(path.join(root, 'bots', 'writer', 'AGENTS.md'), 'utf8'), /HOB bot network/);
}));

test('managed blocks teach the team how to run work', async () => fixture(async root => {
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: teamProfiles() }), workspaceRoot: root, relayUrl: ENDPOINT });
  await network.sync();
  const main = await readFile(path.join(root, 'main', 'AGENTS.md'), 'utf8');
  assert.match(main, /TASK <id> — <short title>/);
  assert.match(main, /OUTCOME: <what done looks like, verifiable>/);
  assert.match(main, /waiting on <bot>/);
  assert.match(main, /How to run work/);
  assert.match(main, /Plan first/);
  assert.match(main, /Work in segments/);
  assert.match(main, /Interruptions/);
  assert.match(main, /Main never blocks on a long job/);
  assert.match(main, /Tier 1 \(project status, contact details, tool notes\)/);
  assert.match(main, /Tier 2 \(standing rules, preferences, money, outsiders, credentials policy\)/);

  const writer = await readFile(path.join(root, 'bots', 'writer', 'AGENTS.md'), 'utf8');
  assert.match(writer, /TASK <id> — <DONE \| BLOCKED \| PARTIAL>/);
  assert.match(writer, /PROMOTE: <facts proposed for the team core/);
  assert.match(writer, /How to run work/);
  assert.match(writer, /Interruptions/);
  assert.doesNotMatch(writer, /Main never blocks on a long job/);
  assert.doesNotMatch(writer, /TASK <id> — <short title>/);
}));

test('targeted syncs rewrite only the core block or only the shared docs', async () => fixture(async root => {
  await mkdir(path.join(root, 'main', 'shared'), { recursive: true });
  await writeFile(path.join(root, 'main', 'TEAM_CORE.md'), '# Team core\n\n- Core fact.\n');
  await writeFile(path.join(root, 'main', 'shared', 'plan.md'), '# Plan\n\nShared plan.\n');
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: teamProfiles() }), workspaceRoot: root, relayUrl: ENDPOINT });

  const coreOnly = await network.syncTeamCore();
  assert.deepEqual(coreOnly.updated, ['default', 'writer']);
  assert.match(await readFile(path.join(root, 'bots', 'writer', 'AGENTS.md'), 'utf8'), /Core fact\./);
  await assert.rejects(readFile(path.join(root, 'bots', 'writer', 'shared', 'plan.md')), { code: 'ENOENT' });

  const sharedOnly = await network.syncSharedDocs();
  assert.deepEqual(sharedOnly.shared.updated, { writer: ['plan.md'] });
  assert.match(await readFile(path.join(root, 'bots', 'writer', 'shared', 'plan.md'), 'utf8'), /Shared plan\./);
}));

test('a session fact that was never promoted never reaches another bot', async () => fixture(async root => {
  await mkdir(path.join(root, 'main', 'shared'), { recursive: true });
  await writeFile(path.join(root, 'main', 'TEAM_CORE.md'), '# Team core\n\n- Shared fact.\n');
  await writeFile(path.join(root, 'main', 'shared', 'plan.md'), '# Plan\n\nShared plan.\n');
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: teamProfiles() }), workspaceRoot: root, relayUrl: ENDPOINT });
  await network.sync();
  // A fact that lives only in the writer's own episodic memory.
  await writeFile(path.join(root, 'bots', 'writer', 'MEMORY.md'), 'The user secretly prefers the mango workflow.\n');
  await network.sync();
  const main = await readFile(path.join(root, 'main', 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(main, /mango workflow/);
  assert.match(main, /Shared fact\./);
  // And it never lands in the core source either.
  assert.doesNotMatch(await readFile(path.join(root, 'main', 'TEAM_CORE.md'), 'utf8'), /mango workflow/);
}));
