/**
 * Mobile slice 35 (CMP-09 tablet tier, VP-10 iPad): the tablet and foldable icon rail that expands
 * over the page.
 *
 * md up to lg, at normal height, the sidebar is the 60 px icon rail and the page gets the rest of
 * the width. Expanding the rail opens the full sidebar as an overlay over the rail and the page,
 * in front of everything and against the whole window (never inside the content column). While it
 * is shut it is not rendered at all, so it is not in the accessibility tree or the tab order and
 * nothing paints over the rail. lg and up keeps the full sidebar and its collapse-to-rail toggle.
 *
 * - iPad Mini (768x1024, the tablet project): checked at its own size, then resized to an unfolded
 *   foldable (884x1104) and a wide-but-normal-height foldable (841x701), then to 1023 and 1024 px
 *   wide, the last px of the rail tier and the first of the full sidebar.
 * - Desktop control (1280x720): the full 192 px sidebar, the toggle collapses it in place and
 *   never opens an overlay.
 * - Phones and the landscape phone are the drawer's (phone-drawer.spec.ts); skipped here.
 *
 * Set MOBILE_RAIL_SHOTS=<dir> to save the closed/open screenshot pairs (the HITL sign-off).
 * MOBILE_GATE_ROUTES selects it by `home`.
 */
import { expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

const RAIL_W = 60;
const OVERLAY_MAX_W = 320;

const TABLET_SIZES = [
  { name: 'ipad-mini', width: 768, height: 1024 },
  { name: 'foldable-unfolded', width: 884, height: 1104 },
  { name: 'foldable-landscape-normal-height', width: 841, height: 701 },
  { name: 'last-rail-width', width: 1023, height: 800 },
];

const railToggle = (page: Page) => page.locator('[data-slot="app-body"] > aside[data-slot="sidebar"]').getByRole('button', { name: 'Expand sidebar' });
const overlay = (page: Page) => page.getByRole('dialog', { name: 'Navigation' });

async function open(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

async function shot(page: Page, name: string) {
  const dir = process.env.MOBILE_RAIL_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

/** The rail tier at the page's current size: rail closed, then open, then closed again. */
async function checkRailTier(page: Page, touch: boolean, label: string) {
  const vp = page.viewportSize()!;
  const aside = page.locator('[data-slot="app-body"] > aside[data-slot="sidebar"]');
  const canvas = page.locator('[data-slot="app-canvas"]');

  // Closed: the rail is 60 px and the page has the rest of the width.
  await expect(aside).toHaveAttribute('data-mode', 'rail');
  await page.waitForTimeout(700); // the width transition after a resize
  const rail = (await aside.boundingBox())!;
  expect(rail.width, `${label}: the rail is 60 px`).toBeCloseTo(RAIL_W, 0);
  expect(rail.x, `${label}: the rail starts at the left edge`).toBeCloseTo(0, 0);
  const page_ = (await canvas.boundingBox())!;
  expect(page_.x, `${label}: the page starts right of the rail`).toBeLessThanOrEqual(RAIL_W + 1);
  expect(page_.x + page_.width, `${label}: the page reaches the right edge (minus the frame's 9 px)`).toBeGreaterThanOrEqual(vp.width - 10);
  expect(page_.width, `${label}: the page gets everything the rail leaves`).toBeGreaterThanOrEqual(vp.width - RAIL_W - 10);

  // Closed: no overlay is mounted, so it is not in the accessibility tree or the tab order, and
  // nothing paints over the rail (the topmost thing at the rail's centre is inside the rail).
  await expect(overlay(page)).toHaveCount(0);
  await expect(page.locator('[data-slot="nav-overlay"]')).toHaveCount(0);
  await expect(page.locator('aside[data-slot="sidebar"]')).toHaveCount(1);
  const topmost = await aside.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + 120);
    return !!hit && el.contains(hit);
  });
  expect(topmost, `${label}: the rail is the topmost thing on its own strip`).toBe(true);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
  await shot(page, `${label}-closed`);

  // Open: a dialog over the rail and the page, against the whole window.
  await press(touch, railToggle(page));
  const dlg = overlay(page);
  await expect(dlg).toBeVisible();
  await page.waitForTimeout(500); // the open animation
  const box = (await dlg.boundingBox())!;
  expect(box.x, `${label}: the overlay starts at the window's left edge`).toBeCloseTo(0, 0);
  expect(box.y, `${label}: the overlay starts at the window's top edge`).toBeCloseTo(0, 0);
  expect(box.height, `${label}: the overlay takes the whole window height`).toBeGreaterThanOrEqual(vp.height - 1);
  expect(box.width, `${label}: the overlay is wider than the rail`).toBeGreaterThan(RAIL_W + 100);
  expect(box.width, `${label}: the overlay is not the whole page`).toBeLessThanOrEqual(OVERLAY_MAX_W + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
  // The page did not move under it.
  const during = (await canvas.boundingBox())!;
  expect(during.x, `${label}: opening does not push the page`).toBeCloseTo(page_.x, 0);
  expect(during.width, `${label}: opening does not narrow the page`).toBeCloseTo(page_.width, 0);
  // It covers the rail (the topmost thing over the rail's icon strip is the overlay) and the page
  // (the topmost thing over the page is the overlay's scrim or the overlay).
  const covers = await page.evaluate(({ railX, pageX }) => {
    const top = (x: number, y: number) => document.elementFromPoint(x, y);
    const inDialog = (el: Element | null) => !!el && !!el.closest('[role="dialog"]');
    const scrim = (el: Element | null) => !!el && el.closest('[data-slot="sheet-overlay"]') !== null;
    return {
      rail: inDialog(top(railX, 200)),
      page: inDialog(top(pageX, 400)) || scrim(top(pageX, 400)),
    };
  }, { railX: RAIL_W / 2, pageX: Math.min(vp.width - 20, OVERLAY_MAX_W + 60) });
  expect(covers.rail, `${label}: the overlay covers the rail`).toBe(true);
  expect(covers.page, `${label}: the overlay and its scrim cover the page`).toBe(true);
  await shot(page, `${label}-open`);

  // Tab stays inside it.
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    if (!inside) throw new Error(`${label}: Tab number ${i + 1} left the overlay`);
  }

  // Escape closes it and gives focus back to the rail's toggle.
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(railToggle(page)).toBeFocused();
  await expect(page.locator('aside[data-slot="sidebar"]')).toHaveCount(1);
}

test.describe('tablet icon rail', () => {
  test('the rail is 60 px, expands over the page, traps focus, closes on Escape and on navigation', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    const device = gateDevice(testInfo.project.name);
    test.skip(device.id !== 'ipad-mini', 'the tablet project; the desktop control has its own test');
    await signIn(page, session, []);
    await open(page);

    await checkRailTier(page, device.touch, 'ipad-mini');

    // A destination picked from the overlay closes it and lands on the page.
    await press(device.touch, railToggle(page));
    const dlg = overlay(page);
    await expect(dlg).toBeVisible();
    await press(device.touch, dlg.getByRole('link', { name: 'Customers' }));
    await expect(page).toHaveURL(/\/customers/);
    await expect(dlg).toHaveCount(0);

    // Unfolded foldables and the widest rail width: the same tier.
    for (const size of TABLET_SIZES.slice(1)) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await checkRailTier(page, device.touch, size.name);
    }

    // The overlay open while the window widens to lg: it goes away with the layout, and the
    // full sidebar is in the flow.
    await press(device.touch, railToggle(page));
    await expect(overlay(page)).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(overlay(page)).toHaveCount(0);
    const aside = page.locator('[data-slot="app-body"] > aside[data-slot="sidebar"]');
    await expect(aside).toHaveAttribute('data-mode', 'expanded');
    await page.waitForTimeout(700);
    expect((await aside.boundingBox())!.width, 'lg: the full sidebar, 192 px').toBeCloseTo(192, 0);
    await keepSession(page, session).catch(() => {});
  });

  test('lg and up keeps the full sidebar and its own collapse toggle, with no overlay', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    test.skip(gateDevice(testInfo.project.name).id !== 'desktop', 'the desktop control only');
    await signIn(page, session, []);
    await open(page);

    const aside = page.locator('[data-slot="app-body"] > aside[data-slot="sidebar"]');
    await expect(aside).toHaveAttribute('data-mode', 'expanded');
    expect((await aside.boundingBox())!.width).toBeCloseTo(192, 0);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);

    // The user's collapse-to-rail toggle: in place, no dialog.
    await aside.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(aside).toHaveAttribute('data-mode', 'rail');
    await expect(overlay(page)).toHaveCount(0);
    await page.waitForTimeout(700);
    expect((await aside.boundingBox())!.width).toBeCloseTo(RAIL_W, 0);
    await aside.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(aside).toHaveAttribute('data-mode', 'expanded');
    await expect(overlay(page)).toHaveCount(0);

    // One px below lg it is the rail tier with the overlay.
    await page.setViewportSize({ width: 1023, height: 720 });
    await checkRailTier(page, false, 'desktop-1023');
    await keepSession(page, session).catch(() => {});
  });

  test('phones keep the drawer: no rail', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    const id = gateDevice(testInfo.project.name).id;
    test.skip(id === 'ipad-mini' || id === 'desktop', 'phones and the landscape phone only');
    await signIn(page, session, []);
    await open(page);
    await expect(page.locator('aside[data-slot="sidebar"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toHaveCount(0);
    await keepSession(page, session).catch(() => {});
  });
});
