import { expect, type Page } from '@playwright/test';

// Check inner scroll panels too: the fixed app shell can conceal their overflow.
export async function expectNoHorizontalScroll(page: Page) {
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body, body *')]
    .filter(node => node.clientWidth > 0 && node.getBoundingClientRect().height > 0 && node.scrollWidth > node.clientWidth + 1 && /^(auto|scroll)$/.test(getComputedStyle(node).overflowX))
    .map(node => ({ element: node.tagName, label: node.getAttribute('aria-label'), class: node.className, width: node.clientWidth, contentWidth: node.scrollWidth }))), { message: 'No mobile panel should scroll horizontally' }).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual((await page.viewportSize())!.width);
}
