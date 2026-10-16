import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hermesConfigChanges, hermesModelSelectionResult } from '../src/services/hermes-settings.ts';

test('native model warnings require explicit confirmation instead of showing a false saved message', () => {
  assert.deepEqual(hermesModelSelectionResult({ ok: false, confirm_required: true, confirm_message: 'This model has higher costs.' }),
    { saved: false, confirmation: 'This model has higher costs.' });
  assert.deepEqual(hermesModelSelectionResult({ ok: true }), { saved: true });
  for (const value of [null, {}, { ok: false }, { ok: true, confirm_required: true }]) assert.throws(() => hermesModelSelectionResult(value), /did not confirm/);
});

test('only edited settings are sent, preserving stored secrets and unrelated nested configuration', () => {
  const previous = { model: 'old', custom_providers: [{ api_key: '[stored credential]' }],
    memory: { enabled: true, provider: 'builtin' }, terminal: { backend: 'docker' } };
  const next = structuredClone(previous);
  next.model = 'new';
  next.memory.enabled = false;
  assert.deepEqual(hermesConfigChanges(previous, next), { model: 'new', memory: { enabled: false } });
  assert.deepEqual(hermesConfigChanges(previous, previous), {});
});

test('field removal is rejected instead of implying an unsupported Hermes deletion', () => {
  assert.throws(() => hermesConfigChanges({ memory: { enabled: true } }, { memory: {} }), /reset enabled/);
  assert.deepEqual(hermesConfigChanges({ memory: { provider: 'plugin' } }, { memory: { provider: null } }), { memory: { provider: null } });
});

test('false, zero, empty strings and array replacements remain explicit edits', () => {
  assert.deepEqual(hermesConfigChanges({ enabled: true, count: 5, name: 'old', tools: ['a', 'b'] },
    { enabled: false, count: 0, name: '', tools: ['a'] }), { enabled: false, count: 0, name: '', tools: ['a'] });
});

test('JSON property names cannot mutate the configuration patch prototype', () => {
  const input = JSON.parse('{"__proto__":"explicit-value"}');
  const patch = hermesConfigChanges({}, input);
  assert.equal(Object.getPrototypeOf(patch), Object.prototype);
  assert.equal(Object.hasOwn(patch, '__proto__'), true);
  assert.equal(JSON.stringify(patch), '{"__proto__":"explicit-value"}');
});
