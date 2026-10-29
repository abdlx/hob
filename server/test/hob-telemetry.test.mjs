import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHobTelemetry } from '../hob-telemetry.mjs';

test('diagnostic samples are bounded, bot-scoped, correlated and exclude all arbitrary input', () => {
  let now = 10;
  const metrics = createHobTelemetry({ maxEvents: 3, clock: () => now });
  const finish = metrics.start('writer', 'native.rpc', { operation: 'prompt.submit', runId: 'private-run', token: 'DO_NOT_LOG', url: 'https://secret.invalid' });
  now = 35; finish('ok'); finish('error');
  metrics.record('other', 'native.http', 15, 'ok', { operation: 'GET' });
  metrics.record('writer', 'artifact.publish', 5, 'ok', { runId: 'private-run', filename: 'DO_NOT_LOG' });
  metrics.record('../bad', 'native.rpc', 3, 'ok'); metrics.record('writer', 'unknown', 3, 'ok');
  const view = metrics.snapshot('writer');
  assert.equal(view.samples, 2); assert.equal(view.events[0].traceId, view.events[1].traceId);
  assert.equal(view.stages[0].p95Ms, 25);
  assert.doesNotMatch(JSON.stringify(view), /DO_NOT_LOG|private-run|secret.invalid|"other"/);
  metrics.record('writer', 'browser.start', 100, 'error', { operation: 'cold' });
  assert.equal(metrics.snapshot('writer').events.length, 2);
});

test('diagnostic logs rotate within their storage cap and survive collector replacement', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-telemetry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metrics = createHobTelemetry({ stateDir: root, maxFileBytes: 1024 });
  for (let index = 0; index < 35; index++) metrics.record('default', 'browser.wait', index, 'ok', { operation: 'agent' });
  await metrics.flush();
  assert.equal(metrics.snapshot('default').storageErrors, 0);
  const names = await readdir(path.join(root, 'diagnostics'));
  assert.deepEqual(names.sort(), ['performance.jsonl', 'performance.jsonl.1']);
  for (const name of names) assert.ok((await readFile(path.join(root, 'diagnostics', name))).length <= 1024);
  const restarted = createHobTelemetry({ stateDir: root, maxFileBytes: 1024 });
  restarted.record('default', 'native.rpc', 1, 'unknown'); await restarted.flush();
  assert.equal(restarted.snapshot('default').storageErrors, 0);
});
