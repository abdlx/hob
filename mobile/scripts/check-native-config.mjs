// Inspect Expo's generated native metadata, after all config plugins have run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''));
const native = config._internal?.modResults;
const permissions = native?.android?.manifest?.manifest?.['uses-permission'] || [];
const application = native?.android?.manifest?.manifest?.application?.[0];
assert.equal(application?.$?.['android:enableOnBackInvokedCallback'], 'true', 'Android must enable the native back callback.');
assert.equal(application?.activity?.find(entry => entry.$?.['android:name'] === '.MainActivity')?.$?.['android:windowSoftInputMode'], 'adjustResize', 'The native composer must resize above the keyboard.');
assert.ok(permissions.some(entry => entry.$?.['android:name'] === 'android.permission.RECORD_AUDIO'), 'Android must declare microphone capture for explicit voice drafts.');
assert.ok(!permissions.some(entry => entry.$?.['android:name'] === 'android.permission.RECORD_AUDIO' && entry.$?.['tools:node'] === 'remove'), 'A config plugin must not remove microphone capture.');
assert.match(native?.ios?.infoPlist?.NSMicrophoneUsageDescription || '', /voice draft/i, 'iOS needs a microphone purpose after plugin processing.');
console.log('Native back callback, keyboard resize, and Android/iOS microphone metadata are present. Physical device acceptance remains separate.');
