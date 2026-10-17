const SECRET = /(?:api[_-]?keys?(?:[_-]?preview)?|passwords?|tokens?|secrets?|credentials?|private[_-]?keys?|^key$|^authorization$|^proxy-authorization$|^cookies?$|^set-cookie$)$/i;
export const STORED_SECRET = '[stored credential]';

export function redactHermesSettings(value) {
  if (Array.isArray(value)) return value.map(redactHermesSettings);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    SECRET.test(key) && item && (typeof item === 'string' || typeof item === 'object')
      ? STORED_SECRET : redactHermesSettings(item)]));
}

export function containsStoredSecret(value) {
  if (value === STORED_SECRET) return true;
  if (Array.isArray(value)) return value.some(containsStoredSecret);
  return value && typeof value === 'object' ? Object.values(value).some(containsStoredSecret) : false;
}
