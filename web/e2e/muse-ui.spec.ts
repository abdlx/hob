import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Explicit API fixtures exercise the production UI without changing a user's bots.
const orbitAvatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#478a96"/><circle cx="40" cy="40" r="20" fill="#f6dfb9"/></svg>');
const image = readFileSync(new URL('../public/brand/hob-mark.png', import.meta.url)).toString('base64');
async function fixture(page: Page) {
  const errors: string[] = [], writes: string[] = [];
  const sessions = [{ id: 'reference-session', agentId: 'default', title: 'HyperFrames test', transport: 'canonical', createdAt: '2026-10-30T09:00:00Z' }];
  const jobs = [
    { id: 'study', name: 'ACCA FA1 and MA1 7-week study push', prompt: 'Pace is now at risk: keep making progress through November 6.', schedule: '0 9 * * *', enabled: true, next_run_at: '2026-10-31T09:08:00+05:00' },
    { id: 'film', name: 'Watermelon Hulk vs. Banana prison mess hall film', prompt: 'Part 2 prompt pack is built and Clip 1 accepted as generated.', schedule: '0 10 * * *', enabled: true },
    { id: 'book', name: 'BookStore Flutter merge and Drive delivery', prompt: 'Final project is on main and the Drive zip is shared.', schedule: '0 11 * * *', enabled: true },
  ];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
    if (path === '/api/auth/status') return json({ authenticated: true, configured: true });
    if (path === '/api/runtime') return json({ runtime: 'hermes' });
    if (path === '/api/readiness') return json({ ready: true, status: 'ready' });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: connection\ndata: {"connected":true}\n\n' });
    if (path === '/api/agents') return json({ agents: [{ id: 'default', name: 'Aster', avatarUrl: '/brand/hob-mark.png' }, { id: 'orbit', name: 'Orbit', avatarUrl: orbitAvatar }] });
    if (path === '/api/agent') { const orbit = request.headers()['x-hob-profile'] === 'orbit'; return json({ id: orbit ? 'orbit' : 'default', name: orbit ? 'Orbit' : 'Aster', status: 'connected', avatarUrl: orbit ? orbitAvatar : '/brand/hob-mark.png' }); }
    if (path === '/api/sessions') {
      const profile = request.headers()['x-hob-profile'] || 'default';
      if (request.method() === 'POST') {
        const session = { id: 'created-session', agentId: profile, title: request.postDataJSON().title, transport: 'canonical', createdAt: '2026-10-30T10:00:00Z' };
        sessions.unshift(session);
        return json(session);
      }
      return json(sessions.map(session => ({ ...session, agentId: profile })));
    }
    if (path === '/api/sessions/created-session/messages') return json([]);
    if (path.endsWith('/messages')) return json([{ id: 'reply', role: 'assistant', content: 'What this proves: the render works end to end here, with frame-accurate animation and encoding.\n\nWhat it doesn’t prove: anything about a real production film. This is a small test with generic text.\n\nWhat next?', timestamp: '2026-10-30T09:18:00Z' }]);
    if (path.endsWith('/run')) return json({ run: null });
    if (path === '/api/tasks') return json([
      { id: '1', title: 'Set up HyperFrames test project', subtitle: 'Preparing headless browser to render scene', timestamp: '9:18am', status: 'in_progress', group: 'Today' },
      { id: '2', title: 'Check HyperFrames on VM', subtitle: 'Checking browser setup in HyperFrames test project', timestamp: '9:13am', status: 'in_progress', group: 'Today' },
      { id: '3', title: 'Check logged study minutes', subtitle: 'No logged study minutes found for FA1', timestamp: '9:12am', status: 'completed', group: 'Today' },
      { id: '4', title: 'Compare Professor to Grok bot', subtitle: 'Recorded Hob live test and Professor probes', timestamp: '1:31am', status: 'completed', group: 'Today' },
    ]);
    if (path === '/api/security/approvals') return json([{ id: 'approval', type: 'credential', description: 'Fill saved credentials in Browser', requestedAt: '2026-10-30T01:00:00Z', riskLevel: 'low', status: 'approved' }]);
    if (path === '/api/stats') return json({ tokensUsed: 0 });
    if (path === '/api/hermes/groups') return json({ groups: [] });
    if (path === '/api/hermes/exchanges') return json({ exchanges: [], nextBefore: null });
    if (path === '/api/hermes/workspace/jobs') return json(jobs);
    if (path === '/api/hermes/workspace/skills') return json([]);
    if (path === '/api/hermes/workspace/reviews/skills') return json({ items: [], nextOffset: null });
    if (path.endsWith('/study/pause')) { jobs[0].enabled = false; return json({ ok: true }); }
    if (path === '/api/hermes/workspace/learning') return json({ nodes: [] });
    if (path === '/api/hermes/workspace/soul') return json({ content: '# Soul\nBe thoughtful and helpful.' });
    if (path === '/api/hermes/workspace/files') return json({ entries: [
      { name: 'FA1_Kaplan_Exam_Kit_2025-26.md', path: 'kit.md', directory: false, size: 200 },
      { name: 'FA1_BPP_Study_Text.md', path: 'text.md', directory: false, size: 200 },
      { name: 'FA1-Study-Journal.html', path: 'journal.html', directory: false, size: 200 },
      ...Array.from({ length: 15 }, (_, index) => ({ name: `Media ${index + 1}.png`, path: `image-${index}.png`, directory: false, size: 200 })),
    ] });
    if (path === '/api/hermes/workspace/file') return json(url.searchParams.get('path')?.endsWith('.png')
      ? { mimeType: 'image/png', dataUrl: `data:image/png;base64,${image}` }
      : { mimeType: 'text/plain', dataUrl: `data:text/plain;base64,${Buffer.from('# Study material').toString('base64')}` });
    // Settings home retains its scoped forms while the mobile directory is open.
    if (path === '/api/hermes/profiles') return json({ profiles: [{ name: 'default' }] });
    if (path === '/api/hermes/config') return json({ model: 'test-model' });
    if (path === '/api/hermes/config/schema') return json({ fields: {} });
    if (path === '/api/hermes/credentials') return json({});
    if (path === '/api/hermes/saved-providers') return json({ connections: [], unavailableProfiles: [] });
    if (path === '/api/hermes/setup/accounts' || path === '/api/hermes/setup/providers') return json({ providers: [] });
    if (path === '/api/hermes/setup/models') return json({ providers: [], model: '', provider: '' });
    if (path === '/api/hermes/setup/preferences') return json({ language: 'auto', timezone: 'Asia/Karachi' });
    errors.push(`Unexpected API ${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: path } });
  });
  return { errors, writes };
}

test.use({ viewport: { width: 393, height: 800 } });

test('the new conversation action creates one session and the unified sidebar lists it', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  const create = page.getByRole('button', { name: 'New conversation', exact: true });
  await expect(create).toBeEnabled();
  await expect(create).toHaveCount(1);
  await create.click();
  await expect(page.getByRole('heading', { name: 'What can I help you with?' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const sidebar = page.getByRole('dialog', { name: 'Conversations', exact: true });
  await expect(sidebar).toHaveCount(1);
  await expect(sidebar.getByRole('button', { name: 'New Chat', exact: true })).toHaveCount(0);
  await expect(sidebar.getByText('New Conversation', { exact: true })).toBeVisible();
  expect(state.writes).toEqual(['POST /api/sessions']);
  expect(state.errors).toEqual([]);
});

test('one bottom bar keeps the same bounds across every tab and chat mounts only one composer', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  const dock = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  for (const viewport of [{ width: 393, height: 800 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    const original = (await dock.boundingBox())!;
    for (const label of ['Activity', 'Workshop', 'Goals', 'Library', 'Chat']) {
      await dock.getByRole('button', { name: label, exact: true }).click();
      await expect(dock.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('.hob-mobile-dock')).toHaveCount(1);
      const bounds = (await dock.boundingBox())!;
      expect(bounds.height).toBe(72);
      expect(bounds.y).toBe(original.y);
      expect(bounds.y + bounds.height).toBe(viewport.height);
      expect(bounds.width).toBe(viewport.width);
    }
    await expect(page.locator('textarea[aria-label="Message"]')).toHaveCount(1);
  }
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft through a layout change');
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.locator('textarea[aria-label="Message"]')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Keep this draft through a layout change');
  await page.getByRole('button', { name: 'Show bots', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create new bot', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'New Bot', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Manage in Settings', exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test('settings exposes every original category once using grouped rows', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/settings');
  const categories = page.getByRole('navigation', { name: 'Settings categories' });
  await expect(categories.getByRole('button')).toHaveCount(11);
  for (const label of ['General', 'Models & providers', 'Agents & bots', 'Tools & computer', 'Plugins & integrations', 'Skills', 'Memory & history', 'Learning & approvals', 'Automation', 'Channels & messaging', 'Advanced configuration']) {
    await expect(categories.getByRole('button', { name: label, exact: true })).toHaveCount(1);
  }
  await expect(page.getByRole('button', { name: 'Connectors', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Secure credentials store', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/settings-original-categories-mobile.png' });
  await categories.getByRole('button', { name: 'General', exact: true }).click();
  await expect(categories).toBeHidden();
  await expect(page.getByRole('group', { name: 'Color theme' })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(categories).toBeVisible();
  await expect(categories.getByRole('button')).toHaveCount(11);
  expect(state.errors).toEqual([]);
});

test('each screen uses the selected bot identity and the avatar sits in front of its tag', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  const profile = page.locator('.hob-reference-header .hob-profile-button').filter({ visible: true });
  await expect(profile).toHaveText('Aster');
  await expect(profile.locator('img')).toHaveAttribute('src', '/brand/hob-mark.png');
  expect(await profile.evaluate(node => {
    const avatar = node.firstElementChild!, tag = node.lastElementChild!;
    const imageBounds = avatar.getBoundingClientRect(), tagBounds = tag.getBoundingClientRect();
    const nameBounds = tag.firstElementChild!.getBoundingClientRect();
    return Number(getComputedStyle(avatar).zIndex) > Number(getComputedStyle(tag).zIndex)
      && imageBounds.bottom > tagBounds.top && imageBounds.bottom <= nameBounds.top;
  })).toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('dialog', { name: 'Conversations', exact: true }).getByRole('button', { name: 'Bots', exact: true }).click();
  await page.getByRole('listitem').filter({ has: page.getByText('Orbit', { exact: true }) }).click();
  await expect(profile).toHaveText('Orbit');
  await expect(profile.locator('img')).toHaveAttribute('src', orbitAvatar);
  await profile.click();
  const panel = page.getByRole('complementary', { name: 'Agent details', exact: true });
  await expect(panel.getByRole('heading', { name: 'Orbit', exact: true })).toBeVisible();
  await expect(panel.locator('.hob-agent-profile img')).toHaveAttribute('src', orbitAvatar);
  await panel.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Library', exact: true }).click();
  await expect(profile).toHaveText('Orbit');
  await expect(profile.locator('img')).toHaveAttribute('src', orbitAvatar);
  await page.screenshot({ path: 'test-results/muse-selected-bot.png' });
  expect(state.errors).toEqual([]);
});

test('reference chat and every agent tab fit the phone and retain their data', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dock = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(dock.getByRole('button')).toHaveCount(5);
  await expect(dock.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(await page.locator('.hob-round-button').first().evaluate(node => node.getBoundingClientRect().width)).toBe(46);
  await page.screenshot({ path: 'test-results/muse-chat.png' });
  await page.getByRole('button', { name: 'Open agent details and activity', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Agent details', exact: true });
  await expect(panel.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(panel.getByText('Preparing headless browser to render scene')).toBeVisible();
  await page.screenshot({ path: 'test-results/muse-agent-activity.png' });
  for (const [tab, heading, file] of [
    ['Approvals', 'Approvals history', 'approvals'], ['Browser', '', 'browser'],
    ['Scheduled tasks', 'Daily', 'schedules'], ['Identity', 'Aster', 'identity'],
  ]) {
    await panel.getByRole('tab', { name: tab, exact: true }).click();
    await expect(panel.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    if (heading) await expect(panel.getByRole('tabpanel').getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/muse-agent-${file}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Bot photo', exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('goals use real scoped pause actions and category creation opens a usable editor', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/goals');
  await expect(page.getByRole('heading', { name: 'Goals', exact: true })).toBeVisible();
  await expect(page.getByText('Pace is now at risk:', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'test-results/muse-goals.png' });
  await page.getByRole('button', { name: 'Pause ACCA FA1 and MA1 7-week study push', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume ACCA FA1 and MA1 7-week study push', exact: true })).toBeVisible();
  expect(state.writes).toEqual(['POST /api/hermes/workspace/jobs/study/pause']);
  await page.getByRole('button', { name: 'Health', exact: true }).click();
  await expect(page.getByLabel('Goal name', { exact: true })).toHaveValue('Health');
  await expect(page.getByRole('button', { name: 'Save goal', exact: true })).toBeDisabled();
  expect(state.errors).toEqual([]);
});

test('artifact and media tabs support previews, overflow tools, scrolling and navigation', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/library');
  await expect(page.getByRole('tab', { name: 'Artifacts', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Open agent details and activity', exact: true })).toBeVisible();
  await expect(page.locator('button[aria-label="Preview FA1_Kaplan_Exam_Kit_2025-26.md"]')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/muse-artifacts.png' });
  await page.getByRole('button', { name: 'Preview FA1_Kaplan_Exam_Kit_2025-26.md', exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole('dialog').getByLabel('File contents')).toHaveText('# Study material');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Media', exact: true }).click();
  await expect(page.locator('.hob-media-grid img').first()).toBeVisible();
  expect(await page.locator('.hob-media-grid').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(3);
  await page.screenshot({ path: 'test-results/muse-media.png' });
  await page.getByRole('button', { name: 'Preview Media 1.png', exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Library options', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Search library' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Goals' }).click();
  await expect(page).toHaveURL(/\/goals$/);
  expect(state.errors).toEqual([]);
});

test('settings directory opens appearance, returns home, and preserves the five-tab navigation', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/chat');
  const dock = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(dock.getByRole('button')).toHaveCount(5);
  await expect(dock.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const sidebar = page.getByRole('dialog', { name: 'Conversations', exact: true });
  const sidebarSettings = sidebar.getByRole('button', { name: 'Settings', exact: true });
  await expect(sidebarSettings).toBeVisible();
  expect((await sidebarSettings.boundingBox())!.y).toBeGreaterThan(700);
  await page.screenshot({ path: 'test-results/muse-sidebar.png' });
  await sidebarSettings.click();
  await expect(page.getByRole('button', { name: 'Plugins & integrations', exact: true })).toBeVisible();
  await page.goBack();
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const conversations = page.getByRole('dialog', { name: 'Conversations', exact: true });
  const conversationSettings = conversations.getByRole('button', { name: 'Settings', exact: true });
  await expect(conversationSettings).toBeVisible();
  expect((await conversationSettings.boundingBox())!.y).toBeGreaterThan(700);
  await conversationSettings.click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.goBack();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await sidebar.getByRole('button', { name: 'Bots', exact: true }).click();
  const botSettings = page.locator('.hob-bots-settings').filter({ visible: true });
  await expect(botSettings).toBeVisible();
  const bounds = (await botSettings.boundingBox())!;
  expect(bounds.y).toBeLessThan(80);
  expect(bounds.x).toBeGreaterThan(300);
  await page.screenshot({ path: 'test-results/muse-bots.png' });
  await botSettings.click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.screenshot({ path: 'test-results/muse-settings.png' });
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Color theme' })).toBeVisible();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Plugins & integrations', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});
