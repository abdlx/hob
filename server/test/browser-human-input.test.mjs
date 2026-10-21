import test from 'node:test';
import assert from 'node:assert/strict';
import { humanizedMouseMove } from '../browser-human-input.mjs';

const fixedRandom = () => 0.75;

test('human input: long mouse moves become bounded curves ending exactly at the target', () => {
  const original = { type: 'mouseMoved', x: 900, y: 700, button: 'none', buttons: 0 };
  const points = humanizedMouseMove({ x: 10, y: 20 }, original,
    { viewport: { w: 1280, h: 960 }, random: fixedRandom });

  assert.ok(points.length >= 4 && points.length <= 36);
  assert.deepEqual(points.at(-1).params, original);
  assert.ok(points.every(point => point.delayMs >= 4));
  assert.ok(points.reduce((total, point) => total + point.delayMs, 0) <= 700);
  assert.ok(points.every(point => point.params.x >= 0 && point.params.x < 1280));
  assert.ok(points.every(point => point.params.y >= 0 && point.params.y < 960));
  assert.ok(points.slice(0, -1).some(point => {
    const progress = (point.params.x - 10) / (900 - 10);
    const straightY = 20 + progress * (700 - 20);
    return Math.abs(point.params.y - straightY) > 0.5;
  }), 'the route should not be a mechanical straight line');
});

test('human input: short moves stay immediate and preserve the original object', () => {
  const params = { type: 'mouseMoved', x: 15, y: 14, button: 'none' };
  assert.deepEqual(humanizedMouseMove({ x: 10, y: 10 }, params, { random: fixedRandom }),
    [{ params, delayMs: 0 }]);
});

test('human input: invalid starting coordinates fail safe to one normal CDP move', () => {
  const params = { type: 'mouseMoved', x: 100, y: 200 };
  assert.deepEqual(humanizedMouseMove(null, params), [{ params, delayMs: 0 }]);
});
