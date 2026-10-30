import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('native team context contracts preserve turn boundaries and private group scope', async t => {
  try {
    await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', [fileURLToPath(new URL('./test-team-context.py', import.meta.url))], { timeout: 30000, windowsHide: true });
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('Python unavailable'); return; }
    throw error;
  }
});
