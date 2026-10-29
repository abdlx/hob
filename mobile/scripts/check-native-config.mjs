// Inspect Expo's generated native metadata, after all config plugins have run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''));
const native = config._internal?.modResults;
const permissions = native?.android?.manifest?.manifest?.['uses-permission'] || [];
assert.ok(permissions.some(entry => entry.$?.['android:name'] === 'android.permission.RECORD_AUDIO'), 'Android must declare microphone capture for explicit voice drafts.');
assert.ok(!permissions.some(entry => entry.$?.['android:name'] === 'android.permission.RECORD_AUDIO' && entry.$?.['tools:node'] === 'remove'), 'A config plugin must not remove microphone capture.');
assert.match(native?.ios?.infoPlist?.NSMicrophoneUsageDescription || '', /voice draft/i, 'iOS needs a microphone purpose after plugin processing.');
console.log('Generated Android and iOS microphone metadata is present. Physical permission/capture acceptance remains separate.');
