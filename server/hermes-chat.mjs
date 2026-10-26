import { randomUUID } from 'node:crypto';
import { HermesError, hermesProfile, hermesResource, hermesSessionKey, parseHermesSessionKey } from './hermes-client.mjs';
import { avatarUrl } from './hermes-avatars.mjs';
import { messageContentText } from './hermes-content.mjs';
import { HermesRunJournal, TERMINAL_RUNS, runFingerprint } from './hermes-run-journal.mjs';

function iso(value) {
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function sessionView(session, profile) {
  return { id: hermesSessionKey(profile, session.id), agentId: profile,
    title: session.title || 'New conversation', createdAt: iso(session.started_at), lastMessageSnippet: session.preview || '' };
}

function rows(value) {
  if (!Array.isArray(value?.data)) throw new HermesError(502, 'Hermes returned an invalid session response.', 'HERMES_PROTOCOL_ERROR');
  return value.data;
}

export function createHermesChatRoutes(client, bots, journal = new HermesRunJournal(), { home } = {}) {
  // These are presentation caches, not approval authority. Hermes validates the
  // exact prompt ID/generation when a human responds. Run references survive
  // restart in the journal; prompt authority always comes from native status.
  const approvals = new Map();
  const questions = new Map();
  const recovering = new Set();
  const activeRuns = profile => journal.list(profile).filter(run => parseHermesSessionKey(run.key).transport !== 'canonical' && !TERMINAL_RUNS.has(run.status));
  const clearRun = async (key, run, status) => {
    await journal.update(key, run.requestKey, { status });
    for (const [id, item] of approvals) if (item.runId === run.id && item.profile === run.profile) approvals.delete(id);
    for (const [id, item] of questions) if (item.runId === run.id && item.profile === run.profile) questions.delete(id);
  };
  const observeApproval = (event, runId, profile) => {
    const requestId = event.request_id ?? event.prompt_id;
    const generation = event.execution_generation;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) return;
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) return;
    if (event.prompt_id && generation === undefined) return; // canonical prompts must bind an epoch
    if ([...approvals.values()].some(item => item.profile === profile && item.runId === runId && item.requestId === requestId && item.generation === generation)) return;
    if (approvals.size >= 1000) throw new HermesError(503, 'Too many pending approvals. Resolve existing requests first.', 'APPROVAL_LIMIT');
    const item = { id: randomUUID(), profile, runId, requestId, generation,
      type: 'command', description: event.description || 'Hermes requests command approval.', commandSnippet: event.command || '',
      riskLevel: 'medium', requestedAt: iso(event.timestamp), status: 'pending' };
    approvals.set(item.id, item);
    client.emit('event', { event: 'exec.approval.requested', payload: { id: item.id } });
  };
  const refreshRun = async run => {
    if (!run.runId) return run;
    let state;
    try { state = await client.runtime(`/v1/runs/${hermesResource(run.runId)}`, { profile: run.profile }); }
    catch (error) {
      if (error.status !== 404) throw error;
      for (const [id, item] of approvals) if (item.runId === run.runId && item.profile === run.profile) approvals.delete(id);
      for (const [id, item] of questions) if (item.runId === run.runId && item.profile === run.profile) questions.delete(id);
      return journal.update(run.key, run.requestKey, { status: 'unavailable' });
    }
    if (state.run_id !== run.runId) throw new HermesError(502, 'Hermes returned another run’s status.', 'HERMES_PROTOCOL_ERROR');
    const patch = { status: state.status };
    if (Number.isSafeInteger(state.execution_generation) && state.execution_generation >= 0) patch.generation = state.execution_generation;
    if (typeof state.admission_id === 'string') patch.admissionId = state.admission_id;
    const updated = await journal.update(run.key, run.requestKey, patch);
    if (!updated) return undefined;
    const prompts = Array.isArray(state.pending_controls) ? state.pending_controls.filter(item => item.kind === 'approval')
      : state.status === 'waiting_for_approval' && state.approval ? [state.approval] : [];
    for (const [id, item] of approvals) {
      if (item.runId === run.runId && item.profile === run.profile && !prompts.some(prompt =>
        (prompt.request_id ?? prompt.prompt_id) === item.requestId && prompt.execution_generation === item.generation)) approvals.delete(id);
    }
    if (!TERMINAL_RUNS.has(updated.status)) for (const prompt of prompts) observeApproval(prompt, run.runId, run.profile);
    for (const [id, item] of questions) if (item.runId === run.runId && item.profile === run.profile) questions.delete(id);
    if (!TERMINAL_RUNS.has(updated.status) && Array.isArray(state.pending_controls)) for (const prompt of state.pending_controls) {
      if (prompt.kind !== 'clarify' || typeof prompt.prompt_id !== 'string' || !prompt.prompt_id || prompt.prompt_id.length > 256
        || !Number.isSafeInteger(prompt.execution_generation) || prompt.execution_generation < 0 || typeof prompt.question !== 'string') continue;
      const id = runFingerprint({ profile: run.profile, runId: run.runId, promptId: prompt.prompt_id, generation: prompt.execution_generation });
      questions.set(id, { id, profile: run.profile, runId: run.runId, requestId: prompt.prompt_id, generation: prompt.execution_generation,
        question: prompt.question, choices: Array.isArray(prompt.choices) ? prompt.choices.filter(choice => typeof choice === 'string') : [], multiSelect: prompt.multi_select === true });
    }
    if (updated && updated.status !== run.status) client.emit('event', { event: 'sessions.changed', payload: { sessionKey: run.key } });
    return updated;
  };
  const reconcile = async profile => {
    for (const run of activeRuns(profile)) await refreshRun(run);
  };
  const runView = run => run ? { runId: run.runId, status: run.runId || TERMINAL_RUNS.has(run.status) ? run.status : 'unknown', submittedAt: new Date(run.submittedAt).toISOString(),
    revision: runFingerprint({ key: run.key, requestKey: run.requestKey, runId: run.runId, generation: run.generation, admissionId: run.admissionId }),
    canRecover: !run.runId && !TERMINAL_RUNS.has(run.status) && typeof run.input === 'string' && Date.now() >= run.submittedAt && Date.now() < run.replayUntil,
    canResolveUnknown: run.status === 'unknown' && typeof run.admissionId === 'string' && Number.isSafeInteger(run.generation),
    questions: [...questions.values()].filter(item => item.profile === run.profile && item.runId === run.runId)
      .map(({ profile: _profile, runId: _runId, requestId: _requestId, ...view }) => view) } : null;
  const sessionRows = profile => client.runtime('/api/sessions', { profile }).then(rows);
  const listBots = () => bots ? bots.list() : client.dashboard('/api/profiles');
  const agentView = async profile => {
    const roster = await listBots();
    const item = roster.profiles?.find(item => item.name === profile);
    if (!item) throw new HermesError(404, 'This bot no longer exists.', 'NOT_FOUND');
    const startup = await client.getProfileStatus(profile);
    return { id: profile, name: item.display_name || item.bot_title || (profile === 'default' ? 'Main' : profile),
      status: startup.ready ? 'connected' : 'disconnected', avatarUrl: await avatarUrl(home, profile), roleDescription: item.description || '', tags: item.tags || [], identitySync: item.identitySync,
      model: item.model || '', agentRuntime: 'hermes' };
  };

  const route = async (req, res, url, { json, body, startEvents, sendEvent, required }) => {
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
      const items = (roster.profiles || []).filter(item => !item.state || item.state === 'active');
      json(res, 200, {
        agents: await Promise.all(items.map(async item => ({
          id: item.name,
          name: item.display_name || item.bot_title || (item.name === 'default' ? 'Main' : item.name),
          roleDescription: item.description || '', tags: item.tags || [], identitySync: item.identitySync,
          model: item.model || '',
          avatarUrl: await avatarUrl(home, item.name),
        })))
      }); return true;
    }
    if (url.pathname === '/api/tasks' && method === 'GET') {
      await reconcile(profile);
      json(res, 200, (await sessionRows(profile)).map(item => ({ id: hermesSessionKey(profile, item.id), title: item.title || item.id,
        subtitle: item.preview || '', timestamp: iso(item.last_active || item.started_at),
        status: (() => {
          const run = journal.get(hermesSessionKey(profile, item.id));
          if (!run) return item.ended_at ? 'completed' : 'pending';
          return ['admitting', 'unknown', 'unavailable'].includes(run.status) ? 'unknown' : TERMINAL_RUNS.has(run.status) ? run.status : 'in_progress';
        })() }))); return true;
    }
    if (url.pathname === '/api/stats' && method === 'GET') {
      const start = performance.now();
      const sessions = await sessionRows(profile);
      json(res, 200, { tokensUsed: sessions.reduce((total, item) => total + (Number(item.input_tokens) || 0) + (Number(item.output_tokens) || 0), 0),
        maxTokens: 0, memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        latencyMs: Math.round(performance.now() - start), activeProcesses: activeRuns(profile).length }); return true;
    }
    if (url.pathname === '/api/security/approvals' && method === 'GET') {
      await reconcile(profile);
      json(res, 200, [...approvals.values()].filter(item => item.profile === profile).map(({ profile: _profile, runId: _runId, requestId: _requestId, generation: _generation, ...view }) => view)); return true;
    }
    const approval = /^\/api\/security\/approvals\/([^/]+)$/.exec(url.pathname);
    if (approval && method === 'POST') {
      await reconcile(profile);
      const item = approvals.get(approval[1]);
      if (!item || item.profile !== profile) throw new HermesError(404, 'This approval is no longer available. Refresh the run.', 'NOT_FOUND');
      const input = await body(req);
      const choice = { approved: 'once', rejected: 'deny' }[input.decision];
      if (!choice) throw new HermesError(400, 'Choose approve once or reject.', 'INVALID_REQUEST');
      const result = await client.runtime(`/v1/runs/${hermesResource(item.runId)}/approval`, { profile: item.profile, method,
        body: { choice, request_id: item.requestId, ...(item.generation === undefined ? {} : { execution_generation: item.generation }) } });
      approvals.delete(item.id);
      json(res, 200, result); return true;
    }
    const match = /^\/api\/sessions\/([^/]+)\/(messages|turns|abort|run|recover|resolve-unknown|clarify|approvals)$/.exec(url.pathname);
    if (!match) return false;
    const key = decodeURIComponent(match[1]);
    const owner = parseHermesSessionKey(key);
    if (owner.transport === 'canonical') throw new HermesError(503, 'The native session adapter is unavailable. No HTTP fallback was attempted.', 'SESSION_UNAVAILABLE');
    const sessionPath = `/api/sessions/${hermesResource(owner.sessionId)}`;
    if (match[2] === 'run' && method === 'GET') {
      // Check bot enrollment even when there is no active native request.
      await client.credentialBinding(owner.profile);
      const current = journal.get(key);
      const run = current && !TERMINAL_RUNS.has(current.status) ? await refreshRun(current) : current;
      json(res, 200, { run: runView(run) }); return true;
    }
    if (match[2] === 'resolve-unknown' && method === 'POST') {
      const input = await body(req);
      if (input.confirmReviewed !== true || typeof input.expectedRevision !== 'string' || Object.keys(input).some(key => !['confirmReviewed', 'expectedRevision'].includes(key))) throw new HermesError(400, 'Review possible side effects and explicitly confirm before resolving unknown work.', 'CONFIRMATION_REQUIRED');
      const run = journal.get(key);
      const current = run && await refreshRun(run);
      if (!current || !runView(current).canResolveUnknown) throw new HermesError(409, 'This run has no current native unknown-work resolution.', 'RUN_NOT_UNKNOWN');
      if (input.expectedRevision !== runView(current).revision) throw new HermesError(409, 'The run changed. Review its current state before resolving it.', 'RUN_REVISION_CHANGED');
      await client.runtime(`/v1/runs/${hermesResource(current.runId)}/resolve-unknown`, { profile: owner.profile, method,
        body: { admission_id: current.admissionId, execution_generation: current.generation } });
      await refreshRun(current);
      json(res, 200, { run: runView(journal.get(key)) }); return true;
    }
    if (match[2] === 'clarify' && method === 'POST') {
      const input = await body(req);
      if (Object.keys(input).some(key => !['promptId', 'expectedRevision', 'answer'].includes(key)) || typeof input.promptId !== 'string'
        || typeof input.expectedRevision !== 'string' || typeof input.answer !== 'string' || !input.answer.trim() || input.answer.length > 16384) {
        throw new HermesError(400, 'Provide an answer to the current question.', 'INVALID_REQUEST');
      }
      const current = journal.get(key);
      const run = current && await refreshRun(current);
      if (!run || input.expectedRevision !== runView(run).revision) throw new HermesError(409, 'The run changed. Refresh its current question.', 'RUN_REVISION_CHANGED');
      const question = questions.get(input.promptId);
      if (!question || question.profile !== owner.profile || question.runId !== run.runId) throw new HermesError(409, 'That question is no longer pending.', 'QUESTION_NOT_PENDING');
      const result = await client.runtime(`/v1/runs/${hermesResource(run.runId)}/clarify`, { profile: owner.profile, method,
        body: { request_id: question.requestId, execution_generation: question.generation, answer: input.answer } });
      questions.delete(input.promptId);
      json(res, 200, result); return true;
    }
    if (match[2] === 'recover' && method === 'POST') {
      const input = await body(req);
      if (input.confirmDispatch !== true || typeof input.expectedRevision !== 'string' || Object.keys(input).some(key => !['confirmDispatch', 'expectedRevision'].includes(key))) throw new HermesError(400,
        'Explicitly confirm recovery: Hermes may start the original submission if it was never accepted.', 'CONFIRMATION_REQUIRED');
      const run = journal.get(key);
      if (!run || run.runId || !runView(run).canRecover || recovering.has(key)) throw new HermesError(409, 'This submission cannot be replayed safely. Inspect its history before taking further action.', 'RUN_RECOVERY_UNAVAILABLE');
      if (input.expectedRevision !== runView(run).revision) throw new HermesError(409, 'The submission changed. Review its current state before recovering it.', 'RUN_REVISION_CHANGED');
      recovering.add(key);
      try {
        if (await client.credentialBinding(owner.profile) !== run.credentialBinding) throw new HermesError(409, 'The bot credential changed. Recovery cannot use another admission scope.', 'RUN_SCOPE_CHANGED');
        const capabilities = await client.runtime('/v1/capabilities', { profile: owner.profile });
        if (capabilities.features?.runs_idempotency?.durable !== true) throw new HermesError(409, 'Hermes no longer advertises durable replay for this submission.', 'RUN_RECOVERY_UNAVAILABLE');
        const request = { input: run.input, session_id: run.sessionId };
        if (runFingerprint(request) !== run.fingerprint) throw new HermesError(409, 'The recorded submission changed. Nothing was dispatched.', 'RUN_RECOVERY_UNAVAILABLE');
        const accepted = await client.runtime('/v1/runs', { profile: owner.profile, method, idempotencyKey: run.requestKey, body: request });
        hermesResource(accepted.run_id);
        await journal.update(key, run.requestKey, { runId: accepted.run_id, status: 'queued' });
        await refreshRun(journal.get(key));
        json(res, 200, { run: runView(journal.get(key)) }); return true;
      } finally { recovering.delete(key); }
    }
    if (match[2] === 'approvals' && method === 'GET') {
      await client.credentialBinding(owner.profile);
      await reconcile(owner.profile);
      const run = journal.get(key);
      json(res, 200, { approvals: [...approvals.values()].filter(item => item.profile === owner.profile && item.runId === run?.runId)
        .map(({ profile: _profile, runId: _runId, requestId: _requestId, generation: _generation, ...view }) => view) });
      return true;
    }
    if (match[2] === 'messages' && method === 'GET') {
      const messages = rows(await client.runtime(`${sessionPath}/messages`, { profile: owner.profile }));
      json(res, 200, messages.filter(message => ['user', 'assistant', 'system'].includes(message.role)).map((message, index) => ({
        id: String(message.id ?? `${owner.sessionId}-${index}`), role: message.role,
        content: messageContentText(message.content), timestamp: iso(message.timestamp), status: 'complete',
        profile: owner.profile,
      }))); return true;
    }
    if (match[2] === 'abort' && method === 'POST') {
      const input = await body(req);
      const run = journal.get(key);
      if (!run?.runId || TERMINAL_RUNS.has(run.status)) throw new HermesError(409, 'No observed active run belongs to this conversation. Refresh Activity.', 'RUN_NOT_AVAILABLE');
      if (input.expectedRunId !== undefined && input.expectedRunId !== run.runId) throw new HermesError(409, 'This conversation now has another run. Refresh before stopping it.', 'RUN_REVISION_CHANGED');
      json(res, 200, await client.runtime(`/v1/runs/${hermesResource(run.runId)}/stop`, { profile: owner.profile, method, body: {} })); return true;
    }
    if (match[2] !== 'turns' || method !== 'POST') return false;
    const input = await body(req);
    const content = required(input.content, 'content', 100000);
    if (input.attachments?.length) throw new HermesError(400, 'Attachment upload has not been connected to Hermes yet.', 'ATTACHMENTS_UNAVAILABLE');
    const previous = journal.get(key);
    if (previous && !TERMINAL_RUNS.has(previous.status)) await refreshRun(previous);
    // Reserve before awaiting admission so simultaneous browser requests cannot
    // both start a turn. No request is replayed after an uncertain write.
    const capabilities = await client.runtime('/v1/capabilities', { profile: owner.profile });
    const idempotency = capabilities.features?.runs_idempotency;
    const run = await journal.reserve(key, { input: content, requestKey: input.idempotencyKey ?? randomUUID(),
      credentialBinding: await client.credentialBinding(owner.profile), retentionSeconds: idempotency?.durable === true
        && idempotency.supported === true && Number.isFinite(idempotency.retention_seconds) ? idempotency.retention_seconds : 0 });
    let accepted;
    try {
      accepted = await client.runtime('/v1/runs', { profile: owner.profile, method, idempotencyKey: run.requestKey,
        body: { input: content, session_id: owner.sessionId } });
      try { hermesResource(accepted.run_id); }
      catch { throw new HermesError(502, 'Hermes returned an invalid run admission response. Refresh before retrying.', 'HERMES_PROTOCOL_ERROR'); }
      await journal.update(key, run.requestKey, { runId: accepted.run_id, status: 'queued' });
    } catch (error) {
      await journal.update(key, run.requestKey, { status: [400, 403, 404, 409, 422, 429].includes(error.status) ? 'failed' : 'unknown' });
      throw error;
    }
    if (res.destroyed) return true;
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once('close', close);
    startEvents(res);
    sendEvent(res, 'accepted', { runId: accepted.run_id, sessionId: key });
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
    heartbeat.unref();
    let terminal = false;
    let reportedError = false;
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
          await clearRun(key, { ...run, id: accepted.run_id }, 'completed');
          sendEvent(res, 'done', { message: { id: accepted.run_id, role: 'assistant',
            content: typeof event.output === 'string' ? event.output : messageContentText(event.output) || text,
            timestamp: iso(event.timestamp), status: 'complete', profile: owner.profile } });
          break;
        } else if (['run.failed', 'run.cancelled', 'run.interrupted', 'run.unknown'].includes(event.event)) {
          reportedError = true;
          terminal = event.event !== 'run.unknown';
          if (terminal) await clearRun(key, { ...run, id: accepted.run_id }, event.event.slice(4));
          else await journal.update(key, run.requestKey, { status: 'unknown' });
          sendEvent(res, 'error', { message: event.event === 'run.cancelled' ? 'Turn cancelled.' : 'Hermes did not complete this turn. Review Activity before retrying.' });
          break;
        } else sendEvent(res, 'status', event);
      }
      if (!terminal && !reportedError && !res.destroyed) sendEvent(res, 'error', { message: 'The run stream ended before completion. Hermes may still be working; refresh Activity before retrying.' });
    } finally {
      clearInterval(heartbeat);
      res.off('close', close);
      // A lost browser stream is not proof the run stopped. Keep the run id so
      // cancellation remains available and duplicate submissions are blocked.
      client.emit('event', { event: 'sessions.changed', payload: { sessionKey: key } });
      res.end();
    }
    return true;
  };
  route.reconcile = async () => {
    const results = await Promise.allSettled([...new Set(activeRuns().map(run => run.profile))].map(reconcile));
    return results.every(result => result.status === 'fulfilled');
  };
  route.pendingApprovals = async profile => {
    await reconcile(profile);
    return [...approvals.values()].filter(item => item.profile === profile)
      .map(({ profile: _profile, runId: _runId, requestId: _requestId, generation: _generation, ...view }) => view);
  };
  route.agentProfile = agentView;
  return route;
}
