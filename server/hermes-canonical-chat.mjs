import { randomUUID } from 'node:crypto';
import { HermesError, hermesProfile, hermesResource, hermesSessionKey, hermesNativeSessionKey, parseHermesSessionKey } from './hermes-client.mjs';
import { messageContentText } from './hermes-content.mjs';
import { TERMINAL_RUNS, runFingerprint } from './hermes-run-journal.mjs';
import { createHermesAttachments } from './hermes-attachments.mjs';

const iso = value => {
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString() : '';
};
const nativeStatus = receipt => {
  if (receipt.status === 'terminal') {
    if (!TERMINAL_RUNS.has(receipt.outcome)) throw new HermesError(502, 'Hermes returned an unknown terminal outcome.', 'HERMES_PROTOCOL_ERROR');
    return receipt.outcome;
  }
  if (!['queued', 'started', 'unknown'].includes(receipt.status)) throw new HermesError(502, 'Hermes returned an invalid admission state.', 'HERMES_PROTOCOL_ERROR');
  return receipt.status === 'started' ? 'running' : receipt.status;
};
// Native settlements carry an already-redacted reason (gateway/session_results.py). Surface a
// bounded, single-line form so a failed turn is actionable; the generic sentence names no cause.
const failureReason = receipt => {
  const result = receipt?.result && typeof receipt.result === 'object' ? receipt.result : {};
  const reason = [result.error, result.turn_exit_reason].find(value => typeof value === 'string' && value.trim());
  return typeof reason === 'string'
    ? reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
};

/** Translate custom chat UX into the one native session/FIFO owner, without exposing raw RPC. */
export function createHermesCanonicalChatRoutes({ bridge, client, journal, httpChat, attachmentSecret = randomUUID(), onCompleted, recoverCompleted = false, telemetry }) {
  const attachments = createHermesAttachments({ bridge, client, secret: attachmentSecret });
  const observed = new Set();
  const prompts = new Map();
  const refreshes = new Map();
  const canonicalRuns = profile => journal.list(profile).filter(run => parseHermesSessionKey(run.key).transport === 'canonical');
  // Observe retained terminal receipts after restart to recover file delivery.
  // These reads never resubmit a model turn or replay tool side effects.
  const deliveryRecovery = new Set(recoverCompleted ? canonicalRuns().filter(run => run.status === 'completed').map(run => run.key) : []);
  const measuredSettlements = new Set();
  const rpc = (owner, method, params = {}) => bridge.rpc(owner.profile, method, { session_id: owner.sessionId, ...params });
  const promptId = (key, prompt) => 'native-' + runFingerprint({ key, id: prompt.prompt_id, generation: prompt.execution_generation });
  const revision = (owner, admissionId, generation, epoch) => runFingerprint({ ...owner, admissionId, generation, epoch });

  const refresh = key => {
    if (refreshes.has(key)) return refreshes.get(key);
    const work = (async () => {
      const owner = parseHermesSessionKey(key);
      const snapshot = await rpc(owner, 'session.resume');
      if (snapshot.session_id !== owner.sessionId || !Array.isArray(snapshot.pending) || !Array.isArray(snapshot.prompts)
        || !Array.isArray(snapshot.messages) || !Number.isSafeInteger(snapshot.authority_epoch) || snapshot.authority_epoch <= 0
        || !Number.isSafeInteger(snapshot.execution_generation) || snapshot.execution_generation < 0) {
        throw new HermesError(502, 'Hermes returned another conversation or an invalid snapshot.', 'HERMES_PROTOCOL_ERROR');
      }
      observed.add(key);
      if (!snapshot.pending.length) observed.delete(key);
      for (const [id, item] of prompts) if (item.key === key) prompts.delete(id);
      for (const prompt of snapshot.prompts) {
        if (!['clarify', 'approval'].includes(prompt.kind) || typeof prompt.prompt_id !== 'string'
          || !Number.isSafeInteger(prompt.execution_generation) || prompt.execution_generation < 0) continue;
        prompts.set(promptId(key, prompt), { key, owner, prompt });
      }
      let record = journal.get(key);
      // Lost acceptance can be recovered by observation of the native pending
      // ledger. This is a read, never a replay of the submitted input.
      if (record && !record.runId && !TERMINAL_RUNS.has(record.status)) {
        const accepted = snapshot.pending.find(item => item.input_id === record.requestKey && item.text === record.input);
        if (accepted) record = await journal.update(key, record.requestKey, { runId: accepted.admission_id, status: nativeStatus(accepted) });
      }
      let receipt;
      if (record?.runId) {
        try { receipt = await rpc(owner, 'prompt.receipt', { admission_id: record.runId, include_result: true }); }
        catch (error) {
          if (error.code !== 'not_found') throw error;
          if (!TERMINAL_RUNS.has(record.status)) record = await journal.update(key, record.requestKey, { status: 'unavailable' });
        }
        if (receipt) {
          if (receipt.admission_id !== record.runId || receipt.ref?.session_id !== owner.sessionId) {
            throw new HermesError(502, 'Hermes returned another admission’s receipt.', 'HERMES_PROTOCOL_ERROR');
          }
          record = await journal.update(key, record.requestKey, { status: nativeStatus(receipt),
            ...(Number.isSafeInteger(receipt.execution_generation) ? { generation: receipt.execution_generation } : {}) });
          const measurementKey = `${owner.profile}:${record.runId}`;
          if (telemetry && TERMINAL_RUNS.has(record.status) && !measuredSettlements.has(measurementKey)) {
            measuredSettlements.add(measurementKey);
            if (measuredSettlements.size > 2000) measuredSettlements.delete(measuredSettlements.values().next().value);
            telemetry.record(owner.profile, 'turn.settlement', Math.max(0, Date.now() - record.submittedAt), record.status === 'completed' ? 'ok' : record.status === 'cancelled' ? 'cancelled' : record.status === 'failed' ? 'error' : 'unknown', { runId: record.runId });
          }
          if (record.status === 'completed') onCompleted?.({ profile: owner.profile, sessionId: owner.sessionId, admissionId: record.runId, createdAt: record.submittedAt,
            output: messageContentText(receipt.result?.final_response) });
        }
      }
      // Native work from another attached viewer also fences new UI submissions.
      const active = snapshot.pending.find(item => item.status === 'started' || item.status === 'unknown') || snapshot.pending[0];
      const current = active || receipt;
      const runId = current?.admission_id || record?.runId || null;
      let status = current ? nativeStatus(current) : record?.status;
      if (status === 'running' && snapshot.prompts.some(prompt => prompt.kind === 'approval')) status = 'waiting_for_approval';
      const generation = current?.execution_generation ?? snapshot.execution_generation;
      const epoch = snapshot.authority_epoch;
      const run = status ? { runId, status: !runId && !TERMINAL_RUNS.has(status) ? 'unknown' : status,
        submittedAt: record ? new Date(record.submittedAt).toISOString() : '',
        revision: revision(owner, runId, generation, epoch), canRecover: false,
        canResolveUnknown: status === 'unknown' && Boolean(runId) && Number.isSafeInteger(generation),
        questions: snapshot.prompts.filter(prompt => prompt.kind === 'clarify').map(prompt => ({
          id: promptId(key, prompt), generation: prompt.execution_generation, question: String(prompt.question || ''),
          choices: Array.isArray(prompt.choices) ? prompt.choices.filter(choice => typeof choice === 'string') : [], multiSelect: prompt.multi_select === true })) } : null;
      return { owner, snapshot, record, receipt, run, generation };
    })();
    refreshes.set(key, work);
    work.finally(() => { if (refreshes.get(key) === work) refreshes.delete(key); }).catch(() => undefined);
    return work;
  };
  const reconcile = async profile => {
    const keys = new Set([...observed].filter(key => !profile || parseHermesSessionKey(key).profile === profile));
    for (const record of canonicalRuns(profile)) if (!TERMINAL_RUNS.has(record.status)) keys.add(record.key);
    const recovery = [...deliveryRecovery].filter(key => !profile || parseHermesSessionKey(key).profile === profile).slice(0, 10);
    recovery.forEach(key => keys.add(key));
    return Promise.allSettled([...keys].map(async key => {
      try { const result = await refresh(key); deliveryRecovery.delete(key); return result; }
      catch (error) {
        if (deliveryRecovery.delete(key)) deliveryRecovery.add(key);
        throw error;
      }
    }));
  };
  const admit = async (owner, key, run, content) => {
    const finish = telemetry?.start(owner.profile, 'turn.admission');
    try {
      const accepted = await rpc(owner, 'prompt.submit', { submission_id: run.requestKey, text: content,
        ...(run.attachments?.length ? { attachments: run.attachments } : {}) });
      hermesResource(accepted.admission_id);
      if (accepted.ref?.session_id !== owner.sessionId) throw new HermesError(502, 'Hermes admitted another conversation.', 'HERMES_PROTOCOL_ERROR');
      await journal.update(key, run.requestKey, { runId: accepted.admission_id, status: nativeStatus(accepted) });
      observed.add(key);
      finish?.('ok', { runId: accepted.admission_id });
      return accepted;
    } catch (error) {
      finish?.('unknown');
      await journal.update(key, run.requestKey, { status: ['invalid_params', 'permission_denied', 'not_found', 'admission_conflict', 'profile_mismatch'].includes(error.code) ? 'failed' : 'unknown' });
      throw error;
    }
  };
  const sessions = async profile => {
    const [live, stored, old] = await Promise.all([
      bridge.rpc(profile, 'session.list', { limit: 200 }), bridge.rpc(profile, 'session.list', { scope: 'stored', limit: 200 }),
      client.runtime('/api/sessions', { profile }),
    ]);
    if (!Array.isArray(live.sessions) || !Array.isArray(stored.sessions) || !Array.isArray(old.data)) {
      throw new HermesError(502, 'Hermes returned invalid conversation history.', 'HERMES_PROTOCOL_ERROR');
    }
    const rows = new Map();
    for (const row of [...stored.sessions, ...live.sessions]) {
      const sid = row.session_id || row.resolved_id || row.id;
      const id = hermesNativeSessionKey(profile, sid);
      rows.set(id, { id, agentId: profile, title: row.title || 'New conversation', createdAt: iso(row.started_at), lastMessageSnippet: '', transport: 'canonical' });
    }
    // Keep pre-migration API conversations accessible through their original
    // HTTP owner. Never reinterpret their IDs as canonical local sessions.
    for (const row of old.data.filter(row => !row.source || row.source === 'api')) {
      const id = hermesSessionKey(profile, row.id);
      rows.set(id, { id, agentId: profile, title: row.title || 'API conversation', createdAt: iso(row.started_at), lastMessageSnippet: row.preview || '', transport: 'api', readOnly: true });
    }
    return [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
  const onEvent = ({ profile, event }) => {
    if (['approval.request', 'clarify.request', 'message.complete', 'session.info'].includes(event?.type)) {
      if (event.session_id && ['approval.request', 'clarify.request'].includes(event.type)) {
        try { observed.add(hermesNativeSessionKey(profile, event.session_id)); } catch { /* Ignore an invalid upstream scope. */ }
      }
      client.emit('event', { event: 'sessions.changed', payload: { profile } });
    }
  };
  bridge.on('event', onEvent);

  const route = async (req, res, url, { json, body, startEvents, sendEvent, required }) => {
    const method = req.method;
    const profile = hermesProfile(req.headers['x-hob-profile'] ?? 'default');
    if (url.pathname === '/api/sessions' && method === 'GET') { json(res, 200, await sessions(profile)); return true; }
    if (url.pathname === '/api/sessions' && method === 'POST') {
      const input = await body(req);
      if (input.agentId && input.agentId !== profile) throw new HermesError(400, 'The selected bot does not match this conversation.', 'INVALID_PROFILE');
      const title = required(input.title || 'New conversation', 'title', 500);
      const created = await bridge.rpc(profile, 'session.create', { request_id: randomUUID(), source: 'gui', follow_profile_config: true });
      const id = hermesNativeSessionKey(profile, created.session_id);
      observed.add(id);
      let warning;
      // Generic titles stay unset so native first-turn title generation can
      // name the chat. Native title-as-identity creation is never used here.
      if (!/^new conversation$/i.test(title)) {
        try { await rpc({ profile, sessionId: created.session_id }, 'session.mutate', {
          request_id: randomUUID(), expected_revision: created.revision, operation: 'rename', payload: { title } }); }
        catch { warning = 'Conversation created, but its title was not saved. The conversation remains available.'; }
      }
      json(res, 201, { id, agentId: profile, title: warning ? 'New conversation' : title, createdAt: new Date().toISOString(), lastMessageSnippet: '', transport: 'canonical', ...(warning ? { warning } : {}) }); return true;
    }
    if (url.pathname === '/api/tasks' && method === 'GET') {
      await reconcile(profile);
      json(res, 200, (await sessions(profile)).map(session => {
        const run = journal.get(session.id);
        return { id: session.id, title: session.title, timestamp: session.createdAt, subtitle: session.lastMessageSnippet,
          status: !run ? 'pending' : ['admitting', 'unknown', 'unavailable'].includes(run.status) ? 'unknown'
            : TERMINAL_RUNS.has(run.status) ? run.status : 'in_progress' };
      })); return true;
    }
    if (url.pathname === '/api/agent' && method === 'GET') {
      const agent = await httpChat.agentProfile(profile);
      json(res, 200, { ...agent, status: (await route.readiness(profile)).ready ? 'connected' : 'disconnected' }); return true;
    }
    if (url.pathname === '/api/stats' && method === 'GET') {
      const start = performance.now();
      const history = await client.runtime('/api/sessions', { profile });
      if (!Array.isArray(history.data)) throw new HermesError(502, 'Hermes returned invalid usage history.', 'HERMES_PROTOCOL_ERROR');
      json(res, 200, { tokensUsed: history.data.reduce((total, row) => total + (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0), 0),
        maxTokens: 0, memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024), latencyMs: Math.round(performance.now() - start),
        activeProcesses: journal.list(profile).filter(run => !TERMINAL_RUNS.has(run.status)).length }); return true;
    }
    if (url.pathname === '/api/security/approvals' && method === 'GET') {
      await reconcile(profile);
      const native = [...prompts.entries()].filter(([, item]) => item.owner.profile === profile && item.prompt.kind === 'approval')
        .map(([id, { prompt }]) => ({ id, type: 'command', description: prompt.description || 'Hermes requests approval.',
          commandSnippet: prompt.command || '', riskLevel: 'medium', requestedAt: '', status: 'pending' }));
      json(res, 200, [...native, ...await httpChat.pendingApprovals(profile)]); return true;
    }
    const approvalMatch = /^\/api\/security\/approvals\/(native-[a-f0-9]{64})$/.exec(url.pathname);
    if (approvalMatch && method === 'POST') {
      await reconcile(profile);
      const item = prompts.get(approvalMatch[1]);
      if (!item || item.owner.profile !== profile || item.prompt.kind !== 'approval') throw new HermesError(409, 'This approval is no longer pending.', 'APPROVAL_NOT_PENDING');
      const input = await body(req);
      const choice = { approved: 'once', rejected: 'deny' }[input.decision];
      if (!choice) throw new HermesError(400, 'Choose approve once or reject.', 'INVALID_REQUEST');
      json(res, 200, await rpc(item.owner, 'approval.respond', { prompt_id: item.prompt.prompt_id,
        execution_generation: item.prompt.execution_generation, choice }));
      await refresh(item.key); return true;
    }
    const match = /^\/api\/sessions\/([^/]+)\/(messages|turns|attachments|abort|run|recover|resolve-unknown|clarify|title)$/.exec(url.pathname);
    if (!match) return false;
    const key = decodeURIComponent(match[1]);
    const owner = parseHermesSessionKey(key);
    if (owner.transport !== 'canonical') {
      if (match[2] === 'turns' && method === 'POST') throw new HermesError(409,
        'This older API conversation is read-only. Start a new conversation for interactive Hermes chat.', 'LEGACY_SESSION_READ_ONLY');
      return false;
    }
    if (match[2] === 'title' && ['GET', 'POST'].includes(method)) {
      if (owner.profile !== profile) throw new HermesError(400, 'Choose a conversation belonging to the selected bot.', 'INVALID_PROFILE');
      if (method === 'GET') {
        const { snapshot } = await refresh(key);
        json(res, 200, { title: snapshot.title || '', revision: snapshot.revision }); return true;
      }
      const value = await body(req);
      if (Object.keys(value).some(field => !['title', 'revision', 'requestId'].includes(field)) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500
        || !Number.isSafeInteger(value.revision) || value.revision < 1 || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.requestId || '')) throw new HermesError(400, 'Review the current title before renaming this conversation.', 'INVALID_REQUEST');
      await rpc(owner, 'session.mutate', { request_id: value.requestId, expected_revision: value.revision, operation: 'rename', payload: { title: value.title.trim() } });
      const { snapshot } = await refresh(key);
      if (snapshot.title !== value.title.trim()) throw new HermesError(409, 'Hermes did not confirm the new title. Refresh before retrying.', 'TITLE_NOT_CONFIRMED');
      json(res, 200, { title: snapshot.title, revision: snapshot.revision }); return true;
    }
    if (match[2] === 'messages' && method === 'GET') {
      const { snapshot } = await refresh(key);
      json(res, 200, snapshot.messages.filter(message => ['user', 'assistant', 'system'].includes(message.role))
        .map((message, index) => ({ id: String(message.row_id ?? message.id ?? `${owner.sessionId}-${index}`), role: message.role,
          content: messageContentText(message.content), timestamp: iso(message.timestamp), status: 'complete',
          profile: owner.profile }))); return true;
    }
    if (match[2] === 'run' && method === 'GET') { json(res, 200, { run: (await refresh(key)).run }); return true; }
    if (match[2] === 'attachments' && method === 'POST') {
      if (owner.profile !== profile) throw new HermesError(400, 'The conversation belongs to another selected bot.', 'INVALID_PROFILE');
      json(res, 201, await attachments.upload(owner, key, await body(req, { maxBytes: 8 * 1024 * 1024 }))); return true;
    }
    if (match[2] === 'recover' && method === 'POST') {
      // There is no public lookup of a completed admission by submission ID.
      // Observe pending receipts, but do not invent retention/identity authority
      // for replay when a native acceptance response was lost.
      await refresh(key);
      throw new HermesError(409, 'Native admission recovery is observational. Refresh history; the original input will not be resent.', 'RECOVERY_UNAVAILABLE');
    }
    if (['abort', 'resolve-unknown', 'clarify'].includes(match[2]) && method === 'POST') {
      const input = await body(req);
      const current = await refresh(key);
      if (!current.run) throw new HermesError(409, 'No active native admission belongs to this conversation.', 'RUN_NOT_AVAILABLE');
      if (match[2] === 'abort') {
        if (!input.expectedRunId || input.expectedRunId !== current.run.runId || !['queued', 'running', 'waiting_for_approval', 'stopping'].includes(current.run.status)) throw new HermesError(409, 'The run changed. Refresh before stopping it.', 'RUN_REVISION_CHANGED');
        await (current.run.status === 'queued'
          ? await rpc(owner, 'prompt.cancel', { admission_id: current.run.runId })
          : await rpc(owner, 'session.interrupt', { execution_generation: current.generation }));
        json(res, 200, { accepted: true }); return true;
      }
      if (input.expectedRevision !== current.run.revision) throw new HermesError(409, 'The run changed. Refresh its current controls.', 'RUN_REVISION_CHANGED');
      if (match[2] === 'resolve-unknown') {
        if (input.confirmReviewed !== true || !current.run.canResolveUnknown) throw new HermesError(400, 'Review possible side effects and explicitly confirm unknown-work resolution.', 'CONFIRMATION_REQUIRED');
        await rpc(owner, 'prompt.resolve_unknown', { admission_id: current.run.runId, execution_generation: current.generation });
        json(res, 200, { run: (await refresh(key)).run }); return true;
      }
      const item = prompts.get(input.promptId);
      if (!item || item.key !== key || item.prompt.kind !== 'clarify' || typeof input.answer !== 'string' || !input.answer.trim() || input.answer.length > 16384) {
        throw new HermesError(409, 'That question is no longer pending or its answer is invalid.', 'QUESTION_NOT_PENDING');
      }
      json(res, 200, await rpc(owner, 'clarify.respond', { prompt_id: item.prompt.prompt_id,
        execution_generation: item.prompt.execution_generation, answer: input.answer })); return true;
    }
    if (match[2] !== 'turns' || method !== 'POST') return false;
    const input = await body(req);
    const selected = attachments.resolve(key, input.attachments);
    const prompt = input.content || (input.attachments?.length ? 'Please review the attached files.' : '');
    const content = [required(prompt, 'content', 100000), ...selected.references].join('\n\n');
    if (content.length > 100000) throw new HermesError(400, 'The prompt and file references are too long.', 'INVALID_REQUEST');
    const before = await refresh(key);
    if (before.snapshot.pending.length) throw new HermesError(409, 'This conversation has active or unknown work. Review its status before submitting again.', 'RUN_ACTIVE');
    const run = await journal.reserve(key, { input: content, requestKey: input.idempotencyKey ?? randomUUID(),
      credentialBinding: await client.credentialBinding(owner.profile), ...(selected.images.length ? { attachments: selected.images } : {}) });
    const queue = [];
    const firstToken = telemetry?.start(owner.profile, 'turn.first_token');
    let bytes = 0, wake, disconnected = false, accepted, heartbeat;
    const observer = frame => {
      if (frame.profile !== owner.profile) return;
      if (frame.event?.type === 'gateway.disconnected') disconnected = true;
      else if (frame.event?.session_id === owner.sessionId && ['message.delta', 'message.complete', 'session.replay_gap'].includes(frame.event.type)) {
        const size = Buffer.byteLength(JSON.stringify(frame.event));
        if (queue.length >= 4096 || bytes + size > 1024 * 1024) disconnected = true;
        else { bytes += size; queue.push(frame.event); }
      }
      wake?.();
    };
    bridge.on('event', observer);
    const closed = () => { disconnected = true; wake?.(); };
    res.once('close', closed);
    try {
      accepted = await admit(owner, key, run, content);
      if (res.destroyed) return true;
      startEvents(res); sendEvent(res, 'accepted', { runId: accepted.admission_id, sessionId: key });
      heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
      heartbeat.unref();
      let completedText, lastCheck = 0;
      while (!res.destroyed) {
        while (queue.length) {
          const event = queue.shift(); bytes -= Buffer.byteLength(JSON.stringify(event));
          if (event.type === 'session.replay_gap') { disconnected = true; break; }
          if (event.admission_id !== accepted.admission_id) continue;
          if (event.type === 'message.delta' && typeof event.payload?.text === 'string') {
            if (event.payload.text) firstToken?.('ok', { runId: accepted.admission_id });
            sendEvent(res, 'delta', { text: event.payload.text });
          }
          if (event.type === 'message.complete') { completedText = event.payload?.text; lastCheck = 0; }
        }
        if (disconnected) {
          sendEvent(res, 'error', { message: 'Connection interrupted. Hermes may still be working; refresh conversation status before resending.' }); break;
        }
        if (Date.now() - lastCheck >= 1000) {
          const state = await refresh(key); lastCheck = Date.now();
          if (state.record?.requestKey !== run.requestKey) throw new HermesError(409, 'A newer turn replaced this observer.', 'RUN_REVISION_CHANGED');
          if (TERMINAL_RUNS.has(state.record.status)) {
            if (state.record.status === 'completed') {
              const final = state.receipt?.result?.final_response ?? completedText;
              if (typeof final !== 'string') throw new HermesError(502, 'The completed native result is unavailable. Refresh history.', 'HERMES_PROTOCOL_ERROR');
              sendEvent(res, 'done', { message: { id: accepted.admission_id, role: 'assistant', content: final,
                timestamp: new Date().toISOString(), status: 'complete', profile: owner.profile } });
            } else {
              const reason = failureReason(state.receipt);
              sendEvent(res, 'error', { message: reason
                ? `Hermes did not complete this turn (${state.record.status}): ${reason}`
                : `Hermes did not complete this turn (${state.record.status}). Review its history before retrying.` });
            }
            break;
          }
          if (state.record.status === 'unknown') { sendEvent(res, 'error', { message: 'Turn outcome is unknown. Review history and possible side effects before resolving it.' }); break; }
        }
        await new Promise(resolve => {
          const timer = setTimeout(done, 250);
          function done() { clearTimeout(timer); wake = undefined; resolve(); }
          wake = done;
        });
      }
    } catch (error) {
      if (!res.headersSent) throw error;
      sendEvent(res, 'error', { message: 'Turn observation failed. Work may still be running; refresh its status.' });
    } finally {
      clearInterval(heartbeat);
      bridge.off('event', observer); res.off('close', closed);
      if (res.headersSent) res.end();
      client.emit('event', { event: 'sessions.changed', payload: { sessionKey: key } });
    }
    return true;
  };
  route.reconcile = () => reconcile();
  route.submitDirective = async (key, content) => {
    const owner = parseHermesSessionKey(key);
    if (owner.transport !== 'canonical' || typeof content !== 'string' || !content.trim() || content.length > 100000) throw new HermesError(400, 'Invalid native goal continuation.', 'INVALID_REQUEST');
    const before = await refresh(key);
    if (before.snapshot.pending.length) throw new HermesError(409, 'This conversation already has active or unknown work. Refresh its status.', 'RUN_ACTIVE');
    const run = await journal.reserve(key, { input: content, requestKey: randomUUID(), credentialBinding: await client.credentialBinding(owner.profile) });
    return admit(owner, key, run, content);
  };
  route.watch = key => { if (parseHermesSessionKey(key).transport === 'canonical') observed.add(key); };
  route.readiness = async profile => {
    try {
      const name = hermesProfile(profile);
      const [runtime, http] = await Promise.all([bridge.rpc(name, 'runtime.describe'), client.getProfileStatus(name)]);
      const compatible = ['durable-admission-v1', 'event-replay-v1', 'local-cli-create-v1'].every(capability => runtime.capabilities?.includes(capability));
      return { ready: http.ready && compatible, status: !compatible ? 'session_protocol_incompatible' : http.ready ? 'started' : 'profile_initializing' };
    } catch { return { ready: false, status: 'session_unavailable' }; }
  };
  route.close = () => bridge.off('event', onEvent);
  return route;
}
