// Team memory + follow-up engine for hob's bot team.
//
// This is hob's own layer, not Hermes. Hermes keeps its native per-profile
// memory (MEMORY.md / USER.md, learning graph) untouched. The team core
// itself is owned by hermes-team.mjs: revision-bound proposals in SQLite,
// distributed into every bot's AGENTS.md as a managed block by
// hermes-bot-network.mjs. This module owns what those modules do not: the
// task board, the follow-up store, the open-thread detector, the sweep
// runner, proactive preferences, daily logs, the promotion adapter (worker
// PROMOTE sections -> HermesTeam proposals), and the "how work runs"
// helpers (plan first, segmented work, mid-task interruptions, Main never
// blocks).
//
// Layers (see the employee-team spec):
//   1. Team core — HermesTeam (SQLite core_versions), Main-owned, durable.
//   2. Per-bot memory — native Hermes, private to each bot.
//   3. Session — transient, never auto-promoted (MANGO-7 rule).
//
// The follow-up engine is the "remember and follow up" loop: tracked items
// in shared/FOLLOWUPS.md, an open-thread detector that drafts items from
// session summaries and relay replies, and a sweep runner that checks each
// open item's current state before delivering, deferring, or closing it.

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { containsTeamCredentials } from './hermes-team.mjs';
import { parseTeamTask } from './hermes-team-protocol.mjs';

// The draft file Main edits in its workspace. It is staging only: the
// approved core lives in the team database (HermesTeam core_versions) and
// only a user-approved revision is distributed. Never treat this file as
// the source of truth.
export const coreDraftPath = root => path.join(root, 'main', 'TEAM_CORE.md');
export const sharedDir = root => path.join(root, 'main', 'shared');
export const tasksPath = root => path.join(sharedDir(root), 'TASKS.md');
export const followupsPath = root => path.join(sharedDir(root), 'FOLLOWUPS.md');
export const preferencesPath = root => path.join(root, 'main', 'PROACTIVE_PREFERENCES.md');

const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
/** Keep user-supplied text from terminating or nesting a managed comment block. */
export const sanitizeBlockText = value => text(value).replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim();

async function atomicWrite(filename, value, mode = 0o600) {
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, value, { flag: 'wx', mode, flush: true });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

const dateStamp = now => now.toISOString().slice(0, 10);
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

// ---------------------------------------------------------------------------
// Task board — main/shared/TASKS.md (markdown table)
// ---------------------------------------------------------------------------

const TASK_STATUSES = new Set(['planned', 'in_progress', 'blocked', 'waiting', 'done']);
const TASK_HEADER = ['ID', 'Owner', 'Outcome', 'Deadline', 'Output', 'Status'];
const TASK_KEYS = ['id', 'owner', 'outcome', 'deadline', 'output', 'status'];

export function tasksTemplate() {
  return '# Task board\n\n| ID | Owner | Outcome | Deadline | Output | Status |\n| --- | --- | --- | --- | --- | --- |\n';
}

function parseTable(markdown, header, keys) {
  const rows = String(markdown ?? '').split('\n').filter(line => line.trim().startsWith('|'));
  if (rows.length < 2) return [];
  const head = rows[0].split('|').slice(1, -1).map(cell => cell.trim());
  if (head.join('|') !== header.join('|')) throw new Error('Unexpected table header.');
  if (!/^[\s|:-]+$/.test(rows[1])) throw new Error('Malformed table separator.');
  return rows.slice(2).map(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length !== header.length) throw new Error(`Table row has ${cells.length} cells, expected ${header.length}.`);
    return Object.fromEntries(keys.map((key, index) => [key, cells[index]]));
  });
}

function renderTable(header, keys, rows) {
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of rows) {
    for (const key of keys) {
      const value = row[key] ?? '';
      if (typeof value !== 'string' || value.includes('|') || value.includes('\n')) {
        throw new Error(`Field ${key} must be a single line without '|'.`);
      }
    }
    lines.push(`| ${keys.map(key => row[key] ?? '').join(' | ')} |`);
  }
  return `# Task board\n\n${lines.join('\n')}\n`;
}

export function parseTasks(markdown) {
  return parseTable(markdown, TASK_HEADER, TASK_KEYS);
}

export function renderTasks(tasks, steps = {}) {
  const table = renderTable(TASK_HEADER, TASK_KEYS, tasks);
  const sections = renderTaskSteps(steps);
  return sections ? `${table}\n${sections}` : table;
}

// Per-task step lists live under the table as `## <id> — steps` sections.
// Exactly one step may be in progress at a time; the step list is what Main
// answers status questions from, never a guess.
const STEP_MARKS = { done: 'x', in_progress: '>', pending: ' ', blocked: '!' };
const STEP_STATES = { x: 'done', '>': 'in_progress', ' ': 'pending', '!': 'blocked' };

export function parseTaskSteps(markdown) {
  const steps = {};
  const sections = String(markdown ?? '').split(/^## /m).slice(1);
  for (const section of sections) {
    const [heading, ...body] = section.split('\n');
    const match = /^(T-\S+)\s+—\s+steps\s*$/.exec(heading.trim());
    if (!match) continue;
    const list = [];
    for (const line of body) {
      const step = /^-\s+\[(x|>|!| )\]\s+(\d+)\.\s+(.+)$/.exec(line);
      if (!step) continue;
      list.push({ index: Number(step[2]), title: step[3].trim(), state: STEP_STATES[step[1]] });
    }
    list.sort((a, b) => a.index - b.index);
    steps[match[1]] = list;
  }
  return steps;
}

export function renderTaskSteps(steps) {
  const lines = [];
  for (const [id, list] of Object.entries(steps)) {
    if (!list.length) continue;
    lines.push(`## ${id} — steps`);
    for (const step of list) lines.push(`- [${STEP_MARKS[step.state]}] ${step.index}. ${step.title}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function parseTaskBoard(markdown) {
  return { tasks: parseTasks(markdown), steps: parseTaskSteps(markdown) };
}

export function renderTaskBoard(tasks, steps = {}) {
  return renderTasks(tasks, steps);
}

export async function readTaskBoard(root) {
  try { return parseTaskBoard(await readFile(tasksPath(root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { tasks: [], steps: {} }; throw error; }
}

export async function writeTaskBoard(root, tasks, steps = {}) {
  await mkdir(sharedDir(root), { recursive: true });
  await atomicWrite(tasksPath(root), renderTaskBoard(tasks, steps));
}

export function addTaskStep(steps, taskId, title) {
  const clean = text(title);
  if (!clean) throw new Error('Step title is required.');
  const list = [...(steps[taskId] || [])];
  const index = list.reduce((max, step) => Math.max(max, step.index), 0) + 1;
  list.push({ index, title: clean, state: 'pending' });
  return { ...steps, [taskId]: list };
}

export function setTaskStep(steps, taskId, index, state) {
  if (!STEP_MARKS[state]) throw new Error(`Unknown step state: ${state}.`);
  const list = steps[taskId];
  if (!list) throw new Error(`Task ${taskId} has no step list.`);
  const target = list.find(step => step.index === index);
  if (!target) throw new Error(`Task ${taskId} has no step ${index}.`);
  if (state === 'in_progress' && list.some(step => step.state === 'in_progress' && step.index !== index)) {
    throw new Error(`Task ${taskId} already has a step in progress.`);
  }
  const next = list.map(step => step.index === index ? { ...step, state } : step);
  return { ...steps, [taskId]: next };
}

export function taskProgress(steps, taskId) {
  const list = steps[taskId] || [];
  const done = list.filter(step => step.state === 'done').length;
  const current = list.find(step => step.state === 'in_progress') || null;
  const next = list.find(step => step.state === 'pending') || null;
  return { total: list.length, done, current, next };
}

export async function readTasks(root) {
  try { return parseTasks(await readFile(tasksPath(root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function writeTasks(root, tasks) {
  const board = await readTaskBoard(root);
  await writeTaskBoard(root, tasks, board.steps);
}

export function addTask(tasks, task) {
  for (const key of ['id', 'owner', 'outcome', 'status']) {
    if (!text(task[key])) throw new Error(`Task ${key} is required.`);
  }
  if (!TASK_STATUSES.has(task.status)) throw new Error(`Unknown task status: ${task.status}.`);
  if (tasks.some(item => item.id === task.id)) throw new Error(`Task ${task.id} already exists.`);
  return [...tasks, {
    id: task.id, owner: task.owner, outcome: task.outcome,
    deadline: text(task.deadline) || 'none', output: text(task.output) || 'none', status: task.status,
  }];
}

export function updateTask(tasks, id, patch) {
  let found = false;
  const next = tasks.map(item => {
    if (item.id !== id) return item;
    found = true;
    const updated = { ...item, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
    if (updated.status && !TASK_STATUSES.has(updated.status)) throw new Error(`Unknown task status: ${updated.status}.`);
    return updated;
  });
  if (!found) throw new Error(`Task ${id} not found.`);
  return next;
}

// ---------------------------------------------------------------------------
// Follow-ups — main/shared/FOLLOWUPS.md (one section per tracked item)
// ---------------------------------------------------------------------------

const FOLLOWUP_STATUSES = new Set(['open', 'delivered', 'deferred', 'done', 'closed']);
const FOLLOWUP_KINDS = new Set(['followup', 'progress']);
const FOLLOWUP_FIELDS = ['Owner', 'Outcome', 'Deadline', 'Destination', 'Status', 'Kind', 'Created', 'Source', 'Evidence', 'Last checked', 'Notes'];
const FOLLOWUP_KEYS = ['owner', 'outcome', 'deadline', 'destination', 'status', 'kind', 'created', 'source', 'evidence', 'lastChecked', 'notes'];

export function followupsTemplate() {
  return '# Follow-ups\n\n<!-- Tracked items Main owes the user. Status: open | delivered | deferred | done | closed. -->\n';
}

export function parseFollowups(markdown) {
  const items = [];
  const sections = String(markdown ?? '').split(/^## /m).slice(1);
  for (const section of sections) {
    const [heading, ...body] = section.split('\n');
    const match = /^(FU-\d+)\s+—\s+(.+)$/.exec(heading.trim());
    if (!match) throw new Error(`Malformed follow-up heading: ${heading.trim()}.`);
    const item = { id: match[1], title: match[2].trim() };
    for (const line of body) {
      const field = /^-\s+([^:]+):\s*(.*)$/.exec(line);
      if (!field) continue;
      const key = FOLLOWUP_FIELDS.indexOf(field[1].trim());
      if (key === -1) throw new Error(`Unknown follow-up field: ${field[1].trim()}.`);
      item[FOLLOWUP_KEYS[key]] = field[2].trim();
    }
    for (const key of FOLLOWUP_KEYS) if (item[key] === undefined) item[key] = '';
    if (!FOLLOWUP_STATUSES.has(item.status)) throw new Error(`Follow-up ${item.id} has unknown status: ${item.status}.`);
    if (!item.kind) item.kind = 'followup';
    if (!FOLLOWUP_KINDS.has(item.kind)) throw new Error(`Follow-up ${item.id} has unknown kind: ${item.kind}.`);
    items.push(item);
  }
  return items;
}

export function renderFollowups(items) {
  const lines = [followupsTemplate().trimEnd()];
  for (const item of items) {
    if (!FOLLOWUP_STATUSES.has(item.status)) throw new Error(`Follow-up ${item.id} has unknown status: ${item.status}.`);
    lines.push('', `## ${item.id} — ${item.title}`);
    FOLLOWUP_FIELDS.forEach((label, index) => {
      const value = item[FOLLOWUP_KEYS[index]] ?? '';
      if (typeof value !== 'string' || value.includes('\n')) throw new Error(`Follow-up ${item.id} field ${label} must be a single line.`);
      lines.push(`- ${label}: ${value}`);
    });
  }
  return `${lines.join('\n')}\n`;
}

export async function readFollowups(root) {
  try { return parseFollowups(await readFile(followupsPath(root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function writeFollowups(root, items) {
  await mkdir(sharedDir(root), { recursive: true });
  await atomicWrite(followupsPath(root), renderFollowups(items));
}

export function nextFollowupId(items) {
  const max = items.reduce((found, item) => {
    const n = Number(/^FU-(\d+)$/.exec(item.id)?.[1]);
    return Number.isFinite(n) ? Math.max(found, n) : found;
  }, 0);
  return `FU-${String(max + 1).padStart(3, '0')}`;
}

export function createFollowup(items, fields, { now = new Date() } = {}) {
  for (const key of ['title', 'owner', 'outcome', 'destination']) {
    if (!text(fields[key])) throw new Error(`Follow-up ${key} is required.`);
  }
  if (fields.deadline && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/.test(fields.deadline)) {
    throw new Error('Follow-up deadline must be YYYY-MM-DD or an ISO timestamp.');
  }
  if (containsTeamCredentials(fields.evidence || '') || containsTeamCredentials(fields.notes || '')) {
    throw new Error('Follow-ups must not contain credentials or secrets.');
  }
  const item = {
    id: nextFollowupId(items),
    title: fields.title, owner: fields.owner, outcome: fields.outcome,
    deadline: fields.deadline || '', destination: fields.destination, status: 'open',
    kind: fields.kind || 'followup',
    created: now.toISOString(), source: fields.source || '', evidence: fields.evidence || '',
    lastChecked: '', notes: fields.notes || '',
  };
  return [...items, item];
}

export function updateFollowup(items, id, patch) {
  let found = false;
  const next = items.map(item => {
    if (item.id !== id) return item;
    found = true;
    const updated = { ...item, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
    if (updated.status && !FOLLOWUP_STATUSES.has(updated.status)) throw new Error(`Unknown follow-up status: ${updated.status}.`);
    return updated;
  });
  if (!found) throw new Error(`Follow-up ${id} not found.`);
  return next;
}

// ---------------------------------------------------------------------------
// Proactive preferences — main/PROACTIVE_PREFERENCES.md
// ---------------------------------------------------------------------------

export function preferencesTemplate() {
  return [
    '# Proactive preferences',
    '',
    '## Quiet hours',
    '22:00-08:00 Asia/Karachi',
    '',
    '## Daily cap',
    '3',
    '',
    '## Delivery',
    'user chat',
    '',
    '## Never re-offer',
    '- (item ids or titles, one per line)',
    '',
  ].join('\n');
}

export function parsePreferences(markdown) {
  const prefs = { quietHours: null, dailyCap: 3, delivery: 'user chat', neverOffer: [] };
  const sections = String(markdown ?? '').split(/^## /m).slice(1);
  for (const section of sections) {
    const [heading, ...body] = section.split('\n');
    const name = heading.trim().toLowerCase();
    const lines = body.map(line => line.trim()).filter(Boolean);
    if (name === 'quiet hours' && lines[0]) {
      const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})(?:\s+(.+))?$/.exec(lines[0]);
      if (!match) throw new Error(`Malformed quiet hours: ${lines[0]}.`);
      prefs.quietHours = { start: match[1], end: match[2], timezone: match[3] || 'UTC' };
    } else if (name === 'daily cap' && lines[0]) {
      const cap = Number(lines[0]);
      if (!Number.isSafeInteger(cap) || cap < 0) throw new Error(`Malformed daily cap: ${lines[0]}.`);
      prefs.dailyCap = cap;
    } else if (name === 'delivery' && lines[0]) {
      prefs.delivery = lines[0];
    } else if (name === 'never re-offer') {
      prefs.neverOffer = lines.filter(line => line.startsWith('- ')).map(line => line.slice(2).trim())
        .filter(entry => entry && !entry.startsWith('('));
    }
  }
  return prefs;
}

export function renderPreferences(prefs) {
  const lines = ['# Proactive preferences', ''];
  lines.push('## Quiet hours');
  lines.push(prefs.quietHours ? `${prefs.quietHours.start}-${prefs.quietHours.end} ${prefs.quietHours.timezone}`.trim() : 'none', '');
  lines.push('## Daily cap', String(prefs.dailyCap ?? 3), '');
  lines.push('## Delivery', prefs.delivery || 'user chat', '');
  lines.push('## Never re-offer');
  for (const entry of prefs.neverOffer || []) lines.push(`- ${entry}`);
  if (!(prefs.neverOffer || []).length) lines.push('- (item ids or titles, one per line)');
  lines.push('');
  return lines.join('\n');
}

export async function readPreferences(root) {
  try { return parsePreferences(await readFile(preferencesPath(root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return parsePreferences(preferencesTemplate()); throw error; }
}

export async function writePreferences(root, prefs) {
  await mkdir(path.join(root, 'main'), { recursive: true });
  await atomicWrite(preferencesPath(root), renderPreferences(prefs));
}

function timeInZone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone,
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('hour')}:${get('minute')}`;
}

function dateInZone(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}

export function inQuietHours(prefs, now = new Date()) {
  const hours = prefs?.quietHours;
  if (!hours) return false;
  const current = timeInZone(now, hours.timezone || 'UTC');
  if (hours.start <= hours.end) return current >= hours.start && current < hours.end;
  return current >= hours.start || current < hours.end;
}

export function deliveredToday(items, now = new Date(), timezone = 'UTC') {
  const today = dateInZone(now, timezone);
  return items.filter(item => item.status === 'delivered' && item.lastChecked
    && dateInZone(new Date(item.lastChecked), timezone) === today).length;
}

export function isNeverOffer(item, prefs) {
  const wanted = [item.id.toLowerCase(), item.title.toLowerCase()];
  return (prefs?.neverOffer || []).some(entry => wanted.includes(entry.toLowerCase()));
}

function isDue(item, now = new Date()) {
  if (!item.deadline) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(item.deadline)) return dateInZone(now, 'UTC') >= item.deadline;
  const deadline = new Date(item.deadline);
  return Number.isFinite(deadline.getTime()) && now >= deadline;
}

/**
 * Delivery rules: surface only when the item is open, due, outside quiet
 * hours, under the daily cap, and never on the never-re-offer list.
 */
export function shouldSurface(item, { now = new Date(), preferences, deliveredCount = 0 } = {}) {
  if (item.status !== 'open' && item.status !== 'deferred') return { ok: false, reason: `status is ${item.status}` };
  if (isNeverOffer(item, preferences)) return { ok: false, reason: 'on the never re-offer list' };
  if (!isDue(item, now)) return { ok: false, reason: 'not due yet' };
  if (inQuietHours(preferences, now)) return { ok: false, reason: 'quiet hours' };
  if (deliveredCount >= (preferences?.dailyCap ?? 3)) return { ok: false, reason: 'daily cap reached' };
  return { ok: true, reason: 'due' };
}

// ---------------------------------------------------------------------------
// Daily session logs — logs/YYYY-MM-DD.md inside the owning bot's workspace
// ---------------------------------------------------------------------------

export async function appendDailyLog(workspaceDir, entry, { now = new Date() } = {}) {
  const clean = text(entry);
  if (!clean) throw new Error('Log entry must not be empty.');
  const dir = path.join(workspaceDir, 'logs');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${dateStamp(now)}.md`);
  let existing = '';
  try { existing = await readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const time = timeInZone(now, 'UTC');
  const next = existing ? `${existing.replace(/\n$/, '')}\n- ${time} UTC ${clean}\n` : `# ${dateStamp(now)}\n\n- ${time} UTC ${clean}\n`;
  await atomicWrite(file, next);
  return file;
}

// ---------------------------------------------------------------------------
// Open-thread detector — drafts tracked items from text, never creates them
// ---------------------------------------------------------------------------

const QUESTION = /[?]\s*$/;
const PROMISE = /\b(i'?ll|i will|let me|i'?m going to|i'?ll get back|i'?ll send|i'?ll check|i'?ll look into|i'?ll follow up|i'?ll update|will send|will check|will update|will do)\b/i;
const DEADLINE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(\s+\d{4})?|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|eod|end of (the )?(day|week))|tomorrow|next week|due (today|tomorrow|friday|monday))\b/i;
const STALLED = /\b(still waiting|waiting on|blocked by|hasn'?t (heard|replied|responded|answered)|no (reply|response|answer) yet|overdue|stuck on|no word (from|on))\b/i;
const SKIP_LINE = /^(#{1,6}\s|\s*```|\s*[-*]\s|\[HOB relay|<!--|>\s|TASK\s+\S+\s+—|OUTCOME:|CONSTRAINTS:|OUTPUT:|DEADLINE:|CORE REFS:|RESULT:|FILES:|VERIFICATION:|BLOCKERS:|PROMOTE:)/;

function draftTitle(line) {
  const clean = line.replace(/^[-*>\s]+/, '').trim();
  return clean.length > 80 ? `${clean.slice(0, 77).trimEnd()}…` : clean;
}

function extractDeadline(line) {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(line);
  if (iso) return iso[1];
  const named = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})\b/i.exec(line);
  if (named) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const date = new Date(Date.UTC(Number(named[3]), months[named[2].toLowerCase().slice(0, 3)], Number(named[1])));
    if (Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return '';
}

/**
 * Scan session summaries and relay replies for unanswered questions,
 * promises, deadlines, and stalled items. Returns DRAFTS for Main to
 * confirm — the detector never creates a tracked item on its own, and
 * never re-drafts an item that already exists (pass existing titles/ids).
 */
export function detectOpenThreads(input, { source = '', existing = [] } = {}) {
  const drafts = [];
  const seen = new Set(existing.map(entry => String(entry).toLowerCase()));
  for (const raw of String(input ?? '').split('\n')) {
    const line = raw.trim();
    if (line.length < 4 || line.length > 500 || SKIP_LINE.test(line)) continue;
    let kind = null;
    if (STALLED.test(line)) kind = 'stalled';
    else if (PROMISE.test(line) && !line.endsWith('?')) kind = 'promise';
    else if (DEADLINE.test(line)) kind = 'deadline';
    else if (QUESTION.test(line)) kind = 'question';
    if (!kind) continue;
    const title = draftTitle(line);
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push({
      kind, title, evidence: line, source,
      deadline: kind === 'deadline' || kind === 'promise' ? extractDeadline(line) : '',
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Follow-up sweep — check first, then deliver, defer, or close
// ---------------------------------------------------------------------------

/**
 * Run one sweep over the open items.
 *
 * checkState(item) is injected by the caller (only Main can know the world):
 *   'done'        — the outcome already happened; close it.
 *   'not-relevant'— it no longer applies; close it with a note.
 *   'still-open'  — still owed; apply the delivery rules.
 *   'unknown'     — cannot tell; leave open and report it as needing a check.
 * deliver(item) is injected by the caller (chat, channel, …). A delivery
 * failure defers the item instead of crashing the sweep.
 *
 * Returns { report, items } — the mutated items list, which the caller
 * persists with writeFollowups. Nothing is ever delivered about a finished
 * item: done/closed items are never passed to deliver.
 */
export async function runFollowupSweep({ items, now = new Date(), preferences, checkState, deliver }) {
  if (typeof checkState !== 'function') throw new Error('A state checker is required.');
  if (typeof deliver !== 'function') throw new Error('A delivery function is required.');
  const prefs = preferences ?? parsePreferences(preferencesTemplate());
  const timezone = prefs.quietHours?.timezone || 'UTC';
  const report = { delivered: [], deferred: [], closed: [], checked: [], skipped: [] };
  let deliveredCount = deliveredToday(items, now, timezone);
  const next = items.map(item => ({ ...item }));
  for (const item of next) {
    // 'deferred' means "checked, not delivered this time" — the next sweep
    // re-evaluates it. Only done/closed/delivered items are terminal.
    if (item.status !== 'open' && item.status !== 'deferred') { report.skipped.push({ id: item.id, reason: `status is ${item.status}` }); continue; }
    let state;
    try { state = await checkState(item); }
    catch { report.checked.push({ id: item.id, reason: 'state check failed' }); continue; }
    if (state === 'done') {
      item.status = 'done'; item.lastChecked = now.toISOString();
      item.notes = [item.notes, 'Closed by sweep: outcome already happened.'].filter(Boolean).join(' ');
      report.closed.push({ id: item.id, reason: 'outcome already happened' });
    } else if (state === 'not-relevant') {
      item.status = 'closed'; item.lastChecked = now.toISOString();
      item.notes = [item.notes, 'Closed by sweep: no longer applies.'].filter(Boolean).join(' ');
      report.closed.push({ id: item.id, reason: 'no longer applies' });
    } else if (state === 'unknown') {
      item.lastChecked = now.toISOString();
      report.checked.push({ id: item.id, reason: 'state unknown — Main must verify' });
    } else if (state === 'still-open') {
      const surface = shouldSurface(item, { now, preferences: prefs, deliveredCount });
      if (!surface.ok) {
        if (surface.reason === 'on the never re-offer list') {
          report.skipped.push({ id: item.id, reason: surface.reason });
        } else {
          item.status = 'deferred'; item.lastChecked = now.toISOString();
          report.deferred.push({ id: item.id, reason: surface.reason });
        }
      } else {
        try {
          await deliver(item);
          item.status = 'delivered'; item.lastChecked = now.toISOString();
          deliveredCount += 1;
          report.delivered.push({ id: item.id });
        } catch (error) {
          item.status = 'deferred'; item.lastChecked = now.toISOString();
          report.deferred.push({ id: item.id, reason: `delivery failed: ${error.message}` });
        }
      }
    } else {
      report.checked.push({ id: item.id, reason: `unknown state: ${String(state)}` });
    }
  }
  return { report, items: next };
}

// ---------------------------------------------------------------------------
// Promotion flow — worker PROMOTE sections into HermesTeam proposals
//
// The team core is owned by hermes-team.mjs: a promotion is a proposal
// against the current revision, decided by the user through team.decide()
// (dashboard route /decisions). This adapter only parses, classifies, and
// stages: it never writes the core directly, and a bad promotion is
// reversible because every approved revision persists in core_versions.
// Tier 2 (standing rules, preferences, money, outsiders, credentials
// policy) always needs the user's explicit approval. Tier 1 follows the
// team policy: when ordinaryPromotions is 'coordinator' Main may approve
// it alone; by default ('user') it stays pending for the user.
// ---------------------------------------------------------------------------

const TIER2 = /\b(standing rules?|preferences?|prefers|money|payments?|pays?|prices?|costs?|spends?|budgets?|outsiders?|publish|credentials?|passwords?|tokens?|api[- ]?keys?|secrets?|private keys?|bank|card)\b/i;
const STOPWORDS = new Set(('the a an is are was were to of in on for and or with user bot main team core this that it as at by from has have had be been not no').split(' '));

/**
 * Parse a worker relay reply's PROMOTE section: one line per fact, each
 * with its evidence after an em dash or an "(evidence: …)" suffix.
 * `PROMOTE: none` (or no section) means no proposals.
 */
export function parsePromoteSection(reply) {
  const lines = String(reply ?? '').split('\n');
  const start = lines.findIndex(line => /^PROMOTE:\s*(.*)$/i.test(line));
  if (start === -1) return [];
  const first = /^PROMOTE:\s*(.*)$/i.exec(lines[start])[1].trim();
  if (/^none\.?$/i.test(first)) return [];
  const proposals = [];
  if (first) proposals.push(parsePromoteLine(first));
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Z][A-Z ]+:\s/.test(line) && !line.startsWith('-')) break;
    if (!line.trim()) {
      if (proposals.length) break;
      continue;
    }
    const bullet = /^-\s+(.*)$/.exec(line.trim());
    if (!bullet) break;
    proposals.push(parsePromoteLine(bullet[1]));
  }
  return proposals.filter(item => item.fact);
}

function parsePromoteLine(line) {
  const evidence = /\(evidence:\s*(.+)\)\s*$/.exec(line);
  if (evidence) return { fact: line.slice(0, evidence.index).trim(), evidence: evidence[1].trim() };
  const dash = line.split(/\s+—\s+/);
  if (dash.length > 1) {
    const rest = dash.slice(1).join(' — ').trim().replace(/^evidence:\s*/i, '');
    return { fact: dash[0].trim(), evidence: rest };
  }
  return { fact: line.trim(), evidence: '' };
}

/** Tier 2 (standing rules, preferences, money, outsiders, credentials policy) needs the user's explicit approval. Everything else is Tier 1. */
export function classifyPromotion(fact) {
  return TIER2.test(fact) ? 'tier2' : 'tier1';
}

function contentWords(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(word => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Find core lines that share significant wording with a proposed fact.
 * These are CANDIDATES for Main to judge — the code never decides a
 * conflict on its own. On any candidate, Main reports both versions to
 * the user and waits; user-stated facts always win.
 */
export function findCoreConflicts(fact, coreText) {
  const words = new Set(contentWords(fact));
  if (!words.size) return [];
  return String(coreText ?? '').split('\n')
    .map(line => line.trim()).filter(Boolean)
    .filter(line => contentWords(line).filter(word => words.has(word)).length >= 2);
}

// Promoted facts belong in the Essential section: that is the part injected
// into every bot. Reference-only details stay out of the injected block.
function insertCoreFact(content, fact, evidence) {
  const line = `- ${fact}${evidence ? ` (${evidence})` : ''}`;
  const trimmed = String(content ?? '').trimEnd();
  if (!trimmed) return `# Essential\n\n${line}\n`;
  const lines = trimmed.split('\n');
  const essentialAt = lines.findIndex(entry => /^# Essential\s*$/.test(entry));
  const referenceAt = lines.findIndex(entry => /^# Reference\s*$/.test(entry));
  if (essentialAt === -1) {
    lines.push(line);
    return `${lines.join('\n')}\n`;
  }
  const end = referenceAt === -1 ? lines.length : referenceAt;
  let at = end;
  while (at > essentialAt + 1 && lines[at - 1].trim() === '') at -= 1;
  lines.splice(at, 0, line);
  return `${lines.join('\n')}\n`;
}

/**
 * Apply one promotion through the team database. Tier 2 without the
 * user's explicit approval is refused, never applied. Tier 1 without
 * approval is staged as a pending proposal for the user, unless the team
 * policy lets the coordinator approve ordinary promotions alone.
 * Duplicates and possible conflicts are refused for Main to judge.
 * `team` is a HermesTeam instance; `userApproved` is the user's explicit
 * approval (dashboard decision, or the operator at the terminal).
 */
export async function applyPromotion(team, { fact, evidence = '', tier, userApproved = false } = {}) {
  const clean = sanitizeBlockText(fact);
  const cleanEvidence = sanitizeBlockText(evidence).slice(0, 4000);
  if (!clean) throw new Error('Promotion fact must not be empty.');
  if (containsTeamCredentials(clean) || containsTeamCredentials(cleanEvidence)) throw new Error('Promotions must not contain credentials or secrets.');
  const decided = tier || classifyPromotion(clean);
  if (decided === 'tier2' && userApproved !== true) {
    return { applied: false, tier: decided, reason: 'tier2-needs-user-approval' };
  }
  const core = team.core();
  const coreLines = core.content.split('\n').map(line => line.trim());
  if (coreLines.includes(clean) || coreLines.includes(`- ${clean}`) || coreLines.some(line => line.startsWith(`- ${clean} (`))) {
    return { applied: false, tier: decided, reason: 'already-in-core' };
  }
  const conflicts = findCoreConflicts(clean, core.content);
  if (conflicts.length) {
    return { applied: false, tier: decided, reason: 'possible-conflict', conflicts };
  }
  const next = insertCoreFact(core.content, clean, cleanEvidence);
  const proposal = team.propose({
    author: 'default',
    content: next,
    base: core.revision,
    evidence: cleanEvidence || 'Promoted from a worker relay reply.',
  });
  if (userApproved === true || (decided === 'tier1' && team.policy().ordinaryPromotions === 'coordinator')) {
    team.decide({ id: proposal.id, base: proposal.base, digest: proposal.digest, decision: 'approve', confirm: true });
    return { applied: true, tier: decided, reason: 'promoted', revision: core.revision + 1, proposalId: proposal.id };
  }
  return { applied: false, tier: decided, reason: 'proposed-pending-user-approval', proposalId: proposal.id };
}

// Rejected promotions stay in the worker's own episodic area only, marked
// rejected, and are never re-proposed without new evidence.
export async function recordRejectedPromotion(workspaceDir, { fact, reason = '', now = new Date() } = {}) {
  const clean = text(fact);
  if (!clean) throw new Error('Rejected promotion fact must not be empty.');
  const file = path.join(workspaceDir, 'REJECTED_PROMOTIONS.md');
  let existing = '';
  try { existing = await readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const next = existing
    ? `${existing.replace(/\n$/, '')}\n- ${dateStamp(now)} ${clean}${reason ? ` — rejected: ${reason}` : ''}\n`
    : `# Rejected promotions\n\n<!-- Facts proposed for the team core that Main rejected. Do not re-propose without new evidence. -->\n\n- ${dateStamp(now)} ${clean}${reason ? ` — rejected: ${reason}` : ''}\n`;
  await atomicWrite(file, next);
}

export async function loadRejectedPromotions(workspaceDir) {
  try {
    const content = await readFile(path.join(workspaceDir, 'REJECTED_PROMOTIONS.md'), 'utf8');
    return content.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2).trim());
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// ---------------------------------------------------------------------------
// How work runs — plan first, segmented, interruptible, never blocking
// ---------------------------------------------------------------------------

export function planAcknowledgementText(task, segments, needsFromUser = '') {
  const steps = segments.map(step => text(step)).filter(Boolean);
  if (!steps.length) throw new Error('A plan needs at least one segment.');
  return [
    `PLAN ${task.id} — ${task.outcome}`,
    `I will do this in ${steps.length} step${steps.length === 1 ? '' : 's'}:`,
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    `NEEDS FROM YOU: ${text(needsFromUser) || 'nothing — starting now'}`,
  ].join('\n');
}

export function progressUpdateText(task, steps) {
  const progress = taskProgress(steps, task.id);
  const head = `UPDATE ${task.id} — step ${progress.done} of ${progress.total} done`;
  const lines = [progress.current ? `${head}: "${progress.current.title}"` : head];
  lines.push(progress.next ? `Next: ${progress.next.title}` : 'Next: deliver the result');
  return lines.join('\n');
}

/**
 * Progress updates are a delivery type of the follow-up engine: a worker
 * emits one at each segment boundary, Main relays it to the user, and the
 * sweep delivers it under the same rules as any other follow-up.
 */
export function createProgressUpdate(items, { taskId, stepTitle, nextTitle, owner = 'main', destination = 'user chat' }) {
  return createFollowup(items, {
    kind: 'progress',
    title: `Progress: ${taskId} — ${stepTitle}`,
    owner,
    outcome: nextTitle ? `Step done: ${stepTitle}. Next: ${nextTitle}.` : `Step done: ${stepTitle}.`,
    destination,
    source: `task ${taskId}`,
    evidence: stepTitle,
  });
}

function nextTaskId(tasks) {
  const max = tasks.reduce((found, item) => {
    const n = Number(/^T-(\d+)$/.exec(item.id)?.[1]);
    return Number.isFinite(n) ? Math.max(found, n) : found;
  }, 0);
  return `T-${String(max + 1).padStart(3, '0')}`;
}

export function createTaskRegistry(tasks = [], steps = {}) {
  return { tasks: tasks.map(task => ({ ...task })), steps: JSON.parse(JSON.stringify(steps)) };
}

export function registerTask(registry, task) {
  const next = addTask(registry.tasks, { ...task, id: task.id || nextTaskId(registry.tasks), status: task.status || 'planned' });
  registry.tasks = next;
  return registry.tasks.at(-1);
}

export function planTask(registry, id, segments, needsFromUser = '') {
  const task = registry.tasks.find(item => item.id === id);
  if (!task) throw new Error(`Task ${id} not found.`);
  if (task.status !== 'planned') throw new Error(`Task ${id} is ${task.status}, not planned.`);
  let steps = registry.steps;
  for (const segment of segments) steps = addTaskStep(steps, id, segment);
  registry.steps = steps;
  return planAcknowledgementText(task, segments, needsFromUser);
}

/** A task cannot start without a plan: plan-first is enforced, not advised. */
export function startTask(registry, id) {
  const task = registry.tasks.find(item => item.id === id);
  if (!task) throw new Error(`Task ${id} not found.`);
  if (task.status !== 'planned') throw new Error(`Task ${id} is ${task.status}, not planned.`);
  if (!(registry.steps[id] || []).length) throw new Error(`Task ${id} has no plan — plan it before starting.`);
  registry.tasks = updateTask(registry.tasks, id, { status: 'in_progress' });
  return registry.tasks.find(item => item.id === id);
}

// The task board stores bare dates; the TASK format needs an ISO timestamp.
function taskDeadline(task) {
  if (!task.deadline || task.deadline === 'none') return 'none';
  if (/^\d{4}-\d{2}-\d{2}$/.test(task.deadline)) return `${task.deadline}T00:00:00Z`;
  return task.deadline;
}

export function delegateTask(registry, id, worker, { constraints = 'none', coreRefs = 'none' } = {}) {
  const task = registry.tasks.find(item => item.id === id);
  if (!task) throw new Error(`Task ${id} not found.`);
  if (task.status === 'planned') startTask(registry, id);
  registry.tasks = updateTask(registry.tasks, id, { owner: worker, status: 'in_progress' });
  const current = registry.tasks.find(item => item.id === id);
  const message = [
    `TASK ${current.id} — ${current.outcome}`,
    `OUTCOME: ${current.outcome}`,
    `CONSTRAINTS: ${constraints}`,
    `OUTPUT: ${current.output}`,
    `DEADLINE: ${taskDeadline(current)}`,
    `CORE REFS: ${coreRefs}`,
  ].join('\n');
  // Exactly one TASK format: a delegation that does not parse is a bug.
  parseTeamTask(message);
  return message;
}

/**
 * Advance one step. Completing a step returns the progress-update text Main
 * relays to the user; starting a step returns null. Exactly one step may be
 * in progress at a time.
 */
export function advanceStep(registry, id, index, state) {
  const task = registry.tasks.find(item => item.id === id);
  if (!task) throw new Error(`Task ${id} not found.`);
  registry.steps = setTaskStep(registry.steps, id, index, state);
  if (state !== 'done') return null;
  return progressUpdateText(task, registry.steps);
}

export function statusAnswer(registry, ref) {
  const wanted = String(ref ?? '').trim().toLowerCase();
  const task = registry.tasks.find(item => item.id.toLowerCase() === wanted)
    ?? registry.tasks.find(item => item.outcome.toLowerCase().includes(wanted) && wanted.length > 3);
  if (!task) return `No task matching "${ref}" is in the registry.`;
  const progress = taskProgress(registry.steps, task.id);
  const state = task.status === 'in_progress'
    ? `in progress — step ${progress.done} of ${progress.total} done${progress.current ? ` ("${progress.current.title}")` : ''}${progress.next ? `, next: ${progress.next.title}` : ''}`
    : task.status;
  return `${task.id} (${task.outcome}) is ${state}, owned by ${task.owner || 'unassigned'}.`;
}

const STATUS_QUESTION = /\b(status|progress|where is|where'?s|how (is|are)|done yet|finished yet|any update|update on)\b/i;
const TASK_REF = /\b(T-\d+|FU-\d+)\b/i;

/**
 * Main stays responsive while work runs. A status question is answered from
 * the task registry, never guessed. Anything else is registered as separate
 * new work (planned) — the running task is never dropped, restarted, or
 * cancelled because of the interruption.
 */
export function handleUserMessage(registry, message) {
  const clean = text(message);
  const ref = TASK_REF.exec(clean)?.[1];
  if (STATUS_QUESTION.test(clean)) {
    const running = registry.tasks.filter(task => task.status === 'in_progress');
    if (ref) return { type: 'status', response: statusAnswer(registry, ref), taskId: ref };
    if (running.length === 1) return { type: 'status', response: statusAnswer(registry, running[0].id), taskId: running[0].id };
    if (running.length > 1) {
      return { type: 'status', response: `Running right now:\n${running.map(task => `- ${statusAnswer(registry, task.id)}`).join('\n')}`, taskId: null };
    }
    return { type: 'status', response: 'Nothing is running right now.', taskId: null };
  }
  const task = registerTask(registry, {
    owner: 'main', outcome: clean.length > 80 ? `${clean.slice(0, 77).trimEnd()}…` : clean,
    deadline: 'none', output: 'none', status: 'planned',
  });
  return { type: 'new-work', response: `Noted — registered as ${task.id} (planned). The running task keeps going.`, taskId: task.id };
}

// ---------------------------------------------------------------------------
// Relay status + verification helpers
// ---------------------------------------------------------------------------

/** A task with no worker reply is "waiting on <bot>", never "done". */
export function relayStatusText(result, botName) {
  if (result?.completed) return 'done';
  if (result?.failure) return 'failed';
  return `waiting on ${botName}`;
}

/** Main verifies RESULT against FILES before reporting success. */
export async function verifyClaimedFiles(files, workspaceRoot) {
  const found = [];
  const missing = [];
  for (const file of files || []) {
    const candidate = path.resolve(workspaceRoot, String(file));
    if (!within(path.resolve(workspaceRoot), candidate)) { missing.push(String(file)); continue; }
    try { const info = await stat(candidate); if (info.isFile()) found.push(String(file)); else missing.push(String(file)); }
    catch { missing.push(String(file)); }
  }
  return { found, missing };
}

/**
 * Activity entries whose job id has no matching job are orphans.
 * Annotate them as "job deleted" instead of presenting them as current
 * failures. (The dashboard wires this helper into its Activity view.)
 */
export function annotateJobFailures(entries, jobs) {
  const known = new Set((jobs || []).map(job => job?.id).filter(Boolean));
  return (entries || []).map(entry => {
    if (!entry?.jobId || known.has(entry.jobId)) return { ...entry, orphan: false };
    return { ...entry, orphan: true, note: 'job deleted' };
  });
}
