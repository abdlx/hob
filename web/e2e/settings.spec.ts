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
    if (path === '/api/sessions') return json([{ id: nativeSession, agentId: 'default', title: 'Test conversation', transport: 'canonical', createdAt: '2026-10-26T00:00:00Z' }]);
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
    if (path === '/api/hermes/setup/mcp') return json({ servers: [] });
    if (path === '/api/hermes/workspace/toolsets') return json([{ name: 'browser', enabled: true, configured: false }]);
    if (path === '/api/hermes/workspace/jobs') return json([]);
    if (path === '/api/hermes/workspace/skills') return json([]);
    if (path === '/api/hermes/workspace/learning') return json({ nodes: [] });
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
  await page.getByRole('button', { name: 'Change bot model', exact: true }).click();
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
  await page.getByRole('button', { name: 'Change bot model', exact: true }).click();
  await expect(model.getByRole('combobox', { name: /^Model / })).toHaveValue('expensive-model');
  expect(state.errors).toEqual([]);
});

test('mobile dock tracks open pages, supports history and same-tab clicks, and closes the agent overlay', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.goto('/chat');
  const dock = page.getByRole('navigation', { name: 'Bottom dock navigation' }).filter({ visible: true });
  const current = () => dock.locator('[aria-current="page"]');
  await expect(current()).toHaveAccessibleName('Bots');
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
  await dock.getByRole('button', { name: 'Bots', exact: true }).click();
  await page.getByRole('listitem').filter({ has: page.getByText('Main', { exact: true }) }).click();
  await dock.getByRole('button', { name: 'Bots', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeHidden();
  await page.getByRole('listitem').filter({ has: page.getByText('Main', { exact: true }) }).click();
  await page.getByRole('button', { name: 'Open agent details and activity', exact: true }).click();
  await page.getByRole('button', { name: 'Change bot model', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Bot model', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/sidebar-model-mobile.png', fullPage: true });
  await page.getByRole('complementary', { name: 'Agent details', exact: true }).getByRole('button', { name: 'Workshop', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Agent details', exact: true })).toBeHidden();
  await expect(current()).toHaveAccessibleName('Workshop');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.errors).toEqual([]);
});

test('conversation search explains empty results and lets the user recover', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Conversations', exact: true }).filter({ visible: true }).click();
  await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('missing title');
  await expect(page.getByText('No matching conversations', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByRole('button').filter({ hasText: 'Test conversation' })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test('categories retain drafts, failed saves stay unsaved, successful saves survive reload', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/settings');
  await expect(page.getByText('No activity has been reported for this bot.')).toBeVisible();
  await expect(page.getByText('Executed Python script')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Web', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Advanced configuration', exact: false }).click();
  const editor = page.locator('.settings-editor');
  await editor.getByRole('combobox').selectOption('false');
  await expect(editor.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'General', exact: false }).click();
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
  await page.getByRole('button', { name: 'General', exact: false }).click();
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
  await expect(page.getByRole('group', { name: 'Color theme' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
  await page.goto('/settings');
  const computerStatus = page.waitForResponse(response => new URL(response.url()).pathname === '/api/hermes/agent-computer/status');
  await page.getByRole('tab', { name: 'Web', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No Chromium-family browser was found on the host.' })).toBeVisible();
  await computerStatus;
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
  await expect(automation.getByRole('button', { name: 'Resume heartbeat' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.errors).toEqual([]);
});
