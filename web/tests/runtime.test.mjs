import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRuntime } from '../src/services/runtime.ts';

test('dashboard selects the installed runtime from the server, independent of bot metadata', async t => {
  const original = globalThis.fetch;
  const calls = [];
  let runtime = 'hermes';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ runtime });
  };
  t.after(() => { globalThis.fetch = original; });
  assert.equal(await readRuntime(), 'hermes');
  runtime = 'openclaw';
  assert.equal(await readRuntime(), 'openclaw');
  assert.ok(calls.every(call => call.url === '/api/runtime' && call.options.credentials === 'same-origin'));
});

test('missing or unsupported runtime never silently selects OpenClaw', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const value of [{}, { runtime: null }, { runtime: 'unknown' }, null]) {
    globalThis.fetch = async () => Response.json(value);
    await assert.rejects(readRuntime(), /unsupported runtime/);
  }
  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(readRuntime(), /offline/);
});
