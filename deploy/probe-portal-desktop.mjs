// Run only in a disposable Linux image, as its unprivileged runtime user.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { Store } from '../portal/src/store.mjs';
import { BrowserManager } from '../portal/src/browser.mjs';

if (process.env.HOB_SMOKE_PORTAL !== '1') throw new Error('Requires a disposable Portal smoke fixture');
const root = await mkdtemp('/tmp/hob-portal-desktop-');
process.env.HOME = root;
const store = new Store(root, { workspaceRoot: root + '/workspace' });
const profile = store.data.profiles[0];
const browser = new BrowserManager(store);
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    const display = await browser.ensureHeaded(profile);
    assert.equal(display.headed, true);
    assert.equal((await browser.status(profile)).started, true);
    await browser.close(profile);
    assert.equal((await browser.status(profile)).started, false);
  }
  console.log('DESKTOP_LAUNCH_OK: real Camoufox and TigerVNC woke and slept twice as runtime user.');
} finally {
  browser.stopIdleCleanup();
  await browser.close(profile);
}
