import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captchaMode, classifyChallengeUrl, classifyDomFacts, classifyBlockUrl,
  isBlockTitle, ChallengeTracker,
} from '../browser-challenge.mjs';

const ANCHOR = 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=SITEKEY&co=abc';
const BFRAME = 'https://www.google.com/recaptcha/api2/bframe?hl=en&v=xyz&k=SITEKEY';
const TURNSTILE = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/ov2';
const HCAPTCHA_CHALLENGE = 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha-challenge.html';

function makeTracker() {
  let now = 1_000_000;
  const transitions = [];
  const tracker = new ChallengeTracker({
    confirmMs: 750,
    now: () => now,
    onTransition: t => transitions.push(t),
  });
  return { tracker, transitions, advance: ms => { now += ms; } };
}

const factsV2 = (token = false) => ({
  ok: true, widgets: { recaptchaV2: true }, sitekeys: ['SITEKEY'],
  tokens: { recaptcha: token }, title: 'Form', url: 'https://example.com/form',
});
const factsNone = { ok: true, widgets: {}, sitekeys: [], tokens: {}, title: 'Ok', url: 'https://example.com/' };

test('captchaMode parses the environment', () => {
  const prev = process.env.HOB_CAPTCHA;
  try {
    delete process.env.HOB_CAPTCHA;
    assert.equal(captchaMode(), 'human');
    process.env.HOB_CAPTCHA = 'human';
    assert.equal(captchaMode(), 'human');
    process.env.HOB_CAPTCHA = 'detect';
    assert.equal(captchaMode(), 'detect');
    process.env.HOB_CAPTCHA = 'solve';
    assert.equal(captchaMode(), 'solve');
    process.env.HOB_CAPTCHA = 'off';
    assert.equal(captchaMode(), 'off');
    process.env.HOB_CAPTCHA = 'bogus';
    assert.throws(() => captchaMode(), /HOB_CAPTCHA/);
  } finally {
    if (prev === undefined) delete process.env.HOB_CAPTCHA; else process.env.HOB_CAPTCHA = prev;
  }
});

test('URL classification distinguishes checkbox from image grid', () => {
  assert.deepEqual(classifyChallengeUrl(ANCHOR), { provider: 'recaptcha-v2', kind: 'checkbox' });
  assert.deepEqual(classifyChallengeUrl(BFRAME), { provider: 'recaptcha-v2', kind: 'image-grid' });
  assert.equal(classifyChallengeUrl(TURNSTILE)?.provider, 'turnstile');
  assert.deepEqual(classifyChallengeUrl(HCAPTCHA_CHALLENGE), { provider: 'hcaptcha', kind: 'image-grid' });
  assert.equal(classifyChallengeUrl('https://example.com/checkout'), null);
  assert.equal(classifyChallengeUrl(''), null);
});

test('block URL and title classification', () => {
  assert.equal(classifyBlockUrl('https://example.com/cdn-cgi/challenge-platform/h/b'), 'cloudflare');
  assert.equal(classifyBlockUrl('https://geo.captcha-delivery.com/interstitial/'), 'datadome');
  assert.equal(classifyBlockUrl('https://example.com/page'), null);
  assert.equal(isBlockTitle('Just a moment...'), true);
  assert.equal(isBlockTitle('Verify you are human'), true);
  assert.equal(isBlockTitle('Welcome to my shop'), false);
});

test('DOM facts classify providers, sitekeys and tokens', () => {
  const hit = classifyDomFacts(factsV2());
  assert.equal(hit.provider, 'recaptcha-v2');
  assert.equal(hit.kind, 'checkbox');
  assert.equal(hit.sitekey, 'SITEKEY');
  assert.equal(hit.tokenPresent, false);
  assert.equal(classifyDomFacts(factsV2(true)).tokenPresent, true);
  const v3 = classifyDomFacts({ ok: true, widgets: { recaptchaV3: true }, sitekeys: [], tokens: {} });
  assert.equal(v3.kind, 'score-only');
  assert.equal(classifyDomFacts(factsNone), null);
  assert.equal(classifyDomFacts({ ok: false }), null);
});

test('tracker: one weak sighting is only a candidate; two spaced sightings confirm', () => {
  const { tracker, advance } = makeTracker();
  tracker.observeDom('t1', factsV2());
  assert.equal(tracker.activeChallenge('t1'), null);
  assert.ok(tracker.candidate('t1'));
  tracker.observeDom('t1', factsV2()); // too soon: hysteresis holds
  assert.equal(tracker.activeChallenge('t1'), null);
  advance(800);
  tracker.observeDom('t1', factsV2());
  const active = tracker.activeChallenge('t1');
  assert.ok(active);
  assert.equal(active.provider, 'recaptcha-v2');
  assert.equal(active.sitekey, 'SITEKEY');
});

test('tracker: a bframe sighting confirms immediately and upgrades the kind', () => {
  const { tracker } = makeTracker();
  tracker.observeUrl('t1', ANCHOR);
  assert.equal(tracker.activeChallenge('t1'), null);
  tracker.observeUrl('t1', BFRAME);
  const active = tracker.activeChallenge('t1');
  assert.ok(active);
  assert.equal(active.kind, 'image-grid');
});

test('tracker: a populated token resolves an active challenge', () => {
  const { tracker, transitions } = makeTracker();
  tracker.observeUrl('t1', BFRAME);
  assert.ok(tracker.activeChallenge('t1'));
  tracker.observeDom('t1', factsV2(true));
  assert.equal(tracker.activeChallenge('t1'), null);
  assert.equal(transitions.at(-1).to.resolvedVia, 'token');
});

test('tracker: a token present before confirmation never activates', () => {
  const { tracker, advance } = makeTracker();
  tracker.observeDom('t1', factsV2(true));
  advance(1000);
  tracker.observeDom('t1', factsV2(true));
  assert.equal(tracker.activeChallenge('t1'), null);
});

test('tracker: block page activates on the main frame and resolves by navigating away', () => {
  const { tracker } = makeTracker();
  tracker.observeUrl('t1', 'https://example.com/cdn-cgi/challenge-platform/h/b', { isMainFrame: true });
  const active = tracker.activeChallenge('t1');
  assert.ok(active);
  assert.equal(active.kind, 'block-page');
  tracker.observeUrl('t1', 'https://example.com/home', { isMainFrame: true });
  assert.equal(tracker.activeChallenge('t1'), null);
});

test('tracker: navigation plus a clean probe resolves a widget challenge', () => {
  const { tracker } = makeTracker();
  tracker.observeUrl('t1', BFRAME);
  assert.ok(tracker.activeChallenge('t1'));
  tracker.observeUrl('t1', 'https://example.com/done', { isMainFrame: true });
  assert.ok(tracker.activeChallenge('t1'), 'navigation alone must not resolve a widget challenge');
  tracker.observeDom('t1', factsNone);
  assert.equal(tracker.activeChallenge('t1'), null);
});

test('tracker: score-only sightings never activate', () => {
  const { tracker, advance } = makeTracker();
  const v3 = { ok: true, widgets: { recaptchaV3: true }, sitekeys: [], tokens: {} };
  tracker.observeDom('t1', v3);
  advance(5000);
  tracker.observeDom('t1', v3);
  assert.equal(tracker.activeChallenge('t1'), null);
  assert.ok(tracker.candidate('t1'));
});
