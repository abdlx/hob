import { randomUUID } from 'node:crypto';
import { HermesError, hermesResource, hermesProfile, hermesSessionKey } from './hermes-client.mjs';
import { HermesExchanges } from './hermes-exchanges.mjs';
import { createHermesWakeups } from './hermes-wakeups.mjs';
import { parseTeamTask, parseTeamReply } from './hermes-team-protocol.mjs';
import { hobTeamRoute } from './hob-team-routes.mjs';
import { containsTeamCredentials } from './hermes-team.mjs';

const BASE = '/api/hermes/bot-relay';
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const active = new Set(['admitting', 'queued', 'running', 'waiting_for_approval', 'stopping']);
const knownStatuses = new Set([...active, 'unknown', ...terminal]);
const RETRY_BASE_MS = 2000, RETRY_MAX_MS = 60000, EXPIRED_STATUS_MS = 300000, FAILURE_LOOKUP_MS = 300000;
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const label = bot => text(bot.displayName || bot.display_name) || (bot.name === 'default' ? 'Main' : bot.name);
const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');
const summary = record => ({ ...record, completed: record.status === 'completed', ok: true,
  nativeCompleted: record.status === 'completed',
  ...(record.teamTask ? { completed: record.status === 'completed' && record.teamVerification === 'coordinator-reviewed' } : {}),
  sessionKey: record.sessionId ? hermesSessionKey(record.to, record.sessionId) : null });

// A terminal native run is not an unexplained event. Hermes carries the provider
// error, a turn exit reason (for example `max_iterations_reached(60/60)`), and
// whether the output was partial. Keep those fields instead of replacing the
// whole outcome with one generic sentence; the caller and both bot chats need
// the actual reason to decide whether a retry is safe.
const FAILURE_TEXT_LIMIT = 8000;
const failureText = value => typeof value === 'string'
  ? value.replace(/\u0000/g, '').trim().slice(0, FAILURE_TEXT_LIMIT) : '';
const nativeFailure = (source, status) => {
  const failure = { status };
  const event = failureText(source?.event || source?.last_event);
  if (event) failure.event = event;
  const error = failureText(source?.error);
  if (error) failure.error = error;
  const turnExitReason = failureText(source?.turn_exit_reason);
  if (turnExitReason) failure.turnExitReason = turnExitReason;
  const reason = failureText(source?.reason);
  if (reason) failure.reason = reason;
  for (const key of ['partial', 'completed', 'interrupted']) {
    if (typeof source?.[key] === 'boolean') failure[key] = source[key];
  }
  return failure;
};
const failureMessage = failure => {
  if (failure?.error) return failure.error;
  if (failure?.turnExitReason) return `The native run stopped before completing the exchange (${failure.turnExitReason}).`;
  if (failure?.reason) return `The native run stopped before completing the exchange (${failure.reason}).`;
  if (failure?.status === 'cancelled') return 'The native run was cancelled before completing the exchange.';
  if (failure?.status === 'interrupted') return 'The native run was interrupted before completing the exchange.';
  return 'The native run failed before completing the exchange.';
};
const observationMessage = error => error?.status === 404
  ? 'Hermes no longer has this run’s status. It may have finished or the gateway restarted; inspect the native conversation before retrying.'
  : error?.code === 'HERMES_UNAVAILABLE'
    ? 'HOB could not reach Hermes to check this run. The run may still be executing; HOB will retry.'
    : `HOB could not check this run: ${failureText(error?.message) || 'unknown error'}.`;
const nativeTerminalPatch = (run, status) => {
  const failure = ['failed', 'cancelled', 'interrupted'].includes(status)
    ? nativeFailure({ ...run, last_event: run.last_event }, status) : null;
  // A failed turn often has no `output` but did stream partial deltas. Keep
  // those unless the terminal payload actually carries replacement text.
  const output = typeof run.output === 'string' && run.output ? run.output : null;
  return {
    status,
    ...(status === 'unknown' ? { error: 'The native run outcome is unknown. Inspect the native conversation before retrying.' } : {}),
    ...(output !== null ? { reply: output.slice(0, 512000), replyTruncated: output.length > 512000 } : {}),
    ...(failure ? { failure, error: failureMessage(failure) } : {}),
  };
};

/** Each handoff has its own native session and durable correlation record. */
export function createHermesBotRelay({ client, bots, exchanges = new HermesExchanges(), journal, bridge, onWake, team, teamArtifacts, memory }) {
  const observers = new Map(), admissions = new Map(), controllers = new Set();
  const retryAt = new Map(), retryAttempts = new Map(), failureChecks = new Map();
  let closed = false, timer, sweep;
  const participant = reference => bots.roster().filter(bot => bot.state === 'active')
    .find(bot => bot.name === reference || label(bot).toLowerCase() === text(reference).toLowerCase());
  const notify = record => client.emit?.('event', { event: 'bot.exchange', payload: { id: record.id, from: record.from, to: record.to, status: record.status } });
  const clearRetry = id => { retryAt.delete(id); retryAttempts.delete(id); };
  const deferRetry = (id, error) => {
    const attempts = (retryAttempts.get(id) || 0) + 1;
    retryAttempts.set(id, attempts);
    retryAt.set(id, Date.now() + (error?.status === 404 ? EXPIRED_STATUS_MS : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 5))));
  };
  const patch = async (id, value) => {
    const before = exchanges.get(id);
    if (!before) throw new HermesError(404, 'Exchange not found.', 'NOT_FOUND');
    if (value.status !== undefined && !knownStatuses.has(value.status)) throw new Error('Invalid exchange status.');
    // Terminal outcomes are monotonic. A late status read or duplicate stream
    // event may add detail, but it must never downgrade completed/failed work.
    if (terminal.has(before.status) && value.status !== undefined && value.status !== before.status) {
      value = { ...value };
      delete value.status;
    }
    if (before.teamControlled && typeof value.reply === 'string' && containsTeamCredentials(value.reply)) value = { ...value, reply: '[Result withheld: potential credentials were detected. Ask the worker for a non-sensitive result.]', teamVerification: 'unproven' };
    if (before.teamTask && terminal.has(value.status)) {
      try {
        const result = parseTeamReply(value.reply ?? before.reply, before.teamTask.id);
        value = { ...value, teamResult: result, teamVerification: value.status === 'completed' && result.title === 'DONE' && result.fields.VERIFICATION.toLowerCase() !== 'none' ? 'self-reported' : 'unproven' };
        if (before.teamReview) value = (value.reply ?? before.reply) === before.reply && value.status === 'completed'
          ? { ...value, teamVerification: before.teamVerification }
          : { ...value, teamVerification: 'unproven', teamReview: null };
      } catch { value = { ...value, teamVerification: 'unproven', teamResultError: 'The native output did not satisfy the pinned TASK reply format. Inspect it before reporting completion.' }; }
    }
    const record = exchanges.update(id, value);
    if (terminal.has(record.status)) clearRetry(id);
    if (before.status !== record.status) notify(record);
    if (terminal.has(record.status) && !closed) queueMicrotask(() => { void tick(); });
    if (journal && record.sessionId) await journal.update(hermesSessionKey(record.to, record.sessionId), record.id,
      { status: record.status, ...(record.runId ? { runId: record.runId } : {}) });
    return record;
  };
  const observe = record => {
    if (observers.has(record.id)) return observers.get(record.id);
    const work = (async () => {
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 600000); timer.unref?.();
      let reply = record.reply || '', replyTruncated = record.replyTruncated === true, settled = false;
      try {
        for await (const event of client.events(record.runId, { profile: record.to, signal: controller.signal })) {
          if (event.event === 'message.delta' && typeof event.delta === 'string') {
            const combined = reply + event.delta;
            replyTruncated ||= combined.length > 512000;
            reply = combined.slice(0, 512000);
          }
          if (event.event === 'run.completed') {
            settled = true;
            if (typeof event.output === 'string' && event.output) { reply = event.output.slice(0, 512000); replyTruncated = event.output.length > 512000; }
            await patch(record.id, { status: 'completed', reply, replyTruncated }); return;
          }
          if (['run.failed', 'run.cancelled', 'run.interrupted'].includes(event.event)) {
            settled = true;
            const status = event.event.slice(4);
            // A failed event can carry its partial answer in `output`; prefer it
            // over the deltas we observed, which may be incomplete. An empty
            // terminal output must not erase the deltas that did arrive.
            if (typeof event.output === 'string' && event.output) { reply = event.output.slice(0, 512000); replyTruncated = event.output.length > 512000; }
            const failure = nativeFailure(event, status);
            await patch(record.id, { status, reply, replyTruncated, failure, error: failureMessage(failure) }); return;
          }
        }
        // EOF is not completion. A completed run commonly closes the event
        // stream before the observer attaches, so check once immediately rather
        // than making the caller wait for the next five-second sweep.
        if (!settled) {
          let current;
          try { current = await reconcile(exchanges.get(record.id)); } catch { current = exchanges.get(record.id); }
          if (!current || terminal.has(current.status)) return;
        }
        await patch(record.id, { reply, replyTruncated });
      } catch (error) {
        if (!controller.signal.aborted) {
          let current;
          try { current = await reconcile(exchanges.get(record.id)); } catch { current = exchanges.get(record.id); }
          if (!current || terminal.has(current.status)) return;
          if (!current.observationError) await patch(record.id, { reply, replyTruncated, observationError: error.message });
        }
      } finally { clearTimeout(timer); controllers.delete(controller); }
    })();
    observers.set(record.id, work);
    work.finally(() => observers.delete(record.id)).catch(() => undefined);
    return work;
  };
  const reconcile = async record => {
    if (!record) return record;
    if (record.teamTask && record.status === 'completed' && teamArtifacts?.reviewState) {
      const reviewed = teamArtifacts.reviewState(record);
      if (reviewed && Object.entries(reviewed).some(([key, value]) => JSON.stringify(record[key]) !== JSON.stringify(value))) record = exchanges.update(record.id, reviewed);
    }
    if (terminal.has(record.status)) { clearRetry(record.id); return record; }
    if ((retryAt.get(record.id) || 0) > Date.now()) return record;
    if (!record.runId && record.sessionId && journal) {
      const correlated = journal.get(hermesSessionKey(record.to, record.sessionId));
      if (correlated?.requestKey === record.id && (correlated.runId || terminal.has(correlated.status))) {
        // The chat journal also uses `unavailable` for an expired native run.
        // The exchange has one explicit parked state for that condition.
        const status = correlated.status === 'unavailable' ? 'unknown' : correlated.status;
        record = await patch(record.id, { runId: correlated.runId, status });
        if (terminal.has(record.status)) { clearRetry(record.id); return record; }
      }
    }
    if (!record.runId) {
      if (admissions.has(`${record.from}:${record.requestKey}`)) return record;
      const message = 'Admission was interrupted by a restart. Nothing was replayed; inspect the native conversation before retrying.';
      if (record.status === 'unknown' && record.error === message) return record;
      return patch(record.id, { status: 'unknown', error: message,
        failure: { status: 'unknown', phase: 'admission', error: message, retryable: false } });
    }
    try {
      const run = await client.runtime(`/v1/runs/${hermesResource(record.runId)}`, { profile: record.to });
      if (run.run_id !== record.runId) throw new Error('Hermes returned a different run.');
      const states = new Set([...active, 'unknown', ...terminal]);
      if (!states.has(run.status)) { clearRetry(record.id); return record; }
      const current = exchanges.get(record.id);
      if (terminal.has(current.status)) { clearRetry(record.id); return current; }
      const next = nativeTerminalPatch(run, run.status);
      if (current.observationError) next.observationError = null;
      // `unknown` is not terminal, but it also is not useful to poll every five
      // seconds. Let Hermes or an operator resolve it before checking again.
      if (run.status === 'unknown') retryAt.set(record.id, Date.now() + 30000);
      else clearRetry(record.id);
      return await patch(record.id, next);
    } catch (error) {
      const message = observationMessage(error);
      deferRetry(record.id, error);
      // A missing run status is a stable state, not a transient read failure.
      // Do not keep hammering Hermes every five seconds for an expired run.
      if (error?.status === 404) {
        const current = exchanges.get(record.id);
        if (current.status === 'unknown' && current.error === message) return current;
        return patch(record.id, { status: 'unknown', error: message,
          failure: { status: 'unknown', phase: 'observation', error: message,
            ...(error.code ? { code: error.code } : {}), retryable: false } });
      }
      if (record.observationError === message) return { ...record, observationError: message };
      try { return await patch(record.id, { observationError: message }); }
      catch { return { ...record, observationError: message }; }
    }
  };
  // Exchange detail is opened by a person investigating an outcome, so it can
  // afford one native status read when an older record predates failure fields
  // (or when the event stream was missed). List and sweep paths never do this.
  const hydrateFailure = async record => {
    if (!record?.runId || record.failure || !['failed', 'cancelled', 'interrupted'].includes(record.status)) return record;
    if ((failureChecks.get(record.id) || 0) > Date.now()) return record;
    try {
      const run = await client.runtime(`/v1/runs/${hermesResource(record.runId)}`, { profile: record.to });
      if (run.run_id !== record.runId || !['failed', 'cancelled', 'interrupted'].includes(run.status)) {
        failureChecks.set(record.id, Date.now() + 60000);
        return record;
      }
      failureChecks.delete(record.id);
      const failure = nativeFailure({ ...run, last_event: run.last_event }, run.status);
      return await patch(record.id, { failure, error: failureMessage(failure) });
    } catch {
      failureChecks.set(record.id, Date.now() + FAILURE_LOOKUP_MS);
      return record;
    }
  };
  const send = async (sender, input) => {
    const receiver = participant(input.to);
    if (!receiver) throw new HermesError(404, 'That bot is not active in this dashboard.', 'BOT_NOT_FOUND');
    if (team?.policy().coordinatorOnly && sender.name !== 'default' && receiver.name !== 'default') throw new HermesError(403, 'Employee-team workers must route requests through the coordinator.', 'TEAM_COORDINATOR_REQUIRED');
    if (receiver.name === sender.name) throw invalid('Send the message to another bot.');
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 64000) throw invalid('Enter a message under 64,000 characters.');
    if (team?.policy().coordinatorOnly && containsTeamCredentials(input.message)) throw invalid('Potential credentials cannot be sent through employee-team messages.');
    const teamTask = team?.policy().coordinatorOnly && sender.name === 'default' ? parseTeamTask(input.message) : null;
    const waitMs = memory?.enabled() && sender.name === 'default' ? 0 : input.waitMs === undefined ? 120000 : input.waitMs;
    if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 600000) throw invalid('Choose a relay wait between zero and ten minutes.');
    const requestKey = input.requestId ?? randomUUID();
    if (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestKey)) throw invalid('Use a valid relay request identifier.');
    if (input.sourceSession !== undefined && (typeof input.sourceSession !== 'string' || !input.sourceSession)) throw invalid('Use a valid source session identifier.');
    if (input.parentExchangeId !== undefined && (typeof input.parentExchangeId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.parentExchangeId))) throw invalid('Use a valid parent exchange identifier.');
    const sourceSession = input.sourceSession || null;
    if (sourceSession !== null) hermesResource(sourceSession);
    const parent = input.parentExchangeId ? exchanges.get(input.parentExchangeId) : sourceSession ? exchanges.parent(sender.name, sourceSession) : null;
    if (input.parentExchangeId && (!parent || parent.to !== sender.name)) throw invalid('The parent exchange does not belong to this bot.');
    const ancestry = parent ? [...parent.ancestry, parent.to] : [sender.name];
    if (ancestry.includes(receiver.name) || ancestry.length >= 8) throw new HermesError(409, 'This handoff would repeat a bot in the same delegation chain. Return the result to your caller instead.', 'RELAY_CYCLE');
    const existing = exchanges.find(sender.name, requestKey);
    if (existing && (existing.to !== receiver.name || existing.message !== input.message || existing.sourceSession !== sourceSession)) throw new HermesError(409, 'This request identifier already belongs to a different exchange.', 'RELAY_REQUEST_CONFLICT');
    const key = `${sender.name}:${requestKey}`;
    let admission = admissions.get(key);
    if (!existing && !admission) {
      // Unknown is a parked outcome, not active work. Counting it here would
      // permanently consume a receiver's capacity after a restart.
      if (exchanges.pending().filter(record => record.to === receiver.name && record.status !== 'unknown').length >= 8) throw new HermesError(429, 'This bot already has eight active handoffs. Wait for a result before sending more work.', 'RELAY_BUSY');
      if (memory?.enabled() && teamTask) memory.checkDelegation(teamTask, receiver.name);
      const record = exchanges.create({ requestKey, from: sender.name, fromName: label(sender), to: receiver.name, toName: label(receiver), message: input.message, sourceSession, ancestry, parentExchangeId: parent?.id || null,
        ...(team?.policy().coordinatorOnly ? { teamControlled: true } : {}), ...(teamTask ? { teamTask, teamVerification: 'unproven' } : {}), hobArchitecture: memory?.enabled() === true, wakeOnComplete: Boolean(bridge), relayHelpers: Object.fromEntries([sender.name, 'default'].map(name => [name, bots.relayHelper?.(name) || '.hob/talk.mjs'])) });
      memory?.delegated(record);
      notify(record);
      admission = (async () => {
        try {
          // Session creation and credential binding are independent. Starting
          // them together removes one round trip from every handoff.
          const [created, credentialBinding] = await Promise.all([
            client.runtime('/api/sessions', { profile: receiver.name, method: 'POST', body: { title: `${record.fromName} → ${record.toName} · ${record.id.slice(0, 8)}` } }),
            journal ? client.credentialBinding(record.to) : Promise.resolve(null),
          ]);
          const sessionId = created?.session?.id ?? created?.id; hermesResource(sessionId);
          team?.registerSession?.(receiver.name, sessionId, 'relay', record.message);
          exchanges.update(record.id, { sessionId });
          const delegation = team?.policy().coordinatorOnly && record.to !== 'default'
            ? 'If another bot is needed, ask the coordinator (default); do not message another worker.'
            : `If you delegate further, use node .hob/talk.mjs send <bot> <message> --parent ${record.id}.`;
          const prompt = `[HOB relay from ${record.fromName} (${record.from})]\nExchange: ${record.id}. Complete this request with your own tools and reply with the result. Your reply returns to the caller automatically; do not message the caller to return it. ${delegation} Share only context needed for the work.\n\n${record.message}`;
          if (journal) await journal.reserve(hermesSessionKey(record.to, sessionId), { input: prompt, requestKey: record.id, credentialBinding });
          const run = await client.runtime('/v1/runs', { profile: record.to, method: 'POST', idempotencyKey: record.id, body: { session_id: sessionId, input: prompt } });
          hermesResource(run?.run_id);
          const admitted = await patch(record.id, { runId: run.run_id, status: 'running' });
          void observe(admitted).catch(error => console.warn(`Exchange observation failed: ${error.message}`));
          return admitted;
        } catch (error) {
          // The exchange is already durable, so admission errors must be
          // inspectable too. A client-side rejection is a definitive failure;
          // a transport or gateway error is parked as unknown until checked.
          const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? 'failed' : 'unknown';
          const reason = failureText(error?.message) || 'Hermes did not provide a reason.';
          const failure = { status, phase: 'admission', error: reason,
            ...(error?.code ? { code: error.code } : {}), retryable: status === 'unknown' || [408, 425, 429].includes(error?.status) };
          const message = status === 'failed'
            ? `The recipient could not start this handoff: ${reason}`
            : `Admission could not be confirmed: ${reason}. The run may still have been accepted; inspect this exchange before retrying.`;
          try { return await patch(record.id, { status, error: message, failure }); }
          catch (patchError) { console.warn(`Exchange admission state could not be saved: ${patchError.message}`); return { ...record, status, error: message, failure }; }
        }
      })();
      admissions.set(key, admission);
      admission.finally(() => admissions.delete(key)).catch(() => undefined);
    }
    const record = admission ? await admission : existing;
    const observer = observers.get(record.id);
    if (waitMs > 0 && observer) {
      let timer;
      await Promise.race([observer, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); clearTimeout(timer);
    }
    return summary(exchanges.get(record.id) || record);
  };
  const route = async (req, res, url, { json, body }) => {
    if (!url.pathname.startsWith(BASE)) return false;
    const sender = await bots.authenticate(/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1]);
    if (!sender) throw new HermesError(401, 'A bot relay credential is required.', 'RELAY_UNAUTHORIZED');
    if (closed) throw new HermesError(503, 'The relay is shutting down. No new handoff was started.', 'RELAY_CLOSED');
    const workPath = url.pathname.slice(BASE.length);
    if (workPath === '/work' || workPath.startsWith('/work/')) return hobTeamRoute(memory, sender.name, req, res, workPath.slice(5), url, { body, json });
    const tail = url.pathname.slice(BASE.length);
    const artifact = /^\/team\/artifacts\/([a-f0-9-]{36})(?:\/(reviews))?$/.exec(tail);
    if (artifact && teamArtifacts) {
      // This is the nominated OUTPUT from the original assignment, never a
      // caller-supplied filesystem path or a private-workspace browsing route.
      if (sender.name !== 'default') throw new HermesError(403, 'Only the coordinator can inspect or review assigned worker outputs.', 'TEAM_COORDINATOR_REQUIRED');
      const record = await reconcile(exchanges.get(artifact[1]));
      if (!record || record.from !== 'default') throw new HermesError(404, 'Assigned exchange not found.', 'NOT_FOUND');
      if (!artifact[2] && req.method === 'GET') return json(res, 200, { artifact: await teamArtifacts.inspect(record) });
      if (req.method === 'POST') {
        const input = await body(req);
        if (artifact[2]) {
          const review = await teamArtifacts.review(record, input);
          await patch(record.id, { teamVerification: review.verdict === 'passed' ? 'coordinator-reviewed' : 'coordinator-rejected',
            teamReview: { id: review.requestId, sha256: review.sha256, verdict: review.verdict, at: review.at } });
          return json(res, 200, { review });
        }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw invalid('The assigned output is fixed by its original TASK. No path overrides are accepted.');
        const receipt = await teamArtifacts.receive(record);
        await patch(record.id, { teamOutput: { sha256: receipt.sha256, bytes: receipt.bytes, receivedAt: receipt.receivedAt } });
        return json(res, 200, { artifact: receipt });
      }
      throw new HermesError(405, 'Inspect, receive or review this assigned output.', 'INVALID_REQUEST');
    }
    if (team && tail === '/team/core' && req.method === 'POST') {
      if (sender.name !== 'default') throw new HermesError(403, 'Workers submit fact candidates through HOB or their structured reply.', 'TEAM_COORDINATOR_REQUIRED');
      const value = await body(req);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['content', 'base', 'evidence'].includes(key))) throw invalid('Unsupported core proposal fields.');
      return json(res, 201, team.propose({ ...value, author: sender.name }));
    }
    if (tail === '/roster' && req.method === 'GET') return json(res, 200, { self: sender.name,
      bots: bots.roster().filter(bot => bot.state === 'active').map(bot => ({ id: bot.name, name: label(bot), tags: bot.tags || [], description: text(bot.description), model: text(bot.model), main: bot.name === 'default', available: true })) });
    if (tail === '/send' && req.method === 'POST') {
      const input = await body(req);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['to', 'message', 'waitMs', 'requestId', 'sourceSession', 'parentExchangeId'].includes(key))) throw invalid('Unsupported relay request.');
      return json(res, 200, await send(sender, input));
    }
    if (tail.startsWith('/exchanges/') && req.method === 'GET') {
      const record = exchanges.get(tail.slice('/exchanges/'.length));
      if (!record || ![record.from, record.to].includes(sender.name)) throw new HermesError(404, 'Exchange not found.', 'NOT_FOUND');
      return json(res, 200, summary(await hydrateFailure(await reconcile(record))));
    }
    throw new HermesError(404, 'Unknown bot relay endpoint.', 'NOT_FOUND');
  };
  route.dashboard = async (req, res, url, { json }) => {
    if (req.method !== 'GET') throw new HermesError(405, 'Read exchange history with GET.', 'INVALID_REQUEST');
    const profile = hermesProfile(url.searchParams.get('profile') || 'default');
    if (!bots.roster().some(bot => bot.name === profile && bot.state === 'active')) throw new HermesError(404, 'Bot not found.', 'BOT_NOT_FOUND');
    const threadMatch = /^\/api\/hermes\/exchanges\/threads(?:\/([^/]+))?$/.exec(url.pathname);
    if (threadMatch) {
      const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(before) || before < 0) throw invalid('Invalid history cursor.');
      const peer = threadMatch[1] ? hermesProfile(decodeURIComponent(threadMatch[1])) : null;
      if (peer === profile) throw invalid('Choose another bot for this conversation.');
      const records = peer ? exchanges.thread(profile, peer, before) : exchanges.threads(profile, before);
      return json(res, 200, { exchanges: records.map(record => summary(record)),
        nextBefore: records.length === (peer ? 30 : 50) ? records.at(-1).createdAt : null });
    }
    const match = /^\/api\/hermes\/exchanges\/([a-f0-9-]{36})(?:\/(transcript))?$/.exec(url.pathname);
    if (match) {
      let record = exchanges.get(match[1]);
      if (!record || ![record.from, record.to].includes(profile)) throw new HermesError(404, 'Exchange not found.', 'NOT_FOUND');
      if (match[2]) {
        if (!record.sessionId) return json(res, 200, { messages: [] });
        const result = await client.runtime(`/api/sessions/${hermesResource(record.sessionId)}/messages`, { profile: record.to });
        return json(res, 200, { messages: Array.isArray(result?.data) ? result.data : [] });
      }
      record = await hydrateFailure(await reconcile(record));
      return json(res, 200, { ...summary(record), wakeups: exchanges.wakeups(record.id) });
    }
    if (url.pathname !== '/api/hermes/exchanges') throw new HermesError(404, 'Exchange not found.', 'NOT_FOUND');
    const session = url.searchParams.get('session');
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 0) throw invalid('Invalid history cursor.');
    const records = session ? exchanges.timeline(profile, session) : exchanges.list(profile, before);
    // The observer and the bounded sweep keep active records current. History
    // reads must not serialize a native GET behind every row, which made the
    // chat list slow whenever several handoffs were running.
    return json(res, 200, { exchanges: records.map(record => {
      const { message: _message, reply: _reply, ...notice } = summary(record);
      return notice;
    }), earlier: Boolean(session && records.length === 100), nextBefore: !session && records.length === 50 ? records.at(-1).createdAt : null });
  };
  const wakeups = createHermesWakeups({ bridge, bots, exchanges, onAdmission: onWake, notify: id => { const record = exchanges.get(id); if (record) notify(record); } });
  const tick = () => {
    if (closed) return Promise.resolve();
    if (sweep) return sweep;
    sweep = (async () => {
      // Observation runs without a browser or helper process waiting on it.
      const pending = exchanges.pending(100);
      for (let i = 0; i < pending.length && !closed; i += 4) {
        await Promise.allSettled(pending.slice(i, i + 4).map(record => reconcile(exchanges.get(record.id))));
      }
      if (!closed) await wakeups();
      if (!closed) await memory?.sweep();
    })().catch(error => console.warn(`Bot coordination sweep failed: ${error.message}`)).finally(() => { sweep = null; });
    return sweep;
  };
  route.sweep = tick;
  route.start = () => {
    if (timer || closed) return;
    timer = setInterval(() => { void tick(); }, 5000); timer.unref?.(); void tick();
  };
  route.close = async () => {
    closed = true; clearInterval(timer);
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...observers.values(), ...admissions.values(), ...(sweep ? [sweep] : [])]);
    retryAt.clear(); retryAttempts.clear(); failureChecks.clear();
    await memory?.close();
    exchanges.close();
  };
  return route;
}
