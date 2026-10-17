// Frontend boundary proof with synthetic API fixtures. This does not certify a live Gateway.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// playwright-core is a test-only dependency and is intentionally not part of the
// shipped web build. Resolve it from an explicit override or a local install.
const candidates = [
  process.env.HOB_UI_TEST_PLAYWRIGHT,
  fileURLToPath(new URL('../web/node_modules/playwright-core/package.json', import.meta.url)),
  fileURLToPath(new URL('../node_modules/playwright-core/package.json', import.meta.url)),
];
const playwright = candidates.find(candidate => candidate && existsSync(candidate));
if (!playwright) throw new Error('The frontend smoke needs playwright-core: install it with "npm install --no-save playwright-core" inside web/, or point HOB_UI_TEST_PLAYWRIGHT at its package.json.');
const { chromium } = createRequire(playwright)('playwright-core');
const baseURL = process.env.HOB_UI_TEST_URL || 'http://127.0.0.1:4180';
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.HOB_UI_TEST_BROWSER ? { executablePath: process.env.HOB_UI_TEST_BROWSER } : {}) });
const errors = [];
const requests = [];
const revision = 'c'.repeat(64);
const config = { skills: { workshop: {} } };
const proposal = { id: 'synthetic-proposal', status: 'pending', kind: 'create', description: 'Capture a safer report workflow', target: { skillName: 'report-workflow' } };
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/**', async route => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const data = request.method() === 'POST' || request.method() === 'PATCH' ? request.postDataJSON() : undefined;
  const fixtures = {
    '/api/auth/status': { authenticated: true, configured: true },
    '/api/readiness': { ready: true, status: 'ready' },
    '/api/sessions': [{ id: 'agent:main:synthetic', title: 'Synthetic conversation', createdAt: new Date(0).toISOString(), agentId: 'main' }],
    '/api/sessions/agent%3Amain%3Asynthetic/messages': [],
    '/api/agent': { id: 'main', name: 'hob', avatarUrl: '', status: 'connected' },
    '/api/tasks': [], '/api/security/approvals': [], '/api/stats': {},
    '/api/settings': { config, hash: 'synthetic-config-revision' },
    '/api/settings/schema': { schema: { type: 'object', properties: {} } },
  };
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: connection\ndata: {"connected":true}\n\n' });
  if (path === '/api/settings' && request.method() === 'PATCH') {
    requests.push({ path, data });
    assert.equal(data.baseHash, 'synthetic-config-revision');
    config.skills = data.patch.skills;
    return route.fulfill({ json: { ok: true } });
  }
  if (path === '/api/rpc') {
    requests.push(data);
    if (data.method === 'skills.proposals.list') return route.fulfill({ json: { proposals: [proposal] } });
    if (data.method === 'skills.proposals.inspect') return route.fulfill({ json: { record: proposal, revisionHash: revision, content: '---\nname: report-workflow\ndescription: Safely prepare reports.\n---\nRead source evidence before writing the final report.' } });
    if (data.method === 'skills.proposals.evaluate') return route.fulfill({ json: { record: proposal, evaluation: { status: 'completed' } } });
    if (data.method === 'skills.proposals.apply') return route.fulfill({ status: 409, json: { error: 'Proposal revision changed; inspect again.' } });
    return route.fulfill({ status: 403, json: { error: 'Unexpected synthetic RPC' } });
  }
  return fixtures[path] === undefined ? route.fulfill({ status: 404, json: { error: 'Unexpected synthetic route' } }) : route.fulfill({ json: fixtures[path] });
});
try {
  await page.goto(baseURL);
  await page.getByRole('heading', { name: /Leave the little things/ }).waitFor();
  assert.match(await page.title(), /^hob/);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Learning', exact: true }).click();
  const mode = value => page.locator(`input[name="learning-mode"][value="${value}"]`);
  assert.equal(await mode('propose').isChecked(), true);
  const policy = page.getByLabel('Model-requested lifecycle actions', { exact: false });
  assert.equal(await policy.inputValue(), 'pending');
  await mode('off').check();
  await mode('propose').check();
  assert.equal(await mode('auto').isChecked(), false);
  await mode('auto').check();
  assert.equal(await policy.inputValue(), 'pending');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('Settings saved. The gateway applies changes and may restart.').waitFor();
  const patch = requests.find(request => request.path === '/api/settings').data.patch;
  assert.equal(patch.skills.workshop.autonomous.mode, 'auto');
  assert.equal(patch.skills.workshop.approvalPolicy, undefined);
  await page.getByRole('button', { name: 'Workshop', exact: true }).click();
  await page.getByRole('button', { name: /Capture a safer report workflow/ }).click();
  const activate = page.getByRole('button', { name: 'Activate reviewed revision' });
  assert.equal(await activate.isDisabled(), true);
  const consent = page.getByRole('checkbox', { name: /I reviewed this exact revision/ });
  await consent.check();
  assert.equal(await activate.isEnabled(), true);
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await page.getByText('Validation finished. Review the updated results before activation.').waitFor();
  assert.equal(await activate.isDisabled(), true);
  await consent.check();
  await activate.click();
  await page.getByRole('alert').filter({ hasText: 'Proposal revision changed' }).waitFor();
  assert.equal(requests.filter(request => request.method === 'skills.proposals.apply').length, 1);
  for (const request of requests.filter(request => ['skills.proposals.apply', 'skills.proposals.evaluate'].includes(request.method))) {
    assert.deepEqual(request.params, { agentId: 'main', proposalId: proposal.id, expectedRevisionHash: revision });
  }
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.waitForURL('**/chat');
  await page.getByRole('heading', { name: /Leave the little things/ }).waitFor();
  await page.getByRole('button', { name: 'Chat', exact: true }).evaluate(button => {
    if (button.getAttribute('aria-current') !== 'page') throw new Error('Chat navigation did not settle.');
  });
  await mkdir('.tmp-ui', { recursive: true });
  await page.screenshot({ path: '.tmp-ui/hob-verified-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('heading', { name: /Leave the little things/ }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '.tmp-ui/hob-verified-mobile.png' });
  await context.unroute('**/api/**');
  await context.route('**/api/**', route => route.fulfill({ json: { authenticated: false, configured: true } }));
  await page.reload();
  await page.getByRole('heading', { name: 'A little more life.' }).waitFor();
  await page.screenshot({ path: '.tmp-ui/hob-verified-signin.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: branding, safe UI defaults, independent explicit auto opt-in, exact-revision Workshop validation/activation, stale rejection without retry, responsive layout, sign-in. Synthetic frontend boundary only.');
} finally { await browser.close(); }
