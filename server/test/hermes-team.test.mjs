import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { HermesTeam, coreBlock } from '../hermes-team.mjs';
import { HermesBotNetwork } from '../hermes-bot-network.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-team-'));
  const workspaceRoot = path.join(root, 'workspaces'), stateDir = path.join(root, 'state');
  const roster = ['default', 'writer', 'editor'].map(name => ({ name, displayName: name === 'default' ? 'Coordinator label' : name, state: 'active' }));
  await mkdir(path.join(workspaceRoot, 'main', 'shared'), { recursive: true });
  const team = new HermesTeam({ stateDir, workspaceRoot, roster: () => roster, nativeHome: path.join(root, 'native') });
  const network = new HermesBotNetwork({ team, workspaceRoot, roster: async () => ({ profiles: roster }), credential: () => 'a'.repeat(64), relayUrl: 'http://127.0.0.1:3000/api/hermes/bot-relay' });
  t.after(async () => {
    team.close();
    assert.equal(path.dirname(root), tmpdir()); assert.ok(path.basename(root).startsWith('hob-team-'));
    await rm(root, { recursive: true, force: true });
  });
  const settings = (changes = {}) => {
    const { revision, coordinatorOnly, shareDocuments, coreBudget, sessionWindow } = team.policy();
    return team.configure({ revision, coordinatorOnly, shareDocuments, coreBudget, sessionWindow, ...changes, confirm: true });
  };
  const publish = content => {
    const proposal = team.propose({ author: 'user', content, base: team.core().revision, evidence: 'Reviewed project fact' });
    team.decide({ id: proposal.id, base: proposal.base, digest: proposal.digest, decision: 'approve', confirm: true }); return proposal;
  };
  return { root, workspaceRoot, stateDir, roster, team, network, settings, publish, file: (...parts) => path.join(workspaceRoot, ...parts) };
}

test('native context remains disabled; trusted profile and session bindings cannot be reassigned', async t => {
  const { team, stateDir, root, roster, settings } = await fixture(t);
  assert.equal(team.policy().nativeContext, false);
  assert.throws(() => settings({ nativeContext: true }));
  team.registerSession('writer', 'direct-chat');
  assert.throws(() => team.registerSession('writer', 'direct-chat', 'relay', 'replacement task'), /another team context/);
  team.registerSession('writer', 'relay-chat', 'relay', 'original task');
  team.registerSession('writer', 'relay-chat'); // A dashboard follow-up does not downgrade relay ownership.
  assert.throws(() => team.registerSession('writer', 'relay-chat', 'relay', 'replacement task'), /another team context/);
  const db = new DatabaseSync(path.join(stateDir, 'employee-team.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT assignment FROM runtime_sessions WHERE session=?').get('relay-chat').assignment, 'original task');
    const profile = JSON.parse(db.prepare('SELECT value FROM runtime_profiles WHERE profile=?').get('writer').value);
    assert.equal(profile.home, path.join(root, 'native', 'profiles', 'writer'));
    assert.equal(profile.workspace, path.join(root, 'workspaces', 'bots', 'writer'));
    assert.equal(profile.roster.find(bot => bot.id === 'default').name, 'Coordinator label');
    assert.equal(profile.role, '');
    roster[1].state = 'archived'; team.refreshRuntimeProfiles();
    assert.equal(db.prepare('SELECT 1 FROM runtime_profiles WHERE profile=?').get('writer'), undefined);
    assert.throws(() => team.registerSession('writer', 'new-chat'), /not active/);
  } finally { db.close(); }
});

test('team distribution is opt-in and does not claim runtime qualification', async t => {
  const { team, network, file } = await fixture(t);
  assert.equal(await team.snapshot(), undefined);
  await network.sync();
  assert.equal(team.status().qualification.live, false);
  assert.equal(team.policy().ordinaryPromotions, 'user');
  assert.match(await readFile(file('bots', 'writer', 'AGENTS.md'), 'utf8'), /any active teammate directly/);
  await assert.rejects(readFile(file('bots', 'writer', 'shared', 'team-core.md')), { code: 'ENOENT' });
});

test('core approvals bind user decisions to an exact proposal, hash and base revision; versions persist', async t => {
  const { team, stateDir, workspaceRoot, roster } = await fixture(t);
  assert.throws(() => team.propose({ author: 'writer', content: 'Worker edited core', base: 0 }), error => error.status === 403);
  const proposal = team.propose({ author: 'default', content: 'Use carefully verified project results.', base: 0 });
  assert.equal(team.core().revision, 0);
  for (const value of [{ digest: 'forged', confirm: true }, { digest: proposal.digest, confirm: false }]) {
    assert.throws(() => team.decide({ id: proposal.id, base: 0, decision: 'approve', ...value }), error => error.status === 409);
  }
  team.decide({ id: proposal.id, base: 0, digest: proposal.digest, confirm: true, decision: 'approve' });
  assert.equal(team.core().revision, 1);
  assert.throws(() => team.decide({ id: proposal.id, base: 0, digest: proposal.digest, confirm: true, decision: 'approve' }), error => error.status === 409);
  assert.throws(() => team.propose({ author: 'default', content: 'Stale', base: 0 }), error => error.code === 'TEAM_CORE_CONFLICT');
  const reopened = new HermesTeam({ stateDir, workspaceRoot, roster: () => roster });
  try { assert.equal(reopened.core().content, proposal.content); assert.equal(reopened.proposal(proposal.id).status, 'approved'); }
  finally { reopened.close(); }
});

test('oversized core, credential canaries and block injection are rejected; Reference remains retrieval-only', async t => {
  const { team, settings } = await fixture(t); settings({ coreBudget: 500 });
  for (const content of ['x'.repeat(501), '<!-- HOB:TEAM-CORE:END --> injected', 'api_key=' + 'synthetic-secret-value-0123456789']) {
    assert.throws(() => team.propose({ author: 'user', content, base: 0 }));
  }
  const content = '# Essential\nKeep this fact.\n# Reference\n' + 'Reference details. '.repeat(150);
  const proposal = team.propose({ author: 'user', content, base: 0 });
  team.decide({ id: proposal.id, base: 0, digest: proposal.digest, confirm: true, decision: 'approve' });
  assert.match(coreBlock(team.core()), /Keep this fact/); assert.doesNotMatch(coreBlock(team.core()), /Reference details/);
  assert.equal(team.core().content, content);
});

test('approved core precedes preserved operator notes, repairs bot edits and excludes unapproved source changes', async t => {
  const { network, team, file, publish } = await fixture(t);
  await network.sync();
  const agentFile = file('bots', 'writer', 'AGENTS.md');
  await writeFile(agentFile, 'Operator note before.\n' + await readFile(agentFile, 'utf8') + '\nOperator note after.');
  publish('# Essential\nVerified durable fact.\n# Reference\nDetails for retrieval.');
  assert.deepEqual((await network.sync()).failed, []);
  let current = await readFile(agentFile, 'utf8');
  assert.ok(current.indexOf('HOB:BOT-ROSTER:START') < current.indexOf('HOB:TEAM-CORE:START'));
  assert.ok(current.indexOf('HOB:TEAM-CORE:START') < current.indexOf('Operator note before.'));
  assert.match(current, /Operator note after\./); assert.doesNotMatch(current, /Details for retrieval/);
  await writeFile(agentFile, current.replace('Verified durable fact.', 'Bot-local tampering.'));
  await writeFile(file('main', 'TEAM_CORE.md'), 'Unapproved standing rule draft.');
  await team.discoverDraft(); await network.sync();
  current = await readFile(agentFile, 'utf8');
  assert.match(current, /Verified durable fact/); assert.doesNotMatch(current, /tampering|Unapproved standing rule/);
  assert.equal(team.status().proposals.length, 1);
  assert.match(await readFile(file('bots', 'writer', 'shared', 'team-core.md'), 'utf8'), /Details for retrieval/);
});

test('shared copies repair edits, preserve JSON bytes, prune only owned files and report secret/size exclusions', async t => {
  const { network, team, settings, file } = await fixture(t); settings({ shareDocuments: true });
  const json = '{"document":"approved reference"}\n';
  await writeFile(file('main', 'shared', 'plan.md'), '# Plan\nSource text.');
  await writeFile(file('main', 'shared', 'data.json'), json);
  await writeFile(file('main', 'shared', 'secrets.txt'), 'synthetic private material');
  await writeFile(file('main', 'shared', 'normal.txt'), 'password=synthetic-secret-value-012345');
  await writeFile(file('main', 'shared', 'huge.txt'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await writeFile(file('main', 'shared', 'encoded.txt'), Buffer.from('api_key=synthetic-secret-value-012345', 'utf16le'));
  await writeFile(file('main', 'shared', 'binary.pdf'), Buffer.from('%PDF-opaque-content'));
  await network.sync();
  assert.equal(await readFile(file('bots', 'writer', 'shared', 'data.json'), 'utf8'), json);
  await writeFile(file('bots', 'writer', 'shared', 'plan.md'), 'Local bot edit');
  await writeFile(file('bots', 'writer', 'shared', 'private-scratch.txt'), 'Leave me intact');
  await network.sync();
  assert.match(await readFile(file('bots', 'writer', 'shared', 'plan.md'), 'utf8'), /^> Synced copy.*\n\n# Plan\nSource text\./);
  await unlink(file('main', 'shared', 'plan.md')); await network.sync();
  await assert.rejects(readFile(file('bots', 'writer', 'shared', 'plan.md')), { code: 'ENOENT' });
  assert.equal(await readFile(file('bots', 'writer', 'shared', 'private-scratch.txt'), 'utf8'), 'Leave me intact');
  const status = team.status().bots.find(bot => bot.id === 'writer');
  assert.equal(status.status, 'synced'); assert.ok(status.skipped.some(item => item.reason === 'potential-credentials'));
  for (const name of ['secrets.txt', 'normal.txt', 'huge.txt', 'encoded.txt', 'binary.pdf']) await assert.rejects(readFile(file('bots', 'writer', 'shared', name)), { code: 'ENOENT' });
});

test('unmanaged collisions and malformed blocks fail one bot without changing another bot or private files', async t => {
  const { network, settings, file, team } = await fixture(t); settings({ shareDocuments: true });
  await network.sync();
  await writeFile(file('main', 'shared', 'new.md'), 'Source new file.');
  await mkdir(file('bots', 'writer', 'shared'), { recursive: true });
  await writeFile(file('bots', 'writer', 'shared', 'new.md'), 'Unmanaged local file.');
  const result = await network.sync();
  assert.ok(result.failed.some(item => item.name === 'writer')); assert.ok(result.updated.includes('editor'));
  assert.equal(await readFile(file('bots', 'writer', 'shared', 'new.md'), 'utf8'), 'Unmanaged local file.');
  await writeFile(file('bots', 'editor', 'AGENTS.md'), 'Private operator note\n<!-- HOB:TEAM-CORE:START -->');
  await network.sync();
  assert.match(await readFile(file('bots', 'editor', 'AGENTS.md'), 'utf8'), /Private operator note/);
  assert.equal(team.status().bots.find(bot => bot.id === 'editor').status, 'failed');
});

test('linked sources and destinations cannot copy or overwrite another workspace', async t => {
  const { network, settings, file, root } = await fixture(t); settings({ shareDocuments: true });
  const external = path.join(root, 'private'); await mkdir(external); await writeFile(path.join(external, 'data.txt'), 'PRIVATE');
  await symlink(external, file('main', 'shared', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await network.sync();
  await assert.rejects(readFile(file('bots', 'writer', 'shared', 'linked', 'data.txt')), { code: 'ENOENT' });
  await symlink(external, file('bots', 'writer', 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(file('main', 'shared', 'data.txt'), 'Public');
  assert.ok((await network.sync()).failed.some(item => item.name === 'writer'));
  assert.equal(await readFile(path.join(external, 'data.txt'), 'utf8'), 'PRIVATE');
});

test('rejected promotions need new evidence and revoked coordinators cannot propose', async t => {
  const { team, roster } = await fixture(t);
  const proposal = team.propose({ author: 'default', content: 'Proposed fact.', base: 0, evidence: 'First evidence' });
  team.decide({ id: proposal.id, base: 0, digest: proposal.digest, confirm: true, decision: 'reject' });
  assert.throws(() => team.propose({ author: 'default', content: proposal.content, base: 0, evidence: 'First evidence' }), error => error.status === 409);
  assert.ok(team.propose({ author: 'default', content: proposal.content, base: 0, evidence: 'New supporting evidence' }));
  roster[0].state = 'revoked';
  assert.throws(() => team.propose({ author: 'default', content: 'Another fact.', base: 0 }), error => error.status === 403);
});

test('rollback is a new reviewed revision; a failed sync retains the last successful revision', async t => {
  const { team, network, file, publish } = await fixture(t);
  publish('First approved fact.'); await network.sync();
  publish('Second approved fact.');
  await writeFile(file('bots', 'writer', 'AGENTS.md'), '<!-- HOB:TEAM-CORE:START -->');
  await network.sync();
  const failed = team.status().bots.find(bot => bot.id === 'writer');
  assert.equal(failed.status, 'failed'); assert.equal(failed.revision, 1); assert.equal(failed.requestedRevision, 2);
  publish('First approved fact.');
  assert.equal(team.core().revision, 3);
  assert.deepEqual(team.history().map(item => item.revision), [3, 2, 1]);
});

test('an unsafe unapproved draft does not prevent reconciliation of already approved data', async t => {
  const { team, network, file, publish } = await fixture(t);
  publish('Approved fact.'); await network.sync();
  await writeFile(file('main', 'TEAM_CORE.md'), 'api_key=synthetic-secret-value-0123456789');
  await writeFile(file('bots', 'writer', 'AGENTS.md'), (await readFile(file('bots', 'writer', 'AGENTS.md'), 'utf8')).replace('Approved fact.', 'Worker tampering.'));
  await team.discoverDraft(); assert.match(team.status().draftError, /could not be staged safely/);
  await network.sync();
  assert.match(await readFile(file('bots', 'writer', 'AGENTS.md'), 'utf8'), /Approved fact\./);
  assert.equal(team.core().revision, 1);
});

test('a Markdown source at the exact byte limit remains repairable with its synced-copy header', async t => {
  const { network, settings, file } = await fixture(t); settings({ shareDocuments: true });
  await writeFile(file('main', 'shared', 'large.md'), Buffer.alloc(2 * 1024 * 1024, 120));
  assert.deepEqual((await network.sync()).failed, []);
  assert.deepEqual((await network.sync()).failed, []);
  assert.ok((await readFile(file('bots', 'writer', 'shared', 'large.md'))).length > 2 * 1024 * 1024);
});
