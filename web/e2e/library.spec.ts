import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const image = readFileSync(new URL('../../docs/assets/banner.png', import.meta.url)).toString('base64');
const notes = '# Launch report\n\nReady for review — مرحبا.\n\n<script>window.libraryUnsafe = true</script>';
async function fixture(page: Page) {
  const errors: string[] = [], reads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const profile = request.headers()['x-hob-profile'] || 'default';
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === '/api/auth/status') return json({ authenticated: true, configured: true });
    if (path === '/api/runtime') return json({ runtime: 'hermes' });
    if (path === '/api/readiness') return json({ ready: true, status: 'ready' });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: connection\ndata: {"connected":true}\n\n' });
    if (path === '/api/agents') return json({ agents: [{ id: 'default', name: 'Main' }, { id: 'writer', name: 'Writer' }] });
    if (path === '/api/agent') return json({ id: profile, name: profile === 'default' ? 'Main' : 'Writer', avatarUrl: '', status: 'connected' });
    if (path === '/api/sessions') return json([{ id: `session-${profile}`, agentId: profile, title: 'Library work', createdAt: '2026-10-27' }]);
    if (path.startsWith('/api/sessions/') && path.endsWith('/messages')) return json([]);
    if (path === '/api/tasks' || path === '/api/security/approvals') return json([]);
    if (path === '/api/stats') return json({ tokensUsed: 0 });
    if (path === '/api/hermes/workspace/files') {
      expect(url.searchParams.get('profile')).toBe(profile);
      if (profile === 'writer') return json({ entries: [{ name: 'Writer notes.txt', path: 'Writer notes.txt', directory: false, size: 40 }] });
      if (url.searchParams.get('path') === 'Research') return json({ entries: [{ name: 'Field notes.md', path: 'Research/Field notes.md', directory: false, size: 70 }] });
      return json({ entries: [
        { name: 'Research', path: 'Research', directory: true },
        { name: 'Launch moodboard.png', path: 'Launch moodboard.png', directory: false, size: 61024 },
        { name: 'Brand direction.png', path: 'Brand direction.png', directory: false, size: 22048 },
        { name: 'Launch report.md', path: 'Launch report.md', directory: false, size: 1200 },
        { name: 'Budget.csv', path: 'Budget.csv', directory: false, size: 4200 },
        { name: 'Website.tsx', path: 'Website.tsx', directory: false, size: 2300 },
        { name: 'Archive.zip', path: 'Archive.zip', directory: false, size: 18000 },
        { name: 'Oversized.pdf', path: 'Oversized.pdf', directory: false, size: 3000000 },
      ] });
    }
    if (path === '/api/hermes/workspace/file') {
      expect(url.searchParams.get('profile')).toBe(profile);
      const name = url.searchParams.get('path')!;
      reads.push(`${profile}:${name}`);
      if (name === 'Oversized.pdf') return route.fulfill({ status: 400, json: { error: 'Preview supports regular files up to 2 MB.' } });
      return json({ name: name.split('/').at(-1), size: 1200, mimeType: name.endsWith('.png') ? 'image/png' : 'text/plain', dataUrl: name.endsWith('.png') ? `data:image/png;base64,${image}` : `data:text/plain;base64,${Buffer.from(notes).toString('base64')}` });
    }
    errors.push(`Unexpected API: ${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: path } });
  });
  return { errors, reads };
}

test('Library is a spacious gallery with thumbnails, filters and focused previews', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/library');
  const library = page.getByRole('region', { name: 'File library' });
  await expect(library.getByRole('heading', { name: 'Your files' })).toBeVisible();
  await expect(page.getByLabel('Agent details', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Bots directory', { exact: true })).toHaveCount(0);
  await expect(library.getByRole('button', { name: 'Preview Launch moodboard.png', exact: true }).locator('img')).toBeVisible();
  const gallery = library.getByLabel('Library gallery');
  expect(await gallery.evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: 'test-results/library-gallery-desktop.png', fullPage: true });
  await library.getByRole('button', { name: 'Images', exact: true }).click();
  await expect(gallery.getByRole('button')).toHaveCount(2);
  const card = library.getByRole('button', { name: 'Preview Launch moodboard.png', exact: true });
  await card.click();
  const dialog = page.getByRole('dialog', { name: 'Launch moodboard.png', exact: true });
  await expect(dialog.getByRole('img', { name: 'Launch moodboard.png' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'Launch moodboard.png');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden(); await expect(card).toBeFocused();
  await library.getByRole('button', { name: 'Documents', exact: true }).click();
  await library.getByRole('textbox', { name: 'Search library' }).fill('Launch');
  await expect(gallery.getByRole('button')).toHaveCount(1);
  await library.getByRole('button', { name: 'Preview Launch report.md', exact: true }).click();
  const document = page.getByRole('dialog', { name: 'Launch report.md', exact: true });
  await expect(document.getByLabel('File contents')).toHaveText(notes);
  expect(await page.evaluate(() => Object.hasOwn(window, 'libraryUnsafe'))).toBe(false);
  await page.keyboard.press('Escape');
  await expect(library.getByRole('textbox', { name: 'Search library' })).toHaveValue('Launch');
  await expect(library.getByRole('button', { name: 'Documents', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(state.errors).toEqual([]);
});

test('Library folders, empty search, error states and bot scope work on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.goto('/library');
  const library = page.getByRole('region', { name: 'File library' });
  await library.getByRole('textbox', { name: 'Search library' }).fill('missing-file');
  await expect(library.getByText('No matching files')).toBeVisible();
  await library.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await library.getByRole('button', { name: 'Open folder Research', exact: true }).click();
  await expect(library.getByRole('button', { name: 'Preview Field notes.md', exact: true })).toBeVisible();
  await library.getByRole('navigation', { name: 'Library folders' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(library.getByRole('button', { name: 'Preview Brand direction.png', exact: true }).locator('img')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/library-gallery-mobile.png', fullPage: true });
  await library.getByRole('button', { name: 'Preview Oversized.pdf', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('up to 2 MB');
  await page.getByRole('button', { name: 'Close file preview', exact: true }).click();
  await page.getByRole('combobox', { name: 'Library bot', exact: true }).selectOption('writer');
  await expect(library.getByRole('button', { name: 'Preview Writer notes.txt', exact: true })).toBeVisible();
  await expect(library.getByRole('button', { name: 'Preview Launch report.md', exact: true })).toHaveCount(0);
  await library.getByRole('button', { name: 'Preview Writer notes.txt', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('File contents')).toContainText('Ready for review');
  expect(state.reads).toContain('writer:Writer notes.txt');
  expect(state.errors).toEqual([]);
});
