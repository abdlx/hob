// Regression tests for the CDP pipe transport and the multiplexer that shares it.
//
// These are the tests that would catch a regression in the *transport*, where the
// gateway's own tests would only see a client-visible symptom. They run against a
// real Chromium over a real `--remote-debugging-pipe`, because the whole point of
// the design is the parts of Chromium's behaviour that cannot be assumed: that one
// pipe carries many sessions, that an explicit attach is private per client, and
// that browser-level auto-attach is not.
//
// The framing and backpressure tests use fake streams, so they are exact: bits in,
// bits out, no timing.
//
// Authorization is deliberately *not* retested here. A pipe has no address, so the
// only way in is the HOB gateway, and the gateway's token, ticket and lease rules
// are covered by test/browser-gateway.test.mjs, browser-routes.test.mjs and
// browser-takeover-bypass.test.mjs.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipeChromium, PipeTransport } from '../browser-pipe.mjs';
import { resolveChromiumExecutable, stopChromium } from '../browser-launcher.mjs';

const FRAME_END = Buffer.from([0]);

// ── framing ──────────────────────────────────────────────────────────────────

function fakePipe({ maxFrame } = {}) {
  const input = new EventEmitter();
  const output = new EventEmitter();
  const written = [];
  output.write = buffer => { written.push(buffer); return true; };
  const messages = [];
  const failures = [];
  const transport = new PipeTransport({
    input, output, maxFrame,
    onMessage: message => messages.push(message),
    onClose: error => failures.push(error),
  });
  return { input, output, written, messages, failures, transport };
}

test('pipe framing: NUL-delimited JSON, coalesced and split across chunks', () => {
  const { input, messages, transport } = fakePipe();

  // Two replies in one read, which is the common case.
  input.emit('data', Buffer.from('{"id":1,"result":{"a":1}}\0{"id":2,"result":{}}\0'));
  assert.deepEqual(messages.map(message => message.id), [1, 2]);

  // One reply split between two reads: the buffer must carry over.
  const payload = JSON.stringify({ id: 3, result: { text: 'line\nbreak' } });
  input.emit('data', Buffer.from(payload.slice(0, 10)));
  assert.equal(messages.length, 2, 'a partial frame is not a message');
  input.emit('data', Buffer.from(`${payload.slice(10)}\0`));
  assert.deepEqual(messages[2], { id: 3, result: { text: 'line\nbreak' } });

  // A NUL *inside* a JSON string is escaped by JSON itself, so it can never be
  // mistaken for a frame delimiter. Only the raw byte ends a frame.
  input.emit('data', Buffer.from(`${JSON.stringify({ id: 4, result: { text: 'nul:\u0000 here' } })}\0`));
  assert.equal(messages[3].result.text, 'nul:\u0000 here');
  assert.equal(transport.closed, false);

  // Newlines are ordinary characters too; the protocol is not line-based.
  input.emit('data', Buffer.from('{\n  "id": 5,\n  "result": {}\n}\0'));
  assert.equal(messages[4].id, 5);
});

test('pipe framing: writes are framed in order, and a broken frame is not fatal', () => {
  const { input, output, written, messages, failures, transport } = fakePipe();
  transport.send({ id: 1, result: {} });
  transport.send({ id: 2, result: {} });
  assert.equal(written.length, 2);
  assert.ok(written[0].subarray(-1).equals(FRAME_END), 'every write ends with a NUL');
  assert.equal(written.map(buffer => JSON.parse(buffer.toString('utf8').replace(/\0$/, '')).id).join(','), '1,2');

  // A frame Chromium (or a bug) sends malformed must be skipped, never thrown.
  input.emit('data', Buffer.from('{not json}\0{"id":9,"result":{}}\0'));
  assert.equal(failures.length, 0);
  assert.equal(messages.at(-1).id, 9);

  transport.close();
  assert.equal(transport.closed, true);
  assert.equal(transport.send({ id: 3 }), false, 'a closed transport refuses new messages');
});

test('pipe framing: backpressure pauses writes and a drain resumes them in order', () => {
  const { output, written, transport } = fakePipe();
  let accepting = false;
  output.write = buffer => { written.push(buffer); return accepting; };

  transport.send({ id: 1 });
  transport.send({ id: 2 });
  transport.send({ id: 3 });
  assert.equal(written.length, 1, 'nothing else is written while the stream is full');

  accepting = true;
  output.emit('drain');
  assert.equal(written.length, 3, 'the queue flushes on drain');
  assert.deepEqual(
    written.map(buffer => JSON.parse(buffer.toString('utf8').replace(/\0$/, '')).id), [1, 2, 3]);
});

test('pipe framing: a frame past the limit fails the connection instead of growing', () => {
  const { input, failures, transport } = fakePipe({ maxFrame: 64 });
  input.emit('data', Buffer.alloc(200, 0x61)); // 200 bytes, no delimiter
  assert.equal(transport.closed, true);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /larger than the limit/);
});

// ── the multiplexer, against a real Chromium ─────────────────────────────────

let browser = null;
let profileDir = null;
let child = null;

before(async () => {
  const executablePath = await resolveChromiumExecutable();
  if (!executablePath) return; // every integration test below returns early
  profileDir = await mkdtemp(join(tmpdir(), 'hob-pipe-test-'));
  child = spawn(executablePath, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout?.resume();
  child.stderr?.resume();
  browser = new PipeChromium({ child, label: 'test' });
  const version = await browser.request('Browser.getVersion');
  assert.ok(version.product);
});

after(async () => {
  if (browser) await browser.request('Browser.close').catch(() => undefined);
  if (child) await stopChromium(child).catch(() => undefined);
  if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
});

/** A minimal CDP client over one channel: own id space, replies and events kept. */
function client(pipe, channel) {
  const pending = new Map();
  const events = [];
  const errors = [];
  let nextId = 1;
  const failAll = reason => {
    for (const entry of pending.values()) entry.reject(new Error(reason));
    pending.clear();
  };
  channel.on('message', data => {
    const message = JSON.parse(data.toString('utf8'));
    if (message.id !== undefined && message.id !== null) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      entry.resolve(message);
      return;
    }
    events.push(message);
  });
  channel.on('close', () => failAll('The browser connection closed.'));
  channel.on('error', error => errors.push(error));
  return {
    channel,
    events,
    errors,
    rawSend: (text, callback) => channel.send(text, callback),
    call(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, 15000);
        pending.set(id, {
          resolve: message => { clearTimeout(timer); resolve(message); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        channel.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    async open() {
      const created = await this.call('Target.createTarget', { url: 'about:blank' });
      const targetId = created.result.targetId;
      const attached = await this.call('Target.attachToTarget', { targetId, flatten: true });
      return { targetId, sessionId: attached.result.sessionId };
    },
    waitFor(predicate, { timeoutMs = 10000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const tick = () => {
          const found = events.find(predicate);
          if (found) return resolve(found);
          if (Date.now() > deadline) return reject(new Error('Timed out waiting for an event.'));
          setTimeout(tick, 30);
        };
        tick();
      });
    },
    /** Poll an expression until it returns the expected value (page commits are async). */
    async until(expression, expected, { sessionId, timeoutMs = 8000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const reply = await this.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
        if (reply.result?.result?.value === expected) return reply;
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${expression} === ${JSON.stringify(expected)} `
            + `(last: ${JSON.stringify(reply.result?.result?.value ?? reply.error)})`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    },
  };
}

test('mux: two clients share one pipe without sharing an id space', async () => {
  if (!browser) return;
  const alpha = client(browser, await browser.createChannel({ kind: 'browser', label: 'alpha' }));
  const beta = client(browser, await browser.createChannel({ kind: 'browser', label: 'beta' }));

  // Both clients use id 1 for a different command, twice over. Each must get its
  // own reply, with its own result.
  const [first, second] = await Promise.all([
    alpha.call('Browser.getVersion'),
    beta.call('Target.getTargets'),
  ]);
  assert.equal(first.id, 1);
  assert.equal(second.id, 1);
  assert.ok(first.result.product);
  assert.ok(Array.isArray(second.result.targetInfos));

  const again = await Promise.all([alpha.call('Browser.getVersion'), beta.call('Browser.getVersion')]);
  assert.deepEqual(again.map(message => message.id), [2, 2]);

  alpha.channel.close();
  beta.channel.close();
});

test('mux: an explicit attach is private to the client that asked for it', async () => {
  if (!browser) return;
  const alpha = client(browser, await browser.createChannel({ kind: 'browser', label: 'alpha' }));
  const beta = client(browser, await browser.createChannel({ kind: 'browser', label: 'beta' }));

  const page = await alpha.open();
  const other = await beta.call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  assert.ok(other.result.sessionId);
  assert.notEqual(other.result.sessionId, page.sessionId,
    'one pipe can still hand out a separate session per client');

  // Each session works for its owner...
  const mine = await alpha.call('Runtime.evaluate', { expression: '1+1', returnByValue: true }, page.sessionId);
  assert.equal(mine.result.result.value, 2);
  const theirs = await beta.call('Runtime.evaluate', { expression: '2+2', returnByValue: true }, other.result.sessionId);
  assert.equal(theirs.result.result.value, 4);

  // ...and a client cannot address a session it was never given.
  const stolen = await beta.call('Runtime.evaluate', { expression: '3+3', returnByValue: true }, page.sessionId);
  assert.equal(stolen.error.code, -32601);
  assert.match(stolen.error.message, /not attached to this connection/);

  // An id that names nothing at all is refused the same way, never forwarded.
  const unknown = await alpha.call('Runtime.evaluate', { expression: '4+4', returnByValue: true }, 'not-a-session');
  assert.equal(unknown.error.code, -32601);

  alpha.channel.close();
  beta.channel.close();
});

test('mux: browser-level auto-attach is shared, but each client gets its own session', async () => {
  if (!browser) return;
  const alpha = client(browser, await browser.createChannel({ kind: 'browser', label: 'alpha' }));
  const beta = client(browser, await browser.createChannel({ kind: 'browser', label: 'beta' }));

  // A client may *ask* for suspension; the multiplexer must not pass it on: one
  // pipe means one auto-attach setting, and a suspended target could only be
  // resumed by a command the lease refuses during a human takeover (H4).
  await alpha.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  const created = await alpha.call('Target.createTarget', { url: 'data:text/html,<title>AUTO</title>' });
  const targetId = created.result.targetId;
  const isMine = event => event.method === 'Target.attachedToTarget' && event.params.targetInfo.targetId === targetId;
  const seenByAlpha = await alpha.waitFor(isMine);
  assert.equal(seenByAlpha.params.waitingForDebugger, false, 'no client can suspend a target');

  // Beta enables auto-attach *after* the shared switch is already on. Chromium
  // would tell a dedicated connection about the targets it already has, so the
  // multiplexer catches the late client up rather than leaving it blind.
  await beta.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const seenByBeta = await beta.waitFor(isMine);
  assert.equal(seenByBeta.params.waitingForDebugger, false);
  assert.notEqual(seenByAlpha.params.sessionId, seenByBeta.params.sessionId,
    'each client addresses the target through its own session');

  // Both virtual ids address the same live target.
  await alpha.until('document.title', 'AUTO', { sessionId: seenByAlpha.params.sessionId });
  await beta.until('document.title', 'AUTO', { sessionId: seenByBeta.params.sessionId });

  // One client detaching must not disturb the other: a catch-up attach is
  // private, so releasing it cannot touch somebody else's view.
  const detached = await alpha.call('Target.detachFromTarget', { sessionId: seenByAlpha.params.sessionId });
  assert.deepEqual(detached.result, {});
  const stillThere = await beta.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, seenByBeta.params.sessionId);
  assert.equal(stillThere.result.result.value, 'AUTO');

  await beta.call('Target.setAutoAttach', { autoAttach: false, flatten: true });
  alpha.channel.close();
  beta.channel.close();
});

test('mux: target lifecycle events go only to clients that asked to discover', async () => {
  if (!browser) return;
  const watching = client(browser, await browser.createChannel({ kind: 'browser', label: 'watching' }));
  const quiet = client(browser, await browser.createChannel({ kind: 'browser', label: 'quiet' }));

  await watching.call('Target.setDiscoverTargets', { discover: true });
  const created = await quiet.call('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result.targetId;

  const event = await watching.waitFor(entry =>
    entry.method === 'Target.targetCreated' && entry.params.targetInfo.targetId === targetId);
  assert.equal(event.params.targetInfo.type, 'page');
  assert.equal(quiet.events.some(entry => entry.method === 'Target.targetCreated'), false,
    'a client that never enabled discovery is not told about targets');

  watching.channel.close();
  quiet.channel.close();
});

test('mux: session events reach the owning client only', async () => {
  if (!browser) return;
  const alpha = client(browser, await browser.createChannel({ kind: 'browser', label: 'alpha' }));
  const beta = client(browser, await browser.createChannel({ kind: 'browser', label: 'beta' }));

  const alphaPage = await alpha.open();
  const betaPage = await beta.open();
  await alpha.call('Page.enable', {}, alphaPage.sessionId);
  await beta.call('Page.enable', {}, betaPage.sessionId);

  await alpha.call('Page.navigate', { url: 'data:text/html,<title>ALPHA</title>' }, alphaPage.sessionId);
  await alpha.waitFor(entry => entry.method === 'Page.frameNavigated');
  await new Promise(resolve => setTimeout(resolve, 300));

  assert.ok(alpha.events.some(entry => entry.method === 'Page.frameNavigated'));
  // Beta's own session may emit lifecycle events; what must never arrive is an
  // event about *alpha's* page.
  const leaked = beta.events.filter(entry => entry.method === 'Page.frameNavigated'
    && String(entry.params?.frame?.url || '').includes('ALPHA'));
  assert.deepEqual(leaked, [], 'page events never cross a client boundary');

  alpha.channel.close();
  beta.channel.close();
});

test('mux: a page-bound channel hides the session id it rides on', async () => {
  if (!browser) return;
  const plain = client(browser, await browser.createChannel({ kind: 'browser', label: 'plain' }));
  const created = await plain.call('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result.targetId;

  // The same shape a `/devtools/page/<id>` WebSocket has: no session id anywhere.
  const page = client(browser, await browser.createChannel({ kind: 'page', targetId, label: 'page' }));
  await page.call('Page.enable');
  await page.call('Page.navigate', { url: 'data:text/html,<title>PAGE-CHANNEL</title>' });
  const navigated = await page.waitFor(entry => entry.method === 'Page.loadEventFired');
  assert.equal('sessionId' in navigated, false);

  const evaluated = await page.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  assert.equal(evaluated.result.result.value, 'PAGE-CHANNEL');
  assert.equal('sessionId' in evaluated, false, 'the client never sees the session it is bound to');

  // A channel bound to something that is not there fails loudly at creation.
  await assert.rejects(browser.createChannel({ kind: 'page', targetId: 'nope', label: 'gone' }));

  page.channel.close();
  plain.channel.close();
});

test('mux: a command without an id is refused at the transport', async () => {
  if (!browser) return;
  const client_ = client(browser, await browser.createChannel({ kind: 'browser', label: 'noid' }));

  const refused = await new Promise(resolve => client_.rawSend('{"method":"Runtime.evaluate","params":{}}', resolve));
  assert.ok(refused instanceof Error, 'the callback reports the problem');
  assert.match(refused.message, /requires a CDP command id/);

  const notJson = await new Promise(resolve => client_.rawSend('not json at all', resolve));
  assert.ok(notJson instanceof Error);

  // The client is still usable afterwards: a bad frame must not take the
  // connection, or the browser, down with it.
  const alive = await client_.call('Browser.getVersion');
  assert.ok(alive.result.product);
  client_.channel.close();
});

test('mux: losing the pipe fails every waiter and closes every client', async () => {
  const executablePath = await resolveChromiumExecutable();
  if (!executablePath) return;
  const dir = await mkdtemp(join(tmpdir(), 'hob-pipe-drop-'));
  const dying = spawn(executablePath, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  dying.stdout?.resume();
  dying.stderr?.resume();
  const pipe = new PipeChromium({ child: dying, label: 'dying' });
  await pipe.request('Browser.getVersion');

  const client_ = client(pipe, await pipe.createChannel({ kind: 'browser', label: 'client' }));
  const closed = new Promise(resolve => client_.channel.once('close', resolve));

  // A command Chromium will never answer on its own: a page promise that never
  // settles. That makes "the pipe died with work in flight" deterministic instead
  // of a race against how fast a trivial command returns.
  const page = await client_.open();
  const inFlight = client_.call('Runtime.evaluate',
    { expression: 'new Promise(() => {})', awaitPromise: true }, page.sessionId)
    .then(() => 'resolved', error => error);
  const internal = pipe.request('Browser.getVersion').then(() => 'resolved', error => error);

  await stopChromium(dying).catch(() => undefined);
  // On Windows the pipe closes with the process; on Linux it may take the exit
  // event first. Either way both waiters must be told, not left hanging.
  const [inFlightOutcome, internalOutcome] = await Promise.all([inFlight, internal, closed]);
  assert.ok(inFlightOutcome instanceof Error, 'a pending client command is failed, not forgotten');
  assert.ok(internalOutcome instanceof Error, 'a pending internal command is failed too');
  assert.equal(pipe.closed, true);
  assert.equal(client_.channel.readyState, 3);
  // And a request made after the fact fails immediately rather than waiting.
  await assert.rejects(pipe.request('Browser.getVersion'));
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
});
