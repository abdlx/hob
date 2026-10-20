// A real hob server for the end-to-end scenario: real routes, real browser
// manager, real Chromium. Only the Hermes gateway client is inert, because the
// browser routes never speak to it.
//
// It prints one READY line with the facts the driver needs, then serves until it
// is asked to stop. Driven by `hermes-tools-e2e.py`; see README.md.
//
//   node e2e/harness-server.mjs <bot> <password> <stateDir>

import { createApp } from '../app.mjs';
import { BrowserRegistry } from '../browser-registry.mjs';
import { BrowserManager } from '../browser-manager.mjs';

const bot = process.argv[2] || 'default';
const password = process.argv[3] || 'e2e-password';
const stateDir = process.argv[4];
if (!stateDir) throw new Error('usage: node e2e/harness-server.mjs <bot> <password> <stateDir>');

// Extra bot profiles for the isolation scenario: `HOB_E2E_BOTS=default,beta`.
const extraBots = (process.env.HOB_E2E_BOTS || '')
  .split(',').map(name => name.trim()).filter(Boolean);
const bots = [...new Set([bot, ...extraBots])];

const registry = await BrowserRegistry.open({ stateDir });
const browser = await BrowserManager.open({
  registry,
  stateDir,
  // A shorter lease wait than production's 20s, so a refusal during a takeover
  // surfaces quickly in the scenario. The production value lives in the session.
  options: {
    agentWaitMs: Number(process.env.HOB_E2E_AGENT_WAIT_MS || 4000),
    idleMs: Number(process.env.HOB_E2E_IDLE_MS || 15000),
    maxFps: 10,
  },
});

const app = createApp({
  gateway: { kind: 'other', connected: false, on() {}, request: async () => ({}), start() {}, stop() {} },
  bots: { list: async () => ({ profiles: bots.map(name => ({ name })) }), has: name => bots.includes(name), token: () => 'x'.repeat(32) },
  browser,
  password,
  stateDir,
  staticDir: `${stateDir}/no-static-dir`,
  sessionSecret: 'e2e-session-secret-e2e-session-secret',
});

await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
// Bind each bot's CDP endpoint up front, which is what `configureBrowser` does in
// the product before it writes `browser.cdp_url` into the bot's Hermes profile.
// Binding an endpoint does not start a browser: the first client does.
const endpoints = {};
const profileDirs = {};
for (const name of bots) {
  await browser.ensureEndpoint(name);
  const record = await browser.record(name);
  endpoints[name] = {
    cdpUrl: `http://127.0.0.1:${record.gatewayPort}/${record.gatewayToken}`,
    gatewayPort: record.gatewayPort,
  };
  profileDirs[name] = registry.profileDir(stateDir, name);
}
console.log(`READY ${JSON.stringify({
  bot,
  bots,
  httpPort: app.address().port,
  cdpUrl: endpoints[bot].cdpUrl,
  gatewayPort: endpoints[bot].gatewayPort,
  endpoints,
  profileDirs,
})}`);

const stop = async () => {
  await browser.shutdown();
  app.close(() => process.exit(0));
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.stdin.on('end', () => void stop());
process.stdin.resume();
