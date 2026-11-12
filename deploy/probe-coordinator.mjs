import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { parse, stringify } = require('yaml');
if (process.env.HOB_SMOKE_COORDINATOR !== '1') throw new Error('Requires disposable coordinator fixture');
const origin = 'http://127.0.0.1:' + (process.env.HOB_PORT || 3000);
const requestOrigin = new URL(process.env.HOB_PUBLIC_URL || origin).origin;
let cookie;
async function api(route, method = 'GET', input) {
  const response = await fetch(origin + route, { method, headers: { Origin: requestOrigin, Cookie: cookie || '', 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(120000) });
  assert.equal(response.ok, true, route + ' returned ' + response.status);
  if (route === '/api/auth/login') cookie = response.headers.get('set-cookie').split(';')[0];
  return response;
}
async function eventually(read, accept, label) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out: ' + label);
}
const state = () => fetch('http://smoke-model:18793/smoke/coordinator').then(response => response.json());
await api('/api/auth/login', 'POST', { password: process.env.HOB_PASSWORD });
const all = await (await api('/api/sessions')).json(), main = all.find(row => row.isMain);
assert.equal(all.filter(row => row.isMain).length, 1);
const session = all.find(row => !row.isMain && row.transport === 'canonical' && !row.readOnly)
  || await (await api('/api/sessions', 'POST', { title: 'Disposable coordinator acceptance' })).json();
const route = '/api/sessions/' + encodeURIComponent(session.id);
const turn = content => api(route + '/turns', 'POST', { content, idempotencyKey: 'coordinator-' + crypto.randomUUID() }).then(response => response.text());
assert.match(await turn('HOB_COORDINATOR_START'), /HOB_COORDINATOR_ACCEPTED/);
await eventually(state, value => value.held === 1, 'worker held in provider');
assert.match(await turn('HOB_COORDINATOR_FOLLOWUP'), /HOB_COORDINATOR_AVAILABLE/);
assert.equal((await state()).held, 1, 'Coordinator answered while execution remained active');
assert.match(await turn('HOB_COORDINATOR_CORRECT'), /HOB_COORDINATOR_CONTROL_ACCEPTED/);
// Change only the synthetic model ID: the endpoint and test credential remain
// on this disposable private fixture. The same native conversation must follow it.
const file = process.env.HERMES_HOME + '/config.yaml';
const config = parse(await readFile(file, 'utf8'));
const previous = structuredClone(config.model);
try {
  config.model = { ...config.model, default: 'hob-coordinator-model-v2' };
  await writeFile(file, stringify(config));
  assert.match(await turn('HOB_COORDINATOR_FOLLOWUP model changed'), /HOB_COORDINATOR_AVAILABLE/);
  const mainRoute = '/api/sessions/' + encodeURIComponent(main.id);
  assert.match(await (await api(mainRoute + '/turns', 'POST', { content: 'HOB_COORDINATOR_FOLLOWUP main history', idempotencyKey: 'coordinator-main-' + crypto.randomUUID() })).text(), /HOB_COORDINATOR_AVAILABLE/);
  assert.ok((await state()).models.includes('hob-coordinator-model-v2'));
  assert.equal((await state()).held, 1, 'Changing models must not cancel the running worker');
  assert.ok((await (await api(mainRoute + '/messages')).json()).some(row => row.content.includes('HOB_COORDINATOR_FOLLOWUP main history')));
} finally { config.model = previous; await writeFile(file, stringify(config)); }
assert.equal((await (await api('/api/sessions')).json()).find(row => row.isMain).id, main.id);
await fetch('http://smoke-model:18793/smoke/coordinator/release', { method: 'POST' });
await eventually(() => api(route + '/messages').then(response => response.json()), rows => rows.some(row => row.role === 'assistant' && row.content.includes('HOB_COORDINATOR_DONE')), 'completion automatically woke coordinator');
await api(route, 'DELETE', {});
assert.equal((await (await api('/api/sessions')).json()).some(row => row.id === session.id), false);
const protectedMain = await fetch(origin + '/api/sessions/' + encodeURIComponent(main.id), { method: 'DELETE', headers: { Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(protectedMain.status, 409);
console.log('Coordinator proof passed: execution guard, forced background dispatch, live chat, worker steering, automatic completion, model continuity, manual deletion, protected Main chat.');
