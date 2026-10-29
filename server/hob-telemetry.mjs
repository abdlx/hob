import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const stages = new Set(['native.http', 'native.rpc', 'turn.admission', 'turn.first_token', 'turn.settlement', 'browser.start', 'browser.wait', 'browser.command', 'artifact.publish']);
const outcomes = new Set(['ok', 'error', 'refused', 'cancelled', 'unknown']);
const operations = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'cold', 'warm', 'agent', 'read', 'write', 'precision', 'prompt.submit', 'prompt.receipt', 'prompt.cancel', 'session.resume', 'other']);
const quantile = (values, fraction) => values.length ? values[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;

/** Bounded diagnostic metadata. Never accepts prompts, URLs, parameters, headers or error text. */
export function createHobTelemetry({ stateDir, maxEvents = 2000, maxFileBytes = 2 * 1024 * 1024, clock = () => performance.now() } = {}) {
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 10000 || !Number.isInteger(maxFileBytes) || maxFileBytes < 1024 || maxFileBytes > 16 * 1024 * 1024) throw new Error('Invalid telemetry bounds.');
  const records = [], profiles = new Map();
  let work = Promise.resolve(), pending = 0, dropped = 0, storageErrors = 0;
  const trace = (profile, runId) => typeof runId === 'string' && runId && runId.length <= 2048
    ? createHash('sha256').update(JSON.stringify([profile, runId])).digest('hex').slice(0, 24) : undefined;
  function record(profile, stage, elapsedMs, outcome, context = {}) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(profile || '') || !stages.has(stage) || !outcomes.has(outcome) || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    if (!profiles.has(profile) && profiles.size >= 256) { dropped++; return; }
    profiles.set(profile, true);
    const traceId = trace(profile, context.runId);
    const item = { at: new Date().toISOString(), profile, stage, elapsedMs: Math.round(elapsedMs * 100) / 100, outcome,
      ...(traceId ? { traceId } : {}), ...(operations.has(context.operation) ? { operation: context.operation } : {}) };
    records.push(item); if (records.length > maxEvents) records.shift();
    if (!stateDir) return;
    if (pending >= 256) { dropped++; return; }
    pending++;
    work = work.then(async () => {
      const folder = path.join(stateDir, 'diagnostics');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const filename = path.join(folder, 'performance.jsonl');
      const line = JSON.stringify(item) + '\n';
      let handle = await open(filename, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Independent diagnostic file required.');
        if (stat.size + Buffer.byteLength(line) > maxFileBytes) {
          await handle.close(); handle = null;
          await rename(filename, filename + '.1');
          handle = await open(filename, constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
        }
        await handle.writeFile(line);
      } finally { await handle?.close(); }
    }).catch(() => { storageErrors++; }).finally(() => { pending--; });
  }
  return {
    record,
    start(profile, stage, context = {}) {
      const started = clock(); let finished = false;
      return (outcome = 'ok', completion = {}) => {
        if (finished) return; finished = true;
        record(profile, stage, Math.max(0, clock() - started), outcome, { operation: context.operation, runId: completion.runId ?? context.runId });
      };
    },
    snapshot(profile) {
      const selected = records.filter(item => item.profile === profile);
      const groups = new Map();
      for (const item of selected) {
        const key = `${item.stage}:${item.operation || ''}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      return { profile, window: 'bounded process-local samples', sampleLimit: maxEvents, samples: selected.length, dropped, storageErrors,
        stages: [...groups.values()].map(items => {
          const values = items.map(item => item.elapsedMs).sort((a, b) => a - b);
          return { stage: items[0].stage, ...(items[0].operation ? { operation: items[0].operation } : {}), count: items.length,
            outcomes: Object.fromEntries([...outcomes].map(outcome => [outcome, items.filter(item => item.outcome === outcome).length])),
            p50Ms: quantile(values, .5), p95Ms: quantile(values, .95), maxMs: values.at(-1) };
        }), events: selected.slice(-200) };
    },
    flush: () => work,
  };
}
