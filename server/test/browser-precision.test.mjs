// Human-motion precision tests: `motion: 'human'` must change the *shape* of
// the input on the wire — many curved mouse samples instead of a teleport,
// per-character typing, eased multi-step scrolling — because that shape is
// what behavioural challenge systems score.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runPrecisionMethod } from '../browser-precision.mjs';

function fakeCdp() {
  const sent = [];
  return {
    sent,
    async send(method, params = {}) {
      sent.push({ method, params });
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: 5 };
      if (method === 'DOM.describeNode') return { node: { localName: 'button', nodeName: 'BUTTON', attributes: [] } };
      if (method === 'DOM.getBoxModel') return { model: { border: [90, 90, 110, 90, 110, 110, 90, 110] } };
      if (method === 'DOM.getOuterHTML') return { outerHTML: '<button>OK</button>' };
      return {};
    },
  };
}

const mouseEvents = (cdp, type) => cdp.sent.filter(e => e.method === 'Input.dispatchMouseEvent' && e.params.type === type);

test('human click travels a path and lands exactly on target', async () => {
  const cdp = fakeCdp();
  const result = await runPrecisionMethod(cdp, 'Hob.input.click', { x: 100, y: 100, motion: 'human' });
  assert.equal(result.ok, true);
  const moves = mouseEvents(cdp, 'mouseMoved');
  assert.ok(moves.length >= 8, `expected a travelled path, got ${moves.length} moves`);
  const lastMove = moves.at(-1).params;
  assert.equal(lastMove.x, 100);
  assert.equal(lastMove.y, 100);
  assert.equal(mouseEvents(cdp, 'mousePressed').length, 1);
  assert.equal(mouseEvents(cdp, 'mouseReleased').length, 1);
  // The press comes after the final move: approach first, then act.
  const lastMoveIndex = cdp.sent.indexOf(moves.at(-1));
  const pressIndex = cdp.sent.indexOf(mouseEvents(cdp, 'mousePressed')[0]);
  assert.ok(pressIndex > lastMoveIndex);
});

test('default click stays a teleport: one move, immediate press', async () => {
  const cdp = fakeCdp();
  await runPrecisionMethod(cdp, 'Hob.input.click', { x: 100, y: 100 });
  assert.equal(mouseEvents(cdp, 'mouseMoved').length, 1);
});

test('human typing inserts character by character', async () => {
  const cdp = fakeCdp();
  const text = 'hello hob';
  const result = await runPrecisionMethod(cdp, 'Hob.input.type', { text, motion: 'human' });
  assert.equal(result.motion, 'human');
  const inserts = cdp.sent.filter(e => e.method === 'Input.insertText');
  assert.equal(inserts.length, text.length);
  assert.equal(inserts.map(e => e.params.text).join(''), text);
});

test('human scroll splits the delta into eased steps summing exactly', async () => {
  const cdp = fakeCdp();
  const result = await runPrecisionMethod(cdp, 'Hob.input.scroll', { x: 50, y: 50, deltaY: 640, motion: 'human' });
  const wheels = mouseEvents(cdp, 'mouseWheel');
  assert.ok(wheels.length >= 3);
  assert.equal(wheels.reduce((acc, e) => acc + e.params.deltaY, 0), 640);
  assert.equal(result.steps, wheels.length);
});
