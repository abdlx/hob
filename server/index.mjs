import { HermesClient } from './hermes-client.mjs';
import { createApp } from './app.mjs';
import path from 'node:path';
import { HermesBotRegistry, HermesBots } from './hermes-bots.mjs';

if (!process.env.MUSE_PASSWORD && !process.env.MUSE_ACCESS_TOKEN) {
  console.error('Set MUSE_PASSWORD or MUSE_ACCESS_TOKEN before starting hob.');
  process.exit(1);
}
const clientOptions = {
  runtimeUrl: process.env.HERMES_API_URL || 'http://127.0.0.1:8642',
  dashboardUrl: process.env.HERMES_DASHBOARD_URL || 'http://127.0.0.1:8080',
  apiKey: process.env.API_SERVER_KEY,
  dashboardToken: process.env.HERMES_DASHBOARD_SESSION_TOKEN,
};
if (!process.env.HERMES_HOME || !process.env.HOB_STATE_DIR) throw new Error('Start hob through deploy/start.mjs to provision private Hermes state.');
const registry = await HermesBotRegistry.open({ stateDir: process.env.HOB_STATE_DIR, mainApiKey: process.env.API_SERVER_KEY });
const bots = new HermesBots({ registry, client: new HermesClient(clientOptions), workspaceRoot: path.join(process.env.HERMES_HOME, 'workspaces') });
const gateway = new HermesClient({ ...clientOptions, profileAccess: profile => registry.token(profile) });
const server = createApp({ gateway, bots, ...(process.env.MUSE_STATIC_DIR ? { staticDir: process.env.MUSE_STATIC_DIR } : {}) });
gateway.start();
server.listen(Number(process.env.MUSE_PORT || 3000), process.env.MUSE_HOST || '127.0.0.1', () => console.log(`hob listening on port ${process.env.MUSE_PORT || 3000}.`));
const shutdown = () => { gateway.stop(); server.close(); server.closeAllConnections(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
