import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('native private retention uses scoped proposals and explicit promotion', async t => {
  if (!process.env.HOB_QUALIFIED_RUNTIME) {
    t.skip('Clean pinned runtime unavailable; the native image probe is mandatory');
    return;
  }
  await promisify(execFile)(process.env.HOB_NATIVE_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    [fileURLToPath(new URL('./test-team-retention-pinned.py', import.meta.url))], { timeout: 60000, windowsHide: true });
});
