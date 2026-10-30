import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('team model execution guards deny before physical HTTP requests', async t => {
  try {
    try { await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import httpx'], { windowsHide: true }); }
    catch (error) { if (error.code === 'ENOENT' || /No module named 'httpx'/.test(error.stderr || '')) { t.skip('Python/httpx unavailable; native image probe is mandatory'); return; } throw error; }
    await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', [fileURLToPath(new URL('./test-team-execution.py', import.meta.url))], { timeout: 30000, windowsHide: true });
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('Python unavailable'); return; }
    throw error;
  }
});
