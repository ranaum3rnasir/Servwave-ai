/**
 * Mobile slice 54 (VP-03, KB-06, KB-07): Save and Send stay above the on-screen keyboard.
 *
 * A headless browser has no soft keyboard, so the keyboard is SIMULATED the way iOS Safari presents
 * one: the layout viewport keeps its height and the visual viewport shrinks from the bottom. The
 * test replaces `window.visualViewport` with an object whose height is `innerHeight - keyboard`
 * (the real object stays untouched on the page's side of the wire) and fires its resize event. The
 * app's own keyboard-inset hook, the dialog and compose CSS are the real ones. What a real keyboard
 * adds (the page panning, the browser's own scroll-into-view, the Chrome Android resizes-content
 * layout) is on the real-device checklist (md_files/specs/qa/real-device-release-checklist.md).
 *
 * - New Task (a full-screen form on phones, a card from md up): its Create button is above the
 *   keyboard, and is the topmost thing at its own centre (nothing painted over it); it comes back
 *   down when the keyboard closes.
 * - Email compose (Inbox > Compose): Send is above the keyboard, the window's top edge is on screen.
 * - A layout that itself resizes with the keyboard (Chrome Android's resizes-content mode, simulated
 *   by shrinking the window): the hook reports zero overlap, so the footer is not lifted twice.
 *
 * Nothing is saved or sent. MOBILE_GATE_ROUTES selects it by the `tasks` and `comm-inbox` route ids.
 */
import { expect, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

declare global {
  interface Window { __setKeyboard?: (px: number) => void }
}

/** Swap in a visual viewport that a test can shrink from the bottom, before the app boots. */
async function simulateKeyboard(page: Page) {
  await page.addInitScript(() => {
    const fake = new EventTarget();
    let keyboard = 0;
    Object.defineProperties(fake, {
      height: { get: () => window.innerHeight - keyboard },
      width: { get: () => window.innerWidth },
      offsetTop: { value: 0 },
      offsetLeft: { value: 0 },
      pageTop: { value: 0 },
      pageLeft: { value: 0 },
      scale: { value: 1 },
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    window.__setKeyboard = (px: number) => {
      keyboard = px;
      fake.dispatchEvent(new Event('resize'));
    };
  });
}

const inset = (page: Page) =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--keyboard-inset'));

/** A keyboard of about 45% of the window, which is what the phone keyboards take. */
const keyboardHeight = (page: Page) => Math.round(page.viewportSize()!.height * 0.45);

test('New Task: Create stays above the keyboard and comes back down with it', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('tasks'), 'MOBILE_GATE_ROUTES does not select tasks');
  const device = gateDevice(testInfo.project.name);
  await simulateKeyboard(page);
  await signIn(page, session, []);
  try {
    await page.goto('/tasks', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const opener = page.locator('main').getByRole('button', { name: /^\s*New Task\s*$/ }).first();
    await expect(opener).toBeVisible({ timeout: 20_000 });
    await press(device.touch, opener, { timeout: 15_000 });
    const dialog = page.getByRole('dialog', { name: 'New Task' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500); // the open animation
    // A title makes Create enabled: a disabled button takes no pointer, so it would not be hit-testable.
    await dialog.getByPlaceholder('Task title').fill('Keyboard check');
    const create = dialog.getByRole('button', { name: 'Create', exact: true });
    await expect(create).toBeEnabled();

    const height = page.viewportSize()!.height;
    const kb = keyboardHeight(page);
    const closedBottom = (await create.boundingBox())!.y + (await create.boundingBox())!.height;

    await page.evaluate((px) => window.__setKeyboard!(px), kb);
    await expect.poll(() => inset(page), { message: 'the hook published the overlap' }).toBe(`${kb}px`);
    await page.waitForTimeout(250);

    const box = (await create.boundingBox())!;
    expect(box.y + box.height, 'Create is above the keyboard').toBeLessThanOrEqual(height - kb + 0.5);
    expect(box.y, 'Create is on screen').toBeGreaterThanOrEqual(0);
    const topmost = await create.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!hit && (hit === el || el.contains(hit));
    });
    expect(topmost, 'nothing is painted over Create').toBe(true);

    await page.evaluate(() => window.__setKeyboard!(0));
    await expect.poll(() => inset(page)).toBe('0px');
    await page.waitForTimeout(250);
    const back = (await create.boundingBox())!;
    expect(Math.abs(back.y + back.height - closedBottom), 'Create returns to where it was').toBeLessThanOrEqual(1);
    // Device sanity: on a phone the dialog is the whole screen, so closed means flush with the window.
    if (['iphone-se', 'galaxy-s24', 'iphone-15'].includes(device.id)) {
      expect(back.y + back.height, 'Create is in the bottom strip of the screen').toBeGreaterThan(height - 90);
    }
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});

test('Email compose: Send stays above the keyboard', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('comm-inbox'), 'MOBILE_GATE_ROUTES does not select comm-inbox');
  const device = gateDevice(testInfo.project.name);
  await simulateKeyboard(page);
  await signIn(page, session, []);
  try {
    await page.goto('/communication/inbox', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const compose = page.getByRole('button', { name: /^\s*Compose\s*$/ }).first();
    await expect(compose).toBeVisible({ timeout: 20_000 });
    await press(device.touch, compose, { timeout: 15_000 });
    const send = page.locator('[data-slot="compose-footer"]').getByRole('button', { name: /^\s*Send\s*$/ });
    await expect(send).toBeVisible({ timeout: 10_000 });

    const height = page.viewportSize()!.height;
    const kb = keyboardHeight(page);
    await page.evaluate((px) => window.__setKeyboard!(px), kb);
    await expect.poll(() => inset(page)).toBe(`${kb}px`);
    await page.waitForTimeout(250);

    const box = (await send.boundingBox())!;
    expect(box.y + box.height, 'Send is above the keyboard').toBeLessThanOrEqual(height - kb + 0.5);
    expect(box.y, 'Send is on screen').toBeGreaterThanOrEqual(0);
    const window_ = (await page.locator('[data-slot="compose-footer"]').locator('xpath=..').boundingBox())!;
    expect(window_.y, 'the compose window top is on screen').toBeGreaterThanOrEqual(-0.5);
    expect(window_.y + window_.height, 'the compose window ends at the keyboard').toBeLessThanOrEqual(height - kb + 0.5);
    const topmost = await send.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!hit && (hit === el || el.contains(hit));
    });
    expect(topmost, 'nothing is painted over Send').toBe(true);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});

test('a layout that resizes with the keyboard is not lifted twice', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('tasks'), 'MOBILE_GATE_ROUTES does not select tasks');
  const device = gateDevice(testInfo.project.name);
  // The real visual viewport follows a real window resize: that is Chrome Android's resizes-content.
  await signIn(page, session, []);
  try {
    await page.goto('/tasks', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const opener = page.locator('main').getByRole('button', { name: /^\s*New Task\s*$/ }).first();
    await expect(opener).toBeVisible({ timeout: 20_000 });
    await press(device.touch, opener, { timeout: 15_000 });
    const dialog = page.getByRole('dialog', { name: 'New Task' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);

    const vp = page.viewportSize()!;
    const kb = keyboardHeight(page);
    await page.setViewportSize({ width: vp.width, height: vp.height - kb });
    await page.waitForTimeout(500);
    expect(await inset(page), 'no overlap to lift by: the layout already shrank').toBe('0px');
    const create = dialog.getByRole('button', { name: 'Create', exact: true });
    await expect(create).toBeVisible();
    const box = (await create.boundingBox())!;
    expect(box.y + box.height, 'Create is inside the shrunk window').toBeLessThanOrEqual(vp.height - kb + 0.5);
    if (['iphone-se', 'galaxy-s24', 'iphone-15'].includes(device.id)) {
      expect(box.y + box.height, 'and sits at its bottom edge, not lifted a second time').toBeGreaterThan(vp.height - kb - 90);
    }
    await page.setViewportSize(vp);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});
