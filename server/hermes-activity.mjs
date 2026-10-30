import { hermesProfile, hermesResource, hermesSessionKey, parseHermesSessionKey } from './hermes-client.mjs';

const statuses = new Set(['completed', 'in_progress', 'cancelled', 'pending', 'failed', 'interrupted', 'unknown']);
const jobStates = new Set(['present', 'deleted', 'unavailable', 'unlinked']);
const iso = value => {
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString() : '';
};

/** A read-only projection. It never acknowledges or rewrites a native failure. */
export async function hermesActivityFeed(client, profile, sessions, team) {
  hermesProfile(profile);
  const items = sessions.map(item => {
    const owner = parseHermesSessionKey(item.id);
    if (owner.profile !== profile) throw new Error('Activity session belongs to another bot.');
    return { ...item, agentId: profile, origin: { kind: team?.sessionKind?.(profile, owner.sessionId) || 'session', profile, sessionId: owner.sessionId } };
  });
  const warnings = [];
  let nextOffset = null;
  try {
    const result = await client.dashboard('/api/hob/activity', { profile, query: { limit: 100 }, timeoutMs: 5000 });
    if (!Array.isArray(result?.items) || result.items.length > 100 || result.nextOffset !== null && (!Number.isSafeInteger(result.nextOffset) || result.nextOffset < 0)) throw new Error('Invalid scheduler history');
    const scheduled = result.items.map(row => {
      hermesResource(row.sessionId);
      const origin = row.origin;
      if (origin?.kind !== 'scheduled-job' || origin.profile !== profile || origin.sessionId !== row.sessionId || !jobStates.has(origin.jobState)
        || typeof origin.historical !== 'boolean' || !iso(origin.observedAt) || !statuses.has(row.status)
        || ['present', 'deleted'].includes(origin.jobState) && (!origin.jobId || origin.inventoryStatus !== 'verified')
        || origin.jobState === 'unlinked' && origin.jobId
        || !['execution-ledger', 'session-lifecycle'].includes(origin.statusSource)) throw new Error('Invalid scheduler provenance');
      if (origin.jobId) hermesResource(origin.jobId);
      if (origin.executionId) hermesResource(origin.executionId);
      return { id: hermesSessionKey(profile, row.sessionId), agentId: profile,
        title: typeof row.title === 'string' ? row.title.slice(0, 500) : 'Scheduled run', timestamp: iso(row.timestamp), status: row.status,
        origin: { kind: 'scheduled-job', profile, sessionId: row.sessionId, jobId: origin.jobId || null, executionId: origin.executionId || null,
          jobState: origin.jobState, historical: origin.historical, observedAt: iso(origin.observedAt), inventoryStatus: origin.inventoryStatus,
          nativeStatus: String(origin.nativeStatus || '').slice(0, 100), statusSource: origin.statusSource } };
    });
    const bySession = new Map(items.map(item => [item.origin.sessionId, item]));
    for (const item of scheduled) {
      const previous = bySession.get(item.origin.sessionId);
      if (previous && previous.status === 'failed' && item.status !== 'failed') {
        item.status = 'failed';
        warnings.push('A recorded failure differs from scheduler history. Its original failed outcome has been preserved.');
      }
      bySession.set(item.origin.sessionId, { ...previous, ...item, id: previous?.id || item.id });
    }
    items.splice(0, items.length, ...bySession.values());
    nextOffset = result.nextOffset;
  } catch {
    warnings.push('Scheduled task history is unavailable. The visible activity may be incomplete.');
  }
  items.sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  return { items, warnings: [...new Set(warnings)], nextScheduledOffset: nextOffset };
}
