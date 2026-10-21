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
const enrolledBots = new Set(registry.list().map(bot => bot.name));
for (const record of browserRegistry.list()) {
  if (!enrolledBots.has(record.bot)) await browserRegistry.remove(record.bot);
}
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
// Bind every active bot on boot, not just the ones this process created. Bots
// that predate the managed browser (and bots whose setup-time binding failed)
// otherwise drive a throwaway Hermes browser while the dashboard watches an idle
// HOB one. Best-effort with a short backoff: the dashboard may still be coming
// up, and a bot must never be blocked from serving because of that.
const bindBrowsers = async (attempt = 1) => {
  let result;
  try { result = await bots.reconcileBrowsers(); }
  catch (error) { result = { configured: [], unchanged: [], failed: [{ name: '*', error: error.message }] }; }
  if (result.configured.length) {
    console.log(`Pointed ${result.configured.length === 1 ? 'a bot' : `${result.configured.length} bots`} at their managed browsers: ${result.configured.join(', ')}.`);
  }
  if (!result.failed.length) return;
  const detail = result.failed.map(item => `${item.name}: ${item.error}`).join('; ');
  if (attempt >= 5) { console.warn(`Could not bind every bot's browser: ${detail}`); return; }
  const timer = setTimeout(() => void bindBrowsers(attempt + 1), attempt * 2000);
  timer.unref?.();
};
void bindBrowsers();
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
