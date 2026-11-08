#!/usr/bin/env node
// Team-memory CLI — the operable surface of hermes-team-memory.mjs.
//
// Main's scheduled sweep job runs this from its own tools, for example:
//   node server/team-memory-cli.mjs sweep <workspace-root>
// The CLI enforces the delivery rules and persists state; it never decides
// whether an outcome actually happened in the world — Main verifies that
// and passes the result back with `followup set-status`.
//
//   init <root>                                   create the team stores
//   sweep <root>                                  report due items (no mutation)
//   detect <root> <file> [--from <bot>]           draft follow-ups from a summary/reply
//   promote <root> <file> --from <bot> [--approve] parse PROMOTE, apply Tier 1, gate Tier 2
//   followup <root> add --title T --owner O --outcome X --destination D [--deadline D] [--source S] [--evidence E]
//   followup <root> set-status <id> <status> [--note N]
//   followup <root> delivered <id>
//   tasks <root> add --id T-001 --owner O --outcome X [--deadline D] [--output P]
//   tasks <root> set-status <id> <status>
//   core <root> show                              print the team core
//   core <root> append --fact F [--evidence E] [--approve]
// All output is JSON on stdout; errors go to stderr with exit code 1.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  addTask, advanceStep, applyPromotion, classifyPromotion, coreBlockText, createFollowup,
  createTaskRegistry, delegateTask, detectOpenThreads, followupsTemplate, loadRejectedPromotions,
  parseFollowups, parsePromoteSection, planTask, preferencesTemplate, readFollowups,
  readPreferences, readTaskBoard, readTeamCore, renderFollowups, shouldSurface,
  startTask, statusAnswer, tasksTemplate, updateFollowup, updateTask, writeFollowups, writeTaskBoard,
  writeTeamCore,
} from './hermes-team-memory.mjs';

const fail = message => { console.error(message); process.exit(1); };
const out = value => console.log(JSON.stringify(value, null, 2));

const flag = (args, name) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) fail(`Missing value for --${name}.`);
  return value;
};
const hasFlag = (args, name) => args.includes(`--${name}`);
const required = (value, name) => { if (value === undefined) fail(`Missing --${name}.`); return value; };

async function init(root) {
  const created = [];
  const ensure = async (file, template) => {
    try { await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, template, 'utf8');
      created.push(path.relative(root, file));
    }
  };
  await ensure(path.join(root, 'main', 'TEAM_CORE.md'), [
    '# Team core',
    '',
    '<!-- Durable facts only: who the user is, contact and delivery details,',
    'standing preferences, standing rules, durable project facts, named',
    'decisions with dates. No task status, no transcripts, no speculation,',
    'no secrets. Main owns this file; workers receive it as a synced block. -->',
    '',
  ].join('\n'));
  await ensure(path.join(root, 'main', 'shared', 'TASKS.md'), tasksTemplate());
  await ensure(path.join(root, 'main', 'shared', 'FOLLOWUPS.md'), followupsTemplate());
  await ensure(path.join(root, 'main', 'PROACTIVE_PREFERENCES.md'), preferencesTemplate());
  out({ ok: true, created });
}

async function sweep(root) {
  const items = await readFollowups(root);
  const prefs = await readPreferences(root);
  const now = new Date();
  let deliveredCount = 0;
  const report = { now: now.toISOString(), quietHours: prefs.quietHours, dailyCap: prefs.dailyCap, items: [] };
  for (const item of items) {
    if (item.status !== 'open') { report.items.push({ id: item.id, title: item.title, action: 'skip', reason: `status is ${item.status}` }); continue; }
    const surface = shouldSurface(item, { now, preferences: prefs, deliveredCount });
    if (surface.ok) {
      deliveredCount += 1;
      report.items.push({ id: item.id, title: item.title, action: 'deliver', reason: surface.reason, outcome: item.outcome, destination: item.destination });
    } else if (surface.reason === 'on the never re-offer list') {
      report.items.push({ id: item.id, title: item.title, action: 'skip', reason: surface.reason });
    } else {
      report.items.push({ id: item.id, title: item.title, action: 'defer', reason: surface.reason });
    }
  }
  out(report);
}

async function detect(root, file, from) {
  const content = await readFile(file, 'utf8');
  const rejected = from ? await loadRejectedPromotions(path.join(root, from === 'default' ? 'main' : path.join('bots', from))) : [];
  const drafts = detectOpenThreads(content, { source: file, existing: rejected });
  out({ ok: true, drafts });
}

async function promote(root, file, from, approve) {
  const reply = await readFile(file, 'utf8');
  const proposals = parsePromoteSection(reply);
  const results = [];
  for (const proposal of proposals) {
    const tier = classifyPromotion(proposal.fact);
    if (tier === 'tier2' && !approve) {
      results.push({ ...proposal, tier, applied: false, reason: 'tier2-needs-user-approval' });
      continue;
    }
    const applied = await applyPromotion(root, { ...proposal, tier, userApproved: approve });
    results.push({ ...proposal, tier, ...applied });
  }
  out({ ok: true, from, results });
}

async function followup(root, args) {
  const action = args[0];
  const items = await readFollowups(root);
  if (action === 'add') {
    const next = createFollowup(items, {
      title: required(flag(args, 'title'), 'title'),
      owner: required(flag(args, 'owner'), 'owner'),
      outcome: required(flag(args, 'outcome'), 'outcome'),
      destination: required(flag(args, 'destination'), 'destination'),
      deadline: flag(args, 'deadline'),
      source: flag(args, 'source'),
      evidence: flag(args, 'evidence'),
      notes: flag(args, 'notes'),
      kind: flag(args, 'kind'),
    });
    await writeFollowups(root, next);
    out({ ok: true, id: next.at(-1).id });
  } else if (action === 'set-status') {
    const id = args[1];
    const status = args[2];
    if (!id || !status) fail('Usage: followup <root> set-status <id> <status> [--note N].');
    const note = flag(args, 'note');
    const next = updateFollowup(items, id, { status, lastChecked: new Date().toISOString(), ...(note ? { notes: note } : {}) });
    await writeFollowups(root, next);
    out({ ok: true, id, status });
  } else if (action === 'delivered') {
    const id = args[1];
    if (!id) fail('Usage: followup <root> delivered <id>.');
    const next = updateFollowup(items, id, { status: 'delivered', lastChecked: new Date().toISOString() });
    await writeFollowups(root, next);
    out({ ok: true, id, status: 'delivered' });
  } else {
    fail('Unknown followup action. Use add, set-status, or delivered.');
  }
}

async function tasks(root, args) {
  const action = args[0];
  const board = await readTaskBoard(root);
  const registry = createTaskRegistry(board.tasks, board.steps);
  const save = async () => writeTaskBoard(root, registry.tasks, registry.steps);
  if (action === 'add') {
    const next = addTask(registry.tasks, {
      id: required(flag(args, 'id'), 'id'),
      owner: required(flag(args, 'owner'), 'owner'),
      outcome: required(flag(args, 'outcome'), 'outcome'),
      deadline: flag(args, 'deadline'),
      output: flag(args, 'output'),
      status: flag(args, 'status') || 'planned',
    });
    registry.tasks = next;
    await save();
    out({ ok: true, id: next.at(-1).id });
  } else if (action === 'set-status') {
    const id = args[1];
    const status = args[2];
    if (!id || !status) fail('Usage: tasks <root> set-status <id> <status>.');
    registry.tasks = updateTask(registry.tasks, id, { status });
    await save();
    out({ ok: true, id, status });
  } else if (action === 'plan') {
    const id = args[1];
    const steps = required(flag(args, 'steps'), 'steps').split(';').map(step => step.trim()).filter(Boolean);
    if (!id || !steps.length) fail('Usage: tasks <root> plan <id> --steps "one;two;three" [--needs "..."].');
    const plan = planTask(registry, id, steps, flag(args, 'needs') || '');
    await save();
    out({ ok: true, id, plan });
  } else if (action === 'start') {
    const id = args[1];
    if (!id) fail('Usage: tasks <root> start <id>.');
    const task = startTask(registry, id);
    await save();
    out({ ok: true, id, status: task.status });
  } else if (action === 'delegate') {
    const id = args[1];
    const worker = args[2];
    if (!id || !worker) fail('Usage: tasks <root> delegate <id> <worker>.');
    const message = delegateTask(registry, id, worker);
    await save();
    out({ ok: true, id, worker, delegation: message });
  } else if (action === 'step') {
    const id = args[1];
    const index = Number(args[2]);
    const state = args[3];
    if (!id || !Number.isSafeInteger(index) || !state) fail('Usage: tasks <root> step <id> <n> <done|in_progress|pending|blocked>.');
    const update = advanceStep(registry, id, index, state);
    await save();
    out({ ok: true, id, step: index, state, ...(update ? { progressUpdate: update } : {}) });
  } else if (action === 'status') {
    const id = args[1];
    if (!id) fail('Usage: tasks <root> status <id>.');
    out({ ok: true, id, status: statusAnswer(registry, id) });
  } else {
    fail('Unknown tasks action. Use add, set-status, plan, start, delegate, step, or status.');
  }
}

async function core(root, args) {
  const action = args[0];
  if (action === 'show') {
    const content = await readTeamCore(root);
    out({ ok: true, core: content, injected: coreBlockText(content) });
  } else if (action === 'append') {
    const fact = required(flag(args, 'fact'), 'fact');
    const evidence = flag(args, 'evidence') || '';
    const approve = hasFlag(args, 'approve');
    const result = await applyPromotion(root, { fact, evidence, userApproved: approve });
    out({ ok: true, ...result });
  } else {
    fail('Unknown core action. Use show or append.');
  }
}

async function main() {
  const [command, root, ...args] = process.argv.slice(2);
  if (!command || !root) {
    fail('Usage: node team-memory-cli.mjs <init|sweep|detect|promote|followup|tasks|core> <workspace-root> [args…]');
  }
  const resolved = path.resolve(root);
  try {
    if (command === 'init') await init(resolved);
    else if (command === 'sweep') await sweep(resolved);
    else if (command === 'detect') await detect(resolved, required(args[0], 'file'), flag(args, 'from'));
    else if (command === 'promote') await promote(resolved, required(args[0], 'file'), required(flag(args, 'from'), 'from'), hasFlag(args, 'approve'));
    else if (command === 'followup') await followup(resolved, args);
    else if (command === 'tasks') await tasks(resolved, args);
    else if (command === 'core') await core(resolved, args);
    else fail(`Unknown command: ${command}.`);
  } catch (error) {
    fail(`team-memory: ${error.message}`);
  }
}

await main();
