import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlLease, AGENT, HUMAN } from '../browser-lease.mjs';

test('lease: the agent holds control by default and admits mutations', async () => {
  const lease = new ControlLease();
  assert.equal(lease.holder, AGENT);
  const admission = await lease.enterAgentMutation();
  assert.equal(admission.ok, true);
  assert.equal(lease.inFlight, 1);
  admission.release();
  assert.equal(lease.inFlight, 0);
  // Releasing twice must not double-decrement and unblock a takeover early.
  admission.release();
  assert.equal(lease.inFlight, 0);
});

test('lease: a viewer cannot mutate while the agent holds control', () => {
  const lease = new ControlLease();
  const refused = lease.enterViewerMutation();
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'agent_has_control');
});

test('lease: takeover waits for an in-flight agent command and never interleaves', async () => {
  const lease = new ControlLease();
  const running = await lease.enterAgentMutation();

  const takeover = lease.requestControl({ timeoutMs: 5000 });
  // The door is already closed by the time this arrives, so it must not start.
  const duringHandover = lease.enterAgentMutation({ waitMs: 40 });

  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(lease.holder, AGENT, 'control must not transfer while a command is running');
  assert.equal(lease.inFlight, 1, 'a refused command must never reach the browser');

  const refused = await duringHandover;
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'handover_in_progress');

  running.release();
  const result = await takeover;
  assert.equal(result.ok, true);
  assert.equal(lease.holder, HUMAN);

  const afterTakeover = await lease.enterAgentMutation({ waitMs: 80 });
  assert.equal(afterTakeover.ok, false);
  assert.equal(afterTakeover.reason, 'human_has_control');
});

test('lease: agent mutations queue during human control and resume on handback', async () => {
  const lease = new ControlLease();
  await lease.requestControl();
  assert.equal(lease.holder, HUMAN);

  const queued = lease.enterAgentMutation({ waitMs: 5000 });
  let settled = false;
  void queued.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(settled, false, 'the agent command must wait rather than fail immediately');
  assert.equal(lease.pending, 1);

  await lease.releaseControl();
  const admission = await queued;
  assert.equal(admission.ok, true, 'the queued command resumes against the same live browser');
  admission.release();
});

test('lease: a bounded wait turns into a structured refusal, not a hang', async () => {
  const lease = new ControlLease();
  await lease.requestControl();
  const admission = await lease.enterAgentMutation({ waitMs: 120 });
  assert.equal(admission.ok, false);
  assert.equal(admission.reason, 'human_has_control');
});

test('lease: a cancellation releases the waiter', async () => {
  const lease = new ControlLease();
  await lease.requestControl();
  const controller = new AbortController();
  const pending = lease.enterAgentMutation({ waitMs: 5000, signal: controller.signal });
  controller.abort();
  const admission = await pending;
  assert.equal(admission.ok, false);
  assert.equal(admission.reason, 'cancelled');
  assert.equal(lease.pending, 0);
});

test('lease: viewers act only while the human holds the lease', async () => {
  const lease = new ControlLease();
  await lease.requestControl();
  const admitted = lease.enterViewerMutation();
  assert.equal(admitted.ok, true);
  admitted.release();
  await lease.releaseControl();
  assert.equal(lease.enterViewerMutation().ok, false);
});

test('lease: a failed handover leaves control with the current holder', async () => {
  const lease = new ControlLease();
  const running = await lease.enterAgentMutation();
  const result = await lease.requestControl({ timeoutMs: 60 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'busy');
  assert.equal(lease.holder, AGENT, 'a busy takeover must not half-transfer control');
  running.release();
  // Control still works for the agent afterwards.
  const admission = await lease.enterAgentMutation();
  assert.equal(admission.ok, true);
  admission.release();
});

test('lease: every holder transition is announced exactly once', async () => {
  const lease = new ControlLease();
  const seen = [];
  lease.on(snapshot => seen.push(snapshot.holder));
  await lease.requestControl();
  await lease.releaseControl();
  await lease.requestControl();
  assert.deepEqual(seen, [HUMAN, AGENT, HUMAN]);
});
