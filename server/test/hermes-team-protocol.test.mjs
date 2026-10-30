import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTeamTask, parseTeamReply } from '../hermes-team-protocol.mjs';

const task = 'TASK task-1 — Check the plan\nOUTCOME: A verified plan\nCONSTRAINTS: No spending\n  Do not publish externally\nOUTPUT: artifacts/plan.md\nDEADLINE: 2026-11-01T12:00:00+05:00\nCORE REFS: none';
const reply = 'TASK task-1 — DONE\nRESULT: Saved a checked plan\nFILES: artifacts/plan.md\nVERIFICATION: Opened and checked the saved bytes\nBLOCKERS: none\nPROMOTE: none';
test('team task/reply parsing preserves exact ordered fields and indented continuations', () => {
  assert.equal(parseTeamTask(task).fields.CONSTRAINTS, 'No spending\nDo not publish externally');
  assert.equal(parseTeamReply(reply, 'task-1').title, 'DONE');
  for (const malformed of [task.replace('CORE REFS: none', ''), task + '\nOUTPUT: duplicate.md', task.replace('artifacts/plan.md', '../other-bot/private.md'), task.replace('2026-11-01T12:00:00+05:00', 'tomorrow'), task.replace('TASK task-1 —', 'TASK task-1 -')]) assert.throws(() => parseTeamTask(malformed));
  assert.throws(() => parseTeamReply(reply, 'other-task'));
  assert.throws(() => parseTeamReply(reply.replace('VERIFICATION:', 'CHECK:'), 'task-1'));
});
