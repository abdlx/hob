import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryProviderEdits } from '../src/services/hermes-memory.ts';

const fields = [
  { key: 'api_key', kind: 'secret', value: '', isSet: true },
  { key: 'project', kind: 'text', value: 'original' },
  { key: 'enabled', kind: 'boolean', value: true },
  { key: 'limit', kind: 'number', value: 8 },
];
test('memory forms send only edited fields and blank secrets preserve the native credential', () => {
  assert.deepEqual(memoryProviderEdits(fields, {}), {});
  assert.deepEqual(memoryProviderEdits(fields, { api_key: '', project: 'original', enabled: 'true', limit: '8' }), {});
  assert.deepEqual(memoryProviderEdits(fields, { api_key: '   ', project: '', enabled: false, limit: 0 }), { project: '', enabled: false, limit: 0 });
  assert.deepEqual(memoryProviderEdits(fields, { api_key: 'new-synthetic-secret' }), { api_key: 'new-synthetic-secret' });
});
test('memory drafts cannot silently save unknown fields after a native schema changes', () => {
  assert.throws(() => memoryProviderEdits(fields, { unknown: 'x' }), /form changed/);
});
test('provider field keys are data and cannot become prototype setters', () => {
  const result = memoryProviderEdits([{ key: '__proto__', kind: 'text', value: '' }], JSON.parse('{"__proto__":"explicit"}'));
  assert.equal(Object.hasOwn(result, '__proto__'), true); assert.equal(result.__proto__, 'explicit');
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});
