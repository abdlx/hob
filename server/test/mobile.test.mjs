import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.mjs';
import { MobileDevices } from '../mobile-devices.mjs';

const pushToken = 'ExponentPushToken[synthetic_private_token_123456]';
test('discovery precedes password login, mobile sessions bootstrap cookies once, and disconnect revokes both', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'hob-mobile-http-'));
  const gateway = new EventEmitter(); gateway.connected = true; gateway.request = async () => ({});
  const app = createApp({ gateway, password: 'test-password', stateDir });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await rm(stateDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.address().port}`;
  const call = (route, method = 'GET', value, token) => fetch(origin + route, { method, redirect: 'manual', headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });
  const info = await (await call('/api/mobile/discovery')).json(); assert.equal(info.app, 'hob'); assert.equal(info.protocol, 1);
  assert.equal((await call('/api/mobile/device')).status, 401);
  assert.equal((await call('/api/mobile/login', 'POST', { password: 'wrong' })).status, 401);
  assert.equal((await fetch(origin + '/api/mobile/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.invalid' }, body: JSON.stringify({ password: 'test-password' }) })).status, 403);
  const login = await (await call('/api/mobile/login', 'POST', { password: 'test-password', deviceName: 'Test phone' })).json();
  assert.equal(login.instanceId, info.instanceId); assert.match(login.token, /^hobm_[a-f0-9]{64}$/);
  const status = await (await call('/api/mobile/device', 'GET', undefined, login.token)).json();
  assert.equal(status.pushEnabled, false); assert.equal(JSON.stringify(status).includes(login.token), false);
  const bootstrap = await (await call('/api/mobile/session', 'POST', undefined, login.token)).json();
  const enter = () => fetch(origin + '/api/mobile/bootstrap', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket: bootstrap.ticket }) });
  const entered = await enter(); assert.equal(entered.status, 303); assert.equal(entered.headers.get('location'), '/chat?mobile=1');
  const cookie = entered.headers.get('set-cookie').split(';')[0]; assert.match(entered.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await enter()).status, 401);
  assert.equal((await fetch(origin + '/api/auth/status', { headers: { Cookie: cookie } }).then(res => res.json())).authenticated, true);
  const registered = await (await call('/api/mobile/device/push', 'PUT', { pushToken }, login.token)).json();
  assert.equal(registered.pushEnabled, true); assert.equal(JSON.stringify(registered).includes(pushToken), false);
  assert.equal((await call('/api/mobile/device', 'DELETE', undefined, login.token)).status, 200);
  assert.equal((await call('/api/mobile/device', 'GET', undefined, login.token)).status, 401);
  assert.equal((await fetch(origin + '/api/auth/status', { headers: { Cookie: cookie } }).then(res => res.json())).authenticated, false);
});

test('mobile keys are hashed and persist; old passwords invalidate mobile sessions', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'hob-mobile-state-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let store = new MobileDevices({ stateDir, fingerprint: 'original' });
  const session = store.login('Phone'), instanceId = store.instanceId;
  assert.equal(store.authenticate(`Bearer ${session.token}`), session.deviceId);
  store.close();
  assert.equal((await readFile(path.join(stateDir, 'mobile.sqlite'))).includes(Buffer.from(session.token)), false);
  store = new MobileDevices({ stateDir, fingerprint: 'original' });
  assert.equal(store.instanceId, instanceId); assert.equal(store.authenticate(`Bearer ${session.token}`), session.deviceId); store.close();
  store = new MobileDevices({ stateDir, fingerprint: 'changed' });
  assert.equal(store.authenticate(`Bearer ${session.token}`), null); assert.equal(store.active(session.deviceId), false); store.close();
});

test('durable notification queue deduplicates completed work, excludes newly enrolled devices from history, and checks receipts without leaking text', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'hob-mobile-push-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  let now = 1000, mode = 'accepted'; const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (mode === 'offline') throw new Error('network unavailable');
    return { ok: true, text: async () => JSON.stringify({ data: url.endsWith('getReceipts') ? mode === 'pending' ? {} : { ticket: { status: 'ok' } } : [{ status: 'ok', id: 'ticket' }] }) };
  };
  let store = new MobileDevices({ stateDir, fingerprint: 'fp', now: () => now, fetchImpl });
  const phone = store.login('Phone'); store.register(phone.deviceId, pushToken); now = 2000;
  const event = { profile: 'default', sessionId: 'native-session', admissionId: 'native-admission', createdAt: now };
  store.completed(event); store.completed(event); store.close();
  store = new MobileDevices({ stateDir, fingerprint: 'fp', now: () => now, fetchImpl });
  await store.flush(); assert.equal(calls.length, 1); assert.equal(calls[0].body.length, 1);
  assert.equal(calls[0].body[0].body, 'Main has a new reply.');
  assert.deepEqual(Object.keys(calls[0].body[0].data).sort(), ['eventId', 'instanceId', 'kind', 'profile', 'sessionKey']);
  mode = 'offline'; now += 16 * 60_000; await store.flush(); assert.ok(calls[1].url.endsWith('getReceipts'));
  mode = 'pending'; now += 16 * 60_000; await store.flush(); assert.ok(calls[2].url.endsWith('getReceipts'));
  mode = 'accepted'; now += 16 * 60_000; await store.flush(); assert.ok(calls[3].url.endsWith('getReceipts'));
  assert.equal(store.status(phone.deviceId).lastPush, 'delivered-to-provider');
  now += 1000; const later = store.login('Later'); store.register(later.deviceId, 'ExpoPushToken[another_synthetic_token_1234]');
  store.completed({ ...event, admissionId: 'older-native', createdAt: 500 }); await store.flush(); assert.equal(calls.length, 4);
  store.close();
});

test('disabled, revoked and unregistered devices stop receiving queued notifications', async () => {
  let now = 10, calls = 0;
  const store = new MobileDevices({ fingerprint: 'fp', now: () => now, fetchImpl: async () => { calls++; return { ok: true, text: async () => JSON.stringify({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }) }; } });
  const phone = store.login(); store.register(phone.deviceId, pushToken); now++;
  store.completed({ profile: 'default', sessionId: 's', admissionId: 'one' }); store.register(phone.deviceId, null); await store.flush(); assert.equal(calls, 0);
  store.register(phone.deviceId, pushToken); store.completed({ profile: 'default', sessionId: 's', admissionId: 'two' }); await store.flush(); assert.equal(calls, 1); assert.equal(store.status(phone.deviceId).pushEnabled, false);
  store.register(phone.deviceId, pushToken); store.completed({ profile: 'default', sessionId: 's', admissionId: 'three' }); store.revoke(phone.deviceId); await store.flush(); assert.equal(calls, 1);
  store.close();
});
