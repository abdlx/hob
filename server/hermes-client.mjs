import { EventEmitter } from 'node:events';

export class HermesError extends Error {
  constructor(status, message, code = 'HERMES_UNAVAILABLE') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function localOrigin(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an http:// loopback IP origin without credentials or a path.`);
  }
  return url.origin;
}

export function hermesProfile(value = 'default') {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new HermesError(400, 'Select a valid Hermes profile.', 'INVALID_PROFILE');
  }
  return value;
}

export function hermesResource(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\s/\\\x00-\x1f\x7f]/.test(value)
    || value === '.' || value === '..') {
    throw new HermesError(400, 'Invalid Hermes resource identifier.', 'INVALID_RESOURCE');
  }
  return encodeURIComponent(value);
}

// The profile travels with a conversation: selecting a different bot must not
// silently redirect an old conversation into that bot's state database.
export function hermesSessionKey(profile, sessionId) {
  hermesResource(sessionId);
  return Buffer.from(JSON.stringify([hermesProfile(profile), sessionId])).toString('base64url');
}

export function parseHermesSessionKey(key) {
  if (typeof key !== 'string' || key.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new HermesError(400, 'Invalid conversation identifier.', 'INVALID_RESOURCE');
  }
  try {
    const tuple = JSON.parse(Buffer.from(key, 'base64url').toString('utf8'));
    if (!Array.isArray(tuple) || tuple.length !== 2) throw new Error();
    const [profile, sessionId] = tuple;
    if (hermesSessionKey(profile, sessionId) !== key) throw new Error();
    return { profile, sessionId };
  } catch {
    throw new HermesError(400, 'Invalid conversation identifier.', 'INVALID_RESOURCE');
  }
}

async function readJson(response, maxBytes) {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new HermesError(502, 'Hermes returned an unexpected response.', 'HERMES_PROTOCOL_ERROR');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HermesError(502, 'Hermes returned an empty response.', 'HERMES_PROTOCOL_ERROR');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new HermesError(502, 'Hermes response exceeds the adapter limit.', 'HERMES_RESPONSE_LIMIT');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HermesError(502, 'Hermes returned invalid JSON.', 'HERMES_PROTOCOL_ERROR'); }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** HTTP boundary around the upstream runtime and dashboard, never Python imports. */
export class HermesClient extends EventEmitter {
  constructor({ runtimeUrl = 'http://127.0.0.1:8642', dashboardUrl = 'http://127.0.0.1:8080',
    apiKey, dashboardToken, profileAccess, fetchImpl = globalThis.fetch, timeoutMs = 30000, maxResponseBytes = 4 * 1024 * 1024 } = {}) {
    super();
    this.kind = 'hermes';
    this.runtimeUrl = localOrigin(runtimeUrl, 'Hermes runtime URL');
    this.dashboardUrl = localOrigin(dashboardUrl, 'Hermes dashboard URL');
    if (!apiKey?.trim()) throw new Error('A server-side Hermes API key is required.');
    // Private fields below keep accidental JSON serialization from disclosing credentials.
    this.#apiKey = apiKey;
    this.#dashboardToken = dashboardToken;
    this.#profileAccess = profileAccess;
    this.#fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.connected = false;
  }
  #apiKey;
  #dashboardToken;
  #profileAccess;
  #fetch;
  #timer;
  #stopped = true;

  async #response(surface, pathname, { profile = 'default', method = 'GET', body, signal, idempotencyKey, stream = false } = {}) {
    profile = hermesProfile(profile);
    if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\\?#\x00-\x20]/.test(pathname)
      || pathname.split('/').some(part => ['.', '..'].includes(decodeURIComponent(part)))) {
      throw new HermesError(400, 'Invalid upstream request path.', 'INVALID_RESOURCE');
    }
    const dashboard = surface === 'dashboard';
    if (!dashboard && surface !== 'runtime') throw new Error('Unknown Hermes API surface.');
    if (dashboard && !this.#dashboardToken?.trim()) {
      throw new HermesError(503, 'Hermes settings service is not configured.', 'HERMES_SETTINGS_UNAVAILABLE');
    }
    const url = new URL(dashboard || profile === 'default' ? pathname : `/p/${profile}${pathname}`,
      dashboard ? this.dashboardUrl : this.runtimeUrl);
    if (dashboard) url.searchParams.set('profile', profile);
    const headers = { Accept: stream ? 'text/event-stream' : 'application/json' };
    const apiKey = this.#profileAccess ? await this.#profileAccess(profile) : this.#apiKey;
    if (dashboard) headers['X-Hermes-Session-Token'] = this.#dashboardToken;
    else headers.Authorization = `Bearer ${apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) {
        throw new HermesError(400, 'Invalid idempotency key.', 'INVALID_RESOURCE');
      }
      headers['Idempotency-Key'] = idempotencyKey;
    }
    const deadline = AbortSignal.timeout(stream ? 30 * 60 * 1000 : this.timeoutMs);
    try {
      // Never retry writes, follow redirects, or forward browser headers/cookies.
      const response = await this.#fetch(url, { method, headers, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        await response.body?.cancel();
        const status = [400, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502;
        throw new HermesError(status, response.status === 401
          ? 'Hermes rejected the server credential. Check the deployment configuration.'
          : `Hermes rejected the request (${response.status}).`, 'HERMES_REQUEST_FAILED');
      }
      return response;
    } catch (error) {
      if (error instanceof HermesError) throw error;
      throw new HermesError(503, signal?.aborted
        ? 'Hermes request was cancelled.'
        : 'Hermes could not be reached. The operation may have completed; refresh before retrying.', 'HERMES_UNAVAILABLE');
    }
  }

  async runtime(pathname, options) {
    const response = await this.#response('runtime', pathname, options);
    if (response.status === 204) { await response.body?.cancel(); return null; }
    return readJson(response, this.maxResponseBytes);
  }

  async dashboard(pathname, options) {
    return readJson(await this.#response('dashboard', pathname, options), this.maxResponseBytes);
  }

  async *events(runId, { profile = 'default', signal } = {}) {
    const response = await this.#response('runtime', `/v1/runs/${hermesResource(runId)}/events`, { profile, signal, stream: true });
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
      await response.body?.cancel();
      throw new HermesError(502, 'Hermes did not return an event stream.', 'HERMES_PROTOCOL_ERROR');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const parse = frame => {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return null;
      try { return JSON.parse(data); }
      catch { throw new HermesError(502, 'Hermes returned an invalid event.', 'HERMES_PROTOCOL_ERROR'); }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          if (Buffer.byteLength(buffer.slice(0, boundary), 'utf8') > this.maxResponseBytes) throw new HermesError(502, 'Hermes event exceeds the adapter limit.', 'HERMES_RESPONSE_LIMIT');
          const event = parse(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event?.run_id !== undefined && event.run_id !== runId) {
            throw new HermesError(502, 'Hermes returned an event for another run.', 'HERMES_PROTOCOL_ERROR');
          }
          if (event) yield event;
        }
        if (Buffer.byteLength(buffer, 'utf8') > this.maxResponseBytes) throw new HermesError(502, 'Hermes event exceeds the adapter limit.', 'HERMES_RESPONSE_LIMIT');
        if (done) break;
      }
      // EOF is not completion. Only a terminal run event establishes the outcome.
      if (buffer.trim() && !buffer.trim().startsWith(':')) {
        throw new HermesError(502, 'Hermes event stream ended inside a frame.', 'HERMES_PROTOCOL_ERROR');
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async getStartupStatus() {
    try {
      const capabilities = await this.runtime('/v1/capabilities');
      if (capabilities?.features?.run_status !== true || capabilities?.features?.run_events_sse !== true) {
        throw new HermesError(502, 'This Hermes listener does not support the required run protocol.', 'HERMES_PROTOCOL_ERROR');
      }
      if (!this.connected && !this.#stopped) { this.connected = true; this.emit('connected'); }
      return { ready: true, status: 'started', runtime: 'hermes' };
    } catch {
      if (this.connected) { this.connected = false; this.emit('disconnected'); }
      return { ready: false, status: 'disconnected', runtime: 'hermes' };
    }
  }

  async getServiceHealth() {
    try {
      const health = await this.dashboard('/api/health');
      return { ready: health?.ok === true, status: health?.ok === true ? 'settings_available' : 'starting', runtime: 'hermes', agentConnected: this.connected };
    } catch {
      return { ready: false, status: 'settings_unavailable', runtime: 'hermes', agentConnected: this.connected };
    }
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    const probe = async () => {
      await this.getStartupStatus();
      if (!this.#stopped) { this.#timer = setTimeout(probe, 5000); this.#timer.unref(); }
    };
    void probe();
  }

  stop() { this.#stopped = true; clearTimeout(this.#timer); this.connected = false; }

  request() {
    throw new HermesError(501, 'This OpenClaw operation has not been migrated to Hermes.', 'RUNTIME_OPERATION_UNSUPPORTED');
  }
}
