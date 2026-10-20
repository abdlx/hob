// Translate Atrium viewer input into Chrome DevTools Protocol input commands.
//
// The Atrium viewer sends the DOM-level facts it has (`key`, `code`, pointer
// coordinates already mapped into remote-viewport space) and deliberately does
// not know about CDP. This module is the only place that knows both, so the
// viewer stays a plain browser UI and the gateway keeps every CDP detail.
//
// Modifier state is tracked here because the viewer never sends a modifier
// bitmask: CDP wants one, and deriving it from the key stream is the only
// correct source (a held Shift must apply to the *next* key too).

const VK = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, Space: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38,
  ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119,
  F9: 120, F10: 121, F11: 122, F12: 123,
};

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function modifierOf(code) {
  const match = /^(Alt|Control|Meta|Shift)(Left|Right)$/.exec(code || '');
  return match ? match[1] : null;
}

/** Track which modifiers are currently held so CDP gets an accurate bitmask. */
export class ModifierState {
  #held = new Set();

  update(type, code) {
    const modifier = modifierOf(code);
    if (!modifier) return;
    if (type === 'down') this.#held.add(modifier); else this.#held.delete(modifier);
  }

  get mask() {
    let mask = 0;
    for (const modifier of this.#held) mask |= MODIFIER_BITS[modifier];
    return mask;
  }

  releaseAll() { this.#held.clear(); }
}

/**
 * One viewer key event → zero or one CDP `Input.dispatchKeyEvent` params.
 * `type` is the viewer's `down`/`up`.
 */
export function keyEventParams({ type, key, code }, modifiers) {
  if (typeof key !== 'string' || key === '') return null;
  const down = type === 'down';
  const named = Object.prototype.hasOwnProperty.call(VK, key) ? key : null;
  const virtualKeyCode = VK[named] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const params = {
    type: down ? 'keyDown' : 'keyUp',
    key,
    code: typeof code === 'string' ? code : '',
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers,
  };
  // A printable key is only text while the "down" half happens; keyUp for
  // Enter/Space/etc. must not retype the character.
  if (down && key.length === 1) params.text = key;
  else if (down && key === 'Enter') params.text = '\r';
  else if (down && key === 'Tab') params.text = '\t';
  return params;
}

/** One viewer mouse event → CDP `Input.dispatchMouseEvent` params. */
export function mouseEventParams({ type, x, y, button }) {
  const coordinates = { x: Number(x) || 0, y: Number(y) || 0 };
  if (type === 'move') return { type: 'mouseMoved', button: 'none', buttons: 0, ...coordinates };
  const pressed = type === 'down';
  const index = Number.isInteger(button) ? button : 0;
  if (index === 2) {
    // The viewer forwards a right-click as a down/up pair with button 2; CDP
    // needs no buttons bitmask for the press itself on this path.
    return { type: pressed ? 'mousePressed' : 'mouseReleased', button: 'right', buttons: 0, clickCount: 1, ...coordinates };
  }
  return {
    type: pressed ? 'mousePressed' : 'mouseReleased',
    button: 'left',
    buttons: pressed ? 1 : 0,
    clickCount: 1,
    ...coordinates,
  };
}

/** One viewer wheel event → CDP `Input.dispatchMouseEvent` params. */
export function wheelEventParams({ deltaX, deltaY }, position) {
  return {
    type: 'mouseWheel',
    button: 'none',
    buttons: 0,
    x: Number(position?.x) || 0,
    y: Number(position?.y) || 0,
    deltaX: Number(deltaX) || 0,
    deltaY: Number(deltaY) || 0,
  };
}

const TEXT_TYPES = new Set(['char', 'keyDown', 'keyUp', 'rawKeyDown']);
const NON_INSERTABLE = new Set(['Backspace', 'Delete', 'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Translate one `{t:'input'}` client message into CDP commands. Returns a list of
 * `{method, params}` in order; an empty list means "nothing to do".
 *
 * `clipboard` is intentionally not a `Clipboard.*` CDP domain call: browsers gate
 * that domain to a focused, secure context, which a headless screencast is not.
 * A paste becomes literal text insertion, and a copy is answered by the gateway
 * reading the current selection (see `BrowserGateway`).
 */
export function inputCommands(message, { modifiers, viewport, lastPointer }) {
  const { kind, payload = {} } = message;
  if (kind === 'mouse') {
    const params = mouseEventParams(payload);
    return [{ method: 'Input.dispatchMouseEvent', params, pointer: { x: params.x, y: params.y } }];
  }
  if (kind === 'wheel') {
    return [{ method: 'Input.dispatchMouseEvent', params: wheelEventParams(payload, lastPointer) }];
  }
  if (kind === 'key') {
    const params = keyEventParams(payload, modifiers.mask);
    if (!params) return [];
    if (!TEXT_TYPES.has(params.type)) return [];
    return [{ method: 'Input.dispatchKeyEvent', params }];
  }
  if (kind === 'clipboard') {
    const action = String(payload.action || '');
    if (action !== 'paste') return [];
    const text = typeof payload.text === 'string' ? payload.text : '';
    const chunks = text ? [text] : [];
    return chunks.slice(0, 1).map(value => ({ method: 'Input.insertText', params: { text: value.slice(0, 100000) } }));
  }
  if (kind === 'ime') return [];
  return [];
}

export { NON_INSERTABLE };
