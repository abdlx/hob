import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../app.mjs';
import { HermesClient, HermesError, hermesSessionKey, hermesNativeSessionKey, parseHermesSessionKey } from '../hermes-client.mjs';
import { HermesRunJournal } from '../hermes-run-journal.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-native-chat-'));
  const shared = { sessions: new Map(), admissions: new Map(), calls: [], mode: 'complete', sequence: 0, generation: 5 };
  const legacyCalls = [];
  const legacy = http.createServer(async (req, res) => {
    legacyCalls.push(req.url);
    const pathname = new URL(req.url, 'http://test').pathname.replace(/^\/p\/[^/]+/, '');
    const value = pathname === '/api/profiles' ? { profiles: [{ name: 'default' }, { name: 'coder' }] }
      : pathname === '/api/health' ? { ok: true }
      : pathname === '/api/sessions' ? { data: [{ id: 'older-api', source: 'api', title: 'Existing API conversation' },
        { id: 'native-row', source: 'gui', title: 'Already in native feed' }] }
      : pathname.endsWith('/messages') ? { data: [{ id: 'old-message', role: 'assistant', content: 'Old history' }] }
      : pathname === '/v1/capabilities' ? { features: { run_status: true, run_events_sse: true } } : { error: 'unexpected legacy call' };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => legacy.listen(0, '127.0.0.1', resolve));
  const nativeOwner = profile => `native-owner-${profile}`;
  class Bridge extends EventEmitter {
    async rpc(profile, method, params = {}) {
      shared.calls.push({ profile, method, params: structuredClone(params) });
      if (!['default', 'coder'].includes(profile)) throw new HermesError(404, 'Bot not enrolled.', 'BOT_NOT_FOUND');
      if (method === 'runtime.describe') return { capabilities: ['durable-admission-v1', 'event-replay-v1', 'local-cli-create-v1'] };
      if (method === 'session.create') {
        const sid = 'local-' + ++shared.sequence;
        shared.sessions.set(profile + ':' + sid, { session_id: sid, id: sid, title: '', messages: [], prompts: [], pending: [], revision: 1 });
        return { session_id: sid, revision: 1, execution_generation: shared.generation };
      }
      if (method === 'session.list') return { sessions: params.scope === 'stored' ? [] : [...shared.sessions.entries()]
        .filter(([key]) => key.startsWith(profile + ':')).map(([, item]) => ({ id: item.session_id, session_id: item.session_id, title: item.title })) };
      const session = shared.sessions.get(profile + ':' + params.session_id);
      if (!session) throw new HermesError(409, 'Missing session.', 'not_found');
      if (method === 'session.mutate') { session.title = params.payload.title; return { title: session.title }; }
      if (method === 'session.resume') return { ...structuredClone(session), authority_epoch: 11, execution_generation: shared.generation,
        info: { private_policy: 'do-not-expose-inventory' }, running: session.pending.some(item => item.status === 'started') };
      if (method === 'prompt.submit') {
        const id = 'admission-' + ++shared.sequence;
        const receipt = { admission_id: id, ref: { profile_id: nativeOwner(profile), session_id: params.session_id }, sequence: shared.sequence,
          status: 'started', outcome: null, authority_epoch: 11, execution_generation: shared.generation };
        shared.admissions.set(id, receipt);
        session.pending.push({ ...receipt, input_id: params.submission_id, text: params.text });
        session.messages.push({ id: 'user-' + id, role: 'user', content: params.text });
        if (shared.mode === 'question') session.prompts = [{ kind: 'clarify', prompt_id: 'question-' + id, execution_generation: shared.generation,
          question: 'Which result?', choices: ['Report', 'Chart'], multi_select: false }];
        if (shared.mode === 'approval') session.prompts = [{ kind: 'approval', prompt_id: 'approval-' + id, execution_generation: shared.generation,
          command: 'echo proof', description: 'Approve proof command', choices: ['once', 'deny'] }];
        if (shared.mode === 'unknown') { receipt.status = 'unknown'; session.pending[0].status = 'unknown'; }
        if (shared.mode === 'complete') {
          this.emit('event', { profile, event: { type: 'message.delta', session_id: params.session_id, admission_id: id, payload: { text: 'Native ' } } });
          this.finish(session, receipt);
        }
        if (shared.mode === 'lost-acceptance') throw new HermesError(503, 'Connection lost.', 'SESSION_UNAVAILABLE');
        return structuredClone(receipt);
      }
      const receipt = shared.admissions.get(params.admission_id) || shared.admissions.get(session.pending[0]?.admission_id);
      if (method === 'prompt.receipt') return structuredClone(receipt);
      if (method === 'clarify.respond' || method === 'approval.respond') {
        const prompt = session.prompts.find(item => item.prompt_id === params.prompt_id);
        if (!prompt || prompt.execution_generation !== params.execution_generation) throw new HermesError(409, 'Stale prompt.', 'stale_generation');
        this.finish(session, receipt); return { status: 'resolved' };
      }
      if (method === 'session.interrupt') {
        if (params.execution_generation !== shared.generation) throw new HermesError(409, 'Stale generation.', 'stale_generation');
        this.finish(session, receipt, 'interrupted'); return { execution_state: 'terminal' };
      }
      if (method === 'prompt.cancel') { this.finish(session, receipt, 'cancelled'); return structuredClone(receipt); }
      if (method === 'prompt.resolve_unknown') {
        if (params.execution_generation !== shared.generation) throw new HermesError(409, 'Stale generation.', 'stale_generation');
        this.finish(session, receipt, 'interrupted'); return structuredClone(receipt);
      }
      throw new Error('Unexpected native method ' + method);
    }
    finish(session, receipt, outcome = 'completed') {
      receipt.status = 'terminal'; receipt.outcome = outcome;
      receipt.result = { final_response: 'Native final response' };
      session.pending = []; session.prompts = [];
      session.messages.push({ role: 'assistant', content: 'Native final response' });
    }
    close() { this.emit('event', { profile: 'default', event: { type: 'gateway.disconnected' } }); }
  }
  const f = { shared, legacyCalls, async start() {
    const url = `http://127.0.0.1:${legacy.address().port}`;
    f.client = new HermesClient({ runtimeUrl: url, dashboardUrl: url, apiKey: 'synthetic-runtime', dashboardToken: 'synthetic-settings' });
    f.bridge = new Bridge(); f.journal = await HermesRunJournal.open(root);
    f.app = createApp({ gateway: f.client, nativeSessions: f.bridge, runJournal: f.journal, password: 'synthetic-login' });
    await new Promise(resolve => f.app.listen(0, '127.0.0.1', resolve));
    f.origin = `http://127.0.0.1:${f.app.address().port}`;
    const login = await fetch(f.origin + '/api/auth/login', { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-login' }) });
    f.cookie = login.headers.get('set-cookie').split(';')[0];
  }, async stop() {
    f.bridge.close(); f.client.stop(); f.app.closeAllConnections();
    await new Promise(resolve => f.app.close(resolve));
  }, call(pathname, method = 'GET', body, profile = 'default') {
    return fetch(f.origin + pathname, { method, headers: { Cookie: f.cookie, 'X-Hob-Profile': profile,
      ...(body ? { Origin: f.origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }, async create(profile = 'default', title = 'New Conversation') {
    const response = await f.call('/api/sessions', 'POST', { title }, profile);
    assert.equal(response.status, 201); return response.json();
  }, turn(key, content = 'Hello') { return f.call(`/api/sessions/${key}/turns`, 'POST', { content, idempotencyKey: 'request-' + shared.sequence }); } };
  await f.start();
  t.after(async () => {
    await f.stop(); legacy.closeAllConnections(); await new Promise(resolve => legacy.close(resolve));
    const resolved = await realpath(root), allowed = await realpath(tmpdir());
    assert.equal(path.dirname(resolved), allowed); assert.match(path.basename(resolved), /^hob-native-chat-/);
    await rm(resolved, { recursive: true, force: true });
  });
  return f;
}

test('new conversations are distinct canonical sessions and inherit only their own current profile setup', async t => {
  const f = await fixture(t);
  const a = await f.create('coder'), b = await f.create('coder');
  assert.notEqual(a.id, b.id);
  assert.equal(parseHermesSessionKey(a.id).transport, 'canonical');
  const creates = f.shared.calls.filter(call => call.method === 'session.create');
  assert.equal(creates.length, 2); assert.equal(creates.every(call => call.profile === 'coder'), true);
  assert.equal(creates.every(call => call.params.source === 'gui' && call.params.follow_profile_config === true && !('title' in call.params)), true);
});

test('native and old API history keep distinct IDs and old reads retain their original owner', async t => {
  const f = await fixture(t); const native = await f.create('coder');
  const sessions = await (await f.call('/api/sessions', 'GET', undefined, 'coder')).json();
  assert.equal(sessions.some(item => item.id === native.id), true);
  assert.equal(sessions.some(item => item.id === hermesSessionKey('coder', 'older-api')), true);
  assert.equal(sessions.find(item => item.id === hermesSessionKey('coder', 'older-api')).readOnly, true);
  assert.equal(sessions.some(item => item.title === 'Already in native feed'), false);
  const history = await (await f.call(`/api/sessions/${hermesSessionKey('coder', 'older-api')}/messages`)).json();
  assert.equal(history[0].content, 'Old history'); assert.match(f.legacyCalls.at(-1), /^\/p\/coder\//);
  assert.equal((await f.turn(hermesSessionKey('coder', 'older-api'))).status, 409);
  assert.equal(f.legacyCalls.some(url => url.includes('/v1/runs')), false);
});

test('chat uses native durable receipts and never dispatches through HTTP runs', async t => {
  const f = await fixture(t); const session = await f.create('coder');
  const response = await f.turn(session.id); const stream = await response.text();
  assert.match(stream, /event: accepted/); assert.match(stream, /event: delta/); assert.match(stream, /event: done/);
  assert.match(stream, /Native final response/); assert.doesNotMatch(stream, /private_policy|do-not-expose|event: error/);
  assert.equal(f.shared.calls.find(call => call.method === 'prompt.submit').profile, 'coder');
  assert.equal(f.legacyCalls.some(url => url.includes('/v1/runs')), false);
});

test('real HTTP question controls send exact native prompt and generation after adapter restart', async t => {
  const f = await fixture(t); f.shared.mode = 'question'; const session = await f.create();
  const response = await f.turn(session.id); const interrupted = response.text().catch(() => 'connection closed');
  await f.stop(); await interrupted; await f.start();
  const state = await (await f.call(`/api/sessions/${session.id}/run`)).json();
  assert.equal(state.run.questions[0].question, 'Which result?');
  const answered = await f.call(`/api/sessions/${session.id}/clarify`, 'POST', { expectedRevision: state.run.revision, promptId: state.run.questions[0].id, answer: 'Report' });
  assert.equal(answered.status, 200);
  const call = f.shared.calls.find(call => call.method === 'clarify.respond');
  assert.equal(call.params.execution_generation, 5); assert.match(call.params.prompt_id, /^question-/); assert.equal(call.params.answer, 'Report');
  const final = await (await f.call(`/api/sessions/${session.id}/run`)).json(); assert.equal(final.run.status, 'completed');
  assert.equal(f.shared.calls.filter(call => call.method === 'prompt.submit').length, 1);
});

test('stale question revisions and changed approval generations cannot answer newer prompts', async t => {
  const f = await fixture(t); f.shared.mode = 'approval'; const session = await f.create();
  const response = await f.turn(session.id); const stream = response.text().catch(() => 'closed');
  const before = await (await f.call('/api/security/approvals')).json(); assert.equal(before.length, 1);
  const state = f.shared.sessions.values().next().value; state.prompts[0].execution_generation++;
  const stale = await f.call(`/api/security/approvals/${before[0].id}`, 'POST', { decision: 'approved' });
  assert.equal(stale.status, 409); assert.equal(f.shared.calls.some(call => call.method === 'approval.respond'), false);
  f.bridge.close(); await stream;
});

test('native approvals remain profile-bound and approve once uses canonical authority', async t => {
  const f = await fixture(t); f.shared.mode = 'approval'; const session = await f.create('coder');
  const response = await f.turn(session.id); const stream = response.text();
  assert.equal((await (await f.call('/api/security/approvals')).json()).length, 0);
  const approvals = await (await f.call('/api/security/approvals', 'GET', undefined, 'coder')).json();
  const accepted = await f.call(`/api/security/approvals/${approvals[0].id}`, 'POST', { decision: 'approved' }, 'coder');
  assert.equal(accepted.status, 200); assert.match(await stream, /event: done/);
  const call = f.shared.calls.find(call => call.method === 'approval.respond');
  assert.equal(call.profile, 'coder'); assert.equal(call.params.choice, 'once'); assert.equal(call.params.execution_generation, 5);
});

test('stop requires the displayed admission and uses its current native execution generation', async t => {
  const f = await fixture(t); f.shared.mode = 'question'; const session = await f.create();
  const response = await f.turn(session.id); const stream = response.text();
  assert.equal((await f.call(`/api/sessions/${session.id}/abort`, 'POST', { expectedRunId: 'stale' })).status, 409);
  assert.equal(f.shared.calls.some(call => call.method === 'session.interrupt'), false);
  const state = await (await f.call(`/api/sessions/${session.id}/run`)).json();
  assert.equal((await f.call(`/api/sessions/${session.id}/abort`, 'POST', { expectedRunId: state.run.runId })).status, 200);
  assert.equal(f.shared.calls.find(call => call.method === 'session.interrupt').params.execution_generation, 5);
  assert.doesNotMatch(await stream, /event: done/);
});

test('lost native acceptance recovers its pending ID by observation without replay', async t => {
  const f = await fixture(t); f.shared.mode = 'lost-acceptance'; const session = await f.create();
  assert.equal((await f.turn(session.id)).status, 503);
  const state = await (await f.call(`/api/sessions/${session.id}/run`)).json(); assert.match(state.run.runId, /^admission-/);
  assert.equal(state.run.canRecover, false);
  assert.equal((await f.turn(session.id)).status, 409);
  assert.equal(f.shared.calls.filter(call => call.method === 'prompt.submit').length, 1);
});

test('unknown native outcomes remain fenced and explicit resolution binds current epoch/generation', async t => {
  const f = await fixture(t); f.shared.mode = 'unknown'; const session = await f.create();
  const stream = await (await f.turn(session.id)).text(); assert.match(stream, /event: error/); assert.doesNotMatch(stream, /event: done/);
  const state = await (await f.call(`/api/sessions/${session.id}/run`)).json(); assert.equal(state.run.canResolveUnknown, true);
  assert.equal((await f.call(`/api/sessions/${session.id}/resolve-unknown`, 'POST', { expectedRevision: 'stale', confirmReviewed: true })).status, 409);
  const resolved = await f.call(`/api/sessions/${session.id}/resolve-unknown`, 'POST', { expectedRevision: state.run.revision, confirmReviewed: true });
  assert.equal(resolved.status, 200); assert.equal(f.shared.calls.find(call => call.method === 'prompt.resolve_unknown').params.execution_generation, 5);
});

test('browser disconnect preserves admitted work and a restarted adapter cannot submit a duplicate', async t => {
  const f = await fixture(t); f.shared.mode = 'question'; const session = await f.create();
  const response = await f.turn(session.id); const stream = response.text().catch(() => 'closed');
  await f.stop(); await stream; await f.start();
  assert.equal((await f.turn(session.id)).status, 409);
  assert.equal(f.shared.calls.filter(call => call.method === 'prompt.submit').length, 1);
  assert.equal(f.shared.calls.some(call => ['session.interrupt', 'prompt.cancel'].includes(call.method)), false);
});

test('readiness checks the selected native authority; HTTP readiness cannot mask an incompatible session owner', async t => {
  const f = await fixture(t);
  assert.equal((await (await f.call('/api/readiness', 'GET', undefined, 'coder')).json()).ready, true);
  assert.equal(f.shared.calls.find(call => call.method === 'runtime.describe').profile, 'coder');
  const original = f.bridge.rpc.bind(f.bridge);
  f.bridge.rpc = (profile, method, params) => method === 'runtime.describe' ? Promise.resolve({ capabilities: [] }) : original(profile, method, params);
  assert.equal((await (await f.call('/api/readiness')).json()).ready, false);
});

test('missing native receipts do not erase history or authorize another task', async t => {
  const f = await fixture(t); f.shared.mode = 'question'; const session = await f.create();
  const response = await f.turn(session.id); const stream = response.text().catch(() => 'closed');
  const original = f.bridge.rpc.bind(f.bridge);
  f.shared.sessions.values().next().value.pending = [];
  f.shared.sessions.values().next().value.prompts = [];
  f.bridge.rpc = (profile, method, params) => {
    if (method === 'prompt.receipt') throw new HermesError(409, 'Receipt not found.', 'not_found');
    return original(profile, method, params);
  };
  const history = await f.call(`/api/sessions/${session.id}/messages`); assert.equal(history.status, 200);
  assert.equal((await history.json()).some(message => message.content === 'Hello'), true);
  const state = await (await f.call(`/api/sessions/${session.id}/run`)).json(); assert.equal(state.run.status, 'unavailable');
  assert.equal((await f.turn(session.id)).status, 409);
  f.bridge.close(); await stream;
});

test('unavailable native creation cannot silently create a limited HTTP conversation', async t => {
  const f = await fixture(t);
  f.bridge.rpc = async () => { throw new HermesError(503, 'Owner unavailable.', 'SESSION_UNAVAILABLE'); };
  const before = f.legacyCalls.length;
  assert.equal((await f.call('/api/sessions', 'POST', { title: 'New Conversation' })).status, 503);
  assert.equal(f.legacyCalls.length, before);
});
