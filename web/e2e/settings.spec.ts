import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// A real production bundle in Chromium, with explicit Hermes API fixtures.
// This verifies UI contracts; it does not claim a live Hermes install or model run.
const sha = 'a'.repeat(40);
const nativeSession = Buffer.from(JSON.stringify(['default', 'native-conversation', 'canonical'])).toString('base64url');
async function fixture(page: Page, extraApps = false, savedProviderCards = false) {
  const errors: string[] = [], writes: { path: string; body: Record<string, unknown>; profile: string | null }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let saved = { model: 'test-model', memory: { enabled: true } }, failSave = false, installed = false;
  let heartbeat: { status: string; prompt: string; interval_seconds: number; fire_count: number } | null = null;
  let providerConnected = false, providerVerified = false;
  let conversationTitle = 'Test conversation', titleRevision = 1;
  const preferences: Record<string, { language: string; timezone: string; maxTurns: number | null; runBudgetSeconds: number | null }> = {};
  const models: Record<string, { provider: string; model: string }> = { default: { provider: 'openai', model: 'test-model' }, research: { provider: 'openrouter', model: 'research-model' } };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const profile = url.searchParams.get('profile') || 'default';
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON(), profile: request.headers()['x-hob-profile'] || null });
    if (path === '/api/auth/status') return json({ authenticated: true, configured: true });
    if (path === '/api/runtime') return json({ runtime: 'hermes' });
    if (path === '/api/readiness') return json({ ready: true, status: 'ready' });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: connection\ndata: {"connected":true}\n\n' });
    if (path === '/api/agents') return json({ agents: [{ id: 'default', name: 'Main' }, { id: 'research', name: 'Research' }] });
    if (path === '/api/agent') {
      const selected = request.headers()['x-hob-profile'] || 'default';
      return json({ id: selected, name: selected === 'default' ? 'Main' : 'Research', status: 'connected', model: models[selected]?.model, avatarUrl: '' });
    }
    if (path === '/api/sessions') return json([{ id: nativeSession, agentId: 'default', title: conversationTitle, transport: 'canonical', createdAt: '2026-10-26T00:00:00Z' }]);
    if (path === `/api/sessions/${nativeSession}/title`) {
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        if (body.revision !== titleRevision) return json({ error: 'Stale title' }, 409);
        conversationTitle = body.title; titleRevision++;
      }
      return json({ title: conversationTitle, revision: titleRevision });
    }
    if (path === `/api/sessions/${nativeSession}/messages` || path === '/api/tasks' || path === '/api/security/approvals') return json([]);
    if (path === `/api/sessions/${nativeSession}/run`) return json({ run: null });
    if (path === '/api/stats') return json({ tokensUsed: 0, maxTokens: 128000 });
    if (path === '/api/hermes/profiles') return json({ profiles: [{ name: 'default' }, { name: 'research', display_name: 'Research' }] });
    if (path === '/api/hermes/exchanges') return json({ exchanges: [], nextBefore: null });
    if (path === '/api/hermes/groups') return json({ groups: [] });
    if (path === '/api/hermes/config') {
      if (request.method() === 'PUT') {
        if (failSave) return json({ error: 'Fixture: configuration could not be persisted' }, 503);
        saved = { ...saved, ...request.postDataJSON().config };
        return json({ ok: true });
      }
      return json(saved);
    }
    if (path === '/api/hermes/config/schema') return json({ fields: { 'memory.enabled': { type: 'boolean', category: 'memory', description: 'Enable long-term memory' } }, category_order: ['memory'] });
    if (path === '/api/hermes/credentials') return json({ OPENAI_API_KEY: { is_set: true, provider: 'openai', provider_primary: true }, OPENROUTER_API_KEY: { is_set: true, provider: 'openrouter', provider_primary: true } });
    if (path === '/api/hermes/saved-providers') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        expect(Object.keys(body).sort()).toEqual(['action', 'id']);
        if (body.action === 'connect') providerConnected = true;
        else providerVerified = true;
        return json({ ok: true, message: 'The provider accepted this key.' });
      }
      return json({ connections: savedProviderCards ? [{ id: 'a'.repeat(64), provider: 'openrouter', name: 'OpenRouter', sourceProfile: 'default', sourceName: 'Main', configured: profile === 'default' || providerConnected, verifiedAt: providerVerified ? new Date().toISOString() : null }] : [], unavailableProfiles: [] });
    }
    if (path === '/api/hermes/setup/models') return json({ ...models[profile], providers: [
      { slug: 'openai', name: 'OpenAI', authenticated: true, models: ['test-model', 'next-model', 'expensive-model'] },
      { slug: 'openrouter', name: 'OpenRouter', authenticated: true, models: ['research-model'] },
    ] });
    if (path === '/api/hermes/model') {
      const value = request.postDataJSON();
      if (value.model === 'invalid-model') return json({ error: 'This model is not available.' }, 400);
      if (value.model === 'expensive-model' && !value.confirm_expensive_model) return json({ ok: false, confirm_required: true, confirm_message: 'This model has higher costs.' });
      models[profile] = { provider: value.provider, model: value.model };
      return json({ ok: true });
    }
    if (path === '/api/hermes/setup/accounts') return json({ providers: [] });
    if (path === '/api/hermes/setup/preferences') {
      if (request.method() === 'PUT') preferences[profile] = request.postDataJSON();
      return json(preferences[profile] || { language: 'auto', timezone: 'Asia/Karachi', maxTurns: 30, runBudgetSeconds: 300 });
    }
    if (path === '/api/hermes/setup/tools') return json([{ name: 'web', label: 'Web search', description: 'Search the web.', enabled: true, configured: true }]);
    if (path === '/api/hermes/setup/channels') return json({ platforms: [] });
    if (path === '/api/hermes/setup/memory') return json({ active: '', providers: [], builtinFiles: { memory: 120, user: 40 } });
    if (path === '/api/hermes/setup/learning') return json({ controls: Object.fromEntries(['memoryEnabled', 'userProfileEnabled', 'memoryApproval', 'skillApproval', 'backgroundReview'].map(key => [key, { value: true, source: 'default' }])) });
    if (path === '/api/hermes/setup/mcp') return json({ servers: [] });
    if (path === '/api/hermes/workspace/toolsets') return json([{ name: 'browser', enabled: true, configured: false }]);
    if (path === '/api/hermes/workspace/jobs') return json([]);
    if (path === '/api/hermes/workspace/schedule-preview') return json({ valid: true, nextRun: '2027-01-01T09:00:00+05:00', timezone: 'Asia/Karachi' });
    if (path === '/api/hermes/workspace/skills') return json([]);
    if (/^\/api\/hermes\/workspace\/reviews\/(memory|skills)$/.test(path)) return json({ items: [], nextOffset: null });
    if (path === '/api/hermes/workspace/learning') return json({ nodes: [] });
    if (path === '/api/hermes/workspace/learning') return json({ nodes: [] });
    if (path === '/api/hermes/workspace/soul') return json({ content: '# Bot personality' });
    if (path === '/api/hermes/workspace/files') return json({ entries: [] });
    if (path === '/api/hermes/workspace/autonomy') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        expect(body.sessionKey).toBe(nativeSession);
        if (body.action === 'set') heartbeat = { status: 'active', prompt: body.prompt, interval_seconds: body.intervalSeconds, fire_count: 0 };
        else if (heartbeat) heartbeat.status = body.action === 'pause' ? 'paused' : 'active';
      }
      return json({ control: { revision: 'native-snapshot', goal: null, heartbeat } });
    }
    if (path === '/api/hermes/browser' || path === '/api/hermes/browser/diagnose') return json({
      bot: 'default', state: 'stopped', available: false, control: { holder: 'agent', pending: 0, since: null },
      viewers: 0, agentConnections: 0, viewport: { w: 1000, h: 800 }, tabs: [], url: '', title: '', loading: false, lastError: null,
      binding: { configured: false, reason: 'unavailable' },
    });
    if (path === '/api/hermes/browser/activity') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (path === '/api/hermes/agent-computer/status') return json({ configured: false, connected: false });
    if (path === '/api/hermes/setup/plugins') {
      expect(profile).toBe('default');
      const example = { name: 'example', description: 'A test integration', sha, tier: 'community', maintainer: 'Example', repo: 'https://github.com/example/plugin', docs_url: 'https://example.com/docs', requires_hermes: '>=0.22.0', platforms: ['linux', 'darwin'], installed, update_available: false, capabilities: { provides_tools: ['lookup'], provides_hooks: ['on_start'], provides_middleware: ['request_context'], requires_env: ['EXAMPLE_KEY'] } };
      return json({ scope: 'default', entries: [example, ...(extraApps ? [
        { ...example, name: 'notes', description: 'Organize notes and documents.', maintainer: 'Notebook Studio', tier: 'official', capabilities: { provides_tools: ['save_note'], provides_hooks: [], provides_middleware: [], requires_env: [] } },
        { ...example, name: 'metrics', description: 'Review system measurements.', maintainer: 'Metrics Lab', tier: 'verified', capabilities: { provides_tools: ['read_metrics'], provides_hooks: [], provides_middleware: [], requires_env: [] } },
      ] : [])], installed: [
        ...(installed ? [{ name: 'example', description: 'A test integration', version: '1.0', source: 'catalog', runtime_status: 'disabled', can_remove: true, can_update_git: true }] : []),
        ...(extraApps ? [{ name: 'local-helper', description: 'A locally installed plugin.', version: '2.0', source: 'local', runtime_status: 'enabled', can_remove: true, can_update_git: false }] : []),
      ], removed: [] });
    }
    if (path === '/api/hermes/setup/plugins/example/install') { installed = true; return json({ ok: true, enabled: false, missing_env: ['EXAMPLE_KEY'] }); }
    errors.push(`Unexpected API: ${request.method()} ${path}`);
    return json({ error: `Unexpected fixture endpoint ${path}` }, 404);
  });
  return { errors, writes, failSaves: () => { failSave = true; } };
}

test('a narrow touch viewport keeps dock targets usable and settings inputs at 16px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage(), state = await fixture(page);
    await page.goto('http://127.0.0.1:4187/chat');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
    const dock = page.getByRole('navigation', { name: 'Mobile navigation' }).filter({ visible: true });
    await expect(dock.getByRole('button')).toHaveCount(5);
    for (const button of await dock.getByRole('button').all()) {
      const rect = await button.boundingBox(); expect(rect!.height).toBeGreaterThanOrEqual(44); expect(rect!.width).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('dialog', { name: 'Conversations', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'General', exact: true }).click();
    const timezone = page.getByRole('textbox', { name: /^Bot timezone/ });
    await expect(timezone).toBeVisible();
    expect(await timezone.evaluate(node => getComputedStyle(node).fontSize)).toBe('16px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/touch-320-settings.png', fullPage: true });
    expect(state.errors).toEqual([]);
  } finally { await context.close(); }
});

test('language and native run limits persist for the selected bot and another bot retains its choices', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  const form = page.getByRole('region', { name: 'Bot language and limits' });
  await form.getByRole('combobox', { name: 'Reply and title language' }).selectOption('ur-Latn');
  await form.getByRole('spinbutton', { name: /^Maximum model turns/ }).fill('12');
  await form.getByRole('spinbutton', { name: /^Run time budget/ }).fill('90');
  await form.getByRole('button', { name: 'Save bot preferences' }).click();
  await expect(form.getByRole('status').filter({ hasText: 'Preferences saved' })).toBeVisible();
  await page.reload();
  await expect(form.getByRole('combobox', { name: 'Reply and title language' })).toHaveValue('ur-Latn');
  await expect(form.getByRole('spinbutton', { name: /^Maximum model turns/ })).toHaveValue('12');
  await page.getByRole('combobox', { name: 'Bot', exact: true }).selectOption('research');
  await expect(form.getByRole('combobox', { name: 'Reply and title language' })).toHaveValue('auto');
  expect(state.writes.filter(row => row.path.endsWith('/preferences'))).toEqual([{ path: '/api/hermes/setup/preferences', profile: 'default', body: { language: 'ur-Latn', timezone: 'Asia/Karachi', maxTurns: 12, runBudgetSeconds: 90, confirm: true } }]);
  expect(state.errors).toEqual([]);
});

test('a title correction saves the inspected revision and survives reload', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).filter({ visible: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Conversations', exact: true });
  await drawer.getByRole('button', { name: 'Rename Test conversation' }).click();
  await drawer.getByRole('textbox', { name: 'Conversation title', exact: true }).fill('Roman Urdu ki guftagu');
  await drawer.getByRole('button', { name: 'Save title' }).click();
  await expect(drawer.getByRole('button', { name: 'Rename Roman Urdu ki guftagu' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Open navigation', exact: true }).filter({ visible: true }).click();
  await expect(drawer.getByRole('button', { name: 'Rename Roman Urdu ki guftagu' })).toBeVisible();
  const write = state.writes.find(row => row.path.endsWith('/title'))!;
  expect(write.profile).toBe('default'); expect(write.body.revision).toBe(1); expect(write.body.title).toBe('Roman Urdu ki guftagu');
  expect(state.errors).toEqual([]);
});

test('tablet chat starts unobstructed and the conversation drawer contains and restores keyboard focus', async ({ page }) => {
  const state = await fixture(page);
  for (const width of [768, 820, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/chat');
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Agent details', exact: true })).toBeHidden();
  }
  const opener = page.getByRole('button', { name: 'Open navigation', exact: true }).filter({ visible: true });
  await opener.click();
  const drawer = page.getByRole('dialog', { name: 'Conversations', exact: true });
  await expect(drawer.getByRole('textbox', { name: 'Search conversations' })).toBeFocused();
  await expect(drawer.locator('time')).not.toHaveText(/T00:00/);
  await drawer.getByRole('button', { name: 'Rename Test conversation', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('button', { name: 'Close conversations', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden(); await expect(opener).toBeFocused();
  await page.screenshot({ path: 'test-results/tablet-1024-chat.png', fullPage: true });
  expect(state.errors).toEqual([]);
});

test('phone navigation opens Settings and follows browser navigation', async ({ page }) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('dialog', { name: 'Conversations', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('button', { name: 'Plugins & integrations', exact: true })).toBeVisible();
  await page.goBack();
  const dock = page.getByRole('navigation', { name: 'Mobile navigation' }).filter({ visible: true });
  await expect(dock.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.errors).toEqual([]);
});

test('goals require a current native schedule preview and reject malformed input', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/goals');
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByLabel('Goal name', { exact: true }).fill('Daily research');
  await page.getByLabel('Instructions', { exact: true }).fill('Review approved sources.');
  const scheduleInput = page.getByRole('textbox', { name: /^Schedule/ });
  await scheduleInput.fill('99 99 * * *');
  await expect(page.getByRole('button', { name: 'Save goal', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Preview next run', exact: true })).toBeDisabled();
  await scheduleInput.fill('0 9 * * *');
  await expect(page.getByRole('button', { name: 'Save goal', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview next run', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Next run:' })).toContainText('Asia/Karachi');
  await scheduleInput.fill('0 10 * * *');
  await expect(page.getByRole('button', { name: 'Save goal', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview next run', exact: true }).click();
  await page.getByRole('button', { name: 'Save goal', exact: true }).click();
  expect(state.writes.filter(row => row.path.endsWith('/jobs'))).toEqual([{ path: '/api/hermes/workspace/jobs', profile: 'default', body: { name: 'Daily research', prompt: 'Review approved sources.', schedule: '0 10 * * *' } }]);
  expect(state.errors).toEqual([]);
});

test('skill reviews display the full diff, reject stale decisions and bind the updated revision', async ({ page }) => {
  const state = await fixture(page);
  let revision = 'a'.repeat(64), pending = true;
  const decisions: Record<string, unknown>[] = [];
  await page.route('**/api/hermes/workspace/reviews/skills**', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); decisions.push(body);
      if (decisions.length === 1) { revision = 'b'.repeat(64); return route.fulfill({ status: 409, json: { error: 'Proposal changed; refresh and review again' } }); }
      expect(body.revision).toBe(revision); pending = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (new URL(route.request().url()).pathname.endsWith('/proposal-one')) return route.fulfill({ json: { id: 'proposal-one', summary: 'Review a lesson', revision, diff: '+ first line\n' + 'complete diff\n'.repeat(400) + '+ last line' } });
    return route.fulfill({ json: { items: pending ? [{ id: 'proposal-one', summary: 'Review a lesson', origin: 'foreground', revision }] : [], nextOffset: null } });
  });
  await page.goto('/idea');
  const queue = page.getByRole('region', { name: 'Skill review queue' });
  await queue.getByRole('button', { name: /Review a lesson/ }).click();
  await expect(queue.getByLabel('Proposal diff')).toContainText('+ last line');
  expect((await queue.getByLabel('Proposal diff').textContent())!.length).toBeGreaterThan(3000);
  await queue.getByRole('button', { name: 'Approve reviewed revision' }).click();
  await expect(queue.getByRole('alert')).toContainText('Proposal changed');
  await queue.getByRole('button', { name: 'Refresh proposals' }).click();
  await queue.getByRole('button', { name: /Review a lesson/ }).click();
  await queue.getByRole('button', { name: 'Approve reviewed revision' }).click();
  await expect(queue.getByText('No pending proposals for this bot.', { exact: true })).toBeVisible();
  expect(decisions).toHaveLength(2);
  expect(decisions[0].revision).toBe('a'.repeat(64)); expect(decisions[0].confirm).toBe(true);
  expect(decisions[1].requestId).not.toBe(decisions[0].requestId);
  expect(state.errors).toEqual([]);
});

test('uncertain approvals require native-state inspection and record observations without another application', async ({ page }) => {
  const state = await fixture(page);
  const revision = 'c'.repeat(64), decisions: Record<string, unknown>[] = [];
  let retained = true;
  await page.route('**/api/hermes/workspace/reviews/skills**', route => route.fulfill({ json: {
    items: [], nextOffset: null, unresolvedDecisions: retained ? 1 : 0,
    claims: retained ? [{ id: 'uncertain-one', revision, summary: 'A retained lesson', origin: 'unconfirmed decision' }] : [],
  } }));
  await page.route('**/api/hermes/workspace/review-claims/skills**', async route => {
    if (route.request().method() === 'POST') {
      decisions.push(route.request().postDataJSON()); retained = false;
      return route.fulfill({ json: { ok: true, decision: { status: 'operator_reconciled' } } });
    }
    return route.fulfill({ json: { id: 'uncertain-one', revision, diff: '{"payload":"retained complete proposal"}' } });
  });
  await page.goto('/idea');
  const queue = page.getByRole('region', { name: 'Skill review queue' });
  await queue.getByRole('button', { name: 'Inspect uncertain A retained lesson' }).click();
  await expect(queue.getByLabel('Proposal diff')).toContainText('retained complete proposal');
  await expect(queue.getByRole('button', { name: 'Approve reviewed revision' })).toHaveCount(0);
  await expect(queue.getByRole('button', { name: 'Record observed application' })).toBeDisabled();
  await expect(queue.getByRole('button', { name: 'Abandon unresolved proposal' })).toBeDisabled();
  expect(decisions).toHaveLength(0);
  await queue.getByRole('checkbox', { name: 'I compared this proposal with the current native state.' }).check();
  await queue.getByRole('button', { name: 'Record observed application' }).click();
  await expect(queue.getByText('Operator observation recorded. No changes were applied or undone.', { exact: true })).toBeVisible();
  await expect(queue.getByRole('heading', { name: 'Unconfirmed decisions' })).toHaveCount(0);
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toEqual({ id: 'uncertain-one', revision, action: 'observed_applied', requestId: expect.any(String), confirm: true });
  expect(state.errors).toEqual([]);
});

test('saved provider cards connect a bot privately while keeping model choice separate', async ({ page }) => {
  const state = await fixture(page, false, true);
  await page.goto('/settings');
  const providers = page.getByRole('region', { name: 'Saved providers', exact: true });
  await expect(providers.getByRole('heading', { name: 'OpenRouter' })).toBeVisible();
  await expect(providers.getByRole('button', { name: 'Configured for Main', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Bot', exact: true }).selectOption('research');
  await page.getByRole('combobox', { name: /^Model / }).fill('keep-this-model-draft');
  await providers.getByRole('button', { name: 'Connect to Research', exact: true }).click();
  await expect(providers.getByRole('status')).toContainText('OpenRouter connected to Research');
  await expect(providers.getByRole('button', { name: 'Configured for Research', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: /^Model / })).toHaveValue('keep-this-model-draft');
  expect(state.writes.filter(write => write.path === '/api/hermes/model' || write.path === '/api/hermes/credentials')).toEqual([]);
  expect(state.writes.filter(write => write.path === '/api/hermes/saved-providers')).toEqual([{ path: '/api/hermes/saved-providers', profile: 'research', body: { id: 'a'.repeat(64), action: 'connect' } }]);
  await expect(providers.getByText('Not verified recently', { exact: true })).toBeVisible();
  await providers.getByRole('button', { name: 'Verify key', exact: true }).click();
  await expect(providers.getByText('Verified recently', { exact: true })).toBeVisible();
  expect((await providers.getByRole('article').boundingBox())!.width).toBeGreaterThanOrEqual(240);
  await page.screenshot({ path: 'test-results/saved-providers-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'Models & providers', exact: true }).click();
  await expect(providers.getByRole('heading', { name: 'OpenRouter', exact: true })).toBeVisible();
  await providers.getByRole('heading', { name: 'OpenRouter', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/saved-providers-mobile.png', fullPage: true });
  expect(state.errors).toEqual([]);
});

test('saved provider cards select a configured provider without losing its credential name', async ({ page }) => {
  const state = await fixture(page, false, true);
  await page.goto('/settings');
  const providers = page.getByRole('region', { name: 'Saved providers', exact: true });
  await providers.getByRole('button', { name: 'Choose model', exact: true }).click();
  await expect(page.getByRole('combobox', { name: /^Provider / })).toHaveValue('openrouter');
  await expect(page.getByRole('combobox', { name: /^Credential name / })).toHaveValue('OPENROUTER_API_KEY');
  await expect(page.getByRole('button', { name: 'Select model', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: /^Provider / }).selectOption('openai');
  await expect(page.getByRole('combobox', { name: /^Credential name / })).toHaveValue('OPENAI_API_KEY');
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('an unconfirmed credential save retains the entered key and reports the failure', async ({ page }) => {
  const state = await fixture(page);
  await page.route('**/api/hermes/credentials?*', route => route.request().method() === 'PUT' ? route.fulfill({ json: { ok: false } }) : route.fallback());
  await page.goto('/settings');
  await page.getByRole('combobox', { name: /^Provider / }).selectOption('openai');
  await expect(page.getByRole('combobox', { name: /^Credential name / })).toHaveValue('OPENAI_API_KEY');
  const key = page.getByLabel(/^API key/);
  await key.fill('synthetic-credential');
  await page.getByRole('button', { name: 'Save credential', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('did not confirm the saved credential');
  await expect(key).toHaveValue('synthetic-credential');
  await expect(page.getByText('Credential saved for this bot.', { exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test('sidebar model selection saves the chosen bot, requires native confirmation, and survives reload', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  await page.getByRole('listitem').filter({ has: page.getByText('Research', { exact: true }) }).click();
  await page.getByRole('tab', { name: 'Identity', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const model = page.getByRole('region', { name: 'Bot model', exact: true });
  await expect(model.getByRole('combobox', { name: /^Provider / })).toHaveValue('openrouter');
  await expect(model.getByRole('combobox', { name: /^Model / })).toHaveValue('research-model');
  await model.getByRole('combobox', { name: /^Provider / }).selectOption('openai');
  await model.getByRole('combobox', { name: /^Model / }).fill('invalid-model');
  await model.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect(model.getByRole('alert')).toContainText('not available');
  await expect(model.getByRole('combobox', { name: /^Model / })).toHaveValue('invalid-model');
  await model.getByRole('combobox', { name: /^Model / }).fill('expensive-model');
  await model.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect(model.getByText('This model has higher costs.', { exact: true })).toBeVisible();
  await expect(model.getByText('Model saved.', { exact: false })).toHaveCount(0);
  await model.getByRole('button', { name: 'Confirm this model selection' }).click();
  await expect(model.getByText('Model saved.', { exact: false })).toBeVisible();
  expect(state.writes.filter(write => write.path === '/api/hermes/model')).toEqual([
    { path: '/api/hermes/model', profile: 'research', body: { scope: 'main', provider: 'openai', model: 'invalid-model' } },
    { path: '/api/hermes/model', profile: 'research', body: { scope: 'main', provider: 'openai', model: 'expensive-model' } },
    { path: '/api/hermes/model', profile: 'research', body: { scope: 'main', provider: 'openai', model: 'expensive-model', confirm_expensive_model: true } },
  ]);
  await page.screenshot({ path: 'test-results/sidebar-model-desktop.png', fullPage: true });
  // The bot selection is intentionally reset on a full reload; reopen Research.
  await page.reload();
  await page.getByRole('listitem').filter({ has: page.getByText('Research', { exact: true }) }).click();
  await page.getByRole('tab', { name: 'Identity', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(model.getByRole('combobox', { name: /^Model / })).toHaveValue('expensive-model');
  expect(state.errors).toEqual([]);
});

test('mobile dock tracks open pages, supports history and same-tab clicks, and closes the agent overlay', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.goto('/chat');
  const dock = page.getByRole('navigation', { name: 'Mobile navigation' }).filter({ visible: true });
  const current = () => dock.locator('[aria-current="page"]');
  await expect(current()).toHaveAccessibleName('Chat');
  await dock.getByRole('button', { name: 'Workshop', exact: true }).click();
  await expect(page).toHaveURL(/\/ideas$/);
  await expect(current()).toHaveAccessibleName('Workshop');
  await expect(page.getByText('No skills installed for this bot', { exact: true })).toBeVisible();
  await dock.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(current()).toHaveAccessibleName('Goals');
  await expect(page.getByText('No scheduled goals for this bot', { exact: true })).toBeVisible();
  await dock.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(current()).toHaveAccessibleName('Library');
  await page.goBack();
  await expect(current()).toHaveAccessibleName('Goals');
  await dock.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(current()).toHaveAccessibleName('Goals');
  await dock.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await dock.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open agent details and activity', exact: true }).click();
  await page.getByRole('tab', { name: 'Identity', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Bot model', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/sidebar-model-mobile.png', fullPage: true });
  await page.getByRole('complementary', { name: 'Agent details', exact: true }).getByRole('button', { name: 'Back to chat', exact: true }).click();
  await dock.getByRole('button', { name: 'Workshop', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Agent details', exact: true })).toBeHidden();
  await expect(current()).toHaveAccessibleName('Workshop');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.errors).toEqual([]);
});

test('conversation search explains empty results and lets the user recover', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).filter({ visible: true }).click();
  await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('missing title');
  await expect(page.getByText('No matching conversations', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByRole('button').filter({ hasText: 'Test conversation' })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test('categories retain drafts, failed saves stay unsaved, successful saves survive reload', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/settings');
  await expect(page.getByRole('complementary', { name: 'Agent details', exact: true })).toHaveCount(0);
  await expect(page.getByText('Executed Python script')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Browser', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Advanced configuration', exact: false }).click();
  const editor = page.locator('.settings-editor');
  await editor.getByRole('combobox').selectOption('false');
  await expect(editor.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: 'Advanced configuration', exact: false }).click();
  await expect(editor.getByRole('combobox')).toHaveValue('false');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByText('All settings saved')).toBeVisible();
  await page.reload();
  await expect(editor.getByRole('combobox')).toHaveValue('false');
  state.failSaves();
  await editor.getByRole('combobox').selectOption('true');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('alert')).toContainText('could not be persisted');
  await expect(editor.getByText('Unsaved changes')).toBeVisible();
  await expect(editor.getByRole('combobox')).toHaveValue('true');
  expect(state.errors).toEqual([]);
});

test('theme and settings navigation persist with keyboard-visible focus and mobile layout', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('textbox', { name: 'Find settings category' }).focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => {
    const element = document.activeElement!;
    const style = getComputedStyle(element);
    return element.matches(':focus-visible') && style.outlineStyle === 'solid' && style.outlineWidth === '2px';
  })).toBe(true);
  await page.screenshot({ path: 'test-results/settings-dark-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Color theme' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find settings category' }).fill('cron');
  await expect(page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/settings-dark-mobile.png', fullPage: true });
  expect(state.errors).toEqual([]);
});

test('catalog install uses reviewed SHA, reports missing credentials and refuses per-bot installation', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Plugins & integrations', exact: false }).click();
  await expect(page.getByText('EXAMPLE_KEY', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'View example details', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'example', exact: true })).toBeVisible();
  await expect(page.getByText('EXAMPLE_KEY', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await page.getByRole('button', { name: 'Install reviewed pin', exact: true }).click();
  await expect(page.getByText('Required credentials:', { exact: false })).toBeVisible();
  expect(state.writes.find(write => write.path.endsWith('/example/install'))).toEqual({ path: '/api/hermes/setup/plugins/example/install', body: { confirm: true, expectedSha: sha }, profile: 'default' });
  await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/settings-plugins-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Close plugin details' }).click();
  await page.getByRole('combobox', { name: 'Bot', exact: true }).selectOption('research');
  await expect(page.getByText('This Hermes version manages plugins for Main only.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable', exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test('opening the computer inspector loads its deferred module and shows actual availability', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  const computerStatus = page.waitForResponse(response => new URL(response.url()).pathname === '/api/hermes/agent-computer/status');
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No Chromium-family browser was found on the host.' })).toBeVisible();
  await page.getByRole('tab', { name: 'Computer', exact: true }).click();
  await computerStatus;
  await expect(page.getByText('No agent computer is configured for this bot.', { exact: false })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'No Chromium-family browser was found on the host.' })).toHaveCount(0);
  await expect(page.getByText('Agent Computer is Sleeping', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Live stream', { exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});


test('plugin store uses app tiles, filters installed and catalog apps, and opens keyboard-accessible details', async ({ page }) => {
  const state = await fixture(page, true);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Plugins & integrations', exact: false }).click();
  const apps = page.getByRole('list', { name: 'Plugin apps' });
  await expect(apps.getByRole('listitem')).toHaveCount(4);
  const first = await apps.getByRole('listitem').nth(0).boundingBox();
  const second = await apps.getByRole('listitem').nth(1).boundingBox();
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(2);
  expect(second!.x).toBeGreaterThan(first!.x);
  expect(first!.width).toBeGreaterThan(150);
  await page.screenshot({ path: 'test-results/plugin-store-grid-desktop.png', fullPage: true });
  await page.getByRole('textbox', { name: 'Search plugin catalog' }).fill('save_note');
  await expect(apps.getByRole('listitem')).toHaveCount(1);
  await expect(apps.getByRole('button', { name: 'View notes details' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search plugin catalog' }).fill('');
  await page.getByRole('combobox', { name: 'Filter plugins' }).selectOption('installed');
  await expect(apps.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'View local-helper details' }).click();
  let dialog = page.getByRole('dialog', { name: 'local-helper', exact: true });
  await expect(dialog.getByText('2.0', { exact: true })).toBeVisible();
  await expect(dialog.getByText('This installed plugin has no matching catalog entry.', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View local-helper details' })).toBeFocused();
  await page.getByRole('combobox', { name: 'Filter plugins' }).selectOption('all');
  const tile = page.getByRole('button', { name: 'View example details', exact: true });
  await tile.focus(); await page.keyboard.press('Enter');
  dialog = page.getByRole('dialog', { name: 'example', exact: true });
  await expect(dialog.getByText('lookup', { exact: true })).toBeVisible();
  await expect(dialog.getByText('on_start', { exact: true })).toBeVisible();
  await expect(dialog.getByText('request_context', { exact: true })).toBeVisible();
  await expect(dialog.getByText('>=0.22.0', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Documentation', exact: true })).toHaveAttribute('href', 'https://example.com/docs');
  await expect(dialog.getByRole('button', { name: 'Close plugin details' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Install', exact: true })).toBeFocused();
  expect(state.writes.filter(write => write.path.includes('/plugins/'))).toEqual([]);
  await page.screenshot({ path: 'test-results/plugin-store-details-desktop.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'Plugins & integrations', exact: true }).click();
  await tile.click();
  dialog = page.getByRole('dialog', { name: 'example', exact: true });
  await expect(dialog.getByRole('button', { name: 'Install', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/plugin-store-details-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'test-results/plugin-store-grid-mobile.png', fullPage: true });
  expect(state.errors).toEqual([]);
});

test('automation saves a real conversation-scoped heartbeat and displays native pause state', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Automation', exact: false }).click();
  const automation = page.getByRole('region', { name: 'Conversation automation' });
  await expect(automation.getByRole('combobox', { name: 'Automation conversation' })).toHaveValue(nativeSession);
  await automation.getByLabel('Heartbeat instructions', { exact: true }).fill('Check overdue approved dependencies.');
  await automation.getByLabel('Heartbeat interval (minutes)', { exact: true }).fill('15');
  await automation.getByRole('button', { name: 'Save heartbeat' }).click();
  await expect(automation.getByText('Every 15 minutes · 0 checks', { exact: true })).toBeVisible();
  expect(state.writes.find(write => write.path.endsWith('/autonomy'))).toEqual({ path: '/api/hermes/workspace/autonomy', profile: 'default', body: { sessionKey: nativeSession, kind: 'heartbeat', action: 'set', prompt: 'Check overdue approved dependencies.', intervalSeconds: 900 } });
  await automation.getByRole('button', { name: 'Pause heartbeat' }).click();
  await expect(automation.getByRole('button', { name: 'Resume heartbeat' })).toBeVisible();
  await page.reload();
  await expect(automation.getByRole('button', { name: 'Resume heartbeat' })).toBeVisible();
  await page.screenshot({ path: 'test-results/automation-heartbeat-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await page.locator('.hob-settings-directory').getByRole('button', { name: 'Automation', exact: true }).click();
  await expect(automation.getByRole('button', { name: 'Resume heartbeat' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.errors).toEqual([]);
});

test('every settings category fits a narrow phone without horizontal panel scrolling', async ({ page }) => {
  const { expectNoHorizontalScroll } = await import('./mobile-layout');
  const state = await fixture(page, true, true);
  const nativeCategories = ['memory', 'general', 'model', 'tools', 'browser', 'compression', 'terminal', 'agent', 'display', 'privacy'];
  await page.route(url => url.pathname === '/api/hermes/config/schema', route => route.fulfill({ json: { fields: Object.fromEntries(nativeCategories.map(category => [`${category}.${'long_native_setting_'.repeat(5)}`, { type: 'string', category, description: 'A long native setting with a URL: https://example.com/' + 'path'.repeat(45) }])), category_order: nativeCategories } }));
  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/settings');
    const categories = page.locator('.hob-settings-directory').getByRole('navigation', { name: 'Settings categories' });
    await expect(categories.getByRole('button')).toHaveCount(11);
    const labels = await categories.getByRole('button').allTextContents();
    for (const label of labels) {
      await categories.getByRole('button').filter({ hasText: label }).click();
      await expect(categories).toBeHidden();
      expect((await page.locator('.hob-settings-content').getByRole('button', { name: 'Refresh', exact: true }).first().boundingBox())!.height).toBeLessThanOrEqual(44);
      if (label.startsWith('Advanced')) await expect(page.locator('.settings-nav').getByRole('button')).toHaveCount(nativeCategories.length);
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: `test-results/mobile-settings-${width}-${label.split(' ')[0]}.png` });
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(categories).toBeVisible();
    }
  }
  expect(state.errors).toEqual([]);
});

test('team core review requires an explicit approval and reports incomplete distribution on a phone', async ({ page }) => {
  const { expectNoHorizontalScroll } = await import('./mobile-layout');
  const state = await fixture(page), writes: { path: string; body: Record<string, unknown> }[] = [];
  let incomplete = false;
  const team = {
    policy: { revision: 0, coordinatorOnly: false, shareDocuments: false, coreBudget: 4000, sessionWindow: 20, ordinaryPromotions: 'user' },
    core: { revision: 0, content: '' },
    proposals: [] as { id: string; base: number; digest: string; content: string; evidence: string; author: string }[],
    bots: [{ id: 'default', name: 'Main', revision: 0, status: 'not synchronized' }],
  };
  await page.route('**/api/hermes/team**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (request.method() === 'GET' && path.endsWith('/history')) return json({ revisions: [{ revision: 1, content: team.core.content, committed: Date.parse('2026-10-30T10:00:00Z') }] });
    if (request.method() === 'GET') return json(team);
    const body = request.postDataJSON(); writes.push({ path, body });
    if (path.endsWith('/proposals')) {
      const proposal = { ...body, id: 'proposal-1', digest: 'a'.repeat(64), author: 'user' };
      team.proposals = [proposal]; return json(proposal);
    }
    if (path.endsWith('/decisions')) {
      expect(body).toEqual({ id: 'proposal-1', base: 0, digest: 'a'.repeat(64), decision: 'approve', confirm: true });
      team.core = { revision: 1, content: team.proposals[0].content }; team.proposals = [];
      team.bots[0] = { ...team.bots[0], revision: 1, status: 'synced' };
    }
    if (path.endsWith('/settings')) {
      expect(Object.keys(body).sort()).toEqual(['confirm', 'coordinatorOnly', 'coreBudget', 'revision', 'sessionWindow', 'shareDocuments']);
      team.policy = { ...team.policy, ...body, revision: team.policy.revision + 1 };
    }
    return json({ ...team, sync: { updated: incomplete ? [] : ['default'], failed: incomplete ? [{ name: 'Main', error: 'Fixture sync failure' }] : [] } });
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/settings');
  await page.locator('.hob-settings-directory').getByRole('button', { name: 'Memory & history', exact: true }).click();
  const controls = page.getByRole('region', { name: 'Shared team core and documents' });
  await controls.getByRole('button', { name: 'Open team controls' }).click();
  await expect(controls.getByText('Published core · revision 0')).toBeVisible();
  await expect(controls.getByText(/20-turn session window is not active/)).toBeVisible();
  await controls.getByLabel('Proposed team core').fill('Checked project fact.');
  await controls.getByLabel('Promotion evidence').fill('Verified deliverable receipt.');
  await controls.getByRole('button', { name: 'Stage core proposal' }).click();
  const approve = controls.getByRole('button', { name: 'Approve and distribute core' });
  await expect(approve).toBeDisabled(); expect(team.core.revision).toBe(0);
  await controls.getByRole('checkbox', { name: 'I reviewed this exact core change and its evidence.' }).check();
  await approve.click();
  await expect(controls.getByText('Published core · revision 1')).toBeVisible();
  await controls.getByRole('button', { name: 'Load core revision history' }).click();
  await controls.getByRole('button', { name: 'Restore revision 1 as a proposal' }).click();
  await expect(controls.getByLabel('Proposed team core')).toHaveValue('Checked project fact.');
  expect(writes.length).toBe(2); // Restoring only prepares a draft; it cannot bypass approval.
  await controls.getByRole('checkbox', { name: 'Route worker requests through the coordinator' }).check();
  await controls.getByRole('button', { name: 'Save team distribution settings' }).click();
  await expect(controls.getByText('Saved and synchronized. This does not mark the employee team live.')).toBeVisible();
  incomplete = true;
  await controls.getByRole('button', { name: 'Reconcile core draft and synchronize' }).click();
  await expect(controls.getByRole('alert')).toContainText('change was saved, but synchronization failed');
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: 'test-results/employee-team-core-review-mobile.png' });
  expect(writes.map(write => write.path)).toEqual(['/api/hermes/team/proposals', '/api/hermes/team/decisions', '/api/hermes/team/settings', '/api/hermes/team/sync']);
  expect(state.errors).toEqual([]);
});

test('non-metered routes require exact billing review and expose revocation on a phone', async ({ page }) => {
  const { expectNoHorizontalScroll } = await import('./mobile-layout');
  const fixtureState = await fixture(page);
  const team = { policy: { revision: 0, coordinatorOnly: false, shareDocuments: false, coreBudget: 4000, sessionWindow: 20, ordinaryPromotions: 'user' }, core: { revision: 0, content: '' }, proposals: [], bots: [{ id: 'research', name: 'My configured researcher', status: 'not synchronized' }] };
  let execution = { revision: 0, routes: [] as Record<string, unknown>[] };
  let preview: Record<string, unknown> | null = null;
  const writes: string[] = [];
  await page.route('**/api/hermes/team**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: path.endsWith('/execution/routes') ? execution : team });
    const body = request.postDataJSON(); writes.push(path);
    if (path.endsWith('/preview')) {
      preview = { revision: execution.revision, digest: 'b'.repeat(64), route: { ...body, id: 'route-id' } };
      return route.fulfill({ json: preview });
    }
    if (path.endsWith('/revoke')) {
      expect(body).toEqual({ id: 'route-id', digest: 'b'.repeat(64), revision: 1, confirm: true });
      execution = { revision: 2, routes: execution.routes.map(value => ({ ...value, revoked: 2 })) };
    } else {
      expect(body).toEqual({ ...preview, confirm: true, confirmNoUsageCharges: true });
      execution = { revision: 1, routes: [{ ...body.route, digest: body.digest, approvedAt: 1, revoked: null }] };
    }
    return route.fulfill({ json: execution });
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/settings');
  await page.locator('.hob-settings-directory').getByRole('button', { name: 'Memory & history', exact: true }).click();
  await page.getByRole('button', { name: 'Open team controls' }).click();
  const controls = page.getByRole('region', { name: 'Team model execution routes' });
  await controls.getByRole('button', { name: 'Review model routes', exact: true }).click();
  await expect(controls.getByText(/No model routes approved/)).toBeVisible();
  await controls.getByLabel('Inference endpoint').fill(`https://subscription.example/${'long-prefix-'.repeat(10)}/v1/chat/completions`);
  await controls.getByLabel('Exact model IDs').fill('included-model');
  await controls.getByLabel('Credential fingerprint').fill('a'.repeat(64));
  await controls.getByLabel('Billing review evidence').fill('Existing subscription checked today; usage and overages disabled.');
  await controls.getByRole('button', { name: 'Prepare exact route review' }).click();
  const approve = controls.getByRole('button', { name: 'Approve reviewed model route' });
  await expect(approve).toBeDisabled(); expect(writes.length).toBe(1);
  await controls.getByRole('checkbox', { name: /I verified that this exact endpoint/ }).check();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: 'test-results/employee-team-model-route-review-mobile.png' });
  await approve.click();
  await expect(controls.getByText(/Route approval saved/)).toBeVisible();
  await expect(controls.getByLabel('Exact model route review')).toHaveCount(0);
  await controls.getByRole('button', { name: 'Revoke this model route' }).click();
  await expect(controls.getByText(/Each future request requires an active approval/)).toBeVisible();
  await expect(controls.getByRole('button', { name: 'Revoke this model route' })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  expect(writes).toEqual(['/api/hermes/team/execution/routes/preview', '/api/hermes/team/execution/routes', '/api/hermes/team/execution/routes/revoke']);
  expect(fixtureState.errors).toEqual([]);
});
