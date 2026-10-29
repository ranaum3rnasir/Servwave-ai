/**
 * Mobile slice 73: the emulation half of the first real-device run
 * (md_files/specs/qa/real-device-release-checklist.md, run record md_files/specs/qa/real-device-run-01.md).
 *
 * Some checklist rows have a part a headless browser CAN show. This spec runs that part, so the
 * person with the phones starts from what is already known and spends their time on what only
 * hardware shows. Each test names its row. None of them replaces the row: the row's "Pass when"
 * still needs the real phone.
 *
 * - RD-11 (TOUCH-12): on a list with a menu button on every row, a scroll that starts on that
 *   button scrolls the page and does not open the menu, and a plain tap still opens it. Touch
 *   projects only. The list is the Stock list, answered with 40 invented items (a read-only stub,
 *   like inventory-plans-automations.spec.ts; nothing is written).
 * - RD-21 (TEST-07, CMP-09): the user-agent families emulation does not give by default. Chrome on
 *   iOS is WebKit with a "CriOS" user agent: it must get the same phone layout as Safari. The iPad
 *   in iPadOS Safari reports a desktop (Mac) user agent, a Mac platform and touch points: it must
 *   still get the tablet layout (icon rail). Its recognition as an Apple touch device (Apple Maps links)
 *   is a unit test: src/__tests__/contactHrefs-user-agents.test.ts.
 * - RD-02 (PWA-02) and RD-03 (VP-03) static halves: the page asks for the full screen
 *   (`viewport-fit=cover`) and for a keyboard that resizes the page (`interactive-widget`). The
 *   installed-app manifest (RD-19, no orientation lock) is read from deployed staging in the run record.
 *
 * Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects the tests by
 * route: `inventory` (RD-11) and `home` (RD-21, RD-19, RD-02).
 *
 * REPORT mode: a finding already on staging is listed in REPORT (project -> row), like the gate's
 * allow-list. A listed pair that fails is printed and annotated `REPORT`, not failed; a listed pair
 * that passes is annotated `CLEAN: delete it from REPORT`; a pair that is not listed and fails is a
 * new defect and fails the run. The follow-up for each listed pair is in the run record.
 */
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { swipe, tap } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

/**
 * Known findings on the staging base (see the run record for the follow-up of each).
 * `rd11` = the menu opens when a scroll starts on its button. Fixed in the shared menu trigger
 * (a touch or pen opens the menu on the tap, not the press), so it is enforced on every project.
 */
export const REPORT: Record<string, string[]> = {
  rd11: [],
};

/** Print and annotate a finding on a listed project; fail on an unlisted one. */
function judge(testInfo: import('@playwright/test').TestInfo, row: keyof typeof REPORT, failures: string[]) {
  const listed = REPORT[row].includes(testInfo.project.name);
  if (failures.length === 0) {
    if (listed) {
      testInfo.annotations.push({ type: 'CLEAN', description: `${row} on ${testInfo.project.name} is clean: delete it from REPORT` });
      console.log(`[real-device-emulation] CLEAN ${row} on ${testInfo.project.name}: delete it from REPORT`);
    }
    return;
  }
  if (listed) {
    for (const f of failures) {
      testInfo.annotations.push({ type: 'REPORT', description: `${row}: ${f}` });
      console.log(`[real-device-emulation] REPORT ${row} on ${testInfo.project.name}: ${f}`);
    }
    return;
  }
  expect(failures, `${row} on ${testInfo.project.name}`).toEqual([]);
}

const now = new Date().toISOString();
const uuid = (i: number) => `00000000-0000-4000-0073-${String(i + 1).padStart(12, '0')}`;
const ITEMS = Array.from({ length: 40 }, (_, i) => ({
  id: uuid(i),
  sku: `SKU-${String(i + 1).padStart(4, '0')}`,
  name: `Stock item number ${i + 1}, standard grade`,
  category: 'Hardware',
  trade: 'door',
  kind: 'material',
  uom: 'EA',
  unitCost: 10 + (i % 17),
  sellPrice: 25 + (i % 23),
  serialized: false,
  hazmat: false,
  status: 'active',
  vendor: 'Sample Supply Co',
  stock: [],
  updatedAt: now,
}));

async function stubGet(page: Page, path: string, body: (url: URL) => unknown) {
  await page.route((url) => url.pathname === path, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, json: body(new URL(route.request().url())) });
  });
}

async function open(page: Page, path: string, notes: string[]) {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, notes);
  await page.evaluate(() => document.fonts.ready);
}

/** The menu button on the n-th row of the Stock list (the phone card or the table row). */
// A CSS locator, not getByRole: an open modal menu hides the rest of the page from the accessibility
// tree, and the test must still find the button to read where the swipe left it.
const rowMenuButton = (page: Page, n: number): Locator => page.locator('button[aria-label="More actions"]').nth(n);

test.describe('RD-11 (TOUCH-12): a scroll that starts on a row menu button', () => {
  test('scrolls the page and does not open the menu; a tap still does', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('inventory'), 'MOBILE_GATE_ROUTES does not select inventory');
    const device = gateDevice(testInfo.project.name);
    test.skip(!device.touch, 'touch projects only; the desktop control has no finger');
    const notes: string[] = [];
    await signIn(page, session, notes);
    await stubGet(page, '/api/inventory/items', () => ({ data: ITEMS, meta: { page: 1, limit: 100, total: ITEMS.length, totalPages: 1 } }));
    try {
      await open(page, '/inventory', notes);
      // Generous: the first page of a cold dev server compiles its route chunks on a loaded machine.
      await expect(page.getByText(ITEMS[0].name).first()).toBeVisible({ timeout: 60_000 });
      const button = rowMenuButton(page, 2);
      // The list can re-render once more as the page settles (a loaded machine), which detaches the row
      // under the lookup. Nothing has touched the page yet, so look it up again.
      let before!: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;
      for (let attempt = 1; ; attempt++) {
        try {
          await button.scrollIntoViewIfNeeded();
          before = (await button.boundingBox())!;
          break;
        } catch (err) {
          if (attempt >= 3 || !/not attached to the DOM/.test(String(err))) throw err;
          await page.waitForTimeout(500);
        }
      }
      const failures: string[] = [];

      // The finger goes down on the button and drags up the page by about a third of the screen.
      const vp = page.viewportSize()!;
      const lift = Math.min(vp.height * 0.35, before.y - 8);
      const to = { x: before.x + before.width / 2, y: before.y + before.height / 2 - lift };
      // The list can re-render once more as the page settles (a loaded machine), which detaches the row
      // before the finger is down. The helper fails in that lookup, before any touch, so look it up again.
      for (let attempt = 1; ; attempt++) {
        try {
          await swipe(page, button, to);
          break;
        } catch (err) {
          if (attempt >= 3 || !/not attached to the DOM/.test(String(err))) throw err;
          await page.waitForTimeout(500);
        }
      }
      await page.waitForTimeout(400);

      const menu = page.getByRole('menu');
      const opened = (await menu.count()) > 0;
      // The swipe must really have scrolled: otherwise "the menu did not open" proves nothing.
      const after = await button.boundingBox();
      const moved = after ? before.y - after.y : Infinity;
      // (When the menu did open, the open modal menu holds the page still: that is part of the finding.)
      if (!opened) expect(moved, `the swipe scrolled the page (the button moved up by ${Math.round(moved)} px)`).toBeGreaterThan(20);
      if (opened) failures.push('the menu opened when a scroll started on its button');
      await testInfo.attach('rd11.json', { body: JSON.stringify({ device: device.id, opened, buttonMovedPx: Math.round(moved), notes }, null, 1), contentType: 'application/json' });
      if (opened) {
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
      }

      // A plain tap still opens it (so a fix cannot "pass" by making the button dead).
      await tap(button);
      const tapOpens = await menu.first().isVisible().catch(() => false);
      if (!tapOpens) failures.push('a plain tap did not open the menu');
      await page.keyboard.press('Escape').catch(() => {});

      // A tap that opens nothing is never reportable: that is a broken button, not a known finding.
      if (!tapOpens) expect(tapOpens, 'a plain tap opens the menu').toBe(true);
      judge(testInfo, 'rd11', failures);
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });
});

// --- RD-21: user-agent families ---------------------------------------------------------------------

const CHROME_ON_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1';
const IPADOS_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

test.describe('RD-21 (TEST-07, CMP-09): Chrome on iOS gets the Safari phone layout', () => {
  test.use({ userAgent: CHROME_ON_IOS_UA });
  test('the drawer layout: no inline sidebar, a 44 px navigation button, the same page', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    test.skip(gateDevice(testInfo.project.name).id !== 'iphone-15', 'the iPhone 15 project carries the Chrome-on-iOS agent');
    await signIn(page, session, []);
    try {
      await open(page, '/', []);
      expect(await page.evaluate(() => navigator.userAgent), 'the context really reports Chrome on iOS').toContain('CriOS');
      await expect(page.locator('aside[data-slot="sidebar"]')).toHaveCount(0);
      const trigger = page.getByRole('button', { name: 'Open navigation', exact: true });
      await expect(trigger).toBeVisible();
      const box = (await trigger.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no sideways scroll').toBe(true);
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });
});

test.describe('RD-21 (TEST-07, CMP-09): the iPad with its desktop (Mac) user agent gets the tablet layout', () => {
  test.use({ userAgent: IPADOS_DESKTOP_UA });
  test('the icon rail, not a desktop sidebar', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    test.skip(gateDevice(testInfo.project.name).id !== 'ipad-mini', 'the iPad Mini project carries the desktop agent');
    // iPadOS Safari answers a Mac platform with touch points; the context's own platform is iPad.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    });
    await signIn(page, session, []);
    try {
      await open(page, '/', []);
      expect(await page.evaluate(() => navigator.userAgent), 'the context really reports a Mac').toContain('Macintosh');
      const aside = page.locator('[data-slot="app-body"] > aside[data-slot="sidebar"]');
      await expect(aside).toHaveAttribute('data-mode', 'rail');
      await page.waitForTimeout(700);
      expect((await aside.boundingBox())!.width, 'the rail is 60 px').toBeCloseTo(60, 0);
      // The rail toggle is a 26 px icon (slice 35): over the WCAG 2.5.8 floor of 24 px, under the 44 px
      // primary-control size. The size is recorded for the run record; RD-21 on the iPad judges it by thumb.
      const toggle = aside.getByRole('button', { name: 'Expand sidebar' });
      const box = (await toggle.boundingBox())!;
      await testInfo.attach('rd21-rail-toggle.json', { body: JSON.stringify({ width: box.width, height: box.height }), contentType: 'application/json' });
      expect(box.width, 'rail toggle meets the 24 px floor').toBeGreaterThanOrEqual(24);
      expect(box.height, 'rail toggle meets the 24 px floor').toBeGreaterThanOrEqual(24);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no sideways scroll').toBe(true);
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });
});

// --- RD-02 / RD-03: what the page asks the browser for -----------------------------------------------

test('RD-02, RD-03: the page asks for the full screen and a keyboard that resizes it', async ({ page, session }) => {
  test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
  await signIn(page, session, []);
  try {
    await open(page, '/', []);
    const content = await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '');
    expect(content).toContain('viewport-fit=cover');
    expect(content).toContain('interactive-widget=resizes-content');
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});
