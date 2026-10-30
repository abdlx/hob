import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const image = readFileSync(new URL('../../docs/assets/banner.png', import.meta.url));
const stamp = '2026-10-27T10:00:00Z';
const code = 'const greeting = "Hello, مرحبا";\nconsole.log(greeting);';
const reply = 'Here is the launch direction.\n\n![Launch direction](/api/hermes/media?profile=default&path=launch.png)\n\n```javascript\n' + code + '\n```\n\n| Milestone | Status |\n| --- | --- |\n| Design | Ready |\n\n<script>window.chatUnsafe = true</script>';

async function fixture(page: Page, { long = false, question = false, brokenImage = false } = {}) {
  const errors: string[] = [], writes: { path: string; body: Record<string, unknown> }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let release: (() => void) | undefined;
  let run = question ? { runId: 'native-run', status: 'waiting_for_approval', revision: 'revision-1', questions: [{ id: 'question-1', generation: 1, question: 'Which direction should I use?', choices: ['Warm and expressive', 'Quiet and minimal'], multiSelect: false }], canRecover: false, canResolveUnknown: false } : null;
  const history = long ? Array.from({ length: 35 }, (_, index) => ({ id: `history-${index}`, role: index % 2 ? 'assistant' : 'user', content: `Earlier message ${index}. A detailed note about the launch, its milestones and next steps.\n\nKeep the details available for review.`, timestamp: stamp })) : [
    { id: 'user-1', role: 'user', content: 'Show the launch direction and the sample code.', timestamp: stamp },
    { id: 'assistant-1', role: 'assistant', content: reply, timestamp: stamp },
  ];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() });
    if (path === '/api/auth/status') return json({ authenticated: true, configured: true });
    if (path === '/api/runtime') return json({ runtime: 'hermes' });
    if (path === '/api/readiness') return json({ ready: true, status: 'ready' });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: connection\ndata: {"connected":true}\n\n' });
    if (path === '/api/agents') return json({ agents: [{ id: 'default', name: 'Main' }] });
    if (path === '/api/agent') return json({ id: 'default', name: 'Main', status: 'connected', avatarUrl: '' });
    if (path === '/api/sessions') return json([{ id: 'ux-session', agentId: 'default', title: 'Launch direction', createdAt: stamp }]);
    if (path === '/api/sessions/ux-session/messages') return json(history);
    if (path === '/api/sessions/ux-session/run') return json({ run });
    if (path === '/api/sessions/ux-session/attachments') {
      const file = request.postDataJSON();
      return json({ id: `ticket-${file.name}`, name: file.name, mime: file.mime, size: Buffer.from(file.base64, 'base64').length });
    }
    if (path === '/api/sessions/ux-session/clarify') { run = { ...run!, status: 'running', questions: [], revision: 'revision-2' }; return json({ ok: true }); }
    if (path === '/api/sessions/ux-session/abort') { run = { ...run!, status: 'stopping', revision: 'revision-3' }; return json({ ok: true }); }
    if (path === '/api/sessions/ux-session/turns') {
      await new Promise<void>(resolve => { release = resolve; });
      const message = { id: 'new-reply', role: 'assistant', content: 'The new reply is ready.', timestamp: stamp, status: 'complete' };
      history.push({ id: 'submitted-user', role: 'user', content: request.postDataJSON().content, timestamp: stamp }, message);
      return route.fulfill({ contentType: 'text/event-stream', body: `event: delta\ndata: ${JSON.stringify({ text: message.content })}\n\nevent: done\ndata: ${JSON.stringify({ message })}\n\n` });
    }
    if (path === '/api/hermes/media') {
      if (brokenImage) { brokenImage = false; return route.fulfill({ status: 404, headers: { 'Cache-Control': 'no-store' }, body: 'Image unavailable' }); }
      return route.fulfill({ contentType: 'image/png', headers: { 'Cache-Control': 'no-store' }, body: image });
    }
    if (path === '/api/hermes/groups') return json({ groups: [] });
    if (path === '/api/hermes/exchanges') return json({ exchanges: [], nextBefore: null });
    if (path === '/api/tasks' || path === '/api/security/approvals') return json([]);
    if (path === '/api/stats') return json({ tokensUsed: 0 });
    if (path === '/api/hermes/setup/audio/transcribe') return json({ transcript: 'Roman Urdu mein ek naya khayal.' });
    errors.push(`Unexpected API ${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: path } });
  });
  return { errors, writes, release: () => release?.(), submitted: () => Boolean(release) };
}

async function openChat(page: Page, mobile = false) {
  await page.goto('/chat');
  if (mobile) await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  else {
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    if (await page.getByRole('button', { name: 'Close agent panel', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close agent panel', exact: true }).click();
  }
}

test('native media appears in removable cards above the text field and attachment-only prompts carry session references', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.addInitScript(() => {
    Object.assign(window, { ReactNativeWebView: { postMessage: (raw: string) => {
      const request = JSON.parse(raw);
      if (request.type === 'pick-media') setTimeout(() => window.dispatchEvent(new CustomEvent('hob:native-response', { detail: { id: request.id, files: [
        { name: 'photo.png', mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1sAAAAASUVORK5CYII=' },
        { name: 'notes.txt', mime: 'text/plain', base64: 'bm90ZXM=' },
      ] } })), 0);
    } } });
  });
  await openChat(page, true);
  const composer = page.getByRole('form', { name: 'Message composer' });
  const initial = (await composer.boundingBox())!;
  await page.getByRole('button', { name: 'Add files or library', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'File library', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/chat-plus-menu-mobile.png', fullPage: true });
  await page.getByRole('menuitem', { name: 'Attach files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove attachment photo.png', exact: true })).toBeVisible();
  await expect(composer.getByText('notes.txt', { exact: true })).toBeVisible();
  expect((await composer.boundingBox())!.height).toBeGreaterThan(initial.height + 50);
  const input = (await page.getByRole('textbox', { name: 'Message', exact: true }).boundingBox())!;
  expect((await composer.getByText('notes.txt', { exact: true }).boundingBox())!.y).toBeLessThan(input.y);
  await page.screenshot({ path: 'test-results/chat-native-attachments-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Remove attachment notes.txt', exact: true }).click();
  await expect(composer.getByText('notes.txt', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(state.submitted).toBe(true);
  const submitted = state.writes.find(write => write.path.endsWith('/turns'))!;
  expect(submitted.body.content).toBe('Please review the attached files.');
  expect(submitted.body.attachments).toEqual(['ticket-photo.png']);
  await expect(page.getByRole('button', { name: 'Remove attachment photo.png', exact: true })).toBeHidden();
  state.release();
  await expect(page.getByRole('region', { name: 'Conversation messages' }).getByText('The new reply is ready.', { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test('voice requires recording and upload actions, inserts an editable draft, and releases the microphone', async ({ page }) => {
  const state = await fixture(page);
  await page.addInitScript(() => {
    Object.assign(window, { microphoneStarts: 0, microphoneStops: 0 });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
      Object.assign(window, { microphoneStarts: (window as unknown as { microphoneStarts: number }).microphoneStarts + 1 });
      return { getTracks: () => [{ stop: () => Object.assign(window, { microphoneStops: (window as unknown as { microphoneStops: number }).microphoneStops + 1 }) }] };
    } } });
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: class {
      static isTypeSupported() { return true; }
      mimeType = 'audio/webm'; state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['synthetic audio bytes'], { type: this.mimeType }) }); this.onstop?.(); }
    } });
  });
  await openChat(page);
  await page.getByRole('button', { name: 'Voice input', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { microphoneStarts: number }).microphoneStarts)).toBe(0);
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByText('Microphone is recording.', { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByRole('button', { name: 'Transcribe recording' })).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.getByRole('button', { name: 'Transcribe recording' }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Roman Urdu mein ek naya khayal.');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].path).toBe('/api/hermes/setup/audio/transcribe');
  expect(state.writes[0].body.confirm).toBe(true);
  await page.getByRole('button', { name: 'Voice input', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('button', { name: 'Cancel voice input' }).click();
  expect(await page.evaluate(() => (window as unknown as { microphoneStops: number }).microphoneStops)).toBe(2);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Roman Urdu mein ek naya khayal.');
  expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Voice input', exact: true }).click();
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Microphone denied', 'NotAllowedError'); }; });
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone denied');
  expect(state.errors).toEqual([]);
});

test('repeated image directives render once while distinct result images remain available', async ({ page }) => {
  const state = await fixture(page);
  await page.route('**/api/sessions/ux-session/messages', route => route.fulfill({ json: [{ id: 'images', role: 'assistant', timestamp: stamp, content: 'MEDIA: /tmp/launch.png\n\n![Repeated](/tmp/launch.png)\n\n@image: /tmp/launch.png\n\n![Another](/tmp/other.png)' }] }));
  await openChat(page);
  const messages = page.getByRole('region', { name: 'Conversation messages' });
  await expect(messages.getByRole('img')).toHaveCount(2);
  expect(state.errors).toEqual([]);
});

test('a cancelled native picker releases the composer without staging files', async ({ page }) => {
  const state = await fixture(page);
  await page.addInitScript(() => {
    Object.assign(window, { ReactNativeWebView: { postMessage: (raw: string) => {
      const request = JSON.parse(raw);
      setTimeout(() => window.dispatchEvent(new CustomEvent('hob:native-response', { detail: { id: request.id, files: [] } })), 0);
    } } });
  });
  await openChat(page);
  await page.getByRole('button', { name: 'Add files or library', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Attach files', exact: true }).click();
  await expect(page.getByText('Adding attachments…', { exact: true })).toBeHidden();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Still ready');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test('a notification opens its verified conversation from the mobile bot directory', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('dialog', { name: 'Conversations', exact: true }).getByRole('button', { name: 'Bots', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ has: page.getByText('Main', { exact: true }) })).toBeVisible();
  await page.evaluate(() => {
    window.__hobPendingConversation = { profile: 'default', sessionKey: 'ux-session' };
    window.dispatchEvent(new Event('hob:open-conversation'));
  });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversation messages' }).getByText('Show the launch direction and the sample code.', { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test('image previews stay in chat, contain keyboard focus, zoom and restore focus; code copies exact text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const state = await fixture(page);
  await openChat(page);
  const preview = page.getByRole('button', { name: 'Preview image: Launch direction', exact: true });
  await preview.click();
  const dialog = page.getByRole('dialog', { name: 'Launch direction', exact: true });
  await expect(dialog.getByRole('img', { name: 'Launch direction' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close image preview' })).toBeFocused();
  await expect(dialog.getByRole('link', { name: 'Download image' })).toHaveAttribute('download', 'Launch direction');
  await dialog.getByRole('button', { name: 'Actual size' }).click();
  await expect(dialog.getByRole('button', { name: 'Fit to screen' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('link', { name: 'Download image' }).focus(); await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close image preview' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(preview).toBeFocused();
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(code);
  expect(await page.evaluate(() => Object.hasOwn(window, 'chatUnsafe'))).toBe(false);
  await page.screenshot({ path: 'test-results/chat-ux-desktop.png', fullPage: true });
  expect(state.errors).toEqual([]);
});

test('typing stays available during a reply, drafts survive and new content respects a reader scrolled up', async ({ page }) => {
  const state = await fixture(page, { long: true });
  await openChat(page);
  const chat = page.getByRole('region', { name: 'Conversation messages', exact: true });
  await expect.poll(() => chat.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(100);
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Send this first'); await input.press('Enter');
  await expect.poll(state.submitted).toBe(true);
  await expect(input).toBeEnabled(); await input.fill('A draft for later');
  await expect(page.getByRole('button', { name: 'Waiting for current reply' })).toBeDisabled();
  await chat.evaluate(node => { node.scrollTop = 200; });
  const latest = page.getByRole('button', { name: 'Latest messages' });
  await expect(latest).toBeVisible();
  const before = await chat.evaluate(node => node.scrollTop);
  state.release();
  await expect(chat.getByText('The new reply is ready.', { exact: true })).toBeAttached();
  await expect(input).toHaveValue('A draft for later');
  expect(Math.abs(await chat.evaluate(node => node.scrollTop) - before)).toBeLessThan(10);
  await latest.click(); await expect(latest).toBeHidden();
  await expect(chat.getByText('The new reply is ready.', { exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  // This is the same mounted app: responsive layouts must share one draft.
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('A draft for later');
  expect(state.writes.filter(write => write.path.endsWith('/turns'))).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test('inline question choices show selection, require confirmation, and expose the native stop action', async ({ page }) => {
  const state = await fixture(page, { question: true });
  await openChat(page);
  const question = page.getByRole('region', { name: 'Your input needed', exact: true });
  await expect(question.getByRole('button', { name: 'Send answer' })).toBeInViewport();
  const choice = question.getByRole('button', { name: 'Quiet and minimal', exact: true });
  await choice.click(); await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await expect(question.getByRole('button', { name: 'Send answer' })).toBeInViewport();
  await page.screenshot({ path: 'test-results/chat-question-desktop.png', fullPage: true });
  expect(state.writes).toHaveLength(0);
  await question.getByRole('button', { name: 'Send answer' }).click();
  await expect(question).toBeHidden();
  expect(state.writes[0]).toEqual({ path: '/api/sessions/ux-session/clarify', body: { promptId: 'question-1', expectedRevision: 'revision-1', answer: 'Quiet and minimal' } });
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stopping…', exact: true })).toBeDisabled();
  expect(state.writes[1]).toEqual({ path: '/api/sessions/ux-session/abort', body: { expectedRunId: 'native-run' } });
  expect(state.errors).toEqual([]);
});

test('mobile dock has accessible icon labels, gives space to drafting and image previews fit the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await fixture(page);
  await openChat(page, true);
  const dock = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(dock.getByRole('button', { name: 'Library', exact: true })).toHaveAccessibleName('Library');
  await expect(dock.getByRole('button')).toHaveCount(5);
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Keep this draft\nwith another line');
  await expect(dock).toBeHidden();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dock).toBeVisible(); await expect(input).toHaveValue('Keep this draft\nwith another line');
  await page.getByRole('button', { name: 'Preview image: Launch direction', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Launch direction', exact: true });
  await expect(dialog.getByRole('img')).toBeVisible();
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/chat-image-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/chat-ux-mobile.png', fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: 'test-results/chat-ux-mobile-dark.png', fullPage: true });
  expect(state.errors).toEqual([]);
});

test('failed image and clipboard operations show useful feedback and image retry recovers', async ({ page }) => {
  const state = await fixture(page, { brokenImage: true });
  await openChat(page);
  await expect(page.getByText('Launch direction is unavailable.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Retry image', exact: true }).click();
  const preview = page.getByRole('button', { name: 'Preview image: Launch direction', exact: true });
  await expect(preview.locator('img')).toBeVisible();
  await expect(preview.locator('img')).toHaveJSProperty('naturalWidth', 1600);
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { value: () => Promise.reject(new DOMException('Clipboard unavailable', 'NotAllowedError')) }); });
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy failed. Select the text to copy it.', exact: true })).toHaveText('Copy failed');
  await expect(page.getByRole('region', { name: 'Conversation messages' }).getByText('console.log(greeting);', { exact: false })).toBeVisible();
  expect(state.errors).toEqual([]);
});
