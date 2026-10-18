import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createSessionBootstrap, HermesSessionBridge } from '../hermes-session.mjs';

const grant = () => ({ url: 'ws://127.0.0.1:4455/api/ws',
  protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.synthetic'], profile_id: 'synthetic-profile', instance_id: 'synthetic-owner' });

function fixture({ canonical = true, protocol = 'hermes-gateway-v1', answer = frame => ({ profile: frame.params.session_id }) } = {}) {
  const sockets = [];
  class Socket extends EventTarget {
    constructor(url, protocols) {
      super(); this.url = url; this.protocols = protocols; this.protocol = protocol; this.readyState = 1; this.sent = [];
      sockets.push(this);
      queueMicrotask(() => this.frame({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { session_authority: canonical } } }));
    }
    frame(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
    send(raw) {
      const frame = JSON.parse(raw); this.sent.push(frame);
      const result = answer(frame, this);
      if (result !== undefined) queueMicrotask(() => this.frame({ jsonrpc: '2.0', id: frame.id, result }));
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const tokens = { default: 'main-authority', research: 'research-authority' };
  const bridge = new HermesSessionBridge({ bootstrap: async () => grant(), WebSocketClass: Socket,
    profileAccess: profile => tokens[profile], timeout: 50 });
  return { bridge, sockets, tokens, Socket };
}

test('canonical readiness is mandatory; legacy WS and wrong negotiated protocol cannot receive writes', async t => {
  for (const options of [{ canonical: false }, { protocol: 'legacy' }]) {
    const f = fixture(options); t.after(() => f.bridge.close());
    await assert.rejects(f.bridge.rpc('default', 'prompt.submit', { text: 'do not dispatch' }), { code: 'SESSION_UNAVAILABLE' });
    assert.equal(f.sockets[0].sent.length, 0);
  }
});

test('bots get separate connections; simultaneous requests reuse only their own ready connection', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  const results = await Promise.all([f.bridge.rpc('default', 'session.info', { session_id: 'main' }),
    f.bridge.rpc('research', 'session.info', { session_id: 'research' }), f.bridge.rpc('default', 'session.info', { session_id: 'main2' })]);
  assert.deepEqual(results, [{ profile: 'main' }, { profile: 'research' }, { profile: 'main2' }]);
  assert.equal(f.sockets.length, 2); assert.equal(f.sockets[0].sent.length, 2);
});

test('disconnected writes have unknown outcomes and are never replayed', async t => {
  const f = fixture({ answer: (_frame, socket) => { queueMicrotask(() => socket.close()); } }); t.after(() => f.bridge.close());
  await assert.rejects(f.bridge.rpc('default', 'prompt.submit', { text: 'one', submission_id: 'one' }), { code: 'SESSION_UNAVAILABLE' });
  assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].sent.length, 1);
});

test('timeouts retain ambiguous outcome without retrying the request', async t => {
  const f = fixture({ answer: () => undefined }); t.after(() => f.bridge.close());
  await assert.rejects(f.bridge.rpc('default', 'prompt.submit', { text: 'one' }), { code: 'SESSION_UNAVAILABLE' });
  assert.equal(f.sockets[0].sent.length, 1);
});

test('enrollment is rechecked before RPC and incoming data; revoked connections stop projecting events', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.bridge.rpc('research', 'ping');
  delete f.tokens.research;
  const events = []; f.bridge.on('event', event => events.push(event));
  f.sockets[0].frame({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', payload: { text: 'private' } } });
  assert.equal(f.sockets[0].readyState, 3);
  assert.equal(events.some(event => event.event.type === 'message.delta'), false);
  await assert.rejects(f.bridge.rpc('research', 'ping'), { code: 'SESSION_UNAVAILABLE' });
});

test('credential rotation invalidates the old connection and bootstraps a new one', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.bridge.rpc('default', 'ping'); f.tokens.default = 'rotated'; await f.bridge.rpc('default', 'ping');
  assert.equal(f.sockets.length, 2); assert.equal(f.sockets[0].readyState, 3);
});

test('RPC allowlist rejects cross-profile parameter overrides and arbitrary native methods', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  for (const [method, params] of [['plugins.install', {}], ['session.info', { profile: 'research' }]]) {
    await assert.rejects(f.bridge.rpc('default', method, params), { code: 'INVALID_REQUEST' });
  }
  assert.equal(f.sockets.length, 0);
});

test('bootstrap failure never exposes ticket, path or subprocess diagnostics', async () => {
  const bootstrap = createSessionBootstrap({ env: { HERMES_DIR: '/synthetic-hermes', HERMES_HOME: '/synthetic-home' },
    execute: async () => { throw new Error('secret-ticket private-path'); } });
  await assert.rejects(bootstrap('default'), error => error.code === 'SESSION_UNAVAILABLE' && !/secret|private-path/.test(error.message));
});

test('bootstrap passes only the selected home and no web or listener authority to the child', async () => {
  const bootstrap = createSessionBootstrap({ env: { HERMES_DIR: '/synthetic-hermes', HERMES_HOME: '/synthetic-home',
    MUSE_PASSWORD: 'private', HOB_STATE_DIR: 'private', API_SERVER_KEY: 'private', HERMES_DASHBOARD_SESSION_TOKEN: 'private', HERMES_TUI_GATEWAY_URL: 'ws://untrusted' },
    execute: async (_exe, args, options) => {
      assert.equal(args.length, 1); assert.match(options.env.HERMES_HOME, /profiles[\\/]research$/);
      // The multiplexing gateway's single socket lives at the launch home, so the child
      // dials HERMES_HOME while it binds the bot by the profile home above.
      assert.match(options.env.HERMES_GATEWAY_HOME, /synthetic-home$/);
      assert.equal(options.env.HERMES_HOME, path.join(options.env.HERMES_GATEWAY_HOME, 'profiles', 'research'));
      assert.equal(Object.values(options.env).includes('private'), false);
      assert.equal(options.env.HERMES_TUI_GATEWAY_URL, undefined);
      return { stdout: JSON.stringify(grant()) };
    } });
  await bootstrap('research');
});

test('bootstrap rejects non-loopback targets without opening a socket or exposing its ticket', async () => {
  const f = fixture();
  const bridge = new HermesSessionBridge({ bootstrap: async () => ({ ...grant(), url: 'ws://example.com:80/api/ws' }),
    profileAccess: () => 'enrolled', WebSocketClass: f.Socket });
  await assert.rejects(bridge.rpc('default', 'ping'), { code: 'SESSION_UNAVAILABLE' });
  assert.equal(f.sockets.length, 0); bridge.close(); f.bridge.close();
});

test('native refusal reason is bounded; raw remote errors are not relayed', async t => {
  const f = fixture({ answer: (frame, socket) => { queueMicrotask(() => socket.frame({ jsonrpc: '2.0', id: frame.id,
    error: { message: 'private-token /secret/path', data: { token: 'secret' } } })); } });
  t.after(() => f.bridge.close());
  await assert.rejects(f.bridge.rpc('default', 'ping'), error => error.code === 'request_failed' && !/private|secret/.test(error.message));
});

test('request arguments are frozen before asynchronous owner discovery', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  const params = { session_id: 'original' };
  const answer = f.bridge.rpc('default', 'session.info', params);
  params.session_id = 'changed'; params.profile = 'research';
  assert.deepEqual(await answer, { profile: 'original' });
  assert.deepEqual(f.sockets[0].sent[0].params, { session_id: 'original' });
});
