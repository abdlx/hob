import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { HermesTeam, coreBlock } from '../hermes-team.mjs';
import { parseTeamTask } from '../hermes-team-protocol.mjs';
import {
  addTask, addTaskStep, advanceStep, annotateJobFailures, appendDailyLog, applyPromotion,
  classifyPromotion, createFollowup, createProgressUpdate, createTaskRegistry,
  delegateTask, detectOpenThreads, findCoreConflicts, handleUserMessage, inQuietHours,
  loadRejectedPromotions, parseFollowups, parsePreferences, parsePromoteSection, parseTaskBoard,
  parseTasks, planAcknowledgementText, planTask, preferencesTemplate, progressUpdateText,
  readFollowups, readPreferences, readTaskBoard, readTasks, recordRejectedPromotion,
  relayStatusText, renderFollowups, renderTasks, runFollowupSweep, setTaskStep, shouldSurface,
  startTask, statusAnswer, taskProgress, updateFollowup, updateTask, verifyClaimedFiles,
  writeFollowups, writeTaskBoard,
} from '../hermes-team-memory.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../team-memory-cli.mjs', import.meta.url));
const NOW = new Date('2026-11-08T12:00:00Z');
const PREFS = { quietHours: { start: '22:00', end: '08:00', timezone: 'Asia/Karachi' }, dailyCap: 3, delivery: 'user chat', neverOffer: [] };

async function fixture(runFn) {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-team-memory-'));
  try { await runFn(root); }
  finally {
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith('hob-team-memory-'));
    await rm(root, { recursive: true, force: true });
  }
}

function teamIn(t, root) {
  const team = new HermesTeam({
    stateDir: path.join(root, 'team-state'),
    workspaceRoot: root,
    roster: () => [{ name: 'default', state: 'active' }, { name: 'writer', state: 'active' }],
    nativeHome: path.join(root, 'native'),
  });
  t.after(() => team.close());
  return team;
}

const cli = (root, args) => run(process.execPath, [CLI, ...args], {
  cwd: root,
  env: { ...process.env, HOB_STATE_DIR: path.join(root, 'team-state') },
}).then(({ stdout }) => JSON.parse(stdout));

function followupItems() {
  let items = [];
  items = createFollowup(items, { title: 'Send the clips link', owner: 'main', outcome: 'User has the clips link', destination: 'user chat', source: 'chat', evidence: 'send me the link when ready' }, { now: NOW });
  items = createFollowup(items, { title: 'Already done thing', owner: 'main', outcome: 'Report sent', destination: 'user chat' }, { now: NOW });
  items = createFollowup(items, { title: 'No longer relevant', owner: 'main', outcome: 'Book the old venue', destination: 'user chat' }, { now: NOW });
  items = createFollowup(items, { title: 'Cannot tell yet', owner: 'main', outcome: 'Check the refund', destination: 'user chat' }, { now: NOW });
  items = createFollowup(items, { title: 'Future deadline', owner: 'main', outcome: 'Renew in December', destination: 'user chat', deadline: '2026-12-01' }, { now: NOW });
  items = createFollowup(items, { title: 'Declined offer', owner: 'main', outcome: 'Offer the paid workshop', destination: 'user chat' }, { now: NOW });
  return items;
}

// ---------------------------------------------------------------------------
// Task board + step lists
// ---------------------------------------------------------------------------

test('task board round-trips through markdown, including steps', () => {
  let tasks = [];
  tasks = addTask(tasks, { id: 'T-001', owner: 'writer', outcome: 'Draft release notes', deadline: '2026-11-10', output: 'shared/release-notes.md', status: 'planned' });
  let steps = addTaskStep({}, 'T-001', 'Outline the notes');
  steps = addTaskStep(steps, 'T-001', 'Draft sections 1-3');
  steps = addTaskStep(steps, 'T-001', 'Proofread and deliver');
  const rendered = renderTasks(tasks, steps);
  const board = parseTaskBoard(rendered);
  assert.deepEqual(board.tasks, tasks);
  assert.deepEqual(board.steps['T-001'].map(step => [step.index, step.title, step.state]), [
    [1, 'Outline the notes', 'pending'],
    [2, 'Draft sections 1-3', 'pending'],
    [3, 'Proofread and deliver', 'pending'],
  ]);
  assert.throws(() => addTask(tasks, { id: 'T-001', owner: 'writer', outcome: 'Duplicate', status: 'planned' }), /already exists/);
  assert.throws(() => addTask([], { id: 'T-002', owner: 'writer', outcome: 'Bad status', status: 'open' }), /Unknown task status/);
  const moved = updateTask(tasks, 'T-001', { status: 'in_progress' });
  assert.equal(moved[0].status, 'in_progress');
  assert.throws(() => updateTask(tasks, 'T-999', { status: 'done' }), /not found/);
});

test('exactly one step may be in progress at a time', () => {
  let steps = addTaskStep({}, 'T-001', 'One');
  steps = addTaskStep(steps, 'T-001', 'Two');
  steps = setTaskStep(steps, 'T-001', 1, 'in_progress');
  assert.throws(() => setTaskStep(steps, 'T-001', 2, 'in_progress'), /already has a step in progress/);
  steps = setTaskStep(steps, 'T-001', 1, 'done');
  steps = setTaskStep(steps, 'T-001', 2, 'in_progress');
  assert.deepEqual(taskProgress(steps, 'T-001'), {
    total: 2, done: 1,
    current: { index: 2, title: 'Two', state: 'in_progress' },
    next: null,
  });
  assert.throws(() => setTaskStep(steps, 'T-001', 9, 'done'), /no step 9/);
  assert.throws(() => setTaskStep(steps, 'T-001', 2, 'flying'), /Unknown step state/);
});

test('task board files round-trip on disk', async () => fixture(async root => {
  const tasks = addTask([], { id: 'T-001', owner: 'writer', outcome: 'Draft', deadline: 'none', output: 'none', status: 'planned' });
  const steps = addTaskStep({}, 'T-001', 'Outline');
  await writeTaskBoard(root, tasks, steps);
  assert.deepEqual(await readTaskBoard(root), { tasks, steps });
  assert.deepEqual(await readTasks(root), tasks);
}));

// ---------------------------------------------------------------------------
// Follow-ups + preferences + logs
// ---------------------------------------------------------------------------

test('follow-ups round-trip, sequence ids, and default the kind', () => {
  let items = [];
  items = createFollowup(items, { title: 'First', owner: 'main', outcome: 'Done thing', destination: 'user chat' }, { now: NOW });
  items = createFollowup(items, { title: 'Second', owner: 'main', outcome: 'Other thing', destination: 'user chat', deadline: '2026-11-15' }, { now: NOW });
  assert.deepEqual(items.map(item => item.id), ['FU-001', 'FU-002']);
  assert.equal(items[0].kind, 'followup');
  assert.equal(items[0].status, 'open');
  const rendered = renderFollowups(items);
  assert.deepEqual(parseFollowups(rendered).map(item => item.id), ['FU-001', 'FU-002']);
  assert.throws(() => createFollowup(items, { title: '', owner: 'main', outcome: 'x', destination: 'user chat' }), /title is required/);
  assert.throws(() => createFollowup(items, { title: 'Bad', owner: 'main', outcome: 'x', destination: 'user chat', deadline: 'soon' }), /deadline must be/);
  const moved = updateFollowup(items, 'FU-001', { status: 'done' });
  assert.equal(moved[0].status, 'done');
  assert.throws(() => updateFollowup(items, 'FU-001', { status: 'flying' }), /Unknown follow-up status/);
  const progress = createProgressUpdate(items, { taskId: 'T-001', stepTitle: 'Outline', nextTitle: 'Draft' });
  assert.equal(progress.at(-1).kind, 'progress');
  assert.match(progress.at(-1).title, /^Progress: T-001 — Outline/);
});

test('preferences parse quiet hours, cap, and never-offer list', () => {
  const prefs = parsePreferences(preferencesTemplate());
  assert.deepEqual(prefs.quietHours, { start: '22:00', end: '08:00', timezone: 'Asia/Karachi' });
  assert.equal(prefs.dailyCap, 3);
  assert.deepEqual(prefs.neverOffer, []);
  assert.equal(inQuietHours(prefs, new Date('2026-11-08T18:00:00Z')), true, '23:00 PKT is quiet');
  assert.equal(inQuietHours(prefs, NOW), false, '17:00 PKT is not quiet');
  const day = { quietHours: { start: '09:00', end: '17:00', timezone: 'UTC' }, dailyCap: 3, delivery: 'user chat', neverOffer: ['FU-002'] };
  assert.equal(inQuietHours(day, new Date('2026-11-08T12:00:00Z')), true);
  assert.equal(inQuietHours(day, new Date('2026-11-08T18:00:00Z')), false);
  const open = { quietHours: null, dailyCap: 3, delivery: 'user chat', neverOffer: ['FU-002'] };
  const item = { id: 'FU-002', title: 'Declined offer', status: 'open' };
  assert.equal(shouldSurface(item, { now: NOW, preferences: open, deliveredCount: 0 }).ok, false);
  assert.equal(shouldSurface(item, { now: NOW, preferences: open, deliveredCount: 0 }).reason, 'on the never re-offer list');
  assert.equal(shouldSurface({ ...item, id: 'FU-001', title: 'Other' }, { now: NOW, preferences: open, deliveredCount: 3 }).reason, 'daily cap reached');
  assert.equal(shouldSurface({ ...item, id: 'FU-001', title: 'Other', deadline: '2026-12-01' }, { now: NOW, preferences: open, deliveredCount: 0 }).reason, 'not due yet');
});

test('daily logs append dated entries', async () => fixture(async root => {
  const workspace = path.join(root, 'main');
  const file = await appendDailyLog(workspace, 'Session started.', { now: NOW });
  await appendDailyLog(workspace, 'Task T-001 planned.', { now: NOW });
  const content = await readFile(file, 'utf8');
  assert.match(content, /# 2026-11-08/);
  assert.match(content, /Session started\./);
  assert.match(content, /Task T-001 planned\./);
  await assert.rejects(appendDailyLog(workspace, '   '), /must not be empty/);
}));

// ---------------------------------------------------------------------------
// Open-thread detector
// ---------------------------------------------------------------------------

test('detector drafts questions, promises, deadlines, and stalled items', () => {
  const text = [
    'The user asked: when will the clips be ready?',
    "I'll send the report tomorrow morning.",
    "The exam is on 2026-11-12, don't forget.",
    "Still waiting on the teacher's reply.",
    'The sky is blue and the video rendered fine.',
    "I'll send the report tomorrow morning.",
  ].join('\n');
  const drafts = detectOpenThreads(text, { source: 'session summary' });
  assert.deepEqual(drafts.map(draft => draft.kind), ['question', 'promise', 'deadline', 'stalled']);
  assert.equal(drafts[1].evidence, "I'll send the report tomorrow morning.");
  assert.equal(drafts[2].deadline, '2026-11-12');
  assert.equal(drafts[0].source, 'session summary');
  const again = detectOpenThreads(text, { source: 'x', existing: drafts.map(draft => draft.title) });
  assert.deepEqual(again, [], 'already-drafted threads are not re-drafted');
  assert.deepEqual(detectOpenThreads('Plain statements only.\nNothing owed here.'), []);
});

// ---------------------------------------------------------------------------
// Follow-up sweep
// ---------------------------------------------------------------------------

test('sweep checks state first and never delivers about a finished item', async () => {
  const items = followupItems();
  const delivered = [];
  const states = { 'FU-001': 'still-open', 'FU-002': 'done', 'FU-003': 'not-relevant', 'FU-004': 'unknown', 'FU-005': 'still-open', 'FU-006': 'still-open', 'FU-007': 'still-open' };
  // FU-007's state check throws.
  const checkState = async item => {
    if (item.id === 'FU-007') throw new Error('checker down');
    return states[item.id];
  };
  const seventh = createFollowup(items, { title: 'Seventh', owner: 'main', outcome: 'Seventh thing', destination: 'user chat' }, { now: NOW });
  const { report, items: next } = await runFollowupSweep({
    items: seventh,
    now: NOW, preferences: { ...PREFS, neverOffer: ['FU-006'] },
    checkState,
    deliver: async item => { delivered.push(item.id); },
  });
  assert.deepEqual(delivered, ['FU-001'], 'only the due, still-open item is delivered');
  assert.deepEqual(report.closed.map(entry => entry.id), ['FU-002', 'FU-003']);
  assert.deepEqual(report.checked.map(entry => entry.id), ['FU-004', 'FU-007']);
  assert.deepEqual(report.deferred.map(entry => entry.id), ['FU-005']);
  assert.deepEqual(report.skipped.map(entry => entry.id), ['FU-006']);
  const byId = Object.fromEntries(next.map(item => [item.id, item]));
  assert.equal(byId['FU-001'].status, 'delivered');
  assert.equal(byId['FU-002'].status, 'done');
  assert.equal(byId['FU-003'].status, 'closed');
  assert.equal(byId['FU-004'].status, 'open', 'unknown state leaves the item open');
  assert.equal(byId['FU-005'].status, 'deferred');
});

test('sweep defers in quiet hours, at the cap, and on delivery failure', async () => {
  const items = followupItems().slice(0, 1);
  const quiet = await runFollowupSweep({
    items, now: new Date('2026-11-08T18:00:00Z'), preferences: PREFS,
    checkState: async () => 'still-open', deliver: async () => { throw new Error('unreachable'); },
  });
  assert.deepEqual(quiet.report.deferred.map(entry => entry.reason), ['quiet hours']);
  assert.equal(quiet.items[0].status, 'deferred');

  const capped = await runFollowupSweep({
    items: followupItems().slice(0, 2), now: NOW, preferences: { ...PREFS, dailyCap: 1 },
    checkState: async () => 'still-open', deliver: async () => {},
  });
  assert.deepEqual(capped.report.delivered.map(entry => entry.id), ['FU-001']);
  assert.deepEqual(capped.report.deferred.map(entry => entry.reason), ['daily cap reached']);

  const failing = await runFollowupSweep({
    items: followupItems().slice(0, 1), now: NOW, preferences: PREFS,
    checkState: async () => 'still-open', deliver: async () => { throw new Error('channel down'); },
  });
  assert.match(failing.report.deferred[0].reason, /delivery failed: channel down/);
  assert.equal(failing.items[0].status, 'deferred');

  // A deferred item is re-evaluated on the next sweep, not forgotten.
  const retry = await runFollowupSweep({
    items: failing.items, now: NOW, preferences: PREFS,
    checkState: async () => 'still-open', deliver: async () => {},
  });
  assert.deepEqual(retry.report.delivered.map(entry => entry.id), ['FU-001']);
});

// ---------------------------------------------------------------------------
// Promotion flow — staged through the team database, never written direct
// ---------------------------------------------------------------------------

test('promotion parsing, tiering, and gating', async t => fixture(async root => {
  const team = teamIn(t, root);
  const reply = [
    'TASK T-001 — DONE',
    'RESULT: did the work',
    'FILES: shared/notes.md',
    'VERIFICATION: read it back',
    'BLOCKERS: none',
    'PROMOTE:',
    '- The user prefers short replies. — Evidence: user said "keep it short" in chat.',
    '- Clipfac runs on Coolify. (evidence: deploy log 2026-11-07)',
  ].join('\n');
  const proposals = parsePromoteSection(reply);
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].fact, 'The user prefers short replies.');
  assert.equal(proposals[0].evidence, 'user said "keep it short" in chat.');
  assert.equal(proposals[1].fact, 'Clipfac runs on Coolify.');
  assert.equal(proposals[1].evidence, 'deploy log 2026-11-07');
  assert.deepEqual(parsePromoteSection('TASK T-001 — DONE\nPROMOTE: none'), []);
  assert.deepEqual(parsePromoteSection('No promote section here.'), []);

  assert.equal(classifyPromotion('Clipfac runs on Coolify.'), 'tier1');
  assert.equal(classifyPromotion('The user prefers short replies.'), 'tier2');
  assert.equal(classifyPromotion('The tool costs $5 a month.'), 'tier2');

  // Tier 1 without approval is staged, not applied: the user decides.
  const staged = await applyPromotion(team, { fact: 'Clipfac runs on Coolify.', evidence: 'deploy log 2026-11-07' });
  assert.deepEqual(
    { applied: staged.applied, tier: staged.tier, reason: staged.reason },
    { applied: false, tier: 'tier1', reason: 'proposed-pending-user-approval' },
  );
  assert.equal(team.core().revision, 0, 'nothing is in the core until the user decides');
  assert.equal(team.status().proposals.length, 1);
  const pending = team.proposal(staged.proposalId);
  team.decide({ id: pending.id, base: pending.base, digest: pending.digest, decision: 'approve', confirm: true });
  assert.equal(team.core().revision, 1);
  assert.match(team.core().content, /Clipfac runs on Coolify\./);
  assert.match(coreBlock(team.core()), /Clipfac runs on Coolify\./, 'the fact is injected, not retrieval-only');

  const duplicate = await applyPromotion(team, { fact: 'Clipfac runs on Coolify.' });
  assert.equal(duplicate.reason, 'already-in-core');

  const tier2 = await applyPromotion(team, { fact: 'The user prefers short replies.' });
  assert.equal(tier2.applied, false);
  assert.equal(tier2.reason, 'tier2-needs-user-approval');
  const approved = await applyPromotion(team, { fact: 'The user prefers short replies.', userApproved: true });
  assert.equal(approved.applied, true);
  assert.equal(team.core().revision, 2);
  assert.match(team.core().content, /prefers short replies/);

  // A conflicting proposal is flagged for Main, never auto-applied.
  const conflicts = findCoreConflicts('The user prefers long detailed replies.', team.core().content);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /prefers short replies/);
  const conflicted = await applyPromotion(team, { fact: 'The user prefers long detailed replies.', userApproved: true });
  assert.equal(conflicted.applied, false);
  assert.equal(conflicted.reason, 'possible-conflict');
}));

test('promoted facts land in Essential, never in Reference', async t => fixture(async root => {
  const team = teamIn(t, root);
  const seed = team.propose({ author: 'user', content: '# Essential\n\n- Seed fact.\n\n# Reference\n\n- Retrieval-only detail.\n', base: 0, evidence: 'seed' });
  team.decide({ id: seed.id, base: seed.base, digest: seed.digest, decision: 'approve', confirm: true });
  const applied = await applyPromotion(team, { fact: 'Clipfac runs on Coolify.', userApproved: true });
  assert.equal(applied.applied, true);
  const content = team.core().content;
  assert.ok(content.indexOf('Clipfac runs on Coolify.') > content.indexOf('# Essential'));
  assert.ok(content.indexOf('Clipfac runs on Coolify.') < content.indexOf('# Reference'));
  assert.match(coreBlock(team.core()), /Clipfac runs on Coolify\./);
  assert.doesNotMatch(coreBlock(team.core()), /Retrieval-only detail/);
  assert.equal(team.history().length, 2, 'every approved revision persists');
}));

test('tier 1 applies alone only when the team policy allows it', async t => fixture(async root => {
  const team = teamIn(t, root);
  // The policy value is not user-configurable yet (open decision 6); flip
  // it directly in the database to exercise the coordinator branch.
  const db = new DatabaseSync(path.join(root, 'team-state', 'employee-team.sqlite'));
  try {
    const settings = JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get().value);
    db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({ ...settings, ordinaryPromotions: 'coordinator' }));
  } finally { db.close(); }
  assert.equal(team.policy().ordinaryPromotions, 'coordinator');
  const applied = await applyPromotion(team, { fact: 'Clipfac runs on Coolify.' });
  assert.equal(applied.applied, true);
  assert.equal(team.core().revision, 1);
}));

test('rejected promotions are recorded and stay out of the core', async t => fixture(async root => {
  const team = teamIn(t, root);
  const workspace = path.join(root, 'bots', 'writer');
  await mkdir(workspace, { recursive: true });
  await recordRejectedPromotion(workspace, { fact: 'The user loves pineapple pizza.', reason: 'not durable' }, { now: NOW });
  const rejected = await loadRejectedPromotions(workspace);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /pineapple pizza/);
  assert.doesNotMatch(team.core().content, /pineapple pizza/);
  assert.deepEqual(await loadRejectedPromotions(path.join(root, 'bots', 'nobody')), []);
}));

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

test('verifyClaimedFiles checks existence and refuses traversal', async () => fixture(async root => {
  await mkdir(path.join(root, 'main'), { recursive: true });
  await writeFile(path.join(root, 'main', 'report.md'), 'proof');
  const result = await verifyClaimedFiles(['main/report.md', 'main/missing.md', '../escape.md', '/etc/passwd'], root);
  assert.deepEqual(result, { found: ['main/report.md'], missing: ['main/missing.md', '../escape.md', '/etc/passwd'] });
}));

test('orphan job failures are annotated as job deleted', () => {
  const entries = [
    { jobId: 'j1', status: 'failed' },
    { jobId: 'gone', status: 'failed' },
    { jobId: '', status: 'failed' },
  ];
  const annotated = annotateJobFailures(entries, [{ id: 'j1' }]);
  assert.equal(annotated[0].orphan, false);
  assert.equal(annotated[1].orphan, true);
  assert.equal(annotated[1].note, 'job deleted');
  assert.equal(annotated[2].orphan, false);
});

test('relay status text never calls a missing reply done', () => {
  assert.equal(relayStatusText({ completed: true, reply: 'ok' }, 'writer'), 'done');
  assert.equal(relayStatusText({ completed: false }, 'writer'), 'waiting on writer');
  assert.equal(relayStatusText({ completed: false, failure: 'run.failed' }, 'writer'), 'failed');
});

// ---------------------------------------------------------------------------
// How work runs — plan first, segmented, interruptible
// ---------------------------------------------------------------------------

test('plan acknowledgement lists segments and what it needs from the user', () => {
  const task = { id: 'T-001', outcome: 'Write the long report' };
  const plan = planAcknowledgementText(task, ['Outline', 'Draft sections', 'Deliver'], 'the logo file');
  assert.match(plan, /^PLAN T-001 — Write the long report/);
  assert.match(plan, /I will do this in 3 steps:/);
  assert.match(plan, /1\. Outline/);
  assert.match(plan, /3\. Deliver/);
  assert.match(plan, /NEEDS FROM YOU: the logo file/);
  assert.match(planAcknowledgementText(task, ['Outline'], ''), /NEEDS FROM YOU: nothing — starting now/);
  assert.throws(() => planAcknowledgementText(task, []), /at least one segment/);
});

test('a task cannot start without a plan', () => {
  const registry = createTaskRegistry();
  const task = { id: 'T-001', owner: 'writer', outcome: 'Write the long report', deadline: 'none', output: 'shared/report.md', status: 'planned' };
  registry.tasks = [task];
  assert.throws(() => startTask(registry, 'T-001'), /has no plan/);
  const plan = planTask(registry, 'T-001', ['Outline', 'Draft', 'Deliver'], '');
  assert.match(plan, /^PLAN T-001/);
  assert.equal(startTask(registry, 'T-001').status, 'in_progress');
  assert.throws(() => startTask(registry, 'T-001'), /not planned/);
});

test('delegation uses the exact TASK format and progress updates fire at segment boundaries', () => {
  const registry = createTaskRegistry();
  registry.tasks = [{ id: 'T-001', owner: 'writer', outcome: 'Write the long report', deadline: '2026-11-10', output: 'shared/report.md', status: 'planned' }];
  planTask(registry, 'T-001', ['Outline', 'Draft', 'Deliver'], '');
  const delegation = delegateTask(registry, 'T-001', 'writer');
  // Exactly one TASK format: the delegation parses with main's parser.
  assert.deepEqual(parseTeamTask(delegation), {
    id: 'T-001',
    title: 'Write the long report',
    fields: {
      OUTCOME: 'Write the long report',
      CONSTRAINTS: 'none',
      OUTPUT: 'shared/report.md',
      DEADLINE: '2026-11-10T00:00:00Z',
      'CORE REFS': 'none',
    },
  });
  assert.equal(registry.tasks[0].status, 'in_progress');

  assert.equal(advanceStep(registry, 'T-001', 1, 'in_progress'), null);
  const update = advanceStep(registry, 'T-001', 1, 'done');
  assert.match(update, /^UPDATE T-001 — step 1 of 3 done/);
  assert.match(update, /Next: Draft/);
  assert.match(progressUpdateText(registry.tasks[0], registry.steps), /step 1 of 3 done/);
});

test('delegation refuses an output that escapes the workspace', () => {
  const registry = createTaskRegistry();
  registry.tasks = [{ id: 'T-001', owner: 'writer', outcome: 'Write the long report', deadline: 'none', output: '../escape.md', status: 'planned' }];
  planTask(registry, 'T-001', ['Outline'], '');
  assert.throws(() => delegateTask(registry, 'T-001', 'writer'), /exact employee-team TASK header/);
});

test('a second message mid-task is answered while the first task stays in progress', () => {
  const registry = createTaskRegistry();
  registry.tasks = [{ id: 'T-001', owner: 'writer', outcome: 'Write the long report', deadline: 'none', output: 'shared/report.md', status: 'planned' }];
  planTask(registry, 'T-001', ['Outline', 'Draft', 'Deliver'], '');
  delegateTask(registry, 'T-001', 'writer');
  advanceStep(registry, 'T-001', 1, 'in_progress');

  const status = handleUserMessage(registry, 'where is my report?');
  assert.equal(status.type, 'status');
  assert.match(status.response, /T-001 \(Write the long report\) is in progress/);
  assert.match(status.response, /step 0 of 3 done/);
  assert.equal(registry.tasks[0].status, 'in_progress', 'the running task is untouched by the interruption');

  const extra = handleUserMessage(registry, 'also remind me to call the printer tomorrow');
  assert.equal(extra.type, 'new-work');
  assert.equal(extra.taskId, 'T-002');
  assert.equal(registry.tasks.length, 2);
  assert.equal(registry.tasks[0].status, 'in_progress');
  assert.equal(registry.tasks[1].status, 'planned');

  const unknown = handleUserMessage(registry, 'what is the status of T-999?');
  assert.match(unknown.response, /No task matching "T-999" is in the registry/);
});

test('Main never blocks: it delegates the long job and stays responsive', () => {
  const registry = createTaskRegistry();
  const task = { id: 'T-001', owner: 'main', outcome: 'Build the team memory system', deadline: 'none', output: 'server/hermes-team-memory.mjs', status: 'planned' };
  registry.tasks = [task];
  // Main plans first, then delegates to a worker instead of blocking.
  planTask(registry, 'T-001', ['Design the stores', 'Write the engine', 'Add tests', 'Run the suite'], '');
  const delegation = delegateTask(registry, 'T-001', 'coder');
  assert.match(delegation, /^TASK T-001 — Build the team memory system/);
  assert.equal(registry.tasks[0].owner, 'coder');
  assert.equal(registry.tasks[0].status, 'in_progress');

  // The worker reports progress at a segment boundary.
  advanceStep(registry, 'T-001', 1, 'in_progress');
  const update = advanceStep(registry, 'T-001', 1, 'done');
  assert.match(update, /UPDATE T-001 — step 1 of 4 done/);

  // Meanwhile Main answers the user twice without touching the running job.
  const first = handleUserMessage(registry, 'where is the memory system?');
  assert.equal(first.type, 'status');
  assert.match(first.response, /in progress — step 1 of 4 done/);
  const second = handleUserMessage(registry, 'also check the FA1 pace when you get a chance');
  assert.equal(second.type, 'new-work');
  assert.equal(registry.tasks[0].status, 'in_progress');
  assert.equal(registry.tasks[0].owner, 'coder');
  assert.equal(registry.tasks[1].status, 'planned');
  assert.equal(registry.tasks[1].outcome, 'also check the FA1 pace when you get a chance');
});

// ---------------------------------------------------------------------------
// CLI smoke tests
// ---------------------------------------------------------------------------

test('CLI init, tasks, followups, sweep, detect, and promote work end to end', async () => fixture(async root => {
  const created = await cli(root, ['init', root]);
  assert.equal(created.ok, true);
  assert.deepEqual(created.created.sort(), [
    'main/PROACTIVE_PREFERENCES.md',
    'main/TEAM_CORE.md',
    'main/shared/FOLLOWUPS.md',
    'main/shared/TASKS.md',
  ]);

  await cli(root, ['tasks', root, 'add', '--id', 'T-001', '--owner', 'writer', '--outcome', 'Write the long report']);
  const plan = await cli(root, ['tasks', root, 'plan', 'T-001', '--steps', 'Outline;Draft;Deliver']);
  assert.match(plan.plan, /^PLAN T-001/);
  const started = await cli(root, ['tasks', root, 'start', 'T-001']);
  assert.equal(started.status, 'in_progress');
  const stepped = await cli(root, ['tasks', root, 'step', 'T-001', '1', 'done']);
  assert.match(stepped.progressUpdate, /step 1 of 3 done/);
  const status = await cli(root, ['tasks', root, 'status', 'T-001']);
  assert.match(status.status, /in progress — step 1 of 3 done/);

  const added = await cli(root, ['followup', root, 'add', '--title', 'Send the link', '--owner', 'main', '--outcome', 'User has the link', '--destination', 'user chat']);
  assert.equal(added.id, 'FU-001');
  await cli(root, ['followup', root, 'add', '--title', 'Future thing', '--owner', 'main', '--outcome', 'Later', '--destination', 'user chat', '--deadline', '2026-12-01']);
  const sweep = await cli(root, ['sweep', root]);
  assert.deepEqual(sweep.items.map(item => [item.id, item.action]), [['FU-001', 'deliver'], ['FU-002', 'defer']]);

  await writeFile(path.join(root, 'summary.md'), "The user asked: when will this be ready?\nI'll check the logs tomorrow.\n");
  const detected = await cli(root, ['detect', root, path.join(root, 'summary.md')]);
  assert.deepEqual(detected.drafts.map(draft => draft.kind), ['question', 'promise']);

  await writeFile(path.join(root, 'reply.md'), [
    'TASK T-001 — DONE', 'RESULT: done', 'FILES: none', 'VERIFICATION: read it back', 'BLOCKERS: none',
    'PROMOTE:', '- Clipfac runs on Coolify.', '- The user prefers short replies.',
  ].join('\n'));
  // Without approval, Tier 1 is staged for the user and Tier 2 is refused.
  const promoted = await cli(root, ['promote', root, path.join(root, 'reply.md'), '--from', 'writer']);
  assert.equal(promoted.results[0].applied, false);
  assert.equal(promoted.results[0].reason, 'proposed-pending-user-approval');
  assert.equal(promoted.results[1].applied, false);
  assert.equal(promoted.results[1].reason, 'tier2-needs-user-approval');
  const before = await cli(root, ['core', root, 'show']);
  assert.equal(before.revision, 0, 'nothing is in the core until the user decides');

  // With the operator's explicit approval at the terminal, both apply.
  const approved = await cli(root, ['promote', root, path.join(root, 'reply.md'), '--from', 'writer', '--approve']);
  assert.equal(approved.results[0].applied, true);
  assert.equal(approved.results[1].applied, true);
  const after = await cli(root, ['core', root, 'show']);
  assert.equal(after.revision, 2);
  assert.match(after.core, /Clipfac runs on Coolify\./);
  assert.match(after.core, /prefers short replies/);
  assert.match(after.injected, /Clipfac runs on Coolify\./);

  // A third promote of the same reply is a duplicate, not a second core edit.
  const again = await cli(root, ['promote', root, path.join(root, 'reply.md'), '--from', 'writer', '--approve']);
  assert.deepEqual(again.results.map(result => result.reason), ['already-in-core', 'already-in-core']);
  const still = await cli(root, ['core', root, 'show']);
  assert.equal(still.revision, 2);
}));
