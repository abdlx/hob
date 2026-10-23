// CAPTCHA solvers: the ladder the gateway climbs when a challenge is active.
//
// A solver never talks to the agent's CDP session and never holds the control
// lease. It works through a context the gateway builds for one challenge:
//
//   ctx.channel          a page-bound CDP connection of the gateway's own
//                        (Runtime.evaluate, screenshots, frame attach)
//   ctx.clickPoint(x, y) verified precision input with human motion
//   ctx.probeDom()       re-run the detection probe and feed the tracker
//   ctx.isResolved()     whether the tracker still shows the challenge
//   ctx.waitForResolution(ms)
//   ctx.listTargets()    the browser's target list (to find challenge frames)
//
// Solvers report `{ outcome, method, detail }` and never throw for an
// unsolvable challenge — "not-applicable" and "failed" are answers, because
// the next rung (another solver, a service, a human) is always waiting. The
// resolution itself is only ever declared by the tracker, from evidence
// (a token, a navigation) — a solver's confidence is not evidence.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Where the checkbox lives inside a widget, per provider convention: the
// anchor iframe is ~300×78 with the box at the left; container divs wrap the
// same iframe. Read the rect, aim at the box, not the middle of the widget.
const WIDGET_RECT_EXPRESSION = `(() => {
  const candidates = document.querySelectorAll(
    'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"],' +
    'iframe[src*="hcaptcha.com/captcha"], iframe[src*="challenges.cloudflare.com"],' +
    '.g-recaptcha, .h-captcha, .cf-turnstile');
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) {
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
  }
  return null;
})()`;

/**
 * Rung 1: click the checkbox and wait. Turnstile and a large share of
 * checkbox challenges end here — the widget's own verdict arrives as a
 * token, which the tracker sees through `probeDom`.
 */
export async function solveCheckboxChallenge(ctx, { waitMs = 14000 } = {}) {
  const { challenge } = ctx;
  if (!['checkbox', 'interactive'].includes(challenge.kind)) {
    return { outcome: 'not-applicable', method: 'checkbox', detail: `kind is ${challenge.kind}` };
  }
  await ctx.probeDom().catch(() => null);
  if (ctx.isResolved()) return { outcome: 'solved', method: 'checkbox', detail: 'token already present' };

  const rect = await ctx.channel.evaluateValue(WIDGET_RECT_EXPRESSION).catch(() => null);
  if (!rect) return { outcome: 'not-applicable', method: 'checkbox', detail: 'no visible widget to click' };

  const clickX = rect.x + Math.min(28, rect.width / 4);
  const clickY = rect.y + rect.height / 2;
  await ctx.clickPoint(clickX, clickY);

  // Poll the tracker while refreshing its evidence: the token appears in the
  // DOM the probe reads, so probing is what turns "we clicked" into "solved".
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(1100);
    await ctx.probeDom().catch(() => null);
    if (ctx.isResolved()) return { outcome: 'solved', method: 'checkbox', detail: 'token appeared after click' };
    const now = ctx.currentChallenge();
    if (now?.kind === 'image-grid') {
      return { outcome: 'escalated', method: 'checkbox', detail: 'widget escalated to an image challenge' };
    }
  }
  return { outcome: 'failed', method: 'checkbox', detail: 'no token after click + wait' };
}

// The grid state, read inside the challenge frame (or the page itself when
// the grid is same-origin): prompt text, tile rects in *frame-local*
// coordinates, grid dimensions, and the verify button's rect.
export const GRID_STATE_EXPRESSION = `(() => {
  const container = document.querySelector(
    '.rc-imageselect-challenge, .hcaptcha-challenge, [data-challenge-grid]');
  if (!container) return null;
  const promptEl = container.querySelector(
    '.rc-imageselect-desc, .prompt-text, [data-challenge-prompt]') || container;
  const tileEls = [...container.querySelectorAll(
    'td.rc-imageselect-tile, [data-tile], .tile')].filter(el => {
      const r = el.getBoundingClientRect(); return r.width > 8 && r.height > 8;
    });
  if (tileEls.length < 4) return null;
  const tiles = tileEls.map(el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const rows = [...new Set(tiles.map(t => Math.round(t.y)))].length;
  const verifyEl = document.querySelector(
    '#recaptcha-verify-button, .verify-button, [data-challenge-verify]');
  const verify = verifyEl ? (() => { const r = verifyEl.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; })() : null;
  return {
    prompt: (promptEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
    tiles, rows, cols: Math.ceil(tiles.length / rows), verify,
  };
})()`;

// Rect of the challenge iframe inside the top page, to translate frame-local
// coordinates into page coordinates for clicking and screenshotting.
const FRAME_RECT_EXPRESSION = `(() => {
  const frame = document.querySelector(
    'iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha-challenge"], iframe[title*="challenge" i]');
  if (!frame) return null;
  const r = frame.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`;

const CHALLENGE_FRAME_URL = /(?:bframe|hcaptcha-challenge|arkose|challenge-platform)/;

/**
 * Rung 2: image-grid challenges, answered by a vision solver.
 * `vision.solveGrid({ imageBase64, prompt, cols, rows })` must return
 * `{ tiles: number[] }` (0-based, row-major). Without a configured vision
 * solver this rung reports not-applicable — guessing tiles is worse than
 * handing the challenge to a human.
 */
export async function solveImageGridChallenge(ctx, { vision, maxRounds = 3 } = {}) {
  if (!vision || typeof vision.solveGrid !== 'function') {
    return { outcome: 'not-applicable', method: 'image-grid', detail: 'no vision solver configured' };
  }
  for (let round = 1; round <= maxRounds; round += 1) {
    if (ctx.isResolved()) return { outcome: 'solved', method: 'image-grid', detail: `resolved before round ${round}` };

    // Find the frame that hosts the grid: an OOPIF target if there is one,
    // otherwise the grid lives in the page itself.
    let frameSessionId = null;
    let frameOffset = { x: 0, y: 0 };
    const targets = await ctx.listTargets().catch(() => null);
    const frameTarget = Array.isArray(targets)
      ? targets.find(t => t.type === 'iframe' && CHALLENGE_FRAME_URL.test(String(t.url || '')))
      : null;
    if (frameTarget) {
      const attached = await ctx.channel.request('Target.attachToTarget',
        { targetId: frameTarget.id, flatten: true }).catch(() => null);
      if (!attached?.sessionId) {
        return { outcome: 'not-applicable', method: 'image-grid', detail: 'challenge frame could not be attached' };
      }
      frameSessionId = attached.sessionId;
      const rect = await ctx.channel.evaluateValue(FRAME_RECT_EXPRESSION).catch(() => null);
      if (rect) frameOffset = { x: rect.x, y: rect.y };
    }

    const grid = await ctx.channel.evaluateValue(GRID_STATE_EXPRESSION, { sessionId: frameSessionId }).catch(() => null);
    if (!grid) {
      return { outcome: round === 1 ? 'not-applicable' : 'failed', method: 'image-grid', detail: 'grid DOM not readable' };
    }

    const shot = await ctx.channel.request('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (!shot?.data) return { outcome: 'failed', method: 'image-grid', detail: 'screenshot failed' };

    const answer = await vision.solveGrid({
      imageBase64: shot.data, prompt: grid.prompt, cols: grid.cols, rows: grid.rows,
    }).catch(() => null);
    const tiles = Array.isArray(answer?.tiles)
      ? [...new Set(answer.tiles.filter(i => Number.isInteger(i) && i >= 0 && i < grid.tiles.length))]
      : [];
    if (!tiles.length) return { outcome: 'failed', method: 'image-grid', detail: 'vision returned no tiles' };

    for (const index of tiles) {
      const tile = grid.tiles[index];
      await ctx.clickPoint(frameOffset.x + tile.x + tile.width / 2, frameOffset.y + tile.y + tile.height / 2,
        { expected: frameTarget ? { tag: 'iframe' } : undefined });
      await sleep(180);
    }
    if (grid.verify) {
      await ctx.clickPoint(frameOffset.x + grid.verify.x + grid.verify.width / 2,
        frameOffset.y + grid.verify.y + grid.verify.height / 2,
        { expected: frameTarget ? { tag: 'iframe' } : undefined });
    }
    const resolved = await ctx.waitForResolution(9000, async () => { await ctx.probeDom().catch(() => null); });
    if (resolved) return { outcome: 'solved', method: 'image-grid', detail: `round ${round}` };
    // Not resolved: tiles may have refreshed (dynamic challenges) — loop and
    // read a fresh grid rather than clicking yesterday's picture.
  }
  return { outcome: 'failed', method: 'image-grid', detail: `unresolved after ${maxRounds} rounds` };
}

/**
 * A vision solver speaking the OpenAI-compatible chat API (image + text in,
 * JSON out). Any endpoint with that shape works; configuration comes from the
 * environment at the gateway, never from the page or the agent.
 */
export function createHttpVisionSolver({ url, apiKey, model, fetchImpl = fetch } = {}) {
  if (!url || !model) throw new Error('createHttpVisionSolver requires a url and a model.');
  return {
    async solveGrid({ imageBase64, prompt, cols, rows }) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: `This is a ${cols}x${rows} image-grid CAPTCHA. The instruction is: "${prompt}". `
                  + `Tiles are numbered 0 to ${cols * rows - 1}, left to right, top to bottom. `
                  + 'Reply with JSON only: {"tiles": [numbers of the tiles that match the instruction]}.',
              },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) throw new Error(`Vision endpoint answered HTTP ${response.status}.`);
      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content ?? '';
      const match = /\{[\s\S]*\}/.exec(String(content));
      if (!match) throw new Error('Vision reply carried no JSON object.');
      const parsed = JSON.parse(match[0]);
      return { tiles: Array.isArray(parsed.tiles) ? parsed.tiles : [] };
    },
  };
}

/** Build the configured vision solver from the environment, or null. */
export function visionSolverFromEnv(env = process.env) {
  const url = (env.HOB_CAPTCHA_VISION_URL || '').trim();
  const model = (env.HOB_CAPTCHA_VISION_MODEL || '').trim();
  if (!url || !model) return null;
  return createHttpVisionSolver({ url, model, apiKey: (env.HOB_CAPTCHA_VISION_KEY || '').trim() || undefined });
}

// ── External solver services (Phase 6) ──────────────────────────────────────
// The last automated rung. A service mints a token off-site; hob injects it
// into the page that issued the challenge and then — this is the part that
// keeps the design honest — asks the *tracker* whether the challenge
// resolved. The service's word is never the verdict.
//
// Honest limit, kept from the plan: for score-based systems the token is
// only half the answer; the session's reputation is the other half, and no
// service sells that. Services accelerate checkbox/invisible challenges.

const SERVICE_TASK_TYPES = {
  'recaptcha-v2': 'ReCaptchaV2TaskProxyLess',
  'recaptcha-v3': 'ReCaptchaV3TaskProxyLess',
  hcaptcha: 'HCaptchaTaskProxyLess',
  turnstile: 'AntiTurnstileTaskProxyLess',
};

/** A CapSolver-compatible provider (createTask / getTaskResult protocol). */
export function createCapSolverProvider({
  apiKey, fetchImpl = fetch, baseUrl = 'https://api.capsolver.com',
  pollMs = 3000, timeoutMs = 120000,
} = {}) {
  if (!apiKey) throw new Error('createCapSolverProvider requires an apiKey.');
  const post = async (path, payload) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, ...payload }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Solver service answered HTTP ${response.status}.`);
    const body = await response.json();
    if (body?.errorId) throw new Error(`Solver service error: ${body.errorDescription || body.errorCode || 'unknown'}.`);
    return body;
  };
  return {
    name: 'capsolver',
    supports: provider => provider in SERVICE_TASK_TYPES,
    async solveTokenTask({ provider, sitekey, pageUrl }) {
      const type = SERVICE_TASK_TYPES[provider];
      if (!type) return { ok: false, detail: `unsupported provider: ${provider}` };
      if (!sitekey) return { ok: false, detail: 'no sitekey was detected for this challenge' };
      const created = await post('/createTask', { task: { type, websiteURL: pageUrl, websiteKey: sitekey } });
      if (!created?.taskId) return { ok: false, detail: 'the service returned no task id' };
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const result = await post('/getTaskResult', { taskId: created.taskId });
        if (result?.status === 'ready') {
          const token = result.solution?.gRecaptchaResponse || result.solution?.token;
          return token ? { ok: true, token } : { ok: false, detail: 'the service reported ready without a token' };
        }
        if (Date.now() > deadline) return { ok: false, detail: 'the service did not finish in time' };
        await sleep(pollMs);
      }
    },
  };
}

/** The configured solver service from the environment, or null. */
export function solverServiceFromEnv(env = process.env) {
  const apiKey = (env.HOB_CAPTCHA_KEY_CAPSOLVER || '').trim();
  if (!apiKey) return null;
  return createCapSolverProvider({ apiKey });
}

const TOKEN_FIELDS = {
  'recaptcha-v2': ['g-recaptcha-response'],
  'recaptcha-v3': ['g-recaptcha-response'],
  hcaptcha: ['h-captcha-response', 'g-recaptcha-response'],
  turnstile: ['cf-turnstile-response'],
};

/**
 * The in-page half of a service solve: write the token into the response
 * field(s) the widget reads, fire the events a form would fire, and invoke
 * the page's own registered callback where the provider exposes it. Returns
 * how many fields were set. Injection alone proves nothing — the caller
 * confirms resolution through the tracker afterwards.
 */
export function tokenInjectionExpression(provider, token) {
  const fields = TOKEN_FIELDS[provider] ?? ['g-recaptcha-response'];
  return `(() => {
    const token = ${JSON.stringify(String(token))};
    let set = 0;
    for (const name of ${JSON.stringify(fields)}) {
      document.querySelectorAll('textarea[name="' + name + '"], input[name="' + name + '"]').forEach(el => {
        el.value = token;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        set += 1;
      });
    }
    try {
      const clients = window.___grecaptcha_cfg?.clients;
      if (clients) {
        for (const client of Object.values(clients)) {
          for (const slot of Object.values(client)) {
            if (slot && typeof slot === 'object' && typeof slot.callback === 'function') {
              slot.callback(token);
            }
          }
        }
      }
    } catch { /* the callback hunt is best-effort; the field is the contract */ }
    return set;
  })()`;
}

/**
 * Run one service solve through a challenge context: mint, inject, verify.
 * Caps and the circuit breaker live in the gateway (they are policy);
 * this function is only the mechanics.
 */
export async function solveWithService(ctx, { service }) {
  const { challenge } = ctx;
  if (!service?.supports?.(challenge.provider)) {
    return { outcome: 'not-applicable', method: 'service', detail: `service does not support ${challenge.provider}` };
  }
  const targets = await ctx.listTargets().catch(() => null);
  const page = Array.isArray(targets) ? targets.find(t => t.id === ctx.targetId) : null;
  const pageUrl = page?.url || '';
  const minted = await service.solveTokenTask({
    provider: challenge.provider, sitekey: challenge.sitekey, pageUrl,
  }).catch(error => ({ ok: false, detail: error.message }));
  if (!minted.ok) return { outcome: 'failed', method: 'service', detail: minted.detail };

  const fieldsSet = await ctx.channel.evaluateValue(
    tokenInjectionExpression(challenge.provider, minted.token)).catch(() => 0);
  if (!fieldsSet) return { outcome: 'failed', method: 'service', detail: 'no response field accepted the token' };

  const resolved = await ctx.waitForResolution(8000, async () => { await ctx.probeDom().catch(() => null); });
  return resolved
    ? { outcome: 'solved', method: 'service', detail: 'token injected and confirmed by the tracker' }
    : { outcome: 'failed', method: 'service', detail: 'token injected but the challenge did not resolve' };
}
