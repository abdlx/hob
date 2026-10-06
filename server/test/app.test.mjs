import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, SETTINGS_RPC_METHODS } from '../app.mjs';
import { GatewayError } from '../gateway.mjs';

const gateway = new EventEmitter();
gateway.connected = true;
const calls = [];
let handler;
gateway.request = async (method, params = {}) => { calls.push({ method, params }); return handler(method, params); };
let directory, server, origin, cookie;
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'muse-boundary-'));
  await mkdir(path.join(directory, 'web'));
  await writeFile(path.join(directory, 'web/index.html'), '<html>Muse</html>');
  await mkdir(path.join(directory, 'media/browser'), { recursive: true });
  await writeFile(path.join(directory, 'media/browser/screen.png'), Buffer.from([137, 80, 78, 71]));
  server = createApp({ gateway, password: 'synthetic-password', staticDir: path.join(directory, 'web'), stateDir: directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const result = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'synthetic-password' }) });
  assert.equal(result.status, 200);
  cookie = result.headers.get('set-cookie').split(';')[0];
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
const request = (route, method = 'GET', data, headers = {}) => fetch(`${origin}${route}`, { method, headers: { Cookie: cookie, ...(data ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });

test('credentials stay server-side, unauthorized requests fail, cookies are HttpOnly', async () => {
  const unauth = await fetch(`${origin}/api/sessions`);
  assert.equal(unauth.status, 401);
  const login = await request('/api/auth/login', 'POST', { password: 'synthetic-password' });
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.deepEqual(await (await request('/api/auth/status')).json(), { authenticated: true, configured: true, gatewayConnected: true });
  const forged = await request('/api/sessions', 'GET', undefined, { Cookie: `${cookie}tampered` });
  assert.equal(forged.status, 401);
});
test('cross-origin mutations are refused before gateway side effects', async () => {
  calls.length = 0;
  const result = await request('/api/goals', 'POST', { name: 'Do work' }, { Origin: 'https://attacker.example' });
  assert.equal(result.status, 403);
  assert.equal(calls.length, 0);
});
test('session creation persists through the canonical RPC and history is translated', async () => {
  handler = (method, params) => {
    if (method === 'sessions.create') return { ok: true, key: 'agent:main:custom', entry: { agentId: 'main', displayName: params.displayName } };
    if (method === 'chat.history') return { messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Real result' }, { type: 'thinking', thinking: 'private' }] }] };
    throw new Error(method);
  };
  const session = await (await request('/api/sessions', 'POST', { title: 'Review', agentId: 'main' })).json();
  assert.equal(session.id, 'agent:main:custom');
  assert.deepEqual(calls.at(-1), { method: 'sessions.create', params: { agentId: 'main', displayName: 'Review' } });
  const messages = await (await request('/api/sessions/agent%3Amain%3Acustom/messages')).json();
  assert.equal(messages[0].content, 'Real result');
});
test('agent model selection forwards the exact published runtime and profile exposes its ID', async () => {
  calls.length = 0;
  handler = (method, params) => {
    if (method === 'agents.list') return { defaultId: 'main', agents: [{ id: 'main', model: { primary: 'openai/synthetic-model' }, agentRuntime: { id: 'synthetic-runtime', source: 'defaults' } }] };
    if (method === 'config.get') return { valid: true, config: { agents: { entries: { main: { identity: { name: 'Committed identity' } } } } } };
    if (method === 'agents.update') {
      assert.deepEqual(params, { agentId: 'main', model: 'openai/synthetic-model', agentRuntime: 'synthetic-runtime' });
      return { ok: true, agentId: 'main' };
    }
    throw new Error(method);
  };
  const response = await request('/api/agent', 'PATCH', { model: 'openai/synthetic-model', agentRuntime: 'synthetic-runtime' });
  assert.equal(response.status, 200);
  const profile = await response.json();
  assert.equal(profile.agentRuntime, 'synthetic-runtime');
  assert.equal(profile.name, 'Committed identity');
  const sourceSchema = await readFile(new URL('../../openclaw/packages/gateway-protocol/src/schema/agents-models-skills.ts', import.meta.url), 'utf8');
  assert.match(sourceSchema, /agentRuntime: Type\.Optional\(NonEmptyString\)/);
  calls.length = 0;
  const invalid = await request('/api/agent', 'PATCH', { id: 'main', model: 'openai/synthetic-model', agentRuntime: { id: 'synthetic-runtime' } });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 0);
});
test('stream handles synchronous events before admission reply and replaces content correctly', async () => {
  handler = (method, params) => {
    assert.equal(method, 'chat.send');
    for (const payload of [
      { state: 'delta', deltaText: 'Old' },
      { state: 'delta', deltaText: 'New', replace: true },
      { state: 'final', message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'New' }] } },
    ]) gateway.emit('event', { type: 'event', event: 'chat', payload: { ...payload, sessionKey: params.sessionKey, runId: params.idempotencyKey } });
    return { runId: params.idempotencyKey, status: 'started' };
  };
  const result = await request('/api/sessions/agent%3Amain%3Acustom/turns', 'POST', { content: 'Hello', idempotencyKey: 'synthetic-run' });
  assert.equal(result.headers.get('content-type'), 'text/event-stream');
  const stream = await result.text();
  assert.match(stream, /event: delta/);
  assert.match(stream, /"replace":true/);
  assert.match(stream, /event: done/);
  assert.match(stream, /"content":"New"/);
});
test('streamed gateway errors are visible and calls are never retried', async () => {
  let count = 0;
  handler = () => { count++; throw new GatewayError('Synthetic outage'); };
  const result = await request('/api/sessions/agent%3Amain%3Acustom/turns', 'POST', { content: 'Hello' });
  assert.match(await result.text(), /event: error[\s\S]*Synthetic outage/);
  assert.equal(count, 1);
});
test('repeated completed turn closes promptly with a visible history reconciliation instruction', async () => {
  handler = () => ({ runId: 'synthetic-completed', status: 'ok' });
  const result = await request('/api/sessions/agent%3Amain%3Acustom/turns', 'POST', { content: 'Repeat', idempotencyKey: 'synthetic-completed' });
  const stream = await result.text();
  assert.match(stream, /already completed/);
  assert.match(stream, /"refresh":true/);
});
test('agent Markdown editing rejects traversal and requires optimistic concurrency', async () => {
  calls.length = 0;
  const badName = await request('/api/agent/files/..%2Fcredentials?agentId=main');
  assert.equal(badName.status, 400);
  assert.equal(calls.length, 0);
  const missingGuard = await request('/api/agent/files/SOUL.md?agentId=main', 'PUT', { content: 'New soul' });
  assert.equal(missingGuard.status, 400);
  handler = (method, params) => ({ ok: true, file: { name: params.name, content: params.content } });
  const saved = await request('/api/agent/files/MEMORY.md?agentId=main', 'PUT', { content: '# Memory', expectedMissing: true });
  assert.equal(saved.status, 200);
  assert.deepEqual(calls.at(-1).params, { agentId: 'main', name: 'MEMORY.md', content: '# Memory', expectedMissing: true });
});
test('config changes preserve gateway redaction sentinels and carry revision guards', async () => {
  handler = (method, params) => ({ accepted: true, raw: params.raw });
  const missing = await request('/api/settings', 'PATCH', { patch: { channels: {} } });
  assert.equal(missing.status, 400);
  const patch = { models: { providers: { synthetic: { apiKey: '__OPENCLAW_REDACTED__' } } } };
  const result = await request('/api/settings', 'PATCH', { patch, baseHash: 'revision-token' });
  assert.equal(result.status, 200);
  assert.equal(calls.at(-1).method, 'config.patch');
  assert.equal(calls.at(-1).params.baseHash, 'revision-token');
  assert.deepEqual(JSON.parse(calls.at(-1).params.raw), patch);
});
test('approval replay comes from gateway, decision kind is bound to authoritative record', async () => {
  handler = method => {
    if (method === 'sessions.list') return { sessions: [{ key: 'agent:main:custom' }] };
    if (method === 'sessions.messages.subscribe') return { approvalReplay: { approvals: [{ id: 'request/1', status: 'pending', presentation: { kind: 'exec', commandText: 'echo synthetic', allowedDecisions: ['allow-once', 'deny'] } }] } };
    if (method === 'approval.get') return { approval: { id: 'request/1', status: 'pending', presentation: { kind: 'exec', commandText: 'echo synthetic', allowedDecisions: ['allow-once', 'deny'] } } };
    if (method === 'approval.resolve') return { applied: true };
    throw new Error(method);
  };
  const approvals = await (await request('/api/security/approvals')).json();
  assert.equal(approvals[0].commandSnippet, 'echo synthetic');
  assert.equal(approvals[0].kind, 'exec');
  assert.equal(approvals[0].type, 'command');
  await request('/api/security/approvals/request%2F1', 'POST', { decision: 'approved', kind: 'plugin' });
  assert.deepEqual(calls.at(-1), { method: 'approval.resolve', params: { id: 'request/1', kind: 'exec', decision: 'allow-once' } });
});
test('browser screenshots cannot read arbitrary host files', async () => {
  handler = () => ({ path: path.join(directory, 'media/browser/screen.png') });
  const valid = await (await request('/api/browser/actions', 'POST', { action: 'screenshot', targetId: 't1' })).json();
  assert.match(valid.imageUrl, /^data:image\/png;base64,/);
  handler = () => ({ path: path.join(directory, 'web/index.html') });
  const denied = await request('/api/browser/actions', 'POST', { action: 'screenshot', targetId: 't1' });
  assert.equal(denied.status, 502);
});
test('library raw content comes through Gateway, executable artifacts download sandboxed', async () => {
  handler = () => ({ file: { name: 'result.html', content: '<script>alert(1)</script>', contentEncoding: 'utf8', mimeType: 'text/html' } });
  const result = await request('/api/library/file?sessionId=agent%3Amain%3Acustom&path=result.html&raw=1');
  assert.match(result.headers.get('content-security-policy'), /^sandbox/);
  assert.match(result.headers.get('content-disposition'), /^attachment/);
  assert.equal(await result.text(), '<script>alert(1)</script>');
});
test('binary media and larger images use canonical assets RPC with visible source size limits', async () => {
  handler = (method, params) => method === 'sessions.files.get'
    ? { file: { name: 'clip.mp3', previewKind: 'unsupported', size: 300000 } }
    : { assets: [{ ref: params.refs[0], mimeType: 'audio/mpeg', content: Buffer.from('synthetic-audio').toString('base64') }] };
  const result = await request('/api/library/file?sessionId=agent%3Amain%3Acustom&path=clip.mp3&raw=1');
  assert.equal(result.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await result.text(), 'synthetic-audio');
  assert.equal(calls.at(-1).method, 'sessions.files.assets');
  handler = (method, params) => method === 'sessions.files.get'
    ? { file: { name: 'large.png', size: 2 * 1024 * 1024 } }
    : { assets: [{ ref: params.refs[0], error: 'too_large' }] };
  const tooLarge = await request('/api/library/file?sessionId=agent%3Amain%3Acustom&path=large.png&download=1');
  assert.equal(tooLarge.status, 413);
  assert.match((await tooLarge.json()).error, /1 MiB/);
});
test('library discovers exec-created workspace media and deduplicates shared roots', async () => {
  let searches = 0;
  handler = (method, params) => {
    if (method === 'sessions.list') return { sessions: [{ key: 'agent:main:a' }, { key: 'agent:main:b' }] };
    if (params.search) { searches++; return { browser: { entries: [{ name: 'chart.png', path: 'outputs/chart.png', kind: 'file' }], truncated: true } }; }
    return { root: '/workspace', files: [], browser: { entries: [{ name: 'root.png', path: 'root.png', kind: 'file' }] } };
  };
  const result = await (await request('/api/library?kind=media')).json();
  assert.deepEqual(result.files.map(f => f.name), ['root.png', 'chart.png']);
  assert.equal(result.truncated, true);
  assert.equal(searches, 1);
});
test('static SPA fallback works and API typo never returns HTML', async () => {
  const result = await request('/settings');
  assert.match(result.headers.get('content-security-policy'), /img-src 'self' data: blob: https: http:;/);
  assert.equal(result.headers.get('referrer-policy'), 'same-origin');
  assert.match(await result.text(), /Muse/);
  const typo = await request('/api/no-such-endpoint');
  assert.equal(typo.status, 404);
  assert.match(typo.headers.get('content-type'), /application\/json/);
  assert.equal((await request('/%5c..%5csecret')).status, 400);
});
test('health and authenticated readiness distinguish connection from writable startup', async () => {
  gateway.connected = false;
  assert.equal((await request('/healthz')).status, 503);
  gateway.connected = true;
  gateway.getStartupStatus = async () => ({ ready: false, status: 'starting' });
  assert.equal((await request('/healthz')).status, 503);
  assert.deepEqual(await (await request('/api/readiness')).json(), { ready: false, status: 'starting' });
  gateway.getStartupStatus = async () => ({ ready: true, status: 'started' });
  assert.equal((await request('/healthz')).status, 200);
  delete gateway.getStartupStatus;
});
test('settings RPC allowlist matches the modified OpenClaw catalog and forbids raw secret retrieval', async () => {
  const catalog = await readFile(new URL('../../openclaw/src/gateway/methods/core-descriptors.ts', import.meta.url), 'utf8');
  for (const method of SETTINGS_RPC_METHODS) assert.ok(catalog.includes(`"${method}"`), `${method} must exist in the canonical Gateway`);
  assert.equal(SETTINGS_RPC_METHODS.has('secrets.resolve'), false);
  calls.length = 0;
  assert.equal((await request('/api/rpc', 'POST', { method: 'secrets.resolve' })).status, 403);
  assert.equal(calls.length, 0);
});
test('settings cannot remove local mode or commit a remote mode that prevents container startup', async () => {
  calls.length = 0;
  for (const value of [
    { patch: { gateway: { mode: 'remote' } } },
    { patch: { gateway: { mode: null } } },
    { patch: { gateway: null } },
    { patch: { gateway: { port: 18789 } }, replacePaths: ['gateway'] },
  ]) {
    const response = await request('/api/settings', 'PATCH', { baseHash: 'synthetic-revision', ...value });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Keep gateway.mode set to local/);
  }
  assert.equal(calls.length, 0);
});
test('scheduled tasks include disabled jobs and consume canonical pagination', async () => {
  handler = (method, params) => {
    assert.equal(method, 'cron.list');
    assert.equal(params.includeDisabled, true);
    return { jobs: params.offset === 0 ? Array.from({ length: 200 }, (_, index) => ({ id: `job-${index}` })) : [{ id: 'job-200', enabled: false }] };
  };
  const result = await (await request('/api/goals')).json();
  assert.equal(result.jobs.length, 201);
  assert.equal(result.jobs.at(-1).enabled, false);
});
