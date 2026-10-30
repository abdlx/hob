import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, truncate, unlink, link, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HermesTeam } from '../hermes-team.mjs';
import { createTeamArtifactHandoffs } from '../hermes-team-artifacts.mjs';
import { parseTeamTask } from '../hermes-team-protocol.mjs';
import { createHermesBotRelay } from '../hermes-bot-relay.mjs';
import { HermesExchanges } from '../hermes-exchanges.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assignment = output => `TASK plan-1 — Build a checked plan\nOUTCOME: A JSON plan with two steps\nCONSTRAINTS: No external messages\nOUTPUT: ${output}\nDEADLINE: none\nCORE REFS: none`;
const answer = (output, status = 'DONE', blockers = 'none') => `TASK plan-1 — ${status}\nRESULT: Saved the plan\nFILES: ${output}\nVERIFICATION: Parsed the JSON and checked two steps\nBLOCKERS: ${blockers}\nPROMOTE: none`;
async function fixture(t, output = 'artifacts/result.json') {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-team-artifacts-'));
  const workspaceRoot = path.join(root, 'workspaces'), stateDir = path.join(root, 'state');
  const roster = ['default', 'writer', 'editor'].map(name => ({ name, displayName: name === 'default' ? 'Aster' : name, state: 'active' }));
  await mkdir(path.join(workspaceRoot, 'main'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'bots', 'writer', 'artifacts'), { recursive: true });
  const team = new HermesTeam({ stateDir, workspaceRoot, roster: () => roster });
  team.configure({ revision: 0, confirm: true, coordinatorOnly: true, shareDocuments: false, coreBudget: 4000, sessionWindow: 20 });
  const service = createTeamArtifactHandoffs({ team, workspaceRoot, roster: () => roster });
  const record = { id: '11111111-1111-4111-8111-111111111111', from: 'default', to: 'writer', status: 'completed', teamControlled: true,
    message: assignment(output), reply: answer(output), teamTask: parseTeamTask(assignment(output)), teamVerification: 'self-reported' };
  t.after(async () => {
    team.close();
    assert.equal(path.dirname(root), tmpdir()); assert.ok(path.basename(root).startsWith('hob-team-artifacts-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspaceRoot, stateDir, roster, team, service, record, source: path.join(workspaceRoot, 'bots', 'writer', ...output.split('/')),
    copied: receipt => path.join(workspaceRoot, 'main', ...receipt.path.split('/')) };
}

test('only the nominated worker file is copied; snapshot integrity and coordinator review are separate', async t => {
  const { service, record, source, copied, team } = await fixture(t);
  const bytes = Buffer.from('{"steps":["draft","check"]}\n');
  await writeFile(source, bytes);
  const receipt = await service.receive(record);
  assert.equal(receipt.sha256, hash(bytes)); assert.equal(receipt.bytes, bytes.length);
  assert.deepEqual(await readFile(copied(receipt)), bytes);
  assert.deepEqual(receipt.reviews, []);
  assert.equal(record.teamVerification, 'self-reported');
  const content = JSON.parse(await readFile(copied(receipt), 'utf8')); // Main's own independent file check.
  assert.equal(content.steps.length, 2);
  const review = await service.review(record, { requestId: 'review-1', sha256: receipt.sha256, verdict: 'passed', checks: 'Read the received JSON; parsed it and verified two steps.' });
  assert.equal(review.author, 'default'); assert.equal(review.verdict, 'passed');
  assert.equal(team.artifactReviews(record.id).length, 1);
  assert.equal((await service.inspect(record)).reviews[0].sha256, receipt.sha256);
  await assert.rejects(service.inspect({ ...record, message: record.message.replace('two steps', 'three steps') }), /does not match/);
  await assert.rejects(service.inspect({ ...record, reply: record.reply.replace('Saved the plan', 'Saved a different plan') }), /does not match/);
  assert.equal(record.status, 'completed');
});

test('a worker claiming DONE cannot create evidence for a missing output or silently change the nomination', async t => {
  const { service, record, source, team } = await fixture(t);
  await assert.rejects(service.receive(record), { code: 'ENOENT' });
  assert.equal(team.artifactHandoff(record.id), null);
  await assert.rejects(service.review(record, { requestId: 'fake-review', sha256: '0'.repeat(64), verdict: 'passed', checks: 'Worker said it exists' }), /Fetch and inspect/);
  await writeFile(source, '{}');
  await assert.rejects(service.receive({ ...record, reply: answer('artifacts/different.json') }), /original assignment/);
  await assert.rejects(service.receive({ ...record, teamTask: { ...record.teamTask, id: 'another-task' } }), /original assignment/);
});

test('private files, traversal, credential canaries and oversized outputs cannot be handed off', async t => {
  const f = await fixture(t);
  for (const output of ['MEMORY.md', '.hob/relay.json', 'memories/USER.md', 'private.key', '../editor/output.md']) {
    const record = { ...f.record, message: assignment(output), reply: answer(output) };
    await assert.rejects(f.service.receive(record));
  }
  await writeFile(f.source, 'api_key=synthetic-secret-value-0123456789');
  await assert.rejects(f.service.receive(f.record), /Potential credentials/);
  await truncate(f.source, 25 * 1024 * 1024 + 1);
  await assert.rejects(f.service.receive(f.record), /assigned, non-sensitive/);
  assert.equal(f.team.artifactHandoff(f.record.id), null);
});

test('an existing handoff remains the original snapshot; missing copies restore only identical bytes', async t => {
  const f = await fixture(t);
  await writeFile(f.source, 'original output');
  const receipt = await f.service.receive(f.record);
  await writeFile(f.source, 'changed after handoff');
  assert.equal((await f.service.receive(f.record)).sha256, receipt.sha256);
  assert.equal(await readFile(f.copied(receipt), 'utf8'), 'original output');
  await unlink(f.copied(receipt));
  await assert.rejects(f.service.receive(f.record), /worker output changed/);
  await writeFile(f.source, 'original output');
  assert.equal((await f.service.receive(f.record)).receivedAt, receipt.receivedAt);
  assert.equal(await readFile(f.copied(receipt), 'utf8'), 'original output');
});

test('tampered copies and stale hashes cannot acquire a passing review; decisions are durable and replay-bound', async t => {
  const f = await fixture(t);
  await writeFile(f.source, 'original output');
  const receipt = await f.service.receive(f.record);
  const input = { requestId: 'review-1', sha256: receipt.sha256, verdict: 'passed', checks: 'Read and checked the exact received output.' };
  for (const invalid of [{ ...input, author: 'default' }, { ...input, checks: 'none' }, { ...input, checks: 'api_key=synthetic-secret-value-0123456789' }]) await assert.rejects(f.service.review(f.record, invalid));
  await assert.rejects(f.service.review(f.record, { ...input, sha256: '0'.repeat(64) }), /exact assigned output/);
  const first = await f.service.review(f.record, input);
  assert.deepEqual(await f.service.review(f.record, input), first);
  await assert.rejects(f.service.review(f.record, { ...input, checks: 'A different decision under the same request.' }), /another decision/);
  const reopened = new HermesTeam({ stateDir: f.stateDir, workspaceRoot: f.workspaceRoot, roster: () => f.roster });
  try { assert.equal(reopened.artifactReviews(f.record.id)[0].sha256, receipt.sha256); assert.equal(reopened.artifactHandoff(f.record.id).source, 'artifacts/result.json'); }
  finally { reopened.close(); }
  await writeFile(f.copied(receipt), 'tampered');
  await assert.rejects(f.service.inspect(f.record), { code: 'TEAM_ARTIFACT_CHANGED' });
  await assert.rejects(f.service.review(f.record, { ...input, requestId: 'review-2' }), { code: 'TEAM_ARTIFACT_CHANGED' });
  assert.equal(f.team.artifactReviews(f.record.id).length, 1);
});

test('concurrent receipt requests are idempotent; partial, revoked and ordinary-mode results cannot pass', async t => {
  const f = await fixture(t);
  await writeFile(f.source, 'output');
  f.record.reply = answer('artifacts/result.json', 'PARTIAL', 'Needs a final check');
  const [first, second] = await Promise.all([f.service.receive(f.record), f.service.receive(f.record)]);
  assert.deepEqual(first, second);
  const partial = { ...f.record, reply: answer('artifacts/result.json', 'PARTIAL', 'Needs a final check') };
  await assert.rejects(f.service.review(partial, { requestId: 'partial', sha256: first.sha256, verdict: 'passed', checks: 'Read output' }), /partial or blocked/);
  const rejected = await f.service.review(partial, { requestId: 'partial-failed', sha256: first.sha256, verdict: 'failed', checks: 'Read the output; the requested final check is missing.' });
  assert.equal(rejected.verdict, 'failed');
  f.roster[1].state = 'revoked';
  await assert.rejects(f.service.inspect(f.record), /both be active/);
  f.roster[1].state = 'active';
  assert.throws(() => f.team.configure({ ...f.team.policy(), nativeContext: undefined, confirm: true }));
  const { revision, shareDocuments, coreBudget, sessionWindow } = f.team.policy();
  f.team.configure({ revision, shareDocuments, coreBudget, sessionWindow, coordinatorOnly: false, confirm: true });
  await assert.rejects(f.service.receive(f.record), /coordinator-assigned/);
});

test('real relay admission, snapshot handoff and coordinator decision keep native completion separate', async t => {
  const f = await fixture(t), main = 'a'.repeat(64), worker = 'b'.repeat(64);
  const exchanges = new HermesExchanges();
  let executions = 0;
  await writeFile(f.source, '{"steps":["draft","check"]}');
  const relay = createHermesBotRelay({ team: f.team, teamArtifacts: f.service, exchanges,
    bots: { roster: () => f.roster, authenticate: async token => f.roster.find(bot => bot.name === (token === main ? 'default' : token === worker ? 'writer' : 'none')) },
    client: { runtime: async route => route === '/api/sessions' ? { id: 'worker-run-session' } : { run_id: 'worker-run' },
      async *events() { executions++; yield { event: 'run.completed', output: f.record.reply }; } } });
  t.after(() => relay.close());
  const call = async (tail, token, input) => {
    let code, result;
    await relay({ method: input === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` } }, {}, new URL('http://hob.test/api/hermes/bot-relay' + tail),
      { body: async () => input, json: (_res, status, value) => { code = status; result = value; } });
    assert.equal(code, 200); return result;
  };
  const admitted = await call('/send', main, { to: 'writer', message: f.record.message, waitMs: 30 });
  assert.equal(admitted.nativeCompleted, true); assert.equal(admitted.completed, false);
  const resource = `/team/artifacts/${admitted.id}`;
  await assert.rejects(call(resource, worker, {}), { status: 403 });
  const { artifact } = await call(resource, main, {});
  const actualBytes = await readFile(f.copied(artifact));
  assert.equal(JSON.parse(actualBytes).steps.length, 2); assert.equal(hash(actualBytes), artifact.sha256);
  await call(resource + '/reviews', main, { requestId: 'main-checked', sha256: artifact.sha256, verdict: 'passed', checks: 'Main opened the received JSON, checked its digest and counted two steps.' });
  const state = await call('/exchanges/' + admitted.id, main);
  assert.equal(state.completed, true); assert.equal(state.nativeCompleted, true);
  assert.equal(state.teamVerification, 'coordinator-reviewed');
  assert.equal(state.teamReview.sha256, artifact.sha256);
  assert.equal(state.teamOutput.bytes, actualBytes.length);
  // Simulate losing the exchange-cache update after the protected review commit.
  exchanges.update(admitted.id, { teamReview: null, teamVerification: 'self-reported', teamOutput: null });
  const recovered = await call('/exchanges/' + admitted.id, main);
  assert.equal(recovered.teamVerification, 'coordinator-reviewed');
  assert.equal(recovered.completed, true);
  assert.equal(executions, 1);
  assert.equal(f.team.artifactReviews(admitted.id).length, 1);
  assert.doesNotMatch(JSON.stringify(recovered), /Main opened the received/);
});

test('hard-linked worker outputs cannot reveal another file through a nomination', async t => {
  const f = await fixture(t);
  const privateFile = path.join(f.root, 'private.txt');
  await writeFile(privateFile, 'PRIVATE_OTHER_PROFILE_CANARY');
  await link(privateFile, f.source);
  await assert.rejects(f.service.receive(f.record), /assigned, non-sensitive/);
  assert.equal(f.team.artifactHandoff(f.record.id), null);
});

test('linked source folders and redirected Main inboxes cannot cross workspace boundaries', async t => {
  const f = await fixture(t);
  const elsewhere = path.join(f.root, 'elsewhere');
  await mkdir(elsewhere); await writeFile(path.join(elsewhere, 'private.txt'), 'PRIVATE_OTHER_PROFILE_CANARY');
  try { await symlink(elsewhere, path.join(f.workspaceRoot, 'bots', 'writer', 'redirect'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('Symlink creation unavailable'); return; }
  await assert.rejects(f.service.receive({ ...f.record, message: assignment('redirect/private.txt'), reply: answer('redirect/private.txt') }), /Linked team/);
  await writeFile(f.source, 'assigned output');
  await mkdir(path.join(f.workspaceRoot, 'main', '.hob'));
  await symlink(elsewhere, path.join(f.workspaceRoot, 'main', '.hob', 'team-inbox'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.receive(f.record), /Linked team/);
  assert.equal(await readFile(path.join(elsewhere, 'private.txt'), 'utf8'), 'PRIVATE_OTHER_PROFILE_CANARY');
});
