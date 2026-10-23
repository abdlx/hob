// Solver ladder tests against scripted fake contexts: the solvers are pure
// orchestration over the gateway-built ctx, so what is proven here is the
// decision logic — where the checkbox click lands, when a challenge counts
// as escalated, which tiles get clicked, and that nothing guesses when it
// has no eyes.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solveCheckboxChallenge, solveImageGridChallenge, createHttpVisionSolver,
} from '../browser-solvers.mjs';

const WIDGET = { x: 100, y: 200, width: 300, height: 78 };

function checkboxCtx({ rect = WIDGET, resolveAfterProbes = Infinity, escalateAtProbe = Infinity } = {}) {
  const calls = { clicks: [], probes: 0 };
  let resolved = false;
  const ctx = {
    targetId: 't1',
    challenge: { provider: 'recaptcha-v2', kind: 'checkbox', sitekey: 'K' },
    channel: { async evaluateValue() { return rect; }, async request() { return {}; } },
    async clickPoint(x, y, opts) { calls.clicks.push({ x, y, opts }); return { ok: true }; },
    async probeDom() {
      calls.probes += 1;
      if (calls.probes >= resolveAfterProbes) resolved = true;
      return {};
    },
    isResolved: () => resolved,
    currentChallenge: () => (calls.probes >= escalateAtProbe
      ? { provider: 'recaptcha-v2', kind: 'image-grid' }
      : { provider: 'recaptcha-v2', kind: 'checkbox' }),
    async waitForResolution() { return resolved; },
    async listTargets() { return []; },
  };
  return { ctx, calls };
}

test('checkbox solver clicks the box, then polls until the token lands', async () => {
  const { ctx, calls } = checkboxCtx({ resolveAfterProbes: 3 });
  const outcome = await solveCheckboxChallenge(ctx, { waitMs: 20000 });
  assert.equal(outcome.outcome, 'solved');
  assert.equal(calls.clicks.length, 1);
  assert.equal(calls.clicks[0].x, WIDGET.x + 28, 'the click aims at the checkbox, not the widget center');
  assert.equal(calls.clicks[0].y, WIDGET.y + WIDGET.height / 2);
});

test('checkbox solver reports not-applicable when there is no widget', async () => {
  const { ctx } = checkboxCtx({ rect: null });
  const outcome = await solveCheckboxChallenge(ctx);
  assert.equal(outcome.outcome, 'not-applicable');
});

test('checkbox solver hands off when the widget escalates to an image grid', async () => {
  const { ctx } = checkboxCtx({ escalateAtProbe: 2 });
  const outcome = await solveCheckboxChallenge(ctx, { waitMs: 20000 });
  assert.equal(outcome.outcome, 'escalated');
});

test('checkbox solver ignores score-only and block challenges', async () => {
  const { ctx } = checkboxCtx({});
  ctx.challenge = { provider: 'recaptcha-v3', kind: 'score-only' };
  const outcome = await solveCheckboxChallenge(ctx);
  assert.equal(outcome.outcome, 'not-applicable');
});

const GRID = {
  prompt: 'Select all images with cars',
  tiles: Array.from({ length: 9 }, (_, i) => ({
    x: (i % 3) * 100, y: Math.floor(i / 3) * 100, width: 100, height: 100,
  })),
  rows: 3, cols: 3,
  verify: { x: 10, y: 320, width: 80, height: 30 },
};

function gridCtx({ visionTiles = [0, 4], resolveOnWait = true } = {}) {
  const clicks = [];
  const visionCalls = [];
  const ctx = {
    targetId: 't1',
    challenge: { provider: 'recaptcha-v2', kind: 'image-grid', sitekey: 'K' },
    channel: {
      async evaluateValue(expression) {
        if (String(expression).includes('data-challenge-grid')) return GRID;
        return null;
      },
      async request(method) {
        if (method === 'Page.captureScreenshot') return { data: 'QUJD' };
        return {};
      },
    },
    async clickPoint(x, y, opts) { clicks.push({ x, y, opts }); return { ok: true }; },
    async probeDom() { return {}; },
    isResolved: () => false,
    currentChallenge: () => ({ provider: 'recaptcha-v2', kind: 'image-grid' }),
    async waitForResolution() { return resolveOnWait; },
    async listTargets() { return []; },
  };
  const vision = {
    async solveGrid(args) { visionCalls.push(args); return { tiles: visionTiles }; },
  };
  return { ctx, vision, clicks, visionCalls };
}

test('grid solver clicks the vision-chosen tile centers, then verify', async () => {
  const { ctx, vision, clicks, visionCalls } = gridCtx();
  const outcome = await solveImageGridChallenge(ctx, { vision });
  assert.equal(outcome.outcome, 'solved');
  assert.equal(visionCalls[0].prompt, 'Select all images with cars');
  assert.equal(visionCalls[0].cols, 3);
  assert.deepEqual(clicks.map(c => [c.x, c.y]), [[50, 50], [150, 150], [50, 335]]);
});

test('grid solver without vision refuses to guess', async () => {
  const { ctx } = gridCtx();
  const outcome = await solveImageGridChallenge(ctx, { vision: null });
  assert.equal(outcome.outcome, 'not-applicable');
});

test('grid solver fails cleanly when vision returns no tiles', async () => {
  const { ctx, vision } = gridCtx({ visionTiles: [] });
  const outcome = await solveImageGridChallenge(ctx, { vision });
  assert.equal(outcome.outcome, 'failed');
});

test('HTTP vision solver speaks the chat API and parses the JSON reply', async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'The matching tiles are {"tiles": [2, 5]} as requested.' } }] }),
    };
  };
  const solver = createHttpVisionSolver({ url: 'https://vision.example/v1/chat', apiKey: 'k', model: 'm1', fetchImpl });
  const answer = await solver.solveGrid({ imageBase64: 'QUJD', prompt: 'cars', cols: 3, rows: 3 });
  assert.deepEqual(answer.tiles, [2, 5]);
  assert.equal(request.init.headers.authorization, 'Bearer k');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'm1');
  assert.match(body.messages[0].content[0].text, /cars/);
});

import { createCapSolverProvider, solveWithService, tokenInjectionExpression } from '../browser-solvers.mjs';

test('CapSolver provider creates a task, polls, and returns the token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith('/createTask')) return { ok: true, json: async () => ({ errorId: 0, taskId: 'T1' }) };
    return { ok: true, json: async () => ({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'TOKEN123' } }) };
  };
  const provider = createCapSolverProvider({ apiKey: 'KEY', fetchImpl, pollMs: 1 });
  assert.equal(provider.supports('recaptcha-v2'), true);
  assert.equal(provider.supports('geetest'), false);
  const minted = await provider.solveTokenTask({ provider: 'recaptcha-v2', sitekey: 'SK', pageUrl: 'https://example.com/form' });
  assert.deepEqual(minted, { ok: true, token: 'TOKEN123' });
  assert.equal(calls[0].body.clientKey, 'KEY');
  assert.equal(calls[0].body.task.type, 'ReCaptchaV2TaskProxyLess');
  assert.equal(calls[0].body.task.websiteKey, 'SK');
});

test('CapSolver provider surfaces service errors as failed mints', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ errorId: 1, errorCode: 'ERROR_KEY_DOES_NOT_EXIST', errorDescription: 'bad key' }) });
  const provider = createCapSolverProvider({ apiKey: 'KEY', fetchImpl, pollMs: 1 });
  await assert.rejects(
    () => provider.solveTokenTask({ provider: 'turnstile', sitekey: 'SK', pageUrl: 'https://x.example/' }),
    /bad key/);
});

test('solveWithService mints, injects, and trusts only the tracker', async () => {
  const evaluated = [];
  let resolved = false;
  const ctx = {
    targetId: 't1',
    challenge: { provider: 'turnstile', kind: 'interactive', sitekey: 'SK' },
    channel: { async evaluateValue(expr) { evaluated.push(expr); return 1; }, async request() { return {}; } },
    async clickPoint() { return { ok: true }; },
    async probeDom() { return {}; },
    isResolved: () => resolved,
    currentChallenge: () => ({ provider: 'turnstile', kind: 'interactive' }),
    async waitForResolution() { resolved = true; return true; },
    async listTargets() { return [{ id: 't1', type: 'page', url: 'https://example.com/form' }]; },
  };
  const service = {
    name: 'fake',
    supports: p => p === 'turnstile',
    async solveTokenTask(args) {
      assert.equal(args.pageUrl, 'https://example.com/form');
      assert.equal(args.sitekey, 'SK');
      return { ok: true, token: 'TOK' };
    },
  };
  const outcome = await solveWithService(ctx, { service });
  assert.equal(outcome.outcome, 'solved');
  assert.match(evaluated[0], /cf-turnstile-response/);
  assert.match(evaluated[0], /TOK/);
});

test('solveWithService refuses providers the service does not support', async () => {
  const ctx = {
    targetId: 't1',
    challenge: { provider: 'geetest', kind: 'interactive', sitekey: 'SK' },
    channel: { async evaluateValue() { return 0; }, async request() { return {}; } },
    async clickPoint() { return { ok: true }; },
    async probeDom() { return {}; },
    isResolved: () => false,
    currentChallenge: () => null,
    async waitForResolution() { return false; },
    async listTargets() { return []; },
  };
  const service = { name: 'fake', supports: () => false, async solveTokenTask() { return { ok: false }; } };
  const outcome = await solveWithService(ctx, { service });
  assert.equal(outcome.outcome, 'not-applicable');
});

test('token injection expression targets the right fields per provider', () => {
  assert.match(tokenInjectionExpression('hcaptcha', 'T'), /h-captcha-response/);
  assert.match(tokenInjectionExpression('recaptcha-v2', 'T'), /g-recaptcha-response/);
  assert.match(tokenInjectionExpression('turnstile', 'T'), /cf-turnstile-response/);
});
