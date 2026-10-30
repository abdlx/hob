import { hobEnv } from './hob-config.mjs';
import { HermesClient } from './hermes-client.mjs';
import { createApp } from './app.mjs';
import path from 'node:path';
import { HermesBotRegistry, HermesBots } from './hermes-bots.mjs';
import { HermesExchanges } from './hermes-exchanges.mjs';
import { HermesRunJournal } from './hermes-run-journal.mjs';
import { HermesSessionBridge } from './hermes-session.mjs';
import { BrowserRegistry } from './browser-registry.mjs';
import { BrowserManager } from './browser-manager.mjs';
import { cdpTransportMode } from './browser-launcher.mjs';
import { botRelayUrl } from './hermes-bot-network.mjs';
import { HermesBotIsolation, isolationMode } from './hermes-isolation.mjs';
import { createHobTelemetry } from './hob-telemetry.mjs';
import { HermesTeam } from './hermes-team.mjs';

Object.assign(process.env, hobEnv());

if (!process.env.HOB_PASSWORD && !process.env.HOB_ACCESS_TOKEN) {
  console.error('Set HOB_PASSWORD or HOB_ACCESS_TOKEN before starting hob.');
  process.exit(1);
}

// Validated once at boot, not at the first browser launch: a typo here is a
// configuration error, and the transport is what keeps the DevTools port gone.
const browserTransport = cdpTransportMode();
const isolation = isolationMode() === 'users' ? new HermesBotIsolation() : null;
if (isolation && browserTransport !== 'pipe') throw new Error('OS-isolated browsers require CDP pipe transport.');
if (browserTransport === 'tcp') {
  console.warn('HOB_CDP_TRANSPORT=tcp: the managed browser exposes a raw loopback DevTools port '
    + 'that any local process can drive without the lease. This is a development fallback; '
    + 'leave the variable unset (pipe) in production.');
}
const telemetry = createHobTelemetry({ stateDir: process.env.HOB_STATE_DIR });
const clientOptions = {
  telemetry,
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
const browserRegistry = await BrowserRegistry.open({ stateDir: process.env.HOB_STATE_DIR, profileRoot: process.env.HOB_BROWSER_DATA_DIR });
const enrolledBots = new Set(registry.list().map(bot => bot.name));
for (const record of browserRegistry.list()) {
  if (!enrolledBots.has(record.bot)) await browserRegistry.remove(record.bot);
}
const idleMs = Number(process.env.HOB_BROWSER_IDLE_MS);
const browser = await BrowserManager.open({
  registry: browserRegistry,
  stateDir: process.env.HOB_STATE_DIR,
  options: { telemetry, ...(Number.isFinite(idleMs) && idleMs >= 0 ? { idleMs } : {}), ...(isolation ? { spawnBrowser: isolation.spawnBrowser.bind(isolation) } : {}) },
});
const team = new HermesTeam({ stateDir: process.env.HOB_STATE_DIR, workspaceRoot: process.env.HOB_WORKSPACE_ROOT || path.join(process.env.HERMES_HOME, 'workspaces'), roster: () => registry.list() });
const bots = new HermesBots({
  team,
  registry, isolation,
  client: new HermesClient(clientOptions),
  workspaceRoot: process.env.HOB_WORKSPACE_ROOT || path.join(process.env.HERMES_HOME, 'workspaces'),
  browser,
  // Co-located bots use the private app listener, independently of the public
  // proxy's origin/port. A remote backend can provision HOB_BOT_RELAY_URL.
  relayUrl: botRelayUrl(),
});
const gateway = new HermesClient({ ...clientOptions, profileAccess: profile => registry.token(profile) });
const runJournal = await HermesRunJournal.open(process.env.HOB_STATE_DIR);
const nativeSessions = new HermesSessionBridge({ telemetry, profileAccess: profile => registry.token(profile) });
const exchanges = await HermesExchanges.open(process.env.HOB_STATE_DIR);
const server = createApp({ gateway, bots, browser, runJournal, nativeSessions, exchanges, telemetry, team, ...(process.env.HOB_STATIC_DIR ? { staticDir: process.env.HOB_STATIC_DIR } : {}) });
gateway.start();
const port = Number(process.env.HOB_PORT || 3000);
const build = `${process.env.HOB_GIT_COMMIT || 'unknown'} (${process.env.HOB_GIT_REF || 'unknown'})`;
server.listen(port, process.env.HOB_HOST || '127.0.0.1', () => console.log(`hob ${build} listening on port ${port}.`));
// Bind every active bot on boot, not just the ones this process created. Bots
// that predate the managed browser (and bots whose setup-time binding failed)
// otherwise drive a throwaway Hermes browser while the dashboard watches an idle
// HOB one. Best-effort with a short backoff: the dashboard may still be coming
// up, and a bot must never be blocked from serving because of that.
const bindBrowsers = async (attempt = 1) => {
  let result;
  try { result = await bots.reconcileBrowsers(); }
  catch (error) { result = { configured: [], unchanged: [], failed: [{ name: '*', error: error.message }] }; }
  // Every bot needs the current roster in AGENTS.md and the generated relay
  // helper in its workspace. This is best-effort and independent of browsers:
  // a bot whose workspace cannot be written must not block the others.
  try {
    const roster = await bots.syncNetwork();
    if (roster.updated.length) console.log(`Updated the HOB roster for ${roster.updated.join(', ')}.`);
    if (roster.failed.length) result.failed.push(...roster.failed.map(item => ({ name: item.name, error: `Bot synchronization: ${item.error}` })));
  } catch (error) { result.failed.push({ name: '*', error: `Bot synchronization: ${error.message}` }); }
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
let teamReconciliation;
const reconcileTeam = () => {
  if (teamReconciliation) return;
  if (!team.policy().revision && !team.core().revision) return;
  teamReconciliation = (async () => {
    await team.discoverDraft();
    const result = await bots.syncSharedNetwork();
    if (result.failed.length) console.warn(`Employee-team sync incomplete for ${result.failed.length} bot(s). Check Settings for details.`);
  })().catch(() => console.warn('Employee-team source reconciliation failed. No new core was approved.'))
    .finally(() => { teamReconciliation = undefined; });
};
// Reconciliation catches source edits, missed watcher events, restarts and edited copies.
const teamTimer = setInterval(reconcileTeam, 30000); teamTimer.unref();
// A signal must finish the graceful browser stop — that close is what flushes cookies
// and storage to the profile — but it must also finish inside the supervisor's window:
// `deploy/start.mjs` escalates to SIGKILL at 30 s, so wait at most 25 s and then leave.
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(teamTimer);
  nativeSessions.close();
  gateway.stop();
  server.close();
  server.closeAllConnections();
  await Promise.race([
    browser.shutdown().catch(() => undefined),
    new Promise(resolve => { setTimeout(resolve, 25000); }),
  ]);
  await Promise.race([telemetry.flush(), new Promise(resolve => setTimeout(resolve, 1000))]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
