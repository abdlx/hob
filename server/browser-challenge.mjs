// CAPTCHA / anti-bot challenge detection for one bot's browser session.
//
// This module is deliberately pure: it performs no I/O and speaks no CDP. The
// gateway feeds it what it already sees — frame navigations, request URLs and
// DOM probe facts gathered on the gateway's own internal connection — and the
// tracker answers two questions: "is there a challenge in front of this
// target?" and "did it just get resolved?". Keeping classification here means
// the signatures are unit-testable against recorded fixtures and the gateway
// stays a router, not a detector.
//
// Two failure modes shape the design:
//   * A false positive parks a working agent (Phase 2's gate), which is worse
//     than a missed detection. So a challenge must be *confirmed*: either one
//     high-confidence signal (a challenge bframe URL, a visible widget with a
//     sitekey) or the same candidate seen twice, spaced in time.
//   * A flickering iframe must not flap the gate. Resolution requires positive
//     evidence — a populated token field — or the challenge signals gone AND a
//     successful main-frame navigation afterwards.

/**
 * Master mode for the CAPTCHA system, from the environment.
 *   off    — no detection, no gate, no solving (the pre-system behavior).
 *   detect — detection + metrics only; agent commands are never parked.
 *   human  — park agent actions and request human intervention; no solvers.
 *   solve  — legacy opt-in solver ladder.
 * Defaults to "human" so confirmed interruptions preserve pending actions.
 */
export function captchaMode() {
  const requested = (process.env.HOB_CAPTCHA || '').trim().toLowerCase();
  if (requested === 'off') return 'off';
  if (requested === 'human' || requested === '') return 'human';
  if (requested === 'solve') return 'solve';
  if (requested === 'detect') return 'detect';
  throw new Error(`HOB_CAPTCHA must be "off", "detect", "human" or "solve" (got "${requested}").`);
}

// ── URL signatures ──────────────────────────────────────────────────────────
// Frame and request URLs are the cheapest, hardest-to-fake signal: a page
// cannot show a reCAPTCHA without loading Google's frames. Each entry maps a
// URL pattern to a provider and, where the URL itself distinguishes it, the
// challenge kind. `anchor` frames are the checkbox widget; `bframe` is the
// image-challenge popup — the distinction matters to the solvers.

const URL_SIGNATURES = [
  // reCAPTCHA v2: anchor = checkbox, bframe = image grid.
  { provider: 'recaptcha-v2', kind: 'image-grid', pattern: /(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api2|enterprise)\/bframe/ },
  { provider: 'recaptcha-v2', kind: 'checkbox', pattern: /(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api2|enterprise)\/anchor/ },
  { provider: 'recaptcha-v2', kind: 'interactive', pattern: /(?:google\.com|recaptcha\.net)\/recaptcha\// },
  // hCaptcha: the checkbox iframe and the challenge iframe share the host;
  // the challenge iframe carries `hcaptcha-challenge` in its URL.
  { provider: 'hcaptcha', kind: 'image-grid', pattern: /hcaptcha\.com\/.*hcaptcha-challenge/ },
  { provider: 'hcaptcha', kind: 'checkbox', pattern: /(?:newassets\.)?hcaptcha\.com\/captcha\/v1\// },
  { provider: 'hcaptcha', kind: 'interactive', pattern: /hcaptcha\.com\// },
  // Cloudflare Turnstile widget frame.
  { provider: 'turnstile', kind: 'interactive', pattern: /challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\/.+\/turnstile/ },
  { provider: 'turnstile', kind: 'interactive', pattern: /challenges\.cloudflare\.com\/turnstile/ },
  // Arkose Labs / FunCaptcha.
  { provider: 'arkose', kind: 'interactive', pattern: /(?:arkoselabs\.com|funcaptcha\.com)\// },
  // GeeTest.
  { provider: 'geetest', kind: 'interactive', pattern: /(?:geetest\.com|geevisit\.com|geetest\.cn)\// },
];

// Whole-page interstitials and hard blocks are a different kind of problem:
// there is no widget to solve, the *page itself* is the challenge.
const BLOCK_URL_PATTERNS = [
  /cdn-cgi\/challenge-platform/,       // Cloudflare managed challenge / "Just a moment"
  /captcha-delivery\.com/,             // DataDome
  /(?:px-captcha|perimeterx|humansecurity)/i, // PerimeterX / HUMAN
  /botmanager|bot-manager/i,           // Akamai Bot Manager interstitials
];

const BLOCK_TITLE_PATTERNS = [
  /just a moment/i,
  /attention required/i,
  /verify you are human/i,
  /are you a robot/i,
  /checking your browser/i,
  /access denied/i,
  /you have been blocked/i,
  /unusual traffic/i,
];

/** Classify a frame/request URL. Returns `{ provider, kind }` or null. */
export function classifyChallengeUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  for (const sig of URL_SIGNATURES) {
    if (sig.pattern.test(url)) return { provider: sig.provider, kind: sig.kind };
  }
  return null;
}

/** True when a URL itself is a whole-page challenge/block interstitial. */
export function isBlockUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  return BLOCK_URL_PATTERNS.some(pattern => pattern.test(url));
}

/** True when a page title reads like a challenge/block page. */
export function isBlockTitle(title) {
  if (typeof title !== 'string' || !title) return false;
  return BLOCK_TITLE_PATTERNS.some(pattern => pattern.test(title));
}

// ── DOM probe ───────────────────────────────────────────────────────────────
// Evaluated by the gateway on its internal connection (Runtime.evaluate is
// the gateway's own observational tool here — the probe only *reads*). It
// returns plain facts; classification stays in this module where it can be
// tested. The probe must never throw and never mutate: a hostile or broken
// page gets `{ ok: false }`, not an exception in the gateway.

export const DOM_PROBE_EXPRESSION = `(() => {
  try {
    const facts = { ok: true, sitekeys: [], tokens: {}, widgets: {} };
    const visible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const token = name => {
      const el = document.querySelector('textarea[name="' + name + '"], input[name="' + name + '"]');
      return !!(el && typeof el.value === 'string' && el.value.length > 10);
    };
    // reCAPTCHA: v2 renders .g-recaptcha with a data-sitekey; v3 loads
    // api.js?render=<sitekey> and leaves no visible widget.
    const v2 = document.querySelector('.g-recaptcha[data-sitekey]');
    if (v2) { facts.widgets.recaptchaV2 = visible(v2) || !!v2.querySelector('iframe'); facts.sitekeys.push(v2.getAttribute('data-sitekey')); }
    if (document.querySelector('script[src*="recaptcha/api.js?render="]')) facts.widgets.recaptchaV3 = true;
    facts.tokens.recaptcha = token('g-recaptcha-response');
    // hCaptcha
    const hc = document.querySelector('.h-captcha[data-sitekey]');
    if (hc) { facts.widgets.hcaptcha = true; facts.sitekeys.push(hc.getAttribute('data-sitekey')); }
    facts.tokens.hcaptcha = token('h-captcha-response');
    // Turnstile
    const ts = document.querySelector('.cf-turnstile[data-sitekey]');
    if (ts) { facts.widgets.turnstile = true; facts.sitekeys.push(ts.getAttribute('data-sitekey')); }
    facts.tokens.turnstile = token('cf-turnstile-response');
    facts.title = document.title || '';
    facts.url = location.href;
    return facts;
  } catch (e) { return { ok: false }; }
})()`;

const PROVIDER_FOR_WIDGET = [
  ['recaptchaV2', 'recaptcha-v2', 'checkbox'],
  ['recaptchaV3', 'recaptcha-v3', 'score-only'],
  ['hcaptcha', 'hcaptcha', 'checkbox'],
  ['turnstile', 'turnstile', 'interactive'],
];

const TOKEN_FOR_PROVIDER = {
  'recaptcha-v2': 'recaptcha', 'recaptcha-v3': 'recaptcha',
  hcaptcha: 'hcaptcha', turnstile: 'turnstile',
};

/**
 * Classify DOM probe facts. Returns
 * `{ provider, kind, sitekey, tokenPresent }` or null.
 * A present token means the challenge (if any) is already satisfied — the
 * tracker uses this as its strongest resolution signal.
 */
export function classifyDomFacts(facts) {
  if (!facts || facts.ok !== true) return null;
  for (const [widget, provider, kind] of PROVIDER_FOR_WIDGET) {
    if (facts.widgets?.[widget]) {
      return {
        provider, kind,
        sitekey: facts.sitekeys?.[0] ?? null,
        tokenPresent: Boolean(facts.tokens?.[TOKEN_FOR_PROVIDER[provider]]),
      };
    }
  }
  return null;
}

/** True when the probe facts carry a solution token for the provider. */
export function tokenPresentFor(facts, provider) {
  if (!facts || facts.ok !== true) return false;
  const key = TOKEN_FOR_PROVIDER[provider];
  return key ? Boolean(facts.tokens?.[key]) : false;
}

// ── Per-target tracker ──────────────────────────────────────────────────────
// The gateway owns one tracker per browser session. It consumes URL and DOM
// observations and maintains, per target, one of:
//   none      — no challenge signals.
//   candidate — signals seen, not yet confirmed. Never parks anything.
//   active    — a confirmed challenge is being presented. Parks the agent
//               (Phase 2) and starts the solver ladder (Phase 4).
// A record is `{ provider, kind, sitekey, status, firstSeenAt, activeAt,
// resolvedAt, resolvedVia }`.

const STRONG_KINDS = new Set(['image-grid']); // a bframe/challenge popup is unambiguous

export function classifyBlockUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  if (/cdn-cgi\/challenge-platform/.test(url)) return 'cloudflare';
  if (/captcha-delivery\.com/.test(url)) return 'datadome';
  if (/(?:px-captcha|perimeterx|humansecurity)/i.test(url)) return 'perimeterx';
  if (/botmanager|bot-manager/i.test(url)) return 'akamai';
  return null;
}

export class ChallengeTracker {
  #targets = new Map();
  #onTransition;
  #confirmMs;
  #now;

  constructor({ onTransition = null, confirmMs = 750, now = () => Date.now() } = {}) {
    this.#onTransition = onTransition;
    this.#confirmMs = confirmMs;
    this.#now = now;
  }

  /** The confirmed (active) challenge for a target, or null. */
  activeChallenge(targetId) {
    const state = this.#targets.get(targetId);
    return state?.active ?? null;
  }

  /** The unconfirmed candidate for a target, or null. */
  candidate(targetId) {
    const state = this.#targets.get(targetId);
    return state?.candidate ?? null;
  }

  /** Observe any URL the browser touched (frame navigation or request). */
  observeUrl(targetId, url, { isMainFrame = false } = {}) {
    const state = this.#state(targetId);
    if (isMainFrame) state.lastMainUrl = url;

    const blockProvider = classifyBlockUrl(url);
    if (blockProvider) {
      this.#sight(targetId, {
        provider: blockProvider, kind: 'block-page', sitekey: null,
        strength: isMainFrame ? 2 : 1,
      });
      return;
    }
    const hit = classifyChallengeUrl(url);
    if (hit) {
      this.#sight(targetId, {
        provider: hit.provider, kind: hit.kind, sitekey: null,
        strength: STRONG_KINDS.has(hit.kind) ? 2 : 1,
      });
      return;
    }
    // A main-frame navigation to an ordinary URL while a block page is active
    // means the interstitial let us through (or the user did): block pages
    // carry no token, so the navigation itself is the resolution evidence.
    if (isMainFrame && state.active?.kind === 'block-page') {
      this.#resolve(targetId, 'navigation');
    } else if (isMainFrame && state.active) {
      state.pendingNavigationResolution = true;
    }
  }

  /** Observe a page title (block pages announce themselves in the title). */
  observeTitle(targetId, title) {
    if (!isBlockTitle(title)) return;
    const state = this.#state(targetId);
    // Only meaningful while the main frame is on, or plausibly on, an
    // interstitial: require a block-ish URL or no better explanation.
    if (state.active) return;
    this.#sight(targetId, {
      provider: state.candidate?.provider ?? 'interstitial', kind: 'block-page',
      sitekey: null, strength: 1,
    });
  }

  /** Observe DOM probe facts for a target (from classifyDomFacts' input). */
  observeDom(targetId, facts) {
    const state = this.#state(targetId);
    const hit = classifyDomFacts(facts);

    // Strongest resolution signal there is: a populated token field.
    if (state.active && tokenPresentFor(facts, state.active.provider)) {
      this.#resolve(targetId, 'token');
      return;
    }
    if (state.active && state.pendingNavigationResolution && !hit) {
      this.#resolve(targetId, 'navigation');
      return;
    }
    if (!hit) return;
    if (hit.tokenPresent) return; // already solved before we ever confirmed it
    if (hit.kind === 'score-only') {
      // v3 has no interaction to park for; record it as a candidate so the
      // session knows the host scores it, but it can never become "active".
      this.#sight(targetId, { provider: hit.provider, kind: hit.kind, sitekey: hit.sitekey, strength: 0, passive: true });
      return;
    }
    this.#sight(targetId, {
      provider: hit.provider, kind: hit.kind, sitekey: hit.sitekey, strength: 1,
    });
  }

  /** A target went away; forget everything about it. */
  forget(targetId) { this.#targets.delete(targetId); }

  #state(targetId) {
    let state = this.#targets.get(targetId);
    if (!state) {
      state = { candidate: null, active: null, lastMainUrl: null, pendingNavigationResolution: false };
      this.#targets.set(targetId, state);
    }
    return state;
  }

  #sight(targetId, { provider, kind, sitekey, strength, passive = false }) {
    const state = this.#state(targetId);
    const now = this.#now();
    if (state.active) {
      // An image-grid popup opening over a checkbox challenge upgrades the
      // kind: solvers need to know which problem they are looking at.
      if (state.active.provider === provider && kind === 'image-grid' && state.active.kind !== 'image-grid') {
        state.active.kind = 'image-grid';
      }
      return;
    }
    let candidate = state.candidate;
    if (!candidate || candidate.provider !== provider) {
      candidate = {
        provider, kind, sitekey: sitekey ?? null, status: 'candidate',
        firstSeenAt: now, lastSeenAt: now, sightings: 0, score: 0,
      };
      state.candidate = candidate;
    }
    if (kind === 'image-grid' || (candidate.kind === 'checkbox' && kind === 'image-grid')) candidate.kind = 'image-grid';
    if (sitekey) candidate.sitekey = sitekey;
    candidate.sightings += 1;
    candidate.lastSeenAt = now;
    // Confirmation: one strong signal, or two weak signals spaced far
    // enough apart that a single flicker cannot confirm itself.
    if (strength >= 2) candidate.score = 2;
    else if (candidate.sightings >= 2 && now - candidate.firstSeenAt >= this.#confirmMs) candidate.score = 2;
    else candidate.score = Math.max(candidate.score, strength);
    if (passive) return; // score-only sightings are bookkeeping, never a gate
    if (candidate.score >= 2) {
      candidate.status = 'active';
      candidate.activeAt = now;
      state.active = candidate;
      state.candidate = null;
      this.#emit(targetId, null, state.active);
    }
  }

  #resolve(targetId, via) {
    const state = this.#targets.get(targetId);
    if (!state?.active) return;
    const resolved = { ...state.active, status: 'resolved', resolvedAt: this.#now(), resolvedVia: via };
    const was = state.active;
    state.active = null;
    state.candidate = null;
    state.pendingNavigationResolution = false;
    this.#emit(targetId, was, resolved);
  }

  #emit(targetId, from, to) {
    if (!this.#onTransition) return;
    try { this.#onTransition({ targetId, from, to }); } catch { /* a listener must not break detection */ }
  }
}
