import { randomUUID } from 'node:crypto';
import { HermesError, hermesProfile, hermesResource, hermesSessionKey, parseHermesSessionKey } from './hermes-client.mjs';

function iso(value) {
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function sessionView(session, profile) {
  return { id: hermesSessionKey(profile, session.id), agentId: profile,
    title: session.title || 'New conversation', createdAt: iso(session.started_at), lastMessageSnippet: session.preview || '' };
}

function textContent(value) {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.filter(part => part.type === 'text').map(part => part.text || '').join('\n') : '';
}

function rows(value) {
  if (!Array.isArray(value?.data)) throw new HermesError(502, 'Hermes returned an invalid session response.', 'HERMES_PROTOCOL_ERROR');
  return value.data;
}

export function createHermesChatRoutes(client, bots) {
  // These are presentation caches, not approval authority. Hermes validates the
  // exact request_id when a human responds. Durable run recovery is separate.
  const approvals = new Map();
  const activeRuns = new Map();
  const clearRun = (key, run) => {
    activeRuns.delete(key);
    for (const [id, item] of approvals) if (item.runId === run.id && item.profile === run.profile) approvals.delete(id);
  };
  const observeApproval = (event, runId, profile) => {
    if (typeof event.request_id !== 'string' || !event.request_id) return;
    if ([...approvals.values()].some(item => item.profile === profile && item.runId === runId && item.requestId === event.request_id)) return;
    if (approvals.size >= 1000) throw new HermesError(503, 'Too many pending approvals. Resolve existing requests first.', 'APPROVAL_LIMIT');
    const item = { id: randomUUID(), profile, runId, requestId: event.request_id,
      type: 'command', description: event.description || 'Hermes requests command approval.', commandSnippet: event.command || '',
      riskLevel: 'medium', requestedAt: iso(event.timestamp), status: 'pending' };
    approvals.set(item.id, item);
    client.emit('event', { event: 'exec.approval.requested', payload: { id: item.id } });
  };
  const reconcile = async profile => {
    for (const [key, run] of activeRuns) {
      if (run.profile !== profile || !run.id) continue;
      const state = await client.runtime(`/v1/runs/${hermesResource(run.id)}`, { profile });
      if (state.run_id !== run.id) throw new HermesError(502, 'Hermes returned another run’s status.', 'HERMES_PROTOCOL_ERROR');
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(state.status)) clearRun(key, run);
      else if (state.status === 'waiting_for_approval' && state.approval) observeApproval(state.approval, run.id, profile);
    }
  };
  const sessionRows = profile => client.runtime('/api/sessions', { profile }).then(rows);
  const listBots = () => bots ? bots.list() : client.dashboard('/api/profiles');
  const agentView = async profile => {
    const roster = await listBots();
    const item = roster.profiles?.find(item => item.name === profile);
    if (!item) throw new HermesError(404, 'This bot no longer exists.', 'NOT_FOUND');
    return { id: profile, name: item.display_name || item.bot_title || (profile === 'default' ? 'Main' : profile),
      status: client.connected ? 'connected' : 'disconnected', avatarUrl: '', roleDescription: item.description || '',
      model: item.model || '', agentRuntime: 'hermes' };
  };

  return async (req, res, url, { json, body, startEvents, sendEvent, required }) => {
    const method = req.method;
    const profile = hermesProfile(req.headers['x-hob-profile'] ?? 'default');
    if (url.pathname === '/api/sessions' && method === 'GET') {
      json(res, 200, (await sessionRows(profile)).map(item => sessionView(item, profile))); return true;
    }
    if (url.pathname === '/api/sessions' && method === 'POST') {
      const input = await body(req);
      if (input.agentId && input.agentId !== profile) throw new HermesError(400, 'The selected bot does not match this conversation.', 'INVALID_PROFILE');
      const created = await client.runtime('/api/sessions', { profile, method, body: { title: required(input.title || 'New conversation', 'title', 500) } });
      json(res, 201, sessionView(created.session, profile)); return true;
    }
    if (url.pathname === '/api/agent' && method === 'GET') {
      json(res, 200, await agentView(profile)); return true;
    }
    if (url.pathname === '/api/agents' && method === 'GET') {
      const roster = await listBots();
      json(res, 200, { agents: (roster.profiles || []).filter(item => !item.state || item.state === 'active').map(item => ({ id: item.name, name: item.display_name || (item.name === 'default' ? 'Main' : item.name) })) }); return true;
    }
    if (url.pathname === '/api/tasks' && method === 'GET') {
      await reconcile(profile);
      json(res, 200, (await sessionRows(profile)).map(item => ({ id: hermesSessionKey(profile, item.id), title: item.title || item.id,
        subtitle: item.preview || '', timestamp: iso(item.last_active || item.started_at),
        status: activeRuns.has(hermesSessionKey(profile, item.id)) ? 'in_progress' : item.ended_at ? 'completed' : 'pending' }))); return true;
    }
    if (url.pathname === '/api/stats' && method === 'GET') {
      const start = performance.now();
      const sessions = await sessionRows(profile);
      json(res, 200, { tokensUsed: sessions.reduce((total, item) => total + (Number(item.input_tokens) || 0) + (Number(item.output_tokens) || 0), 0),
        maxTokens: 0, memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        latencyMs: Math.round(performance.now() - start), activeProcesses: [...activeRuns.values()].filter(item => item.profile === profile).length }); return true;
    }
    if (url.pathname === '/api/security/approvals' && method === 'GET') {
      await reconcile(profile);
      json(res, 200, [...approvals.values()].filter(item => item.profile === profile).map(({ profile: _profile, runId: _runId, requestId: _requestId, ...view }) => view)); return true;
    }
    const approval = /^\/api\/security\/approvals\/([^/]+)$/.exec(url.pathname);
    if (approval && method === 'POST') {
      const item = approvals.get(approval[1]);
      if (!item || item.profile !== profile) throw new HermesError(404, 'This approval is no longer available. Refresh the run.', 'NOT_FOUND');
      const input = await body(req);
      const choice = { approved: 'once', rejected: 'deny' }[input.decision];
      if (!choice) throw new HermesError(400, 'Choose approve once or reject.', 'INVALID_REQUEST');
      const result = await client.runtime(`/v1/runs/${hermesResource(item.runId)}/approval`, { profile: item.profile, method,
        body: { choice, request_id: item.requestId } });
      approvals.delete(item.id);
      json(res, 200, result); return true;
    }
    const match = /^\/api\/sessions\/([^/]+)\/(messages|turns|abort)$/.exec(url.pathname);
    if (!match) return false;
    const key = decodeURIComponent(match[1]);
    const owner = parseHermesSessionKey(key);
    const sessionPath = `/api/sessions/${hermesResource(owner.sessionId)}`;
    if (match[2] === 'messages' && method === 'GET') {
      const messages = rows(await client.runtime(`${sessionPath}/messages`, { profile: owner.profile }));
      json(res, 200, messages.filter(message => ['user', 'assistant', 'system'].includes(message.role)).map((message, index) => ({
        id: String(message.id ?? `${owner.sessionId}-${index}`), role: message.role,
        content: textContent(message.content), timestamp: iso(message.timestamp), status: 'complete',
      }))); return true;
    }
    if (match[2] === 'abort' && method === 'POST') {
      const run = activeRuns.get(key);
      if (!run?.id) throw new HermesError(409, 'No observed active run belongs to this conversation. Refresh Activity.', 'RUN_NOT_AVAILABLE');
      json(res, 200, await client.runtime(`/v1/runs/${hermesResource(run.id)}/stop`, { profile: owner.profile, method, body: {} })); return true;
    }
    if (match[2] !== 'turns' || method !== 'POST') return false;
    const input = await body(req);
    const content = required(input.content, 'content', 100000);
    if (input.attachments?.length) throw new HermesError(400, 'Attachment upload has not been connected to Hermes yet.', 'ATTACHMENTS_UNAVAILABLE');
    if (activeRuns.has(key)) await reconcile(owner.profile);
    if (activeRuns.has(key)) throw new HermesError(409, 'A run is active or its admission outcome is unknown. Refresh Activity before retrying.', 'RUN_ACTIVE');
    // Reserve before awaiting admission so simultaneous browser requests cannot
    // both start a turn. No request is replayed after an uncertain write.
    activeRuns.set(key, { id: null, profile: owner.profile });
    let accepted;
    try {
      accepted = await client.runtime('/v1/runs', { profile: owner.profile, method, idempotencyKey: input.idempotencyKey || randomUUID(),
        body: { input: content, session_id: owner.sessionId } });
      try { hermesResource(accepted.run_id); }
      catch { throw new HermesError(502, 'Hermes returned an invalid run admission response. Refresh before retrying.', 'HERMES_PROTOCOL_ERROR'); }
    } catch (error) {
      if (error.status !== 502 && error.status !== 503) activeRuns.delete(key);
      throw error;
    }
    activeRuns.set(key, { id: accepted.run_id, profile: owner.profile });
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once('close', close);
    startEvents(res);
    sendEvent(res, 'accepted', { runId: accepted.run_id, sessionId: key });
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
    heartbeat.unref();
    let terminal = false;
    let text = '';
    try {
      for await (const event of client.events(accepted.run_id, { profile: owner.profile, signal: controller.signal })) {
        if (res.destroyed) break;
        if (event.event === 'message.delta' && typeof event.delta === 'string') {
          text += event.delta;
          sendEvent(res, 'delta', { text: event.delta });
        } else if (event.event === 'approval.request') {
          observeApproval(event, accepted.run_id, owner.profile);
          sendEvent(res, 'status', event);
        } else if (event.event === 'run.completed') {
          terminal = true;
          sendEvent(res, 'done', { message: { id: accepted.run_id, role: 'assistant', content: typeof event.output === 'string' ? event.output : text,
            timestamp: iso(event.timestamp), status: 'complete' } });
          break;
        } else if (['run.failed', 'run.cancelled', 'run.interrupted', 'run.unknown'].includes(event.event)) {
          terminal = true;
          sendEvent(res, 'error', { message: event.event === 'run.cancelled' ? 'Turn cancelled.' : 'Hermes did not complete this turn. Review Activity before retrying.' });
          break;
        } else sendEvent(res, 'status', event);
      }
      if (!terminal && !res.destroyed) sendEvent(res, 'error', { message: 'The run stream ended before completion. Hermes may still be working; refresh Activity before retrying.' });
    } finally {
      clearInterval(heartbeat);
      res.off('close', close);
      // A lost browser stream is not proof the run stopped. Keep the run id so
      // cancellation remains available and duplicate submissions are blocked.
      if (terminal) {
        clearRun(key, { id: accepted.run_id, profile: owner.profile });
      }
      client.emit('event', { event: 'sessions.changed', payload: { sessionKey: key } });
      res.end();
    }
    return true;
  };
}
