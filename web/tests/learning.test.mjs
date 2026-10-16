import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learningSettings, setActivationPolicy, setLearningMode } from '../src/services/learning.ts';

test('absent and malformed UI state never represents auto consent', () => {
  for (const skills of [undefined, null, [], {}, { workshop: {} }, { workshop: { autonomous: { mode: 'unknown' }, approvalPolicy: true } }]) {
    assert.deepEqual(learningSettings(skills), { mode: 'propose', approvalPolicy: 'pending' });
  }
});
test('explicit learning and lifecycle choices survive config serialization independently', () => {
  for (const mode of ['off', 'propose', 'auto']) {
    const skills = setLearningMode({ entries: { example: { enabled: false } } }, mode);
    assert.deepEqual(learningSettings(JSON.parse(JSON.stringify(skills))), { mode, approvalPolicy: 'pending' });
    assert.deepEqual(skills.entries, { example: { enabled: false } });
    assert.deepEqual(learningSettings(setActivationPolicy(skills, 'auto')), { mode, approvalPolicy: 'auto' });
  }
});
test('enabling proposal learning preserves explicit lifecycle choice without enabling auto', () => {
  const skills = setLearningMode({ workshop: { autonomous: { mode: 'off' }, approvalPolicy: 'auto', maxPending: 12 } }, 'propose');
  assert.deepEqual(learningSettings(skills), { mode: 'propose', approvalPolicy: 'auto' });
  assert.equal(skills.workshop.maxPending, 12);
});
