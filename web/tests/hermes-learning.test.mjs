import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learningControls, learningEdits } from '../src/services/hermes-learning.ts';

const status = { controls: Object.fromEntries(learningControls.map(control => [control.id, { value: false, source: 'saved' }])) };
test('loading or leaving learning controls unchanged never implies enabling review or direct writes', () => {
  assert.deepEqual(learningEdits(status, {}), {});
  assert.deepEqual(learningEdits(status, { skillApproval: false, backgroundReview: false }), {});
});
test('learning drafts preserve independent explicit booleans and permit deliberate correction of invalid native values', () => {
  const current = structuredClone(status); current.controls.memoryEnabled.value = true; current.controls.memoryApproval.value = null;
  assert.deepEqual(learningEdits(current, { memoryEnabled: false, memoryApproval: true, skillApproval: true }), {
    memoryEnabled: false, memoryApproval: true, skillApproval: true,
  });
  assert.deepEqual(learningEdits(current, { memoryApproval: false }), { memoryApproval: false });
});
test('unknown controls, inherited-key tricks and string booleans cannot become learning edits', () => {
  for (const draft of [{ off: true }, { skillApproval: 'false' }, JSON.parse('{"__proto__":true}')]) assert.throws(() => learningEdits(status, draft));
});
