#!/usr/bin/env node
// Team-memory CLI — the operable surface of hermes-team-memory.mjs.
//
// Main's scheduled sweep job runs this from its own tools, for example:
//   node server/team-memory-cli.mjs sweep <workspace-root>
// The CLI enforces the delivery rules and persists state; it never decides
// whether an outcome actually happened in the world — Main verifies that
// and passes the result back with `followup set-status`.
//
// The team core itself lives in the team database (HermesTeam). `promote`
// and `core` therefore need the team state directory: pass --state-dir or
// set HOB_STATE_DIR (the server uses HOB_STATE_DIR). The core draft file
// (main/TEAM_CORE.md) is staging only — only a user-approved revision is
// distributed.
//
//   init <root>                                   create the team stores
//   sweep <root>                                  report due items (no mutation)
//   detect <root> <file> [--from <bot>]           draft follow-ups from a summary/reply
//   promote <root> <file> --from <bot> [--approve] [--state-dir D]
//                                                 parse PROMOTE, stage Tier 1, gate Tier 2
//   followup <root> add --title T --owner O --outcome X --destination D [--deadline D] [--source S] [--evidence E]
//   followup <root> set-status <id> <status> [--note N]
//   followup <root> delivered <id>
//   tasks <root> add --id T-001 --owner O --outcome X [--deadline D] [--output P]
//   tasks <root> set-status <id> <status>
//   core <root> show [--state-dir D]              print the approved core + injected block
//   core <root> append --fact F [--evidence E] [--approve] [--state-dir D]
// All output is JSON on stdout; errors go to stderr with exit code 1.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  addTask, advanceStep, applyPromotion, classifyPromotion, coreDraftPath, createFollowup,
  createTaskRegistry, delegateTask, detectOpenThreads, followupsTemplate, loadRejectedPromotions,
  parsePromoteSection, planTask, preferencesTemplate, readFollowups,
  readPreferences, readTaskBoard, renderFollowups, shouldSurface,
  startTask, statusAnswer, tasksTemplate, updateFollowup, updateTask, writeFollowups, writeTaskBoard,
} from './hermes-team-memory.mjs';
import { HermesTeam, coreBlock } from './hermes-team.mjs';

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

// The CLI roster is derived from the workspace directories: Main plus every
// bot workspace that exists. Only the coordinator ('default') proposes
// promotions, so only it must be active for promote/core.
async function cliRoster(root) {
  const names = new Set(['default']);
  try {
    for (const entry of await readdir(path.join(root, 'bots'), { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return [...names].map(name => ({ name, state: 'active' }));
}

async function teamFor(root, args) {
  const stateDir = flag(args, 'state-dir') || process.env.HOB_STATE_DIR;
  if (!stateDir) fail('Team state directory is required: set HOB_STATE_DIR or pass --state-dir.');
  // HermesTeam reads the roster synchronously; warm the cache first.
  rosterCache ??= await cliRoster(root);
  return new HermesTeam({ stateDir, workspaceRoot: root, roster: () => rosterCache });
}

let rosterCache = null;

const CORE_DRAFT_TEMPLATE = [
  '# Essential',
  '',
  '- (Add durable facts here: who the user is, contact and delivery details,',
  '  standing preferences, standing rules, durable project facts, named',
  '  decisions with dates. This section is injected into every bot.)',
  '',
  '# Reference',
  '',
  '<!-- Retrieval-only details live here. They are not injected into bots. -->',
  '',
].join('\n');

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
  await ensure(coreDraftPath(root), CORE_DRAFT_TEMPLATE);
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

async function promote(root, file, from, approve, args) {
  const reply = await readFile(file, 'utf8');
  const proposals = parsePromoteSection(reply);
  const team = await teamFor(root, args);
  try {
    const results = [];
    for (const proposal of proposals) {
      const tier = classifyPromotion(proposal.fact);
      const applied = await applyPromotion(team, { ...proposal, tier, userApproved: approve });
      results.push({ ...proposal, tier, ...applied });
    }
    out({ ok: true, from, results });
  } finally {
    team.close();
  }
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
  const team = await teamFor(root, args);
  try {
    if (action === 'show') {
      const current = team.core();
      out({ ok: true, revision: current.revision, core: current.content,
        injected: current.revision ? coreBlock(current) : '(Team core is empty. Publish a core revision to distribute it.)' });
    } else if (action === 'append') {
      const fact = required(flag(args, 'fact'), 'fact');
      const evidence = flag(args, 'evidence') || '';
      const approve = hasFlag(args, 'approve');
      const result = await applyPromotion(team, { fact, evidence, userApproved: approve });
      out({ ok: true, ...result });
    } else {
      fail('Unknown core action. Use show or append.');
    }
  } finally {
    team.close();
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
    else if (command === 'promote') await promote(resolved, required(args[0], 'file'), required(flag(args, 'from'), 'from'), hasFlag(args, 'approve'), args);
    else if (command === 'followup') await followup(resolved, args);
    else if (command === 'tasks') await tasks(resolved, args);
    else if (command === 'core') await core(resolved, args);
    else fail(`Unknown command: ${command}.`);
  } catch (error) {
    fail(`team-memory: ${error.message}`);
  }
}

await main();
