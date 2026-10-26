import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preference, savePreference, searchSettings, settingsSection } from '../src/services/settings-navigation.ts';
import { pluginResultMessage } from '../src/services/hermes-plugins.ts';

test('settings search discovers capabilities and safely restores a known category', () => {
  assert.ok(searchSettings('api key').some(item => item.id === 'models'));
  assert.ok(searchSettings('cron').some(item => item.id === 'automation'));
  assert.equal(settingsSection('integrations'), 'integrations');
  assert.equal(settingsSection('removed-category'), 'models');
  assert.deepEqual(searchSettings('does-not-exist'), []);
});

test('unavailable browser storage does not prevent settings or theme startup', () => {
  assert.equal(preference('theme', 'system'), 'system');
  assert.equal(savePreference('theme', 'dark'), false);
});

test('plugin feedback distinguishes installation, activation, restart and refused writes', () => {
  assert.match(pluginResultMessage('install', { ok: true }), /then enable/);
  assert.match(pluginResultMessage('enable', { ok: true, restart_required: true }), /restart is required/);
  assert.match(pluginResultMessage('update', { consent_required: true }), /Review the changes/);
  assert.throws(() => pluginResultMessage('install', { ok: false }), /did not confirm/);
  assert.throws(() => pluginResultMessage('install', {}), /did not confirm/);
});
