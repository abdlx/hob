import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// A real production bundle in Chromium, with explicit Hermes API fixtures.
// This verifies UI contracts; it does not claim a live Hermes install or model run.
const sha = 'a'.repeat(40);
async function fixture(page: Page, extraApps = false) {
  const errors: string[] = [], writes: { path: string; body: Record<string, unknown>; profile: string | null }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let saved = { model: 'test-model', memory: { enabled: true } }, failSave = false, installed = false;
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
    if (path === '/api/agent') return json({ id: 'default', name: 'Main', status: 'connected', model: 'test-model', avatarUrl: '' });
    if (path === '/api/sessions') return json([{ id: 'session-test', agentId: 'default', title: 'Test conversation', createdAt: '2026-10-26T00:00:00Z' }]);
    if (path === '/api/sessions/session-test/messages' || path === '/api/tasks' || path === '/api/security/approvals') return json([]);
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
    if (path === '/api/hermes/credentials') return json({ OPENAI_API_KEY: { is_set: true } });
    if (path === '/api/hermes/setup/models') return json({ providers: [] });
    if (path === '/api/hermes/setup/accounts') return json({ providers: [] });
    if (path === '/api/hermes/setup/mcp') return json({ servers: [] });
    if (path === '/api/hermes/workspace/toolsets') return json([{ name: 'browser', enabled: true, configured: false }]);
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
