import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SMOKE_MODEL, SMOKE_PROMPT, SMOKE_REPLY, SMOKE_FILE, SMOKE_CONTENT } from './smoke-model.mjs';

// Reusable against the published image or an owned source-launched fixture.
// Every write here is synthetic, and the caller must supply a fresh isolated
// home. Checks assert only surfaces whose shape is owned by this repository or
// is stable in Hermes's own dashboard contract.
export function createHermesSmokeApi({ origin, password, modelUrl, fetchImpl = fetch }) {
  let cookie = '';
  const checks = [];
  const check = (name, value, detail) => { assert.ok(value, detail ? name + ' (' + detail + ')' : name); checks.push(name); };
  const request = (path, method = 'GET', value, profile = 'default') => fetchImpl(origin + path, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin, 'X-Hob-Profile': profile,
      'Content-Type': 'application/json', Connection: 'close' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    signal: AbortSignal.timeout(120000),
  });
  const api = async (path, method, value, profile) => {
    const response = await request(path, method, value, profile);
    assert.ok(response.ok, (method || 'GET') + ' ' + path + ' returned ' + response.status);
    return response.json();
  };
  // Workspace resources are addressed as /api/hermes/workspace/<resource> and are
  // always bound to one enrolled bot. Selectors travel in the query string.
  const workspace = (resource, method = 'GET', value, profile = 'default', query) => api(
    '/api/hermes/workspace/' + resource + '?' + new URLSearchParams({ ...(query || {}), profile }).toString(),
    method, value, profile);
  const session = (id, suffix) => '/api/sessions/' + encodeURIComponent(id) + (suffix || '');
  // Hermes reports a paused schedule as enabled false with state paused.
  const paused = row => Boolean(row) && row.enabled === false && row.state === 'paused' && row.last_run_at == null;
  const rows = value => Array.isArray(value) ? value : Array.isArray(value?.jobs) ? value.jobs : [];

  // The native session authority is initialized per bot once that bot has a
  // provider/model, so the first native call after provider setup can be refused
  // while the profile is still coming up. Retry the real operation instead of
  // trusting a status flag, and never treat a refusal as a completed turn.
  const retry = async (label, open, timeoutMs = 180000) => {
    const deadline = Date.now() + timeoutMs;
    let last = 'not attempted';
    for (;;) {
      try { return await open(); } catch (error) { last = error.message; }
      if (Date.now() > deadline) throw new Error(label + ' never answered: ' + last);
      await delay(1000);
    }
  };

  const firstBoot = async () => {
    const page = await request('/');
    check('the built dashboard is served', page.ok && /<html/i.test(await page.text()));
    check('the application API requires login', (await request('/api/hermes/profiles')).status === 401);
    const login = await request('/api/auth/login', 'POST', { password });
    check('login succeeds', login.status === 200);
    check('the session cookie is HttpOnly and SameSite Strict', /HttpOnly; SameSite=Strict/.test(login.headers.get('set-cookie') || ''));
    cookie = login.headers.get('set-cookie').split(';')[0];
    check('Hermes is the selected runtime', (await api('/api/runtime')).runtime === 'hermes');
    // A stale OpenClaw-era dashboard must never reach a different runtime's owner.
    check('a stale OpenClaw-era dashboard action is refused', (await request('/api/settings')).status === 409);
    check('the fresh roster contains Main only', JSON.stringify((await api('/api/hermes/profiles')).profiles.map(item => item.name)) === '["default"]');
    const config = await api('/api/hermes/config');
    check('native settings are readable before provider setup', Boolean(config) && typeof config === 'object' && !Array.isArray(config));
    check('the native settings schema is available', Object.keys((await api('/api/hermes/config/schema')).fields || {}).length > 0);
    const secret = 'synthetic-container-provider-key';
    await api('/api/hermes/credentials', 'PUT', { key: 'EXAMPLE_PROVIDER_API_KEY', value: secret });
    const credentials = await api('/api/hermes/credentials');
    check('credential writes are masked on read', credentials.EXAMPLE_PROVIDER_API_KEY?.is_set === true && !JSON.stringify(credentials).includes(secret));
    check('the native MCP inventory is readable', Array.isArray((await api('/api/hermes/setup/mcp')).servers));

    const soul = '# Isolated smoke personality\n\nSynthetic persistence proof.\n';
    await workspace('soul', 'PUT', { content: soul });
    check('native personality writes persist', (await workspace('soul')).content === soul);
    // A schedule created paused must stay paused and, above all, must never run.
    const created = await workspace('jobs', 'POST', { name: 'Isolated disabled smoke task',
      prompt: 'Never execute this synthetic smoke task.', schedule: '2099-01-01T00:00:00', paused: true });
    check('a paused native schedule is created', typeof created.id === 'string');
    const listed = rows(await workspace('jobs'));
    check('the paused schedule belongs to the selected bot and never ran',
      listed.some(item => item.id === created.id && paused(item)), 'observed ' + JSON.stringify(listed.find(item => item.id === created.id) || null));

    let providerTier = false;
    let sessionId = null;
    let requestKey = null;
    if (modelUrl) {
      const endpoint = await api('/api/hermes/custom-endpoints', 'POST', { name: 'Isolated smoke model', model: SMOKE_MODEL,
        base_url: modelUrl, api_key: 'synthetic-local-smoke-key', make_default: false });
      check('a named custom endpoint is saved without activation', endpoint.ok === true && typeof endpoint.id === 'string');
      const selected = await api('/api/hermes/model', 'POST', { scope: 'main', provider: endpoint.id, model: SMOKE_MODEL, base_url: modelUrl });
      check('only the owned local model is selected', selected.ok === true && selected.base_url === modelUrl);
      const conversation = await retry('the native conversation authority', () => api('/api/sessions', 'POST',
        { title: 'Isolated Hermes smoke conversation', agentId: 'default' }));
      check('a conversation uses the canonical native owner', conversation.transport === 'canonical' && typeof conversation.id === 'string');
      sessionId = conversation.id;
      requestKey = randomUUID();
      const turn = await request(session(sessionId, '/turns'), 'POST', { content: SMOKE_PROMPT, idempotencyKey: requestKey });
      check('the native turn is admitted', turn.ok);
      const stream = await turn.text();
      check('the native stream completes after the tool round trip', stream.includes('event: accepted') && stream.includes('event: done')
        && stream.includes(SMOKE_REPLY) && !stream.includes('event: error'), stream.slice(-400));
      const entry = ((await workspace('files')).entries || []).find(item => item.name === SMOKE_FILE);
      check('the model tool wrote the artifact into the bot workspace', Boolean(entry));
      const file = await workspace('file', 'GET', undefined, 'default', { path: entry.path });
      check('the written artifact has the expected content', Buffer.from(String(file.dataUrl).split(',')[1], 'base64').toString('utf8') === SMOKE_CONTENT);
      const history = await api(session(sessionId, '/messages'));
      check('native history includes the assistant reply', history.some(item => item.role === 'assistant' && item.content.includes(SMOKE_REPLY)));
      providerTier = true;
    } else {
      check('the native runtime status endpoint answers', typeof (await api('/api/readiness')).ready === 'boolean');
    }
    const bot = await api('/api/hermes/profiles', 'POST', { name: 'smoke-bot', soul: 'Independent synthetic smoke bot.' });
    check('an additional bot needs explicit creation', bot.ok === true && bot.state === 'active');
    check('the new bot does not inherit Main personality', !String((await workspace('soul', 'GET', undefined, 'smoke-bot')).content).includes(soul.trim()));
    return { providerTier, sessionId, requestKey, jobId: created.id, soul };
  };

  const afterRestart = async saved => {
    check('login survives recreation', (await api('/api/auth/status')).authenticated === true);
    check('personality survives recreation', (await workspace('soul')).content === saved.soul);
    check('the bot roster survives recreation', (await api('/api/hermes/profiles')).profiles.some(item => item.name === 'smoke-bot' && item.state === 'active'));
    const row = rows(await workspace('jobs')).find(item => item.id === saved.jobId);
    check('the paused schedule survives recreation without executing', paused(row), 'observed ' + JSON.stringify(row || null));
    check('credentials survive recreation without exposure', (await api('/api/hermes/credentials')).EXAMPLE_PROVIDER_API_KEY?.is_set === true);
    if (!saved.sessionId) return;
    // A conversation read is the authority proof: it must answer again after the
    // application process is replaced, using the same durable native state.
    const history = await retry('the retained conversation', () => api(session(saved.sessionId, '/messages')));
    check('the conversation survives recreation', Array.isArray(history));
    if (!saved.providerTier) return;
    check('assistant history survives recreation', history.some(item => item.content.includes(SMOKE_REPLY)));
    check('the completed run journal survives recreation', (await api(session(saved.sessionId, '/run'))).run?.status === 'completed');
    const replay = await request(session(saved.sessionId, '/turns'), 'POST', { content: SMOKE_PROMPT, idempotencyKey: saved.requestKey });
    check('a completed request cannot be replayed', replay.status === 409, 'observed ' + replay.status);
  };

  return { firstBoot, afterRestart, checks };
}
