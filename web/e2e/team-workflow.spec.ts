import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll } from './mobile-layout';

async function fixture(page: Page) {
  const errors: string[] = [], writes: { path: string; body: Record<string, unknown> }[] = [];
  let stale = false, unavailable = false, boardUnavailable = false, read = false;
  const task = { id: 'report-1', owner: 'writer', title: 'Checked launch report', outcome: 'A checked launch report', output: 'none', status: 'review_pending', nativeStatus: 'completed', verification: 'unproven', revision: 3, steps: [{ title: 'Write', status: 'done' }, { title: 'Verify', status: 'done' }], exchangeId: 'exchange-1', result: 'TASK report-1 — DONE\nRESULT: The launch report is ready.\nFILES: none\nVERIFICATION: Checked the two requested sections\nBLOCKERS: none\nPROMOTE: none' };
  const followup = { id: 'followup-1', owner: 'default', title: 'Confirm delivery', outcome: 'Confirm whether the report was delivered', deadline: null, revision: 1, status: 'draft', lastChecked: null, source: { kind: 'thread' } };
  const candidate = { id: 'candidate-1', owner: 'writer', fact: 'The launch plan uses two phases', evidence: 'Reviewed report, observed today', status: 'pending', revision: 1, tier: 'tier1', conflicts: ['The launch plan previously used three phases'] };
  let preferences = { revision: 0, dailyCap: 3, timezone: 'UTC', quietStart: '22:00', quietEnd: '08:00', neverOffer: [] as string[], delivery: 'hob', maintenance: true };
  const state = () => ({ enabled: true, tasks: [task], followups: [followup], candidates: [candidate], preferences, maintenance: { day: '2026-11-08', staleCandidates: 0 } });
  page.on('pageerror', cause => errors.push(cause.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === '/api/auth/status') return json({ authenticated: true, configured: true });
    if (path === '/api/runtime') return json({ runtime: 'hermes' });
    if (path === '/api/readiness') return json({ ready: true, status: 'ready' });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: connection\ndata: {"connected":true}\n\n' });
    if (path === '/api/agents') return json({ agents: [{ id: 'default', name: 'Main' }, { id: 'writer', name: 'Scribe' }] });
    if (path === '/api/agent') return json({ id: 'default', name: 'Main', status: 'connected', avatarUrl: '' });
    if (path === '/api/sessions') return json([{ id: 'main-chat', agentId: 'default', title: 'Launch work' }]);
    if (path.endsWith('/messages') || path === '/api/tasks' || path === '/api/security/approvals') return json([]);
    if (path.endsWith('/run')) return json({ run: null });
    if (path === '/api/stats') return json({ tokensUsed: 0 });
    if (path === '/api/hermes/groups') return json({ groups: [] });
    if (path === '/api/hermes/exchanges' || path.startsWith('/api/hermes/exchanges/threads')) return json({ exchanges: [], nextBefore: null });
    if (path === '/api/hermes/team') return json({ core: { revision: 0, content: '' } });
    if (path === '/api/hermes/team/work/inbox') {
      if (unavailable) return route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' });
      return json({ items: [{ id: 'notice-1', title: 'Report reviewed', message: 'Main reviewed the assigned output snapshot.', createdAt: Date.parse('2026-11-08T12:00:00Z'), verification: 'coordinator-reviewed', taskId: task.id, output: 'artifacts/report.pdf', ...(read ? { acknowledgedAt: 1 } : {}) }] });
    }
    if (path === '/api/hermes/team/work/episodes') return json({ items: [{ id: 'lesson-1', summary: `${url.searchParams.get('profile')} private work lesson`, evidence: 'Own task', createdAt: Date.parse('2026-11-08T12:00:00Z') }] });
    if (path === '/api/hermes/team/work' && request.method() === 'GET') return boardUnavailable ? route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' }) : json(state());
    if (path.startsWith('/api/hermes/team/work/') && request.method() === 'POST') {
      const body = request.postDataJSON(); writes.push({ path, body });
      if (stale) { stale = false; task.revision++; return json({ error: 'This item changed. Review its current revision.' }, 409); }
      if (path.endsWith('/text-review')) { task.status = 'done'; task.verification = 'operator-reviewed'; task.revision++; }
      else if (path.endsWith('/followups/decide')) { followup.status = body.decision === 'dismiss' ? 'closed' : 'open'; followup.revision++; }
      else if (path.endsWith('/candidates/decide')) { candidate.status = 'staged'; candidate.revision++; }
      else if (path.endsWith('/preferences')) { preferences = { ...preferences, ...body, revision: preferences.revision + 1 }; }
      else if (path.endsWith('/inbox/read')) read = true;
      else errors.push(`Unexpected mutation: ${path}`);
      return json({ ok: true });
    }
    if (path === '/api/hermes/browser' || path === '/api/hermes/browser/diagnose') return json({ state: 'stopped', available: false, tabs: [], control: { holder: 'agent', pending: 0 }, binding: { configured: false } });
    if (path === '/api/hermes/browser/activity') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (path === '/api/hermes/agent-computer/status') return json({ configured: false, connected: false });
    errors.push(`Unexpected API ${request.method()} ${path}`); return json({ error: path }, 404);
  });
  return { errors, writes, staleOnce: () => { stale = true; }, unavailable: (value: boolean) => { unavailable = value; }, boardUnavailable: (value: boolean) => { boardUnavailable = value; } };
}

test('task board separates native completion from reviewed delivery and handles stale decisions', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/activity');
  await page.getByRole('button', { name: 'Open team workspace' }).click();
  const workspace = page.getByRole('region', { name: 'HOB team workspace' });
  await expect(workspace.getByText('review pending', { exact: true })).toBeVisible();
  await workspace.getByText('Worker result · self-reported until reviewed').click();
  await expect(workspace.getByText(/RESULT: The launch report is ready/)).toBeVisible();
  const review = workspace.getByRole('button', { name: 'I checked this text result; mark reviewed' });
  await expect(review).toBeDisabled();
  await workspace.getByLabel('Review evidence for Checked launch report').fill('I read the result and checked both requested sections.');
  state.staleOnce(); await review.click();
  await expect(workspace.getByRole('alert')).toContainText('item changed');
  expect(state.writes).toHaveLength(1);
  await workspace.getByRole('button', { name: 'Refresh team workspace' }).click(); await review.click();
  await expect(workspace.getByText('done', { exact: true })).toBeVisible();
  expect(state.writes[1].body.revision).toBe(4); expect(state.writes[1].body.confirm).toBe(true);
  expect(state.errors).toEqual([]);
});

test('commitment approval, memory staging and delivery preferences work on a narrow screen', async ({ page }) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 320, height: 820 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/activity'); await page.getByRole('button', { name: 'Open team workspace' }).click();
  const workspace = page.getByRole('region', { name: 'HOB team workspace' });
  await workspace.getByRole('tab', { name: 'Follow-ups', exact: true }).click();
  const approve = workspace.getByRole('button', { name: 'Approve commitment' }); await expect(approve).toBeDisabled();
  await workspace.getByLabel('Current-state evidence').fill('Checked the current delivery state just now.'); await approve.click();
  await expect(workspace.getByRole('button', { name: 'I checked: still open' })).toBeVisible();
  await workspace.getByRole('tab', { name: 'Memory', exact: true }).click();
  await expect(workspace.getByText('default private work lesson')).toBeVisible();
  await expect(workspace.getByText(/Possible overlap with current core/)).toBeVisible();
  await workspace.getByRole('button', { name: 'Stage for core review' }).click();
  await expect(workspace.getByRole('button', { name: 'Stage for core review' })).toHaveCount(0);
  expect(state.writes.some(write => write.path.endsWith('/decisions'))).toBe(false);
  await workspace.getByRole('tab', { name: 'Delivery preferences' }).click();
  await workspace.getByLabel('Timezone', { exact: true }).fill('Asia/Karachi'); await workspace.getByLabel('Daily delivery cap').fill('2');
  await workspace.getByRole('button', { name: 'Save delivery preferences' }).click();
  await expect(workspace.getByLabel('Timezone', { exact: true })).toHaveValue('Asia/Karachi');
  const saved = state.writes.at(-1)!; expect(saved.body).toMatchObject({ revision: 0, dailyCap: 2, timezone: 'Asia/Karachi', confirm: true });
  expect(saved.body.delivery).toBeUndefined(); expect(saved.body.maintenance).toBeUndefined();
  await expectNoHorizontalScroll(page); expect(state.errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('team-workspace-mobile.png'), fullPage: true });
});

test('a team refresh outage preserves tasks and shows a neutral recovery state without sending work again', async ({ page }) => {
  const state = await fixture(page); await page.goto('/activity');
  await page.getByRole('button', { name: 'Open team workspace' }).click();
  const workspace = page.getByRole('region', { name: 'HOB team workspace' });
  await expect(workspace.getByRole('heading', { name: 'Checked launch report' })).toBeVisible();
  state.boardUnavailable(true);
  await page.evaluate(() => window.dispatchEvent(new Event('hob:team-changed')));
  await expect(workspace.getByRole('status')).toHaveText('Reconnecting to team state. Your tasks remain in place.');
  await expect(workspace.getByRole('heading', { name: 'Checked launch report' })).toBeVisible();
  await expect(workspace.getByRole('alert')).toHaveCount(0); expect(state.writes).toEqual([]);
  state.boardUnavailable(false); await page.evaluate(() => window.dispatchEvent(new Event('hob:team-changed')));
  await expect(workspace.getByText('Reconnecting to team state. Your tasks remain in place.')).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test('HOB inbox preserves read state across reload and recovers gracefully from a gateway error', async ({ page }) => {
  const state = await fixture(page); await page.goto('/chat');
  const inbox = page.getByRole('region', { name: 'HOB inbox' });
  await inbox.getByRole('button', { name: 'HOB inbox · 1 unread' }).click();
  await expect(inbox.getByText('Main reviewed the assigned output snapshot.')).toBeVisible();
  await expect(inbox.getByRole('link', { name: 'Download reviewed output' })).toHaveAttribute('href', '/api/hermes/team/work/output/report-1');
  await inbox.getByRole('button', { name: 'Mark read' }).click();
  await expect(inbox.getByRole('button', { name: 'HOB inbox · 0 unread' })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'HOB inbox · 0 unread' })).toBeVisible();
  state.unavailable(true); await page.reload();
  await page.getByRole('button', { name: 'HOB inbox · 0 unread' }).click();
  await expect(inbox.getByRole('status')).toHaveText('Inbox will refresh when the connection returns.');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  state.unavailable(false); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(inbox.getByText('Main reviewed the assigned output snapshot.')).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.writes).toHaveLength(1);
});
