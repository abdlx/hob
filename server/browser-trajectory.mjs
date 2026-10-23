// Human-shaped input trajectories for the precision layer.
//
// CDP input does not have to move like a person, and by default it does not:
// a synthetic click teleports the pointer from wherever it was to the target
// in zero milliseconds and presses instantly. Behavioural challenge systems
// (Phase 3 of the CAPTCHA plan) score exactly that. This module plans pointer
// paths and key timings with the statistical shape of a hand — curved,
// ease-in/ease-out, slightly wrong before it is right — as pure functions, so
// the precision layer can dispatch them and tests can pin their distributions
// with a seeded RNG.
//
// Nothing here dispatches anything. Planning is pure; `browser-precision.mjs`
// owns the CDP side.

/** Deterministic RNG (mulberry32) so trajectory tests are reproducible. */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function bezierSegment(from, to, { rng, durationMs }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // Perpendicular bow: a hand rarely travels the straight line. The bow
  // scales with distance and can fall on either side.
  const nx = dist > 0 ? -dy / dist : 0;
  const ny = dist > 0 ? dx / dist : 0;
  const bow1 = (rng() * 2 - 1) * 0.16 * dist;
  const bow2 = (rng() * 2 - 1) * 0.16 * dist;
  const p1 = { x: from.x + dx * (0.25 + rng() * 0.15) + nx * bow1, y: from.y + dy * (0.25 + rng() * 0.15) + ny * bow1 };
  const p2 = { x: from.x + dx * (0.6 + rng() * 0.2) + nx * bow2, y: from.y + dy * (0.6 + rng() * 0.2) + ny * bow2 };
  const steps = clamp(Math.round(durationMs / 16), 6, 60);
  const samples = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = easeInOut(i / steps);
    const point = cubicBezier(from, p1, p2, to, t);
    samples.push({ x: point.x, y: point.y, atMs: Math.round((i / steps) * durationMs) });
  }
  return samples;
}

/**
 * Plan a pointer path from `from` to `to`.
 * Returns `[{ x, y, atMs }]` — positions with cumulative timing. The first
 * sample is `from`, the last is exactly `to`. Long moves overshoot the target
 * slightly and correct, the way a fast hand does.
 */
export function planPointerPath(from, to, { rng = Math.random, overshoot = true } = {}) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 2) return [{ x: from.x, y: from.y, atMs: 0 }, { x: to.x, y: to.y, atMs: 60 + Math.round(rng() * 60) }];
  const totalMs = clamp(150 + dist * 0.5 + rng() * 130, 180, 1150);

  let samples;
  if (overshoot && dist > 500) {
    const ux = (to.x - from.x) / dist;
    const uy = (to.y - from.y) / dist;
    const past = { x: to.x + ux * dist * (0.02 + rng() * 0.03), y: to.y + uy * dist * (0.02 + rng() * 0.03) };
    const legMs = totalMs * 0.72;
    const leg1 = bezierSegment(from, past, { rng, durationMs: legMs });
    const leg2 = bezierSegment(past, to, { rng, durationMs: totalMs - legMs });
    samples = leg1.concat(leg2.slice(1).map(s => ({ ...s, atMs: s.atMs + Math.round(legMs) })));
  } else {
    samples = bezierSegment(from, to, { rng, durationMs: totalMs });
  }
  // Sub-pixel jitter on the middle of the path only: endpoints stay exact,
  // because the precision layer hit-tests the final position.
  for (let i = 1; i < samples.length - 1; i += 1) {
    samples[i] = { ...samples[i], x: samples[i].x + (rng() * 2 - 1) * 0.7, y: samples[i].y + (rng() * 2 - 1) * 0.7 };
  }
  const last = samples[samples.length - 1];
  samples[samples.length - 1] = { x: to.x, y: to.y, atMs: last.atMs };
  samples[0] = { x: from.x, y: from.y, atMs: 0 };
  return samples;
}

/** Hover dwell before a press, and how long the button stays down. */
export function planPressTiming({ rng = Math.random } = {}) {
  return {
    dwellBeforeMs: Math.round(60 + rng() * 170),
    holdMs: Math.round(45 + rng() * 90),
  };
}

/**
 * Per-character typing delays (the delay *before* each character, ms).
 * Words come in bursts; spaces and sentence ends cost a beat; occasionally
 * the typist thinks. Returns one delay per character of `text`.
 */
export function planKeyTimings(text, { rng = Math.random } = {}) {
  const delays = [];
  let prev = '';
  for (let i = 0; i < text.length; i += 1) {
    let delay = 50 + rng() * 85;
    if (i === 0) delay = 90 + rng() * 220;
    else if (prev === ' ') delay *= 1.5 + rng() * 0.9;
    else if ('.,!?;:'.includes(prev)) delay *= 1.8 + rng() * 1.2;
    if (rng() < 0.035) delay += 260 + rng() * 280; // thinking pause
    delays.push(Math.round(delay));
    prev = text[i];
  }
  return delays;
}

/**
 * Split a wheel scroll into eased human steps: `[{ deltaY, delayMs }]`
 * summing exactly to the requested `deltaY`.
 */
export function planScrollSteps(deltaY, { rng = Math.random } = {}) {
  const total = Math.round(deltaY);
  if (total === 0) return [];
  const count = clamp(Math.round(Math.abs(total) / 110) + 2, 3, 8);
  const weights = [];
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const w = 0.55 + Math.sin((i / (count - 1)) * Math.PI) + rng() * 0.3; // slow-fast-slow
    weights.push(w); sum += w;
  }
  const steps = [];
  let assigned = 0;
  for (let i = 0; i < count; i += 1) {
    const isLast = i === count - 1;
    const dy = isLast ? total - assigned : Math.round((weights[i] / sum) * total);
    assigned += dy;
    steps.push({ deltaY: dy, delayMs: Math.round(28 + rng() * 65) });
  }
  return steps;
}
