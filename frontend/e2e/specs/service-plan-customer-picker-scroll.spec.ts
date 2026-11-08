/**
 * Regression test for a real-browser-only bug: the customer picker's results list
 * (New Service Plan dialog → Customer field) looked scrollable (`max-h-60 overflow-y-auto`,
 * content taller than the viewport) but mouse-wheel scrolling silently did nothing.
 *
 * Root cause: the New Service Plan dialog is a modal Radix `Dialog`, which locks page-wide
 * wheel scrolling (`react-remove-scroll`, `body[data-scroll-locked]`) while open. The picker's
 * Popover results list is portalled as a *sibling* of the Dialog's own content, not a
 * descendant, so it's caught by that lock too — the wheel event's default action never
 * reaches it, even though the div itself is correctly configured to scroll.
 *
 * jsdom can't reproduce this at all (no layout engine, no real scroll/wheel physics), so this
 * has to be a real-browser check, not a unit test.
 */
import { test, expect } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';

const TS = () => Date.now().toString(36);

test.beforeAll(async () => {
  const api = await new ApiClient().init();
  // Seed enough customers to overflow the picker's `limit: 15` search results — the bug
  // only shows up once the results list is actually taller than its max-h-60 viewport.
  const suffix = TS();
  for (let i = 0; i < 20; i++) {
    const { res } = await api.raw('post', '/api/customers', {
      first_name: `ScrollQA${suffix}`,
      last_name: `Row${i}`,
      email: `scrollqa-${suffix}-row${i}@example.test`,
    });
    expect(res.status()).toBe(201);
  }
  await api.dispose();
});

test('customer picker results list scrolls with the mouse wheel inside the New Service Plan dialog', async ({ page }) => {
  await page.goto('/service-plans');
  await page.getByRole('button', { name: 'New Plan' }).click();
  await page.getByRole('button', { name: 'Select customer' }).click();

  const results = page.locator('.max-h-60.overflow-y-auto');
  await expect(results).toBeVisible();
  // Wait past the loading state ("Searching…") so the actual rows are what we measure.
  await expect(results.getByRole('button').first()).toBeVisible();

  // Confirm the setup actually needs scrolling (content taller than the viewport) —
  // otherwise this test would pass trivially with nothing to scroll.
  const { scrollHeight, clientHeight } = await results.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(scrollHeight).toBeGreaterThan(clientHeight);

  await results.evaluate((el) => { el.scrollTop = 0; });
  const box = await results.boundingBox();
  if (!box) { test.fail(); return; }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => results.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});
