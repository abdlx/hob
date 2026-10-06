import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { GatewayBridge } from '../gateway.mjs';

test('startup uses the canonical local HTTP probe and keeps its token server-side', async () => {
  let ready = false;
  const probe = http.createServer((req, res) => {
    assert.equal(req.url, '/startupz');
    assert.equal(req.headers.authorization, 'Bearer synthetic-probe-token');
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: ready, status: ready ? 'started' : 'starting' }));
  });
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const bridge = new GatewayBridge({ url: `ws://127.0.0.1:${probe.address().port}`, token: 'synthetic-probe-token' });
  try {
    assert.deepEqual(await bridge.getStartupStatus(), { ready: false, status: 'disconnected' });
    bridge.connected = true;
    assert.deepEqual(await bridge.getStartupStatus(), { ready: false, status: 'starting' });
    ready = true;
    assert.deepEqual(await bridge.getStartupStatus(), { ready: true, status: 'started' });
  } finally { probe.closeAllConnections(); await new Promise(resolve => probe.close(resolve)); }
});

class Socket extends EventTarget {
  static instances = [];
  readyState = 1;
  sent = [];
  constructor() { super(); Socket.instances.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
test('local handshake uses operator scopes, matches replies, forwards events, rejects inflight on loss', async () => {
  const bridge = new GatewayBridge({ url: 'ws://127.0.0.1:18789', token: 'synthetic-gateway-token', WebSocketImpl: Socket });
  bridge.start();
  const socket = Socket.instances.at(-1);
  socket.receive({ type: 'event', event: 'connect.challenge', payload: { nonce: 'synthetic', ts: 1000 } });
  const connect = socket.sent[0];
  assert.equal(connect.method, 'connect');
  assert.equal(connect.params.client.id, 'cli');
  assert.equal(connect.params.client.mode, 'cli');
  assert.equal(connect.params.minProtocol, 4);
  assert.equal(connect.params.auth.token, 'synthetic-gateway-token');
  assert.ok(connect.params.scopes.includes('operator.admin'));
  const connected = once(bridge, 'connected');
  socket.receive({ type: 'res', id: connect.id, ok: true, payload: { type: 'hello-ok' } });
  await connected;
  assert.equal(bridge.connected, true);
  const subscription = socket.sent.at(-1);
  assert.equal(subscription.method, 'sessions.subscribe');
  socket.receive({ type: 'res', id: subscription.id, ok: true, payload: { subscribed: true } });
  const request = bridge.request('config.get');
  const sent = socket.sent.at(-1);
  socket.receive({ type: 'res', id: sent.id, ok: true, payload: { config: { gateway: {} } } });
  assert.deepEqual(await request, { config: { gateway: {} } });
  const event = once(bridge, 'event');
  socket.receive({ type: 'event', event: 'chat', payload: { state: 'delta' } });
  assert.equal((await event)[0].event, 'chat');
  const mutation = bridge.request('cron.add', { name: 'Synthetic' });
  const rejected = assert.rejects(mutation, /Accepted writes may still have completed/);
  bridge.stop();
  await rejected;
  assert.equal(bridge.connected, false);
  assert.equal(socket.sent.filter(s => s.method === 'cron.add').length, 1);
});
test('gateway secrets cannot be sent to a remote host or an unencrypted remote endpoint', () => {
  assert.throws(() => new GatewayBridge({ url: 'ws://example.com:18789', token: 'synthetic' }), /loopback/);
  assert.throws(() => new GatewayBridge({ url: 'wss://example.com', token: 'synthetic' }), /loopback/);
  assert.throws(() => new GatewayBridge({ url: 'ws://127.0.0.1:18789' }), /TOKEN/);
});
test('advertised ticks keep the connection live and a stalled Gateway becomes disconnected', async () => {
  let now = 0, check, cleared = false;
  const clock = { now: () => now, setInterval: callback => { check = callback; return 1; }, clearInterval: () => { cleared = true; } };
  const bridge = new GatewayBridge({ url: 'ws://127.0.0.1:18789', token: 'synthetic', WebSocketImpl: Socket, clock });
  bridge.start();
  const socket = Socket.instances.at(-1);
  socket.receive({ type: 'event', event: 'connect.challenge', payload: {} });
  const connected = once(bridge, 'connected');
  socket.receive({ type: 'res', id: socket.sent[0].id, ok: true, payload: { policy: { tickIntervalMs: 1000 } } });
  await connected;
  socket.receive({ type: 'res', id: socket.sent.at(-1).id, ok: true, payload: { subscribed: true } });
  now = 1800;
  socket.receive({ type: 'event', event: 'tick', payload: { ts: now } });
  now = 3000; check();
  assert.equal(bridge.connected, true);
  now = 3900; check();
  assert.equal(bridge.connected, false);
  assert.equal(cleared, true);
  bridge.stop();
});
test('native Node WebSocket completes a real HTTP upgrade and routes RPC responses', async () => {
  const server = http.createServer();
  const sockets = new Set();
  let sawOrigin, receivedConnect;
  const send = (socket, value) => {
    const content = Buffer.from(JSON.stringify(value));
    let header;
    if (content.length < 126) header = Buffer.from([0x81, content.length]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(content.length, 2); }
    socket.write(Buffer.concat([header, content]));
  };
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    sawOrigin = req.headers.origin;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    send(socket, { type: 'event', event: 'connect.challenge', payload: { nonce: 'synthetic-network', ts: 1234 } });
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15;
        const masked = Boolean(buffered[1] & 128);
        let length = buffered[1] & 127, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        if (buffered.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? buffered.subarray(offset, offset + 4) : undefined;
        offset += masked ? 4 : 0;
        const content = Buffer.from(buffered.subarray(offset, offset + length));
        if (mask) for (let i = 0; i < content.length; i++) content[i] ^= mask[i % 4];
        buffered = buffered.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const frame = JSON.parse(content);
        if (frame.method === 'connect') receivedConnect = frame.params;
        send(socket, { type: 'res', id: frame.id, ok: true, payload: frame.method === 'connect' ? { type: 'hello-ok', protocol: 4 } : frame.method === 'sessions.subscribe' ? { subscribed: true } : { jobs: [] } });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bridge = new GatewayBridge({ url: `ws://127.0.0.1:${server.address().port}`, token: 'synthetic-network-token' });
  try {
    const connected = once(bridge, 'connected');
    bridge.start();
    await connected;
    assert.equal(sawOrigin, undefined);
    assert.equal(receivedConnect.auth.token, 'synthetic-network-token');
    assert.deepEqual(await bridge.request('cron.list', { includeDisabled: true }), { jobs: [] });
  } finally {
    bridge.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
