import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInstance, notificationTarget, sameInstance, validateInstance } from '../src/connection.ts';

test('instance URLs preserve a single secure origin and reject credential-bearing or ambiguous input', () => {
  assert.equal(normalizeInstance('hob.example.com/'), 'https://hob.example.com');
  assert.equal(normalizeInstance('https://hob.example.com:8443'), 'https://hob.example.com:8443');
  for (const input of ['http://hob.example.com', 'https://user:pass@hob.example.com', 'https://hob.example.com/settings', 'https://hob.example.com?token=secret', 'javascript:alert(1)', 'https://hob.example.com#fragment', '']) assert.throws(() => normalizeInstance(input));
  assert.equal(normalizeInstance('http://10.0.2.2:3000', true), 'http://10.0.2.2:3000');
  assert.throws(() => normalizeInstance('http://192.168.1.2:3000', true));
});
test('only compatible hob discovery is accepted before password collection', () => {
  const info = { app: 'hob', protocol: 1, instanceId: 'instance', configured: true, capabilities: { attachments: true, push: true } };
  assert.equal(validateInstance(info).instanceId, 'instance');
  for (const value of [null, '<html>Website</html>', {}, { ...info, app: 'other' }, { ...info, protocol: 2 }, { ...info, configured: false }]) assert.throws(() => validateInstance(value));
});
test('navigation and notification targets cannot cross instances or turn into arbitrary URLs', () => {
  const connection = { origin: 'https://hob.example.com', token: 'private', deviceId: 'device', instanceId: 'instance', expiresAt: Date.now() + 1000 };
  assert.equal(sameInstance('https://hob.example.com/chat', connection.origin), true);
  for (const url of ['https://hob.example.com.attacker.test', 'https://user@hob.example.com', 'file:///private/key', 'javascript:alert(1)']) assert.equal(sameInstance(url, connection.origin), false);
  assert.deepEqual(notificationTarget({ instanceId: 'instance', profile: 'default', sessionKey: 'encoded-session' }, connection), { profile: 'default', sessionKey: 'encoded-session' });
  assert.equal(notificationTarget({ instanceId: 'other', profile: 'default', sessionKey: 'encoded-session' }, connection), null);
  assert.equal(notificationTarget({ instanceId: 'instance', profile: '../other', sessionKey: 'encoded-session' }, connection), null);
});
