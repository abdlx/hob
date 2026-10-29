// Owned fresh-container proof only. Real native cron, memory tool and applier;
// the model is the disposable local fixture, with no external provider account.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SMOKE_MEMORY_PROMPT, SMOKE_MEMORY_CONTENT, SMOKE_MEMORY_REJECTED } from './smoke-model.mjs';

export async function memoryReviewFirstBoot({ api, request, workspace, retry, check }) {
  const before = await api('/api/hermes/setup/learning');
  const changes = { memoryEnabled: true, memoryApproval: true, backgroundReview: false };
  await api('/api/hermes/setup/learning', 'PUT', { changes, confirm: true });
  try {
    for (const [action, content] of [['approve', SMOKE_MEMORY_CONTENT], ['reject', SMOKE_MEMORY_REJECTED]]) {
      const initial = new Set((await workspace('reviews/memory')).items.map(item => item.id));
      const scheduled = await workspace('jobs', 'POST', { name: `Disposable native memory ${action}`, prompt: SMOKE_MEMORY_PROMPT + (action === 'reject' ? ' REJECT_CASE' : ''), schedule: new Date(Date.now() + 15000).toISOString() });
      assert.equal(typeof scheduled.id, 'string');
      const proposal = await retry(`the real background memory ${action} proposal`, async () => {
        const rows = (await workspace('reviews/memory')).items;
        const row = rows.find(item => !initial.has(item.id) && item.summary.includes(content.slice(0, 25)));
        assert.ok(row); return row;
      });
      const detail = await workspace('reviews/memory/' + proposal.id);
      check(`the complete ${action} memory payload is reviewable`, detail.diff.includes(content) && /^[a-f0-9]{64}$/.test(detail.revision));
      check(`the ${action} memory write remains inactive before review`, !JSON.stringify(await workspace('learning')).includes(content));
      const other = await request(`/api/hermes/workspace/reviews/memory/${proposal.id}?profile=smoke-bot`, 'GET', undefined, 'smoke-bot');
      check(`another bot cannot inspect the ${action} memory proposal`, [403, 404].includes(other.status));
      const decision = { id: proposal.id, revision: detail.revision, action, requestId: randomUUID(), confirm: true };
      const stale = await request('/api/hermes/workspace/reviews/memory?profile=default', 'POST', { ...decision, revision: '0'.repeat(64) });
      check(`stale ${action} memory decisions are refused`, stale.status === 409);
      const applied = await workspace('reviews/memory', 'POST', decision);
      check(`the exact memory ${action} revision is acknowledged`, applied.ok === true);
      const replay = await workspace('reviews/memory', 'POST', decision);
      check(`the same memory ${action} request is acknowledged without another application`, replay.ok === true && replay.replayed === true);
      const history = await workspace('review-history');
      check(`memory ${action} produces one audit decision`, history.decisions.filter(item => item.requestId === decision.requestId).length === 1);
      check(`the ${action} proposal leaves the pending queue`, !(await workspace('reviews/memory')).items.some(item => item.id === proposal.id));
      check(`native memory reflects the explicit ${action} decision`, JSON.stringify(await workspace('learning')).includes(content) === (action === 'approve'));
    }
    return true;
  } finally {
    await api('/api/hermes/setup/learning', 'PUT', { changes: Object.fromEntries(Object.keys(changes).map(key => [key, before.controls[key].value])), confirm: true });
  }
}

export async function memoryReviewAfterRestart({ workspace, check }) {
  const graph = JSON.stringify(await workspace('learning'));
  check('approved native memory survives container recreation', graph.includes(SMOKE_MEMORY_CONTENT));
  check('rejected native memory stays absent after container recreation', !graph.includes(SMOKE_MEMORY_REJECTED));
}
