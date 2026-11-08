import { expect, test, type Page } from '@playwright/test';

async function recoveryFixture(page: Page) {
  const state = { unavailable: false, runtimeUnavailable: false, authUnavailable: false, warmWriter: false, streamMode: false, done: false, posts: [] as string[], errors: [] as string[] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(() => {
    // A stable event connection, independent of the simulated failing reads.
    class FixtureEvents extends EventTarget {
      constructor() { super(); setTimeout(() => this.dispatchEvent(new MessageEvent('connection', { data: '{"connected":true}' })), 0); }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { value: FixtureEvents });
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const profile = request.headers()['x-hob-profile'] || 'default';
    const json = (value: unknown) => route.fulfill({ json: value });
    if (request.method() !== 'GET') state.posts.push(path);
    if (path === '/api/hermes/team/work/inbox') return json({ items: [] });
    if (path === '/api/auth/status') return state.authUnavailable ? route.fulfill({ status: 502, body: 'Bad Gateway' }) : json({ authenticated: true, configured: true });
    if (path === '/api/runtime') return state.runtimeUnavailable ? route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' }) : json({ runtime: 'hermes' });
    if (state.unavailable && ['/api/sessions', '/api/readiness'].includes(path)) return route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' });
    if (path === '/api/readiness') return json({ ready: !(state.warmWriter && profile === 'writer'), status: 'ready' });
    if (path === '/api/agents') return json({ agents: [{ id: 'default', name: 'Main' }, { id: 'writer', name: 'Scribe' }] });
    if (path === '/api/agent') return json({ id: profile, name: profile === 'writer' ? 'Scribe' : 'Main', status: 'connected', avatarUrl: '' });
    if (path === '/api/sessions') return json([{ id: 'new-chat', title: 'Newer chat', agentId: profile }, { id: 'saved-chat', title: 'Ongoing research', agentId: profile }]);
    if (path.endsWith('/messages')) return json(state.streamMode ? [
      { id: 'native-user', role: 'user', content: 'Research this task', timestamp: '2026-11-08T10:00:00Z' },
      { id: 'native-answer', role: 'assistant', content: state.done ? 'The research is complete.' : 'Retained partial answer', timestamp: '2026-11-08T10:01:00Z' },
    ] : [{ id: 'retained', role: 'assistant', content: path.includes('saved-chat') ? 'Your saved research conversation.' : 'A newer conversation.', timestamp: '2026-11-08T10:00:00Z' }]);
    if (path.endsWith('/turns')) {
      state.streamMode = true;
      return route.fulfill({ contentType: 'text/event-stream', body: 'event: accepted\ndata: {"runId":"retained-run"}\n\nevent: delta\ndata: {"text":"Retained partial answer"}\n\n' });
    }
    if (path.endsWith('/run')) return json({ run: state.streamMode ? { runId: 'retained-run', status: state.done ? 'completed' : 'running', submittedAt: '2026-11-08T10:00:00Z', revision: 'rev-1', canRecover: false, canResolveUnknown: false, questions: [] } : null });
    if (path === '/api/tasks' || path === '/api/security/approvals') return json([]);
    if (path === '/api/stats') return json({ tokensUsed: 0, maxTokens: 0 });
    if (path === '/api/hermes/groups') return json({ groups: [] });
    if (path === '/api/hermes/exchanges') return json({ exchanges: [], nextBefore: null });
    if (path === '/api/hermes/browser' || path === '/api/hermes/browser/diagnose') return json({ bot: profile, state: 'stopped', available: false, tabs: [], control: { holder: 'agent', pending: 0, since: null }, binding: { configured: true } });
    if (path === '/api/hermes/agent-computer/status') return json({ configured: false, connected: false });
    state.errors.push(`Unexpected API: ${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: path } });
  });
  return state;
}

test('a transient startup 502 recovers automatically without a failure alert or duplicate conversation', async ({ page }) => {
  const state = await recoveryFixture(page);
  state.unavailable = true;
  await page.goto('/chat');
  await expect(page.getByText('Reconnecting to HOB…', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('status', { name: 'Loading conversation' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('What can I help you with?', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/reconnecting-startup.png' });
  state.unavailable = false;
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByText('A newer conversation.', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Reconnecting to HOB…', { exact: true })).toHaveCount(0);
  expect(state.posts).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('reopening restores the selected bot and older active conversation instead of jumping to the newest chat', async ({ page }) => {
  const state = await recoveryFixture(page);
  await page.addInitScript(() => { localStorage.setItem('hob-active-profile', 'writer'); localStorage.setItem('hob-last-session:writer', 'saved-chat'); });
  await page.goto('/chat');
  await expect(page.getByText('Your saved research conversation.', { exact: true })).toBeVisible();
  await expect(page.getByText('A newer conversation.', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Your saved research conversation.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('hob-active-profile'))).toBe('writer');
  expect(state.posts).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('a dropped live reply keeps native work observable and never resends the task', async ({ page }) => {
  const state = await recoveryFixture(page);
  await page.goto('/chat');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Research this task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Retained partial answer', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Current run')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Retained partial answer', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Current run')).toBeVisible();
  state.done = true;
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.getByText('The research is complete.', { exact: true })).toBeVisible({ timeout: 10000 });
  expect(state.posts.filter(path => path.endsWith('/turns'))).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test('offline status preserves loaded messages and drafting, and motion respects reduced-motion preference', async ({ page, context }) => {
  const state = await recoveryFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');
  await expect(page.getByText('A newer conversation.', { exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Keep this draft');
  await context.setOffline(true);
  await expect(page.getByText('You’re offline', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('Keep this draft');
  await expect(page.locator('button[aria-label="Send message"]')).toBeDisabled();
  await input.press('Enter');
  await expect(input).toHaveValue('Keep this draft');
  await expect(page.getByText('A newer conversation.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/reconnecting-offline-mobile.png' });
  const duration = await page.locator('.hob-message-enter').first().evaluate(node => parseFloat(getComputedStyle(node).animationDuration));
  expect(duration).toBeLessThan(0.001);
  await context.setOffline(false);
  await expect(page.getByText('You’re offline', { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue('Keep this draft');
  expect(state.posts).toEqual([]);
});

test('a runtime lookup outage reconnects automatically instead of requiring a page reload', async ({ page }) => {
  const state = await recoveryFixture(page);
  state.runtimeUnavailable = true;
  await page.goto('/chat');
  await expect(page.getByText('Connecting to your runtime…', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  state.runtimeUnavailable = false;
  await expect(page.getByText('A newer conversation.', { exact: true })).toBeVisible({ timeout: 10000 });
  expect(state.posts).toEqual([]);
});

test('a temporary login-status outage retains the saved login and reconnects without asking for credentials', async ({ page }) => {
  const state = await recoveryFixture(page);
  state.authUnavailable = true;
  await page.goto('/chat');
  await expect(page.getByText('Reconnecting to HOB… Your saved work stays on the server.', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  state.authUnavailable = false;
  await expect(page.getByText('A newer conversation.', { exact: true })).toBeVisible({ timeout: 10000 });
  expect(state.posts).toEqual([]);
});

test('a warming restored bot does not prevent opening a healthy bot', async ({ page }) => {
  const state = await recoveryFixture(page);
  state.warmWriter = true;
  await page.addInitScript(() => { localStorage.setItem('hob-active-profile', 'writer'); });
  await page.goto('/chat');
  const main = page.getByRole('listitem').filter({ has: page.getByText('Main', { exact: true }) });
  await expect(main).toBeVisible();
  await main.click();
  await expect(page.getByText('A newer conversation.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('hob-active-profile'))).toBe('default');
  expect(state.posts).toEqual([]);
  expect(state.errors).toEqual([]);
});
