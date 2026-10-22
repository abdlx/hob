// Exact-coordinate mouse and keyboard input for the agent.
//
// These are gateway methods, not Chromium CDP methods: `Hob.input.*` is
// intercepted before forwarding, executed on the page the agent is attached to,
// and answered with the element that was actually hit. A click can therefore be
// verified against the element the caller expected before any button is pressed,
// which is what makes "click at (x, y)" safe to automate rather than a blind
// coordinate guess.

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };
const MAX_TEXT = 100000;
const MAX_STEPS = 120;

export class PrecisionError extends Error {
  constructor(message, { hit = null } = {}) {
    super(message);
    this.name = 'PrecisionError';
    this.hit = hit;
  }
}

const finite = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new PrecisionError(`'${name}' must be a finite number.`);
  return number;
};

const integer = (value, name, { min, max, fallback }) => {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new PrecisionError(`'${name}' must be an integer between ${min} and ${max}.`);
  }
  return number;
};

const point = (params, name) => {
  const source = params && typeof params === 'object' ? params : {};
  return { x: finite(source.x, `${name}.x`), y: finite(source.y, `${name}.y`) };
};

const button = value => {
  const name = String(value ?? 'left').toLowerCase();
  if (!(name in BUTTON_MASK)) throw new PrecisionError(`'button' must be one of ${Object.keys(BUTTON_MASK).join(', ')}.`);
  return name;
};

const modifiers = value => integer(value, 'modifiers', { min: 0, max: 15, fallback: 0 });

const stripTags = html => String(html ?? '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ')
  .trim();

const attributes = list => {
  const values = {};
  if (!Array.isArray(list)) return values;
  for (let index = 0; index + 1 < list.length; index += 2) values[String(list[index])] = String(list[index + 1]);
  return values;
};

/** The element under a viewport point, with enough detail to verify a target. */
export async function hitTest(cdp, x, y, { timeoutMs = 5000 } = {}) {
  // The DOM domain is not enabled by default on a fresh page-bound connection;
  // without it getNodeForLocation returns no node for an otherwise hit-testable
  // point.
  await cdp.send('DOM.enable', {}, { timeoutMs }).catch(() => undefined);
  let located;
  try {
    located = await cdp.send('DOM.getNodeForLocation', {
      x: Math.floor(x), y: Math.floor(y), includeUserAgentShadowDOM: true,
    }, { timeoutMs });
  } catch (error) {
    throw new PrecisionError(`Could not inspect the element at (${x}, ${y}): ${error.message}`);
  }
  if (!located?.backendNodeId) throw new PrecisionError(`No element was found at (${x}, ${y}).`);

  const described = await cdp.send('DOM.describeNode', { backendNodeId: located.backendNodeId, depth: 0 }, { timeoutMs });
  const node = described?.node ?? {};
  const attrs = attributes(node.attributes);

  let box = null;
  try {
    const model = await cdp.send('DOM.getBoxModel', { backendNodeId: located.backendNodeId }, { timeoutMs });
    const quad = model?.model?.border ?? model?.model?.content;
    if (Array.isArray(quad) && quad.length >= 8) {
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const left = Math.min(...xs); const top = Math.min(...ys);
      box = { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
    }
  } catch { /* the box is useful metadata, never a reason to fail a hit test */ }

  let text = '';
  let ownText = '';
  try {
    const { outerHTML } = await cdp.send('DOM.getOuterHTML', { backendNodeId: located.backendNodeId }, { timeoutMs });
    text = stripTags(outerHTML).slice(0, 160);
    // Text directly inside this element, never its descendants. Without this, a
    // point over <html> would "match" every string on the page.
    ownText = stripTags(String(outerHTML).match(/^<[^>]*>([\s\S]*?)</)?.[1] ?? '').slice(0, 160);
  } catch { /* text is optional */ }

  return {
    tag: String(node.localName || node.nodeName || '').toLowerCase(),
    id: attrs.id || null,
    className: attrs.class || null,
    role: attrs.role || null,
    text,
    ownText,
    box,
    backendNodeId: located.backendNodeId,
  };
}

/** Whether a hit test satisfies the caller's expected target. */
export function hitMatches(hit, expected) {
  if (expected === undefined || expected === null) return true;
  if (typeof expected === 'string') {
    const haystack = [hit.tag, hit.id, hit.className, hit.role, hit.ownText ?? hit.text].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(expected.toLowerCase());
  }
  if (typeof expected !== 'object') return false;
  if (expected.tag && String(expected.tag).toLowerCase().replace(/^</, '').replace(/>$/, '') !== hit.tag) return false;
  if (expected.id !== undefined && expected.id !== null && String(expected.id) !== String(hit.id ?? '')) return false;
  if (expected.role && String(expected.role).toLowerCase() !== String(hit.role ?? '').toLowerCase()) return false;
  if (expected.text && !String(hit.ownText ?? hit.text ?? '').toLowerCase().includes(String(expected.text).toLowerCase())) return false;
  return true;
}

const describeHit = hit => `<${hit.tag}${hit.id ? `#${hit.id}` : ''}${hit.text ? `> "${hit.text}"` : '>'}`;

async function verifyPoint(cdp, x, y, expected, timeoutMs) {
  const hit = await hitTest(cdp, x, y, { timeoutMs });
  if (!hitMatches(hit, expected)) {
    throw new PrecisionError(
      `Point (${x}, ${y}) hit ${describeHit(hit)}, which does not match ${JSON.stringify(expected)}.`,
      { hit },
    );
  }
  return hit;
}

async function mouse(cdp, params, hooks, timeoutMs) {
  if (hooks.signal?.aborted) throw new PrecisionError('Precision input was cancelled.');
  await cdp.send('Input.dispatchMouseEvent', params, { timeoutMs });
  return hooks.onInput?.('Input.dispatchMouseEvent', params);
}

async function key(cdp, params, hooks, timeoutMs) {
  if (hooks.signal?.aborted) throw new PrecisionError('Precision input was cancelled.');
  await cdp.send('Input.dispatchKeyEvent', params, { timeoutMs });
  return hooks.onInput?.('Input.dispatchKeyEvent', params);
}

const sleep = delayMs => new Promise(resolve => setTimeout(resolve, delayMs));

// Named keys and their Windows virtual-key codes. Printable characters are
// generated on demand; this table only covers keys that have no character.
const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};
for (let index = 1; index <= 12; index += 1) {
  KEYS[`f${index}`] = { key: `F${index}`, code: `F${index}`, keyCode: 111 + index };
}

function keyDefinition(name) {
  const named = KEYS[name.toLowerCase()];
  if (named) return named;
  if ([...name].length !== 1) {
    throw new PrecisionError(`Unknown key '${name}'. Use a single character, a named key, or a modifier combination.`);
  }
  const upper = name.toUpperCase();
  const digit = /^[0-9]$/.test(name);
  return {
    key: name,
    code: digit ? `Digit${name}` : (/^[a-z]$/i.test(name) ? `Key${upper}` : ''),
    keyCode: upper.charCodeAt(0),
    text: name,
  };
}

function parseKey(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new PrecisionError("'key' must be a non-empty string.");
  const parts = value.split('+').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new PrecisionError("'key' must be a non-empty string.");
  let flags = 0;
  for (const part of parts.slice(0, -1)) {
    switch (part.toLowerCase()) {
      case 'alt': flags |= 1; break;
      case 'control': case 'ctrl': flags |= 2; break;
      case 'meta': case 'cmd': case 'command': flags |= 4; break;
      case 'shift': flags |= 8; break;
      default: throw new PrecisionError(`Unknown modifier '${part}'.`);
    }
  }
  const definition = keyDefinition(parts.at(-1));
  return { definition, modifiers: flags };
}

// Characters a US keyboard produces when Shift is held with a printable key.
const SHIFTED = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '`': '~', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
};

async function move(cdp, params, hooks, timeoutMs) {
  const { x, y } = point(params, 'point');
  const flags = modifiers(params.modifiers);
  await mouse(cdp, { type: 'mouseMoved', x, y, button: 'none', buttons: 0, modifiers: flags }, hooks, timeoutMs);
  return { ok: true, action: 'move', x, y };
}

async function click(cdp, params, hooks, timeoutMs) {
  const { x, y } = point(params, 'point');
  const name = button(params.button);
  const mask = BUTTON_MASK[name];
  const count = integer(params.clickCount, 'clickCount', { min: 1, max: 3, fallback: 1 });
  const flags = modifiers(params.modifiers);
  const delayMs = integer(params.delayMs, 'delayMs', { min: 0, max: 5000, fallback: 0 });
  const verify = params.verify !== false || params.expected !== undefined;
  const hit = verify ? await verifyPoint(cdp, x, y, params.expected, timeoutMs) : null;

  await mouse(cdp, { type: 'mouseMoved', x, y, button: 'none', buttons: 0, modifiers: flags }, hooks, timeoutMs);
  for (let index = 1; index <= count; index += 1) {
    await mouse(cdp, { type: 'mousePressed', x, y, button: name, buttons: mask, clickCount: index, modifiers: flags }, hooks, timeoutMs);
    if (delayMs > 0) await sleep(delayMs);
    await mouse(cdp, { type: 'mouseReleased', x, y, button: name, buttons: 0, clickCount: index, modifiers: flags }, hooks, timeoutMs);
  }
  return { ok: true, action: 'click', x, y, button: name, clicks: count, hit };
}

async function drag(cdp, params, hooks, timeoutMs) {
  const from = point(params.from, 'from');
  const to = point(params.to, 'to');
  const name = button(params.button);
  const mask = BUTTON_MASK[name];
  const flags = modifiers(params.modifiers);
  const steps = integer(params.steps, 'steps', { min: 1, max: MAX_STEPS, fallback: 12 });
  const verify = params.verify === true || params.expected !== undefined;
  const hit = verify ? await verifyPoint(cdp, from.x, from.y, params.expected, timeoutMs) : null;

  await mouse(cdp, { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, modifiers: flags }, hooks, timeoutMs);
  await mouse(cdp, { type: 'mousePressed', x: from.x, y: from.y, button: name, buttons: mask, clickCount: 1, modifiers: flags }, hooks, timeoutMs);
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const x = from.x + (to.x - from.x) * progress;
    const y = from.y + (to.y - from.y) * progress;
    await mouse(cdp, { type: 'mouseMoved', x, y, button: name, buttons: mask, modifiers: flags }, hooks, timeoutMs);
  }
  await mouse(cdp, { type: 'mouseReleased', x: to.x, y: to.y, button: name, buttons: 0, clickCount: 1, modifiers: flags }, hooks, timeoutMs);
  return { ok: true, action: 'drag', from, to, button: name, steps, hit };
}

async function type(cdp, params, hooks, timeoutMs) {
  if (typeof params.text !== 'string') throw new PrecisionError("'text' must be a string.");
  if (params.text.length > MAX_TEXT) throw new PrecisionError(`'text' is limited to ${MAX_TEXT} characters.`);
  if (params.x !== undefined || params.y !== undefined) {
    await click(cdp, { ...params, text: undefined, clickCount: 1, delayMs: 0 }, hooks, timeoutMs);
  }
  if (params.replace === true) {
    await key(cdp, { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] }, hooks, timeoutMs);
    await key(cdp, { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, hooks, timeoutMs);
  }
  await cdp.send('Input.insertText', { text: params.text }, { timeoutMs });
  if (hooks.onInput?.('Input.insertText', { text: params.text })) hooks.onTyping?.();
  return { ok: true, action: 'type', chars: params.text.length, replaced: params.replace === true };
}

async function press(cdp, params, hooks, timeoutMs) {
  const { definition, modifiers: flags } = parseKey(params.key);
  const shift = (flags & 8) !== 0;
  const shiftText = shift && definition.text ? (SHIFTED[definition.text] ?? definition.text.toUpperCase()) : definition.text;
  const keyName = shift && definition.key.length === 1 ? (SHIFTED[definition.key] ?? definition.key.toUpperCase()) : definition.key;
  const text = flags & (1 | 2 | 4) ? undefined : shiftText;
  const down = {
    type: text ? 'keyDown' : 'rawKeyDown',
    key: keyName,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    modifiers: flags,
  };
  if (text) down.text = text;
  if (params.commands) down.commands = params.commands;
  const sample = await key(cdp, down, hooks, timeoutMs);
  await key(cdp, { type: 'keyUp', key: keyName, code: definition.code, windowsVirtualKeyCode: definition.keyCode, modifiers: flags }, hooks, timeoutMs);
  if (sample) hooks.onTyping?.();
  return { ok: true, action: 'key', key: keyName, modifiers: flags };
}

async function scroll(cdp, params, hooks, timeoutMs) {
  const { x, y } = point(params, 'point');
  const deltaY = finite(params.deltaY ?? 0, 'deltaY');
  const deltaX = finite(params.deltaX ?? 0, 'deltaX');
  const flags = modifiers(params.modifiers);
  await mouse(cdp, { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: flags }, hooks, timeoutMs);
  return { ok: true, action: 'scroll', x, y, deltaX, deltaY };
}

async function inspect(cdp, params, timeoutMs) {
  const { x, y } = point(params, 'point');
  const hit = await hitTest(cdp, x, y, { timeoutMs });
  return { ok: true, action: 'hitTest', x, y, hit, matches: hitMatches(hit, params.expected) };
}

const ACTIONS = {
  'Hob.input.move': move,
  'Hob.input.click': click,
  'Hob.input.drag': drag,
  'Hob.input.type': type,
  'Hob.input.key': press,
  'Hob.input.scroll': scroll,
  'Hob.input.hitTest': inspect,
};

/** The methods and their parameters, for discovery by the agent. */
export function precisionHelp() {
  return {
    ok: true,
    note: 'Coordinates are viewport CSS pixels. Call these through browser_cdp; they execute on the page the CDP session is attached to.',
    methods: {
      'Hob.input.move': { x: 'number', y: 'number', modifiers: 'optional bitmask' },
      'Hob.input.click': {
        x: 'number', y: 'number', button: 'left|right|middle', clickCount: '1-3',
        modifiers: 'optional bitmask', delayMs: 'optional press-to-release hold', verify: 'default true',
        expected: 'optional string or { tag, id, role, text } the hit element must match',
      },
      'Hob.input.drag': {
        from: '{ x, y }', to: '{ x, y }', button: 'left|right|middle', steps: '1-120',
        modifiers: 'optional bitmask', verify: 'optional start-point verification', expected: 'optional verifier',
      },
      'Hob.input.type': {
        text: 'string', x: 'optional click first', y: 'optional click first',
        replace: 'select all before inserting', verify: 'applies to the optional click',
      },
      'Hob.input.key': { key: 'Enter, Tab, Escape, a, Control+a, Shift+ArrowDown, ...', commands: 'optional CDP editing commands' },
      'Hob.input.scroll': { x: 'number', y: 'number', deltaY: 'number', deltaX: 'optional number' },
      'Hob.input.hitTest': { x: 'number', y: 'number', expected: 'optional verifier' },
    },
  };
}

export function isPrecisionMethod(method) { return typeof method === 'string' && method.startsWith('Hob.input.'); }

/** Execute one `Hob.input.*` action against a page-level CDP connection. */
export async function runPrecisionMethod(cdp, method, params, hooks = {}) {
  if (method === 'Hob.input.help') return precisionHelp();
  const action = ACTIONS[method];
  if (!action) throw new PrecisionError(`Unknown precision method '${method}'. Use Hob.input.help for the list.`);
  const values = params && typeof params === 'object' ? params : {};
  const timeoutMs = integer(values.timeoutMs, 'timeoutMs', { min: 500, max: 30000, fallback: 5000 });
  return action(cdp, values, hooks, timeoutMs);
}
