import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRng, planPointerPath, planPressTiming, planKeyTimings, planScrollSteps,
} from '../browser-trajectory.mjs';

test('seeded RNG makes paths reproducible', () => {
  const a = planPointerPath({ x: 10, y: 10 }, { x: 300, y: 200 }, { rng: createRng(42) });
  const b = planPointerPath({ x: 10, y: 10 }, { x: 300, y: 200 }, { rng: createRng(42) });
  assert.deepEqual(a, b);
});

test('path starts and ends exactly on the endpoints', () => {
  const path = planPointerPath({ x: 5, y: 7 }, { x: 900, y: 700 }, { rng: createRng(7) });
  assert.deepEqual({ x: path[0].x, y: path[0].y }, { x: 5, y: 7 });
  assert.deepEqual({ x: path.at(-1).x, y: path.at(-1).y }, { x: 900, y: 700 });
});

test('timing is monotonic and total duration scales with distance', () => {
  const short = planPointerPath({ x: 0, y: 0 }, { x: 60, y: 40 }, { rng: createRng(3) });
  const long = planPointerPath({ x: 0, y: 0 }, { x: 1100, y: 800 }, { rng: createRng(3) });
  for (const path of [short, long]) {
    for (let i = 1; i < path.length; i += 1) assert.ok(path[i].atMs >= path[i - 1].atMs);
  }
  assert.ok(long.at(-1).atMs > short.at(-1).atMs, 'longer moves take longer');
  assert.ok(long.at(-1).atMs <= 1200);
});

test('path is curved, not a straight teleport line', () => {
  const path = planPointerPath({ x: 0, y: 0 }, { x: 400, y: 0 }, { rng: createRng(11) });
  const offLine = path.slice(1, -1).some(p => Math.abs(p.y) > 1.5);
  assert.ok(offLine, 'intermediate samples should bow off the straight line');
  assert.ok(path.length >= 8, 'a 400px move should have many samples, not a jump');
});

test('press timing sits in human bands', () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const { dwellBeforeMs, holdMs } = planPressTiming({ rng: createRng(seed) });
    assert.ok(dwellBeforeMs >= 60 && dwellBeforeMs <= 230);
    assert.ok(holdMs >= 45 && holdMs <= 135);
  }
});

test('key timings: one per character, sane bands, pauses after punctuation', () => {
  const text = 'Hello world. This is Hob.';
  const delays = planKeyTimings(text, { rng: createRng(9) });
  assert.equal(delays.length, text.length);
  for (const d of delays) assert.ok(d >= 40 && d < 900);
  const afterPeriod = delays[text.indexOf('.') + 1];
  assert.ok(afterPeriod >= 90, 'a sentence boundary costs a beat');
});

test('scroll steps sum exactly to the requested delta', () => {
  for (const total of [120, 640, -480, 2000]) {
    const steps = planScrollSteps(total, { rng: createRng(5) });
    assert.equal(steps.reduce((acc, s) => acc + s.deltaY, 0), total);
    assert.ok(steps.length >= 3);
  }
  assert.deepEqual(planScrollSteps(0), []);
});
