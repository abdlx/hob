const MIN_DISTANCE = 12;
const MAX_STEPS = 36;
const MAX_DURATION_MS = 650;

const finite = value => Number.isFinite(Number(value));
const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));

function pointOnCurve(start, control1, control2, end, t) {
  const inverse = 1 - t;
  const startWeight = inverse ** 3;
  const firstWeight = 3 * inverse ** 2 * t;
  const secondWeight = 3 * inverse * t ** 2;
  const endWeight = t ** 3;
  return {
    x: startWeight * start.x + firstWeight * control1.x + secondWeight * control2.x + endWeight * end.x,
    y: startWeight * start.y + firstWeight * control1.y + secondWeight * control2.y + endWeight * end.y,
  };
}

export function humanizedMouseMove(from, params, { viewport, random = Math.random } = {}) {
  if (!from || !finite(from.x) || !finite(from.y) || !finite(params?.x) || !finite(params?.y)) {
    return [{ params, delayMs: 0 }];
  }
  const start = { x: Number(from.x), y: Number(from.y) };
  const end = { x: Number(params.x), y: Number(params.y) };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance < MIN_DISTANCE) return [{ params, delayMs: 0 }];

  const steps = clamp(Math.ceil(distance / 24), 4, MAX_STEPS);
  const duration = clamp(Math.round(75 + distance * 0.45), 90, MAX_DURATION_MS);
  const perpendicular = { x: -dy / distance, y: dx / distance };
  const bend = Math.min(72, distance * 0.16) * (random() * 2 - 1);
  const control1 = {
    x: start.x + dx * (0.22 + random() * 0.12) + perpendicular.x * bend,
    y: start.y + dy * (0.22 + random() * 0.12) + perpendicular.y * bend,
  };
  const control2 = {
    x: start.x + dx * (0.68 + random() * 0.12) - perpendicular.x * bend * 0.35,
    y: start.y + dy * (0.68 + random() * 0.12) - perpendicular.y * bend * 0.35,
  };
  const maxX = finite(viewport?.w) ? Math.max(0, Number(viewport.w) - 1) : Infinity;
  const maxY = finite(viewport?.h) ? Math.max(0, Number(viewport.h) - 1) : Infinity;
  const delayMs = Math.max(4, Math.round(duration / steps));
  const result = [];

  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    const eased = progress * progress * (3 - 2 * progress);
    const point = pointOnCurve(start, control1, control2, end, eased);
    const final = index === steps;
    result.push({
      params: {
        ...params,
        x: final ? end.x : clamp(point.x, 0, maxX),
        y: final ? end.y : clamp(point.y, 0, maxY),
      },
      delayMs,
    });
  }
  return result;
}
