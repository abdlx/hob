import test from 'node:test';
import assert from 'node:assert/strict';
import { createComputerStream, resolveRfbConstructor } from '../src/services/computer-stream.ts';

class Rfb extends EventTarget {
  _rfbConnectionState = 'connected'; _fbWidth = 100; _fbHeight = 100;
  disconnects = 0;
  disconnect() { this.disconnects++; this.dispatchEvent(new Event('disconnect')); }
  emit(name) { this.dispatchEvent(new Event(name)); }
}
function fixture() {
  const clients = [], urls = [], timers = new Map(), states = [], errors = [];
  let id = 0;
  const stream = createComputerStream({ directUrl: 'wss://explicit.test/vnc', proxyUrl: 'ws://local.test/proxy',
    create(url) { const client = new Rfb(); clients.push(client); urls.push(url); return client; },
    onState: state => states.push(state), onError: message => errors.push(message),
    schedule(callback) { timers.set(++id, callback); return id; }, cancel(timer) { timers.delete(timer); },
  });
  const tick = () => { const [key, callback] = timers.entries().next().value; timers.delete(key); callback(); };
  return { stream, clients, urls, states, timers, errors, tick };
}
test('failed direct connection falls back once and stale disconnects cannot replace the proxy', () => {
  const f = fixture();
  f.stream.connect(); f.clients[0].emit('disconnect'); f.tick();
  assert.deepEqual(f.urls, ['wss://explicit.test/vnc', 'ws://local.test/proxy']);
  f.clients[1].emit('connect');
  f.clients[0].emit('disconnect');
  assert.equal(f.timers.size, 0); assert.equal(f.states.at(-1), 'connected');
  f.stream.close();
});
test('closing a stream cancels retries and ignores all later callbacks', () => {
  const f = fixture(); f.stream.connect(); f.clients[0].emit('disconnect');
  assert.equal(f.timers.size, 1);
  f.stream.close(); const count = f.states.length;
  f.clients[0].emit('connect'); f.clients[0].emit('disconnect'); f.stream.connect();
  assert.equal(f.timers.size, 0); assert.equal(f.states.length, count); assert.equal(f.clients.length, 1);
});
test('replacing a connection retires the old socket and update requests use only the current socket', () => {
  const f = fixture(); f.stream.connect(); f.stream.reconnect();
  assert.equal(f.clients[0].disconnects, 1);
  const updates = []; f.stream.requestUpdate(client => updates.push(client));
  assert.deepEqual(updates, [f.clients[1]]);
  f.stream.close(); f.stream.requestUpdate(client => updates.push(client));
  assert.equal(updates.length, 1);
});
test('proxy retries are bounded and explicit reconnect recovers from exhaustion', () => {
  const f = fixture(); f.stream.connect(); f.clients[0].emit('disconnect'); f.tick();
  for (let attempt = 0; attempt < 7; attempt++) { f.clients.at(-1).emit('disconnect'); if (f.timers.size) f.tick(); }
  assert.equal(f.timers.size, 0); assert.equal(f.states.at(-1), 'failed');
  f.stream.reconnect(); f.clients.at(-1).emit('connect');
  assert.equal(f.states.at(-1), 'connected'); f.stream.close();
});
test('invalid or circular noVNC module wrappers fail promptly', () => {
  assert.equal(resolveRfbConstructor({ default: { default: Rfb } }), Rfb);
  const circular = {}; circular.default = circular;
  assert.throws(() => resolveRfbConstructor(circular), /could not be loaded/);
});
