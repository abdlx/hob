import { GatewayBridge } from './gateway.mjs';
import { createApp } from './app.mjs';

if (!process.env.MUSE_PASSWORD && !process.env.MUSE_ACCESS_TOKEN) {
  console.error('Set MUSE_PASSWORD or MUSE_ACCESS_TOKEN before starting Muse.');
  process.exit(1);
}
const gateway = new GatewayBridge({ url: process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789', token: process.env.OPENCLAW_GATEWAY_TOKEN });
const server = createApp({ gateway, ...(process.env.MUSE_STATIC_DIR ? { staticDir: process.env.MUSE_STATIC_DIR } : {}) });
gateway.start();
server.listen(Number(process.env.MUSE_PORT || 3000), process.env.MUSE_HOST || '127.0.0.1', () => console.log(`Muse listening on port ${process.env.MUSE_PORT || 3000}.`));
const shutdown = () => { gateway.stop(); server.close(); server.closeAllConnections(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
