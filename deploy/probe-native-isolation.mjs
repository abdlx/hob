import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { isolationRequest } from '../server/hermes-isolation.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.env.HOB_SMOKE_NATIVE_ISOLATION, '1', 'Disposable smoke flag required.');
const profile = process.env.HOB_NATIVE_ISOLATION_PROFILE;
assert.match(profile || '', /^native-isolation-[a-f0-9]{12}$/);
const status = await isolationRequest('status');
assert.equal(process.getuid(), status.operatorUid);
const owners = await Promise.all(['default', profile].map(name => isolationRequest('ensure', name)));
const result = execFileSync('/opt/hermes/.venv/bin/python', ['/app/deploy/probe-native-isolation.py'], {
  input: JSON.stringify(owners), timeout: 180000, maxBuffer: 1024 * 1024,
  env: { ...process.env, HERMES_HOME: '/opt/data', PYTHONPATH: '/opt/hermes' },
  encoding: 'utf8', windowsHide: true,
});
process.stdout.write(result);
