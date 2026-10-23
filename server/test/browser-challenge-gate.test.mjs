// Challenge-gate integration tests (Phase 2 of the CAPTCHA plan).
//
// These drive the session's public detection feeds and the same
// `admitAgentMutation` choke point every agent mutation passes through, so
// what is proven here is the production path: a confirmed challenge parks
// mutations, resolution releases them in order, a block page refuses fast,
// and `detect` mode changes nothing at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../browser-gateway.mjs';

const BFRAME = 'https://www.google.com/recaptcha/api2/bframe?hl=en&v=x&k=SITEKEY';
const BLOCK = 'https://example.com/cdn-cgi/challenge-platform/h/b';
const TOKEN_FACTS = {
  ok: true, widgets: { recaptchaV2: true }, sitekeys: ['SITEKEY'],
  tokens: { recaptcha: true }, title: 'Form', url: 'https://example.com/form',
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function makeSession(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hob-challenge-gate-'));
  const session = new BrowserSession({
    botId: 'gate-test',
    record: { gatewayToken: 'gate-token', gatewayPort: 39998 },
    options: { profileDir: dir, captchaMode: 'solve', challengeParkMs: 400, ...options },
  });
  t.after(async () => { await session.destroy().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
  return session;
}

test('a confirmed challenge parks an agent mutation until it resolves', async (t) => {
  const session = await makeSession(t);
  session.noteChallengeUrl('target-1', BFRAME);
  assert.equal(session.status().challenge?.provider, 'recaptcha-v2');
  assert.equal(session.status().challengeStats.seen, 1);
  assert.equal(session.hasWork(), true, 'an active challenge is work: the browser must not be reaped');

  let settled = false;
  const admissionPromise = session.admitAgentMutation().then(result => { settled = true; return result; });
  await sleep(200);
  assert.equal(settled, false, 'the mutation must still be parked behind the challenge');

  session.noteChallengeDom('target-1', TOKEN_FACTS);
  const admission = await admissionPromise;
  assert.equal(admission.ok, true);
  admission.release();
  assert.equal(session.status().challenge, null);
  assert.equal(session.status().challengeStats.passive, 1, 'a self-resolving challenge counts as passive');
});

test('a parked mutation is refused after the park timeout', async (t) => {
  const session = await makeSession(t);
  session.noteChallengeUrl('target-1', BFRAME);
  const admission = await session.admitAgentMutation();
  assert.deepEqual(admission, { ok: false, reason: 'challenge_timeout' });
  assert.equal(session.status().challengeStats.failed, 1);
});

test('a block page refuses immediately instead of parking', async (t) => {
  const session = await makeSession(t);
  session.noteChallengeUrl('target-1', BLOCK, { isMainFrame: true });
  assert.equal(session.status().challenge?.kind, 'block-page');
  const started = Date.now();
  const admission = await session.admitAgentMutation();
  assert.deepEqual(admission, { ok: false, reason: 'challenge_blocked' });
  assert.ok(Date.now() - started < 200, 'a block page must fail fast, not wait out the park timeout');
});

test('detect mode observes but never parks', async (t) => {
  const session = await makeSession(t, { captchaMode: 'detect' });
  session.noteChallengeUrl('target-1', BFRAME);
  assert.equal(session.status().challenge?.provider, 'recaptcha-v2', 'detection still records the challenge');
  const admission = await session.admitAgentMutation();
  assert.equal(admission.ok, true, 'detect mode must not change admission behavior');
  admission.release();
});

test('an aborted admission settles as cancelled, not as a timeout', async (t) => {
  const session = await makeSession(t);
  session.noteChallengeUrl('target-1', BFRAME);
  const controller = new AbortController();
  const admissionPromise = session.admitAgentMutation(controller.signal);
  controller.abort();
  const admission = await admissionPromise;
  assert.deepEqual(admission, { ok: false, reason: 'cancelled' });
});

test('a block page burns its host into the cooldown list', async (t) => {
  const session = await makeSession(t);
  session.noteChallengeUrl('target-1', BLOCK, { isMainFrame: true });
  const cooldowns = session.status().challengeCooldowns;
  assert.equal(cooldowns.length, 1);
  assert.equal(cooldowns[0].host, 'example.com');
  assert.ok(cooldowns[0].until > Date.now());
});

test('a parked timeout escalates to the operator callback', async (t) => {
  const escalations = [];
  const session = await makeSession(t, { onChallengeEscalated: info => escalations.push(info) });
  session.noteChallengeUrl('target-1', BFRAME);
  const admission = await session.admitAgentMutation();
  assert.equal(admission.reason, 'challenge_timeout');
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].reason, 'park_timeout');
  assert.equal(escalations[0].provider, 'recaptcha-v2');
});
