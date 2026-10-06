import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrayReplacementPaths } from '../src/services/config.ts';

test('deleting ID-based provider models replaces the array rather than retaining deleted models or fields', () => {
  const before = { models: { providers: { custom: { models: [{ id: 'keep', name: 'Keep', legacy: true }, { id: 'remove' }] } } } };
  const after = { models: { providers: { custom: { models: [{ id: 'keep', name: 'Keep' }] } } } };
  assert.deepEqual(arrayReplacementPaths(before, after), ['models.providers.custom.models']);
});
test('unchanged arrays and edits to scalar settings do not replace unrelated arrays', () => {
  const models = [{ id: 'keep' }];
  assert.deepEqual(arrayReplacementPaths({ models, enabled: false }, { models, enabled: true }), []);
});
