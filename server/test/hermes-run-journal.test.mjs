import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HermesRunJournal } from '../hermes-run-journal.mjs';
import { hermesSessionKey } from '../hermes-client.mjs';

const key = hermesSessionKey('coder', 'session-1');
const submission = { input: 'Synthetic private task', requestKey: 'submission-1', credentialBinding: 'a'.repeat(64), retentionSeconds: 86400 };
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-run-journal-'));
  try { await run(root, await HermesRunJournal.open(root)); }
  finally {
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith('hob-run-journal-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('unconfirmed admission survives restart with its original key and immutable input fingerprint', async () => fixture(async (root, journal) => {
  const record = await journal.reserve(key, submission);
  assert.equal(record.runId, null);
  assert.equal(record.profile, 'coder');
  assert.ok(record.replayUntil > Date.now());
  const restored = await HermesRunJournal.open(root);
  assert.deepEqual(restored.get(key), record);
  const returned = restored.get(key); returned.input = 'Caller mutation';
  assert.equal(restored.get(key).input, submission.input);
  await assert.rejects(restored.reserve(key, { ...submission, requestKey: 'other' }), /awaiting recovery/);
}));

test('shutdown flush joins queued atomic writes before another owner opens the journal', async () => fixture(async (root, journal) => {
  const reservation = journal.reserve(key, submission);
  const admission = journal.update(key, submission.requestKey, { runId: 'native-run', status: 'running' });
  const settlement = journal.update(key, submission.requestKey, { status: 'failed' });
  await journal.flush();
  await Promise.all([reservation, admission, settlement]);
  const reopened = await HermesRunJournal.open(root);
  assert.equal(reopened.get(key).status, 'failed');
  assert.equal(reopened.get(key).runId, 'native-run');
  assert.equal(reopened.get(key).input, undefined);
}));

test('confirmed native run IDs persist while original prompt text is removed', async () => fixture(async (root, journal) => {
  await journal.reserve(key, submission);
  await journal.update(key, submission.requestKey, { runId: 'run-1', status: 'running' });
  const restored = await HermesRunJournal.open(root);
  assert.equal(restored.get(key).runId, 'run-1');
  assert.equal(restored.get(key).input, undefined);
  assert.equal((await readFile(path.join(root, 'runs.json'), 'utf8')).includes(submission.input), false);
}));

test('unconfirmed image inputs are immutable across queued writes and restart, then removed after native confirmation', async () => fixture(async (root, journal) => {
  const attachments = [{ path: '/native/coder/cache/images/photo.png', mime: 'image/png' }];
  const reservation = journal.reserve(key, { ...submission, attachments });
  attachments[0].path = '/caller-mutation';
  await reservation;
  const restored = await HermesRunJournal.open(root);
  assert.equal(restored.get(key).attachments[0].path, '/native/coder/cache/images/photo.png');
  await restored.update(key, submission.requestKey, { runId: 'native-run', status: 'running' });
  assert.equal((await HermesRunJournal.open(root)).get(key).attachments, undefined);
}));

test('unknown native work is never treated as terminal authority after restart', async () => fixture(async (root, journal) => {
  await journal.reserve(key, submission);
  await journal.update(key, submission.requestKey, { runId: 'run-1', status: 'unknown', generation: 42, admissionId: 'admission-1' });
  const restored = await HermesRunJournal.open(root);
  await assert.rejects(restored.reserve(key, { ...submission, requestKey: 'other' }), /awaiting recovery/);
  assert.equal(restored.get(key).generation, 42);
}));

test('concurrent submissions reserve once and late observers cannot overwrite a later turn', async () => fixture(async (_root, journal) => {
  const results = await Promise.allSettled([journal.reserve(key, submission), journal.reserve(key, { ...submission, requestKey: 'submission-2' })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  await journal.update(key, submission.requestKey, { status: 'failed' });
  await journal.reserve(key, { ...submission, requestKey: 'submission-2' });
  await journal.update(key, submission.requestKey, { status: 'completed', runId: 'old-run' });
  assert.equal(journal.get(key).requestKey, 'submission-2');
  assert.equal(journal.get(key).runId, null);
}));

test('definitively rejected admission can settle without an ID and cannot regress on an old poll', async () => fixture(async (root, journal) => {
  await journal.reserve(key, submission);
  await journal.update(key, submission.requestKey, { status: 'failed' });
  await journal.update(key, submission.requestKey, { status: 'running' });
  assert.equal((await HermesRunJournal.open(root)).get(key).status, 'failed');
  await assert.rejects(journal.reserve(key, submission), /completed under that request key/);
  await journal.reserve(key, { ...submission, requestKey: 'different-user-intent' });
}));

test('no declared durable replay window means no recovery authority is recorded', async () => fixture(async (_root, journal) => {
  const record = await journal.reserve(key, { ...submission, retentionSeconds: 0 });
  assert.equal(record.replayUntil, 0);
}));

test('corrupt or owner-confused state fails closed and is not replaced with an empty journal', async () => fixture(async (root, journal) => {
  await journal.reserve(key, submission);
  const filename = path.join(root, 'runs.json');
  const data = JSON.parse(await readFile(filename, 'utf8'));
  data.runs[0].profile = 'other';
  const bytes = JSON.stringify(data);
  await writeFile(filename, bytes);
  await assert.rejects(HermesRunJournal.open(root), /Invalid run journal/);
  assert.equal(await readFile(filename, 'utf8'), bytes);
}));

test('hard-linked state is refused before existing bytes can acquire recovery authority', async () => fixture(async (root) => {
  const filename = path.join(root, 'runs.json');
  await link(filename, path.join(root, 'alias.json'));
  await assert.rejects(HermesRunJournal.open(root), /Invalid run journal/);
}));
