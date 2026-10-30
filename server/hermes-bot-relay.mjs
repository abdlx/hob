import { randomUUID } from 'node:crypto';
import { HermesError, hermesResource, hermesProfile, hermesSessionKey } from './hermes-client.mjs';
import { HermesExchanges } from './hermes-exchanges.mjs';
import { createHermesWakeups } from './hermes-wakeups.mjs';
import { parseTeamTask, parseTeamReply } from './hermes-team-protocol.mjs';
import { containsTeamCredentials } from './hermes-team.mjs';

const BASE = '/api/hermes/bot-relay';
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const label = bot => text(bot.displayName || bot.display_name) || (bot.name === 'default' ? 'Main' : bot.name);
const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');
const summary = record => ({ ...record, completed: record.status === 'completed', ok: true,
  sessionKey: record.sessionId ? hermesSessionKey(record.to, record.sessionId) : null });

/** Each handoff has its own native session and durable correlation record. */
export function createHermesBotRelay({ client, bots, exchanges = new HermesExchanges(), journal, bridge, onWake, team }) {
  const observers = new Map(), admissions = new Map(), controllers = new Set();
  let closed = false, timer, sweep;
  const participant = reference => bots.roster().filter(bot => bot.state === 'active')
    .find(bot => bot.name === reference || label(bot).toLowerCase() === text(reference).toLowerCase());
  const notify = record => client.emit?.('event', { event: 'bot.exchange', payload: { id: record.id, from: record.from, to: record.to, status: record.status } });
  const patch = async (id, value) => {
    const before = exchanges.get(id);
    if (before.teamControlled && typeof value.reply === 'string' && containsTeamCredentials(value.reply)) value = { ...value, reply: '[Result withheld: potential credentials were detected. Ask the worker for a non-sensitive result.]', teamVerification: 'unproven' };
    if (before.teamTask && terminal.has(value.status)) {
      try {
        const result = parseTeamReply(value.reply ?? before.reply, before.teamTask.id);
        value = { ...value, teamResult: result, teamVerification: value.status === 'completed' && result.title === 'DONE' && result.fields.VERIFICATION.toLowerCase() !== 'none' ? 'self-reported' : 'unproven' };
      } catch { value = { ...value, teamVerification: 'unproven', teamResultError: 'The native output did not satisfy the pinned TASK reply format. Inspect it before reporting completion.' }; }
    }
    const record = exchanges.update(id, value);
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
      let reply = record.reply || '', replyTruncated = record.replyTruncated === true;
      try {
        for await (const event of client.events(record.runId, { profile: record.to, signal: controller.signal })) {
          if (event.event === 'message.delta' && typeof event.delta === 'string') {
            const combined = reply + event.delta;
            replyTruncated ||= combined.length > 512000;
            reply = combined.slice(0, 512000);
          }
          if (event.event === 'run.completed') {
            if (typeof event.output === 'string') { reply = event.output.slice(0, 512000); replyTruncated = event.output.length > 512000; }
            await patch(record.id, { status: 'completed', reply, replyTruncated }); return;
          }
          if (['run.failed', 'run.cancelled', 'run.interrupted'].includes(event.event)) {
            await patch(record.id, { status: event.event.slice(4), reply, replyTruncated, error: 'The native run ended before completing the exchange.' }); return;
          }
        }
        await patch(record.id, { reply, replyTruncated }); // End of a stream does not prove completion.
      } catch (error) {
        if (!controller.signal.aborted) await patch(record.id, { reply, replyTruncated, observationError: error.message });
      } finally { clearTimeout(timer); controllers.delete(controller); }
    })();
    observers.set(record.id, work);
    work.finally(() => observers.delete(record.id)).catch(() => undefined);
    return work;
  };
  const reconcile = async record => {
    if (!record || terminal.has(record.status)) return record;
    if (!record.runId && record.sessionId && journal) {
      const correlated = journal.get(hermesSessionKey(record.to, record.sessionId));
      if (correlated?.requestKey === record.id && (correlated.runId || terminal.has(correlated.status))) {
        record = await patch(record.id, { runId: correlated.runId, status: correlated.status });
        if (terminal.has(record.status)) return record;
      }
    }
    if (!record.runId) {
      if (!admissions.has(`${record.from}:${record.requestKey}`)) return patch(record.id, { status: 'unknown', error: 'Admission was interrupted. Nothing was replayed; inspect the native conversation before retrying.' });
      return record;
    }
    try {
      const run = await client.runtime(`/v1/runs/${hermesResource(record.runId)}`, { profile: record.to });
      if (run.run_id !== record.runId) throw new Error('Hermes returned a different run.');
      const states = new Set(['queued', 'running', 'waiting_for_approval', 'stopping', 'unknown', ...terminal]);
      if (!states.has(run.status)) return record;
      const current = exchanges.get(record.id);
      if (terminal.has(current.status)) return current;
      return patch(record.id, { status: run.status, ...(typeof run.output === 'string' ? { reply: run.output.slice(0, 512000), replyTruncated: run.output.length > 512000 } : {}) });
    } catch (error) { return { ...record, observationError: error.message }; }
  };
  const send = async (sender, input) => {
    const receiver = participant(input.to);
    if (!receiver) throw new HermesError(404, 'That bot is not active in this dashboard.', 'BOT_NOT_FOUND');
    if (team?.policy().coordinatorOnly && sender.name !== 'default' && receiver.name !== 'default') throw new HermesError(403, 'Employee-team workers must route requests through the coordinator.', 'TEAM_COORDINATOR_REQUIRED');
    if (receiver.name === sender.name) throw invalid('Send the message to another bot.');
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 64000) throw invalid('Enter a message under 64,000 characters.');
    if (team?.policy().coordinatorOnly && containsTeamCredentials(input.message)) throw invalid('Potential credentials cannot be sent through employee-team messages.');
    const teamTask = team?.policy().coordinatorOnly && sender.name === 'default' ? parseTeamTask(input.message) : null;
    const waitMs = input.waitMs === undefined ? 120000 : input.waitMs;
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
      if (exchanges.pending().filter(record => record.to === receiver.name).length >= 8) throw new HermesError(429, 'This bot already has eight active handoffs. Wait for a result before sending more work.', 'RELAY_BUSY');
      const record = exchanges.create({ requestKey, from: sender.name, fromName: label(sender), to: receiver.name, toName: label(receiver), message: input.message, sourceSession, ancestry, parentExchangeId: parent?.id || null,
        ...(team?.policy().coordinatorOnly ? { teamControlled: true } : {}), ...(teamTask ? { teamTask, teamVerification: 'unproven' } : {}), wakeOnComplete: Boolean(bridge), relayHelpers: Object.fromEntries([sender.name, 'default'].map(name => [name, bots.relayHelper?.(name) || '.hob/talk.mjs'])) });
      notify(record);
      admission = (async () => {
        try {
          const created = await client.runtime('/api/sessions', { profile: receiver.name, method: 'POST', body: { title: `${record.fromName} → ${record.toName} · ${record.id.slice(0, 8)}` } });
          const sessionId = created?.session?.id ?? created?.id; hermesResource(sessionId);
          exchanges.update(record.id, { sessionId });
          const delegation = team?.policy().coordinatorOnly && record.to !== 'default'
            ? 'If another bot is needed, ask the coordinator (default); do not message another worker.'
            : `If you delegate further, use node .hob/talk.mjs send <bot> <message> --parent ${record.id}.`;
          const prompt = `[HOB relay from ${record.fromName} (${record.from})]\nExchange: ${record.id}. Complete this request with your own tools and reply with the result. Your reply returns to the caller automatically; do not message the caller to return it. ${delegation} Share only context needed for the work.\n\n${record.message}`;
          if (journal) await journal.reserve(hermesSessionKey(record.to, sessionId), { input: prompt, requestKey: record.id, credentialBinding: await client.credentialBinding(record.to) });
          const run = await client.runtime('/v1/runs', { profile: record.to, method: 'POST', idempotencyKey: record.id, body: { session_id: sessionId, input: prompt } });
          hermesResource(run?.run_id);
          const admitted = await patch(record.id, { runId: run.run_id, status: 'running' });
          void observe(admitted).catch(error => console.warn(`Exchange observation failed: ${error.message}`));
          return admitted;
        } catch (error) {
          await patch(record.id, { status: 'unknown', error: `Admission could not be confirmed: ${error.message}. Nothing was replayed.` }); throw error;
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
    return summary(exchanges.get(record.id));
  };
  const route = async (req, res, url, { json, body }) => {
    if (!url.pathname.startsWith(BASE)) return false;
    const sender = await bots.authenticate(/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1]);
    if (!sender) throw new HermesError(401, 'A bot relay credential is required.', 'RELAY_UNAUTHORIZED');
    const tail = url.pathname.slice(BASE.length);
    if (team && tail === '/team/core' && req.method === 'POST') {
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
      return json(res, 200, summary(await reconcile(record)));
    }
    throw new HermesError(404, 'Unknown bot relay endpoint.', 'NOT_FOUND');
  };
  route.dashboard = async (req, res, url, { json }) => {
    if (req.method !== 'GET') throw new HermesError(405, 'Read exchange history with GET.', 'INVALID_REQUEST');
    const profile = hermesProfile(url.searchParams.get('profile') || 'default');
    if (!bots.roster().some(bot => bot.name === profile && bot.state === 'active')) throw new HermesError(404, 'Bot not found.', 'BOT_NOT_FOUND');
    const match = /^\/api\/hermes\/exchanges\/([a-f0-9-]{36})(?:\/(transcript))?$/.exec(url.pathname);
    if (match) {
      let record = exchanges.get(match[1]);
      if (!record || ![record.from, record.to].includes(profile)) throw new HermesError(404, 'Exchange not found.', 'NOT_FOUND');
      if (match[2]) {
        if (!record.sessionId) return json(res, 200, { messages: [] });
        const result = await client.runtime(`/api/sessions/${hermesResource(record.sessionId)}/messages`, { profile: record.to });
        return json(res, 200, { messages: Array.isArray(result?.data) ? result.data : [] });
      }
      record = await reconcile(record); return json(res, 200, { ...summary(record), wakeups: exchanges.wakeups(record.id) });
    }
    if (url.pathname !== '/api/hermes/exchanges') throw new HermesError(404, 'Exchange not found.', 'NOT_FOUND');
    const session = url.searchParams.get('session');
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 0) throw invalid('Invalid history cursor.');
    const records = session ? exchanges.timeline(profile, session) : exchanges.list(profile, before);
    const result = [];
    for (const record of records) {
      const { message: _message, reply: _reply, ...notice } = summary(await reconcile(record));
      result.push(notice);
    }
    return json(res, 200, { exchanges: result, earlier: Boolean(session && records.length === 100), nextBefore: !session && records.length === 50 ? records.at(-1).createdAt : null });
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
    exchanges.close();
  };
  return route;
}
