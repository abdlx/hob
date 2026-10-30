import { test, expect, type Page } from '@playwright/test';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
async function fixture(page: Page) {
  const errors: string[] = [], writes: unknown[] = [];
  let name = 'Main', tags = ['Coordinator'], role = 'Coordinate the team.';
  let writerPreview = '**The launch plan** is ready for review.';
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === '/api/auth/status') return json({ authenticated: true, configured: true });
    if (path === '/api/runtime') return json({ runtime: 'hermes' });
    if (path === '/api/readiness') return json({ ready: true, status: 'ready' });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: connection\ndata: {"connected":true}\n\n' });
    if (path === '/api/agents') return json({ agents: [{ id: 'default', name, tags, roleDescription: role }, { id: 'writer', name: 'Scribe', tags: ['Writing'], model: 'synthetic-preview-model', lastMessageSnippet: writerPreview }, { id: 'empty', name: 'New bot', lastMessageSnippet: '' }] });
    if (path === '/api/agent') return json({ id: 'default', name, tags, roleDescription: role, status: 'connected', avatarUrl: '' });
    if (path === '/api/sessions') return json([{ id: 'session-test', agentId: 'default', title: 'Launch plan', createdAt: '2026-10-26T00:00:00Z' }]);
    if (path === '/api/sessions/session-test/messages') return json([{ id: 'user-1', role: 'user', content: 'Prepare the launch plan.', timestamp: '2026-10-26T10:00:00Z' }]);
    if (path === '/api/sessions/session-test/run') return json({ run: null });
    if (path === '/api/tasks' || path === '/api/security/approvals') return json([]);
    if (path === '/api/stats') return json({ tokensUsed: 0, maxTokens: 128000 });
    if (path === '/api/hermes/groups') return json({ groups: [] });
    if (path === '/api/hermes/profiles/default' && request.method() === 'PATCH') {
      const body = request.postDataJSON(); writes.push(body); name = body.displayName; tags = body.tags; role = body.description;
      return json({ ok: true, identitySync: 'synced', sync: { updated: ['default', 'writer'], failed: [] } });
    }
    if (path === '/api/hermes/exchanges') return json({ exchanges: ids.map((id, index) => ({ id, fromName: 'Main', toName: 'Scribe', status: 'completed', createdAt: Date.parse(`2026-10-26T10:0${index + 1}:00Z`) })), nextBefore: null });
    if (path.endsWith('/transcript') && path.startsWith('/api/hermes/exchanges/')) return json({ messages: [{ role: 'tool', name: 'terminal', content: 'Verified document.' }] });
    if (path.startsWith('/api/hermes/exchanges/')) {
      const index = ids.indexOf(path.split('/').at(-1)!);
      return json({ id: ids[index], fromName: 'Main', toName: 'Scribe', status: 'completed', createdAt: Date.parse('2026-10-26T10:01:00Z'), message: `Independent task ${index + 1}`, reply: `Verified result ${index + 1}` });
    }
    if (path === '/api/hermes/browser' || path === '/api/hermes/browser/diagnose') return json({ bot: 'default', state: 'stopped', available: false, tabs: [], control: { holder: 'agent', pending: 0, since: null }, binding: { configured: true } });
    if (path === '/api/hermes/agent-computer/status') return json({ configured: false, connected: false });
    if (path === '/api/hermes/browser/activity') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    errors.push(`Unexpected API: ${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: path } });
  });
  return { errors, writes, setWriterPreview: (value: string) => { writerPreview = value; } };
}

test('unopened bots show five-word last-message previews and pick up unattended replies', async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page);
  await page.goto('/chat');
  const writer = page.getByRole('listitem').filter({ has: page.getByText('Scribe', { exact: true }) });
  await expect(writer.getByText('The launch plan is ready…', { exact: true })).toBeVisible();
  await expect(page.getByText('synthetic-preview-model', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ has: page.getByText('New bot', { exact: true }) }).getByText('No messages yet')).toBeVisible();
  state.setWriterPreview('The revised report is ready to share.');
  await page.clock.fastForward(16000);
  await expect(writer.getByText('The revised report is ready…', { exact: true })).toBeVisible();
  await page.reload();
  await expect(writer.getByText('The revised report is ready…', { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test('worker reports, copied output and coordinator verdicts remain separate in the exchange inspector', async ({ page }) => {
  const { expectNoHorizontalScroll } = await import('./mobile-layout');
  const state = await fixture(page);
  const stages = [
    { verification: 'self-reported', output: false, text: 'The worker reported completion. Coordinator review is still pending.' },
    { verification: 'self-reported', output: true, text: 'The assigned output was received. Coordinator review is still pending.' },
    { verification: 'coordinator-reviewed', output: true, text: 'Main reviewed the output and recorded passing checks.' },
    { verification: 'coordinator-rejected', output: true, text: 'Main reviewed the output and recorded failed checks.' },
  ];
  let current = stages[0];
  await page.route('**/api/hermes/exchanges/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/transcript')) return route.fulfill({ json: { messages: [] } });
    return route.fulfill({ json: { id: ids[0], fromName: 'Main', toName: 'Scribe', status: 'completed', createdAt: Date.parse('2026-10-26T10:01:00Z'),
      message: 'Nominated task', reply: 'TASK plan-1 — DONE', teamTask: { id: 'plan-1' }, teamVerification: current.verification,
      ...(current.output ? { teamOutput: { sha256: 'f'.repeat(64), bytes: 20, receivedAt: '2026-10-26T10:02:00Z' } } : {}) } });
  });
  await page.setViewportSize({ width: 320, height: 760 });
  for (const stage of stages) {
    current = stage;
    await page.goto('/chat');
    const notice = page.locator(`[data-exchange-id="${ids[0]}"]`);
    await notice.getByRole('button').first().click();
    await expect(notice.getByText(stage.text, { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
  expect(state.errors).toEqual([]);
  expect(state.writes).toEqual([]);
});

test('each bot exchange is a separate expandable notice with its own transcript and survives refresh', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  const notices = page.getByRole('button', { name: /Main talked with Scribe/ });
  await expect(notices).toHaveCount(2);
  await notices.nth(0).click();
  await expect(page.getByText('Independent task 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Verified result 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Independent task 2', { exact: true })).toHaveCount(0);
  await notices.nth(1).click();
  await expect(page.getByText('Independent task 2', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/bot-exchanges-desktop.png', fullPage: true });
  await page.reload();
  await expect(notices).toHaveCount(2);
  await page.getByRole('button', { name: 'Bot exchange history', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Bot exchange history' })).toBeVisible();
  await page.getByRole('button', { name: 'Close exchange history' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(notices).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/bot-exchanges-mobile.png', fullPage: true });
  expect(state.errors).toEqual([]);
});

test('bot identity editor saves editable labels beside the name and restores them after reload', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Rename Main', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Bot identity' });
  await dialog.getByRole('textbox', { name: 'Bot labels', exact: true }).fill('Research, Coding');
  await dialog.getByRole('textbox', { name: 'Bot role', exact: true }).fill('Own research and implementation.');
  await dialog.getByRole('textbox').last().fill('Captain');
  await dialog.getByRole('button', { name: 'Save identity' }).click();
  await expect(dialog).toBeHidden();
  expect(state.writes).toEqual([{ displayName: 'Captain', tags: ['Research', 'Coding'], description: 'Own research and implementation.' }]);
  await expect(page.getByRole('heading', { name: /Captain.*Research.*Coding/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: /Captain.*Research.*Coding/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/bot-identity-desktop.png', fullPage: true });
  expect(state.errors).toEqual([]);
});

test('exchange inspector reviews worker permissions and stops the exact receiving run', async ({ page }) => {
  const state = await fixture(page);
  const key = Buffer.from(JSON.stringify(['writer', 'exchange-session'])).toString('base64url');
  let approved = false, stopped = false;
  const record = { id: ids[0], fromName: 'Main', toName: 'Scribe', to: 'writer', status: 'waiting_for_approval', createdAt: Date.now(), message: 'Review a document.', reply: '', sessionKey: key };
  await page.route('**/api/hermes/exchanges?*', route => route.fulfill({ json: { exchanges: [record], nextBefore: null } }));
  await page.route(`**/api/hermes/exchanges/${ids[0]}?*`, route => route.fulfill({ json: record }));
  await page.route(`**/api/sessions/${key}/run`, route => route.fulfill({ json: { run: { runId: 'worker-run', status: stopped ? 'cancelled' : approved ? 'running' : 'waiting_for_approval', revision: 'rev-1', questions: [], canRecover: false, canResolveUnknown: false } } }));
  await page.route(`**/api/sessions/${key}/approvals`, route => route.fulfill({ json: { approvals: approved ? [] : [{ id: 'permission-1', description: 'Create the reviewed document.', commandSnippet: 'touch reviewed.md', status: 'pending' }] } }));
  await page.route('**/api/security/approvals/permission-1', async route => {
    expect(route.request().headers()['x-hob-profile']).toBe('writer');
    expect(route.request().postDataJSON()).toEqual({ decision: 'approved' });
    approved = true; await route.fulfill({ json: { accepted: true } });
  });
  await page.route(`**/api/sessions/${key}/abort`, async route => {
    expect(route.request().postDataJSON()).toEqual({ expectedRunId: 'worker-run' });
    stopped = true; await route.fulfill({ json: { accepted: true } });
  });
  await page.goto('/chat');
  await page.getByRole('button', { name: /Main talked with Scribe/ }).click();
  await expect(page.getByRole('region', { name: 'Permission for Scribe' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop run' }).click();
  await expect(page.getByText('Run: cancelled', { exact: true })).toBeVisible();
  expect(approved && stopped).toBe(true);
  expect(state.errors).toEqual([]);
});
