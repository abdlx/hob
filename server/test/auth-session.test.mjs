import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { createApp } from '../app.mjs';

const DAY = 86400_000;
const password = 'synthetic-password', secret = 'synthetic-session-secret';
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];
const payloadOf = cookie => JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url'));
async function fixture(t, options = {}) {
  let now = Date.now();
  const gateway = new EventEmitter(); gateway.connected = true; gateway.request = async () => ({});
  const app = createApp({ gateway, password, sessionSecret: secret, sessionNow: () => now, ...options });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  const origin = `http://127.0.0.1:${app.address().port}`;
  const call = (path, cookie, value, headers = {}) => fetch(origin + path, {
    method: value ? 'POST' : 'GET', redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(value ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  return { call, origin, now: () => now, advance: days => { now += days * DAY; }, login: () => call('/api/auth/login', null, { password }) };
}

test('browser sessions last 30 days and active sessions renew in their last week', async t => {
  const app = await fixture(t, { publicUrl: 'https://hob.example' });
  const login = await app.login(), cookie = cookieOf(login);
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000; Secure/);
  assert.equal(payloadOf(cookie).exp, app.now() + 30 * DAY);
  app.advance(2);
  let response = await app.call('/api/auth/status', cookie);
  assert.equal((await response.json()).authenticated, true);
  assert.equal(response.headers.get('set-cookie'), null);
  app.advance(22);
  response = await app.call('/api/runtime', cookie);
  assert.equal(response.status, 200);
  const renewed = cookieOf(response);
  assert.equal(payloadOf(renewed).exp, app.now() + 30 * DAY);
  app.advance(7);
  assert.equal((await (await app.call('/api/auth/status', cookie)).json()).authenticated, false);
  assert.equal((await (await app.call('/api/auth/status', renewed)).json()).authenticated, true);
  app.advance(24);
  response = await app.call('/api/auth/status', renewed);
  assert.equal((await response.json()).authenticated, false);
  assert.equal(response.headers.get('set-cookie'), null, 'expired cookies cannot renew');
});

test('active legacy one-day cookies upgrade, while forged cookies and changed passwords stay invalid', async t => {
  const app = await fixture(t);
  const fingerprint = createHash('sha256').update(`${password}:`).digest('base64url');
  const payload = Buffer.from(JSON.stringify({ fp: fingerprint, exp: app.now() + DAY })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  const legacy = `hob_session=${payload}.${signature}`;
  const response = await app.call('/api/auth/status', legacy);
  assert.equal((await response.json()).authenticated, true);
  assert.equal(payloadOf(cookieOf(response)).exp, app.now() + 30 * DAY);
  for (const invalid of [`${legacy}tampered`, `${legacy}.extra`]) {
    const rejected = await app.call('/api/auth/status', invalid);
    assert.equal((await rejected.json()).authenticated, false);
    assert.equal(rejected.headers.get('set-cookie'), null);
  }
  const changed = await fixture(t, { password: 'changed-password' });
  assert.equal((await (await changed.call('/api/auth/status', cookieOf(response))).json()).authenticated, false);
  const logout = await app.call('/api/auth/logout', legacy, {});
  assert.match(logout.headers.get('set-cookie'), /hob_session=;.*Max-Age=0/);
});

test('mobile bootstrap cookies last up to device expiry and revocation still ends access', async t => {
  const app = await fixture(t);
  const enrollment = await (await app.call('/api/mobile/login', null, { password, deviceName: 'Test phone' })).json();
  const headers = { Authorization: `Bearer ${enrollment.token}` };
  const bootstrap = async () => {
    const session = await (await app.call('/api/mobile/session', null, {}, headers)).json();
    return fetch(app.origin + '/api/mobile/bootstrap', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket: session.ticket }) });
  };
  const response = await bootstrap(), cookie = cookieOf(response);
  assert.equal(response.status, 303);
  assert.equal(payloadOf(cookie).exp, enrollment.expiresAt);
  assert.match(response.headers.get('set-cookie'), /Max-Age=2592000/);
  app.advance(24);
  const status = await app.call('/api/auth/status', cookie);
  assert.equal((await status.json()).authenticated, true);
  assert.equal(status.headers.get('set-cookie'), null, 'renewal cannot extend device enrollment');
  const later = await bootstrap();
  assert.equal(payloadOf(cookieOf(later)).exp, enrollment.expiresAt);
  const revoked = await fetch(app.origin + '/api/mobile/device', { method: 'DELETE', headers });
  assert.equal(revoked.status, 200);
  assert.equal((await (await app.call('/api/auth/status', cookie)).json()).authenticated, false);
});
