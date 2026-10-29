import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { HermesBotNetwork, botRelayUrl } from '../hermes-bot-network.mjs';

const ENDPOINT = 'https://hob.example.com/api/hermes/bot-relay';
const credential = name => (name === 'default' ? 'a' : 'b').repeat(64);

test('native relay uses the container listener independently of public proxy and host-published ports', () => {
  assert.equal(botRelayUrl({ HOB_PUBLIC_URL: 'https://bots.example.com' }), 'http://127.0.0.1:3000/api/hermes/bot-relay');
  assert.equal(botRelayUrl({ HOB_PUBLIC_URL: 'http://127.0.0.1:49153', HOB_PORT: '4567' }), 'http://127.0.0.1:4567/api/hermes/bot-relay');
  assert.equal(botRelayUrl({ HOB_BOT_RELAY_URL: ENDPOINT }), ENDPOINT);
  for (const env of [{ HOB_PORT: 'invalid' }, { HOB_BOT_RELAY_URL: 'file:///private' }, { HOB_BOT_RELAY_URL: 'https://name:password@example.com/' }]) assert.throws(() => botRelayUrl(env));
});

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
  const network = new HermesBotNetwork({ roster: async () => ({ profiles }), workspaceRoot: root, credential, relayUrl: `${ENDPOINT}/` });
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
  assert.match(main, /You are the main coordinator/);
  assert.match(main, /Writer — id: `writer` — Writes the documentation\./);
  assert.match(main, /node \.hob\/talk\.mjs send <bot-id>/);
  assert.match(main, /You may message any active bot/);
  assert.doesNotMatch(main, /Pending/);
  assert.equal(main.match(/<!-- HOB:BOT-ROSTER:START -->/g).length, 1);

  const writer = await readFile(path.join(root, 'bots', 'writer', 'AGENTS.md'), 'utf8');
  assert.match(writer, /You are Writer \(stable id: `writer`\)\./);
  assert.match(writer, /You may contact any active teammate directly/);
  assert.doesNotMatch(writer, /You may message any active bot/);
  assert.match(writer, /Main — id: `default` \(Main coordinator\)/);

  const helper = await readFile(path.join(root, 'bots', 'writer', '.hob', 'talk.mjs'), 'utf8');
  assert.match(helper, new RegExp(`const endpoint = "${ENDPOINT.replace(/[/.]/g, '\\$&')}";`));
  execFileSync(process.execPath, ['--check', path.join(root, 'bots', 'writer', '.hob', 'talk.mjs')]);
  assert.doesNotMatch(helper, /process\.env\.API_SERVER_KEY/);
  assert.ok(!helper.includes(credential('writer')));
  assert.equal(JSON.parse(await readFile(path.join(root, 'bots', 'writer', '.hob', 'relay.json'), 'utf8')).token, credential('writer'));

  // A setup-required bot has no workspace and must not receive a roster.
  await assert.rejects(readFile(path.join(root, 'bots', 'pending', 'AGENTS.md')), { code: 'ENOENT' });
}));

test('bot network replaces its block in place when a display name changes', async () => fixture(async root => {
  const profiles = [
    { name: 'default', displayName: 'Main', state: 'active' },
    { name: 'writer', displayName: 'Writer', state: 'active' },
  ];
  const network = new HermesBotNetwork({ roster: async () => ({ profiles }), workspaceRoot: root, credential, relayUrl: ENDPOINT });
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
  const network = new HermesBotNetwork({ roster: async () => ({ profiles }), workspaceRoot: root, credential, relayUrl: ENDPOINT });
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

test('generated helper authenticates without listener secrets in its terminal environment', async () => fixture(async root => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ self: 'writer', bots: [{ id: 'default', name: 'Main', main: true }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const network = new HermesBotNetwork({ roster: async () => ({ profiles: [{ name: 'writer', state: 'active' }] }), workspaceRoot: root, credential,
      relayUrl: `http://127.0.0.1:${server.address().port}/api/hermes/bot-relay` });
    assert.deepEqual((await network.sync()).failed, []);
    const env = { ...process.env };
    delete env.HOB_TALK_TOKEN; delete env.API_SERVER_KEY;
    const helper = path.join(root, 'bots', 'writer', '.hob', 'talk.mjs');
    const result = await promisify(execFile)(process.execPath, [helper, 'roster'], { env, cwd: root });
    assert.match(result.stdout, /Main coordinator/);
    assert.deepEqual(seen, [{ url: '/api/hermes/bot-relay/roster', authorization: `Bearer ${credential('writer')}` }]);
    assert.ok(!result.stdout.includes(credential('writer')));
    // A fresh sync repairs the credential file rather than asking the bot to expose a listener secret.
    await writeFile(path.join(root, 'bots', 'writer', '.hob', 'relay.json'), '{}');
    await network.sync();
    await promisify(execFile)(process.execPath, [helper, 'roster'], { env });
    assert.equal(seen.length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('deployment root aliases work while an alias into another bot cannot receive a relay key', async t => fixture(async root => {
  const actual = path.join(root, 'actual'); await mkdir(actual);
  const alias = path.join(root, 'alias');
  try { await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Directory links unavailable'); return; } throw error; }
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: [{ name: 'default', state: 'active' }] }), workspaceRoot: alias, credential, relayUrl: ENDPOINT });
  assert.deepEqual(await network.sync(), { updated: ['default'], failed: [] });
  await mkdir(path.join(actual, 'bots'));
  await symlink(path.join(actual, 'main'), path.join(actual, 'bots', 'writer'), process.platform === 'win32' ? 'junction' : 'dir');
  const malicious = new HermesBotNetwork({ roster: async () => ({ profiles: [{ name: 'writer', state: 'active' }] }), workspaceRoot: alias, credential, relayUrl: ENDPOINT });
  const result = await malicious.sync(); assert.equal(result.failed.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(actual, 'main', '.hob', 'relay.json'), 'utf8')).token, credential('default'));
}));

test('a hard-linked AGENTS file cannot copy operator secrets into a bot workspace', async () => fixture(async root => {
  const secret = path.join(root, 'operator-private.json');
  await writeFile(secret, 'private-operator-secret');
  await mkdir(path.join(root, 'main'));
  await link(secret, path.join(root, 'main', 'AGENTS.md'));
  const network = new HermesBotNetwork({ roster: async () => ({ profiles: [{ name: 'default', state: 'active' }] }), workspaceRoot: root, credential, relayUrl: ENDPOINT });
  assert.equal((await network.sync()).failed.length, 1);
  assert.equal(await readFile(secret, 'utf8'), 'private-operator-secret');
  await assert.rejects(readFile(path.join(root, 'main', '.hob', 'relay.json')), { code: 'ENOENT' });
}));
