import { HermesClient } from './hermes-client.mjs';
import { createApp } from './app.mjs';
import path from 'node:path';
import { HermesBotRegistry, HermesBots } from './hermes-bots.mjs';
import { HermesRunJournal } from './hermes-run-journal.mjs';
import { HermesSessionBridge } from './hermes-session.mjs';
import { BrowserRegistry } from './browser-registry.mjs';
import { BrowserManager } from './browser-manager.mjs';
import { cdpTransportMode } from './browser-launcher.mjs';

if (!process.env.MUSE_PASSWORD && !process.env.MUSE_ACCESS_TOKEN) {
  console.error('Set MUSE_PASSWORD or MUSE_ACCESS_TOKEN before starting hob.');
  process.exit(1);
}

// Validated once at boot, not at the first browser launch: a typo here is a
// configuration error, and the transport is what keeps the DevTools port gone.
const browserTransport = cdpTransportMode();
if (browserTransport === 'tcp') {
  console.warn('HOB_CDP_TRANSPORT=tcp: the managed browser exposes a raw loopback DevTools port '
    + 'that any local process can drive without the lease. This is a development fallback; '
    + 'leave the variable unset (pipe) in production.');
}
const clientOptions = {
  runtimeUrl: process.env.HERMES_API_URL || 'http://127.0.0.1:8642',
  dashboardUrl: process.env.HERMES_DASHBOARD_URL || 'http://127.0.0.1:8080',
  apiKey: process.env.API_SERVER_KEY,
  dashboardToken: process.env.HERMES_DASHBOARD_SESSION_TOKEN,
};
if (!process.env.HERMES_HOME || !process.env.HOB_STATE_DIR) throw new Error('Start hob through deploy/start.mjs to provision private Hermes state.');
const registry = await HermesBotRegistry.open({ stateDir: process.env.HOB_STATE_DIR, mainApiKey: process.env.API_SERVER_KEY });
// One persistent browser profile per bot. Nothing is launched here: a browser
// starts when an agent turn or a viewer actually needs one, and stops after the
// idle timeout when nobody does.
const browserRegistry = await BrowserRegistry.open({ stateDir: process.env.HOB_STATE_DIR });
const idleMs = Number(process.env.HOB_BROWSER_IDLE_MS);
const browser = await BrowserManager.open({
  registry: browserRegistry,
  stateDir: process.env.HOB_STATE_DIR,
  options: Number.isFinite(idleMs) && idleMs >= 0 ? { idleMs } : {},
});
const bots = new HermesBots({ registry, client: new HermesClient(clientOptions), workspaceRoot: path.join(process.env.HERMES_HOME, 'workspaces'), browser });
const gateway = new HermesClient({ ...clientOptions, profileAccess: profile => registry.token(profile) });
const runJournal = await HermesRunJournal.open(process.env.HOB_STATE_DIR);
const nativeSessions = new HermesSessionBridge({ profileAccess: profile => registry.token(profile) });
const server = createApp({ gateway, bots, browser, runJournal, nativeSessions, ...(process.env.MUSE_STATIC_DIR ? { staticDir: process.env.MUSE_STATIC_DIR } : {}) });
gateway.start();
server.listen(Number(process.env.MUSE_PORT || 3000), process.env.MUSE_HOST || '127.0.0.1', () => console.log(`hob listening on port ${process.env.MUSE_PORT || 3000}.`));
// The Main bot skips the per-bot setup flow, so its browser binding is seeded on
// boot instead. Best-effort: a dashboard that has not finished coming up must not
// stop hob from serving, and the binding is retried on the next boot.
void bots.configureBrowser('default')
  .then(changed => { if (changed) console.log('Pointed the Main bot at its managed browser.'); })
  .catch(error => console.warn(`Could not bind the Main bot's browser: ${error.message}`));
// A signal must finish the graceful browser stop — that close is what flushes cookies
// and storage to the profile — but it must also finish inside the supervisor's window:
// `deploy/start.mjs` escalates to SIGKILL at 30 s, so wait at most 25 s and then leave.
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  nativeSessions.close();
  gateway.stop();
  server.close();
  server.closeAllConnections();
  await Promise.race([
    browser.shutdown().catch(() => undefined),
    new Promise(resolve => { setTimeout(resolve, 25000); }),
  ]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
