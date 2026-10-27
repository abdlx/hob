import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SMOKE_RECOVERY_PROMPT, SMOKE_RECOVERY_REPLY, SMOKE_RECOVERY_RESUME } from './smoke-model.mjs';

/** Crash only the caller's disposable image after a provider has accepted a turn. */
export async function verifyActiveCrashRecovery({ api, request, retry, check, fixture, crash }) {
  const conversation = await api('/api/sessions', 'POST', { title: 'Disposable active-crash proof', agentId: 'default' });
  const path = '/api/sessions/' + encodeURIComponent(conversation.id);
  const requestKey = randomUUID();
  // Observe the stream concurrently: waiting for completion would test settled work.
  const stream = request(path + '/turns', 'POST', { content: SMOKE_RECOVERY_PROMPT, idempotencyKey: requestKey })
    .then(response => response.text()).catch(() => 'Transport ended during intentional crash.');
  await retry('the held provider request', async () => {
    const state = await fixture('/smoke/recovery');
    assert.equal(state.requests, 1); assert.equal(state.held, 1);
  }, 30000);
  const before = (await api(path + '/run')).run;
  check('the crash probe interrupts an actually running native admission', before?.status === 'running' && Boolean(before.runId));
  await crash();
  await retry('the native authority after the active crash', async () => { assert.equal((await api('/api/readiness')).ready, true); });
  const run = await retry('the interrupted admission receipt', async () => {
    const result = (await api(path + '/run')).run;
    assert.equal(result?.runId, before.runId);
    assert.equal(result.status, 'unknown');
    assert.equal(result.canResolveUnknown, true);
    return result;
  }, 30000);
  check('an interrupted model call retains its native admission and unknown-work fence', true);
  const history = await api(path + '/messages');
  check('an interrupted model call never invents a successful reply', !history.some(row => row.role === 'assistant' && row.content.includes(SMOKE_RECOVERY_REPLY)));
  const replay = await request(path + '/turns', 'POST', { content: SMOKE_RECOVERY_PROMPT, idempotencyKey: requestKey });
  check('the interrupted input cannot be replayed after a full container crash', replay.status === 409);
  await replay.arrayBuffer();
  await fixture('/smoke/recovery/release', 'POST');
  check('recovery observes the interrupted input without calling the provider again', (await fixture('/smoke/recovery')).requests === 1);
  await api(path + '/resolve-unknown', 'POST', { expectedRevision: run.revision, confirmReviewed: true });
  check('explicit side-effect review resolves the unknown native admission', (await api(path + '/run')).run?.status === 'interrupted');
  const resumed = await request(path + '/turns', 'POST', { content: SMOKE_RECOVERY_RESUME, idempotencyKey: randomUUID() });
  const result = await resumed.text();
  check('a fresh reviewed turn works after crash recovery', resumed.ok && result.includes('event: done') && result.includes(SMOKE_RECOVERY_RESUME) && !result.includes('event: error'));
  check('reviewed recovery never resends the original input', (await fixture('/smoke/recovery')).requests === 1);
  await stream;
}
