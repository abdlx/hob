import { randomUUID } from 'node:crypto';
import { HermesError, hermesResource } from './hermes-client.mjs';

const BASE = '/api/hermes/bot-relay';
const RELAY_TITLE = 'HOB Bot Relay';
const DEFAULT_WAIT_MS = 120000;
const MAX_WAIT_MS = 600000;
const MAX_MESSAGE = 64000;

const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/**
 * Bot-to-bot messaging over HOB's own surface.
 *
 * A bot authenticates with its existing Hermes listener credential; HOB maps
 * that credential back to its dashboard record, so a bot cannot claim to be
 * another bot by writing a name into the request. The receiving bot gets a real
 * Hermes run in a dedicated relay conversation, and the sender receives its
 * final answer (or the admission id when the answer outlives the wait).
 */
export function createHermesBotRelay({ client, bots }) {
  const conversations = new Map();
  const queues = new Map();

  const conversation = receiver => {
    const current = conversations.get(receiver);
    if (current) return current;
    const work = (async () => {
      const listed = await client.runtime('/api/sessions', { profile: receiver });
      const rows = Array.isArray(listed?.data) ? listed.data : [];
      const existing = rows.find(row => row?.title === RELAY_TITLE && (!row.source || row.source === 'api'));
      if (typeof existing?.id === 'string' && existing.id) return existing.id;
      const created = await client.runtime('/api/sessions', {
        profile: receiver, method: 'POST', body: { title: RELAY_TITLE },
      });
      const id = created?.session?.id ?? created?.id;
      if (typeof id !== 'string' || !id) {
        throw new HermesError(502, 'Hermes did not confirm the relay conversation.', 'HERMES_PROTOCOL_ERROR');
      }
      return id;
    })();
    conversations.set(receiver, work);
    work.catch(() => { if (conversations.get(receiver) === work) conversations.delete(receiver); });
    return work;
  };

  // One receiving conversation should not have two relay turns admitted into it
  // at once; queue those sends instead of turning a busy bot into an error.
  const serialize = (receiver, work) => {
    const previous = queues.get(receiver) ?? Promise.resolve();
    const next = previous.then(work, work);
    queues.set(receiver, next.then(() => undefined, () => undefined));
    return next;
  };

  const participant = reference => {
    if (typeof reference !== 'string' || !reference.trim()) return null;
    const wanted = reference.trim().toLowerCase();
    const roster = bots.roster().filter(bot => bot.state === 'active');
    return roster.find(bot => bot.name === reference) ??
      roster.find(bot => text(bot.displayName || bot.display_name).toLowerCase() === wanted) ?? null;
  };

  const waitForReply = async (runId, receiver, waitMs) => {
    if (!Number.isFinite(waitMs) || waitMs < 1) return { completed: false, reply: '' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    timer.unref?.();
    let completed = false, reply = '', failure = '';
    try {
      for await (const event of client.events(runId, { profile: receiver, signal: controller.signal })) {
        if (event.event === 'message.delta' && typeof event.delta === 'string') reply += event.delta;
        else if (event.event === 'run.completed') {
          completed = true;
          if (typeof event.output === 'string') reply = event.output;
          break;
        } else if (['run.failed', 'run.cancelled', 'run.interrupted', 'run.unknown'].includes(event.event)) {
          failure = event.event;
          break;
        }
      }
    } catch (error) {
      // The deadline is our own; the receiver's run keeps going and its reply
      // remains in the relay conversation. Any other failure is real.
      if (!controller.signal.aborted) throw error;
    } finally { clearTimeout(timer); }
    return { completed, reply: reply.trim(), failure };
  };

  const send = async (sender, input) => {
    const receiver = participant(input.to);
    if (!receiver) throw new HermesError(404, 'That bot is not active in this dashboard.', 'BOT_NOT_FOUND');
    if (receiver.name === sender.name) throw new HermesError(400, 'Send the message to another bot.', 'INVALID_REQUEST');
    // Main is the coordinator. A worker contacting another worker directly would
    // make routing and approvals ambiguous, so only Main fans work out.
    if (sender.name !== 'default' && receiver.name !== 'default') {
      throw new HermesError(403, 'Route cross-bot work through Main (`default`).', 'RELAY_VIA_MAIN');
    }
    const message = typeof input.message === 'string' ? input.message : '';
    if (!message.trim() || message.length > MAX_MESSAGE) {
      throw new HermesError(400, 'Enter a message under 64,000 characters.', 'INVALID_REQUEST');
    }
    const waitMs = input.waitMs === undefined ? DEFAULT_WAIT_MS : Number(input.waitMs);
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
      throw new HermesError(400, 'Choose a relay wait between zero and ten minutes.', 'INVALID_REQUEST');
    }

    const senderName = text(sender.displayName || sender.display_name) || (sender.name === 'default' ? 'Main' : sender.name);
    const header = sender.name === 'default'
      ? `[HOB relay from Main (${sender.name})] Main has delegated this to you. Complete it with your own tools and reply with the result.`
      : `[HOB relay from ${senderName} (${sender.name})] This bot works for Main. Reply with the result; Main will use your answer.`;
    const run = await client.runtime('/v1/runs', {
      profile: receiver.name,
      method: 'POST',
      idempotencyKey: randomUUID(),
      body: { session_id: await conversation(receiver.name), input: `${header}\n\n${message}` },
    });
    const runId = run?.run_id;
    if (typeof runId !== 'string' || !runId) {
      throw new HermesError(502, 'Hermes did not confirm the relayed message.', 'HERMES_PROTOCOL_ERROR');
    }
    hermesResource(runId);
    const waited = await waitForReply(runId, receiver.name, waitMs);
    if (waited.failure) {
      throw new HermesError(502, 'The receiving bot did not complete the relayed message.', 'RELAY_TURN_FAILED');
    }
    return {
      ok: true,
      from: sender.name,
      fromName: senderName,
      to: receiver.name,
      toName: text(receiver.displayName || receiver.display_name) || (receiver.name === 'default' ? 'Main' : receiver.name),
      runId,
      completed: waited.completed,
      ...(waited.reply ? { reply: waited.reply } : {}),
    };
  };

  return async (req, res, url, { json, body }) => {
    if (!url.pathname.startsWith(BASE)) return false;
    const tail = url.pathname.slice(BASE.length);
    const method = req.method;
    const authorization = req.headers.authorization || '';
    const token = /^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1];
    const sender = await bots.authenticate(token);
    if (!sender) throw new HermesError(401, 'A bot relay credential is required.', 'RELAY_UNAUTHORIZED');

    if (tail === '/roster' && method === 'GET') {
      return json(res, 200, {
        self: sender.name,
        bots: bots.roster().filter(bot => bot.state === 'active').map(bot => ({
          id: bot.name,
          name: text(bot.displayName || bot.display_name) || (bot.name === 'default' ? 'Main' : bot.name),
          description: text(bot.description),
          model: text(bot.model),
          main: bot.name === 'default',
          available: !bot.state || bot.state === 'active',
        })),
      });
    }
    if (tail === '/send' && method === 'POST') {
      const input = await body(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['to', 'message', 'waitMs'].includes(key))) {
        throw new HermesError(400, 'Unsupported relay request.', 'INVALID_REQUEST');
      }
      const result = await serialize(participant(input.to)?.name || String(input.to || ''), () => send(sender, input));
      return json(res, 200, result);
    }
    throw new HermesError(404, 'Unknown bot relay endpoint.', 'NOT_FOUND');
  };
}
