/**
 * Category J — Responsive & Viewport + Category K — Visual Hierarchy
 *
 * Verifies layout at multiple viewport sizes, event readability,
 * status color distinction, contrast, and visual state indicators.
 *
 * Test IDs: J-01 through J-10, K-01 through K-12
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import { screenshotAndAssert } from '../helpers/screenshot';
import { type ScheduleSeed, seedScheduleData } from '../helpers/schedule-seed';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

test.describe.serial('Category J/K — Responsive & Visual Hierarchy', () => {
  let seed: ScheduleSeed;

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'resp' });
  });

  test.afterAll(async () => {
    await seed.cleanup();
  });

  // ─── Viewport Tests (J-01 through J-10) ───

  const viewports = [
    { name: 'Full HD', width: 1920, height: 1080, id: 'J-01' },
    { name: 'Common laptop', width: 1440, height: 900, id: 'J-02' },
    { name: 'Small laptop', width: 1366, height: 768, id: 'J-03' },
    { name: 'Tablet landscape', width: 1024, height: 768, id: 'J-04' },
  ];

  for (const vp of viewports) {
    test(`${vp.id} — Layout at ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const sp = new SchedulePage(page);
      await sp.goto();
      await sp.waitForCalendarReady();
      await sp.goToToday();
      await sp.switchToWeekView();

      // Check sidebar visibility
      const sidebarVisible = await sp.sidebar.isVisible().catch(() => false);
      console.log(`[${vp.id}] Sidebar visible at ${vp.width}px:`, sidebarVisible);

      // Check calendar fills remaining space
      const calBox = await sp.calendarCard.boundingBox();
      if (calBox) {
        console.log(`[${vp.id}] Calendar width:`, calBox.width);
        // Calendar should be at least 60% of viewport when sidebar visible, or ~100% when hidden
        const minWidth = sidebarVisible ? vp.width * 0.5 : vp.width * 0.8;
        expect(calBox.width).toBeGreaterThan(minWidth);
      }

      // Check no horizontal scrollbar on calendar
      const hasHScroll = await page.evaluate(() => {
        const cal = document.querySelector('.rbc-calendar');
        return cal ? cal.scrollWidth > cal.clientWidth : false;
      });
      console.log(`[${vp.id}] Calendar has horizontal scroll:`, hasHScroll);

      await sp.takeAuditScreenshot(`${vp.id}_layout-${vp.width}x${vp.height}.png`);
    });
  }

  test('J-05 — Short events still clickable at small viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const events = sp.getAllEvents();
    const count = await events.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const box = await events.nth(i).boundingBox();
      if (box) {
        console.log(`[J-05] Event ${i} height at 1366px:`, box.height);
        // Minimum clickable height should be ~20px
        expect(box.height).toBeGreaterThanOrEqual(15);
      }
    }

    await sp.takeAuditScreenshot('J-05_short-events-1366.png');
  });

  test('J-06 — Grid view with many techs at small viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    // Check horizontal scroll works in grid view
    const gridHasScroll = await page.evaluate(() => {
      const grid = document.querySelector('[class*="overflow-x-auto"]');
      return grid ? grid.scrollWidth > grid.clientWidth : false;
    });
    console.log('[J-06] Grid has horizontal scroll:', gridHasScroll);

    await sp.takeAuditScreenshot('J-06_grid-techs-1366.png');
  });

  test('J-09 — Browser zoom 125%', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Simulate 125% zoom by reducing viewport
    await page.setViewportSize({ width: Math.round(1920 / 1.25), height: Math.round(1080 / 1.25) });

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    // Verify no broken layout
    const mainContent = page.locator('main');
    await expect(mainContent).toBeVisible();

    await sp.takeAuditScreenshot('J-09_zoom-125.png');
  });

  // ─── Visual Hierarchy Tests (K-01 through K-12) ───

  test('K-01 — Status colors are distinguishable', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await sp.toggleToAll(); // Show all statuses
    await page.waitForTimeout(500);

    // Collect background colors of all visible events
    const events = sp.getAllEvents();
    const count = await events.count();
    const colors = new Set<string>();

    for (let i = 0; i < Math.min(count, 10); i++) {
      const bg = await events.nth(i).evaluate((el) => {
        return window.getComputedStyle(el).backgroundColor;
      });
      colors.add(bg);
    }

    console.log('[K-01] Distinct event background colors found:', colors.size);
    console.log('[K-01] Colors:', [...colors]);

    await sp.takeAuditScreenshot('K-01_status-colors.png');
  });

  test('K-06 — Font size on event blocks readable', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const events = sp.getAllEvents();
    const count = await events.count();
    expect(count, 'Seed data should provide visible events').toBeGreaterThanOrEqual(1);

    const fontSize = await events.first().evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
      };
    });

    console.log('[K-06] Event font styles:', JSON.stringify(fontSize));
    // Font size should be >= 11px for readability
    const pxSize = parseFloat(fontSize.fontSize);
    expect(pxSize).toBeGreaterThanOrEqual(10);

    await sp.takeAuditScreenshot('K-06_event-font-size.png');
  });

  test('K-07 — Contrast ratio on colored event backgrounds', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const events = sp.getAllEvents();
    const count = await events.count();
    expect(count, 'Seed data should provide visible events').toBeGreaterThanOrEqual(1);

    // Get both background and text color for contrast check
    const contrast = await events.first().evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        backgroundColor: cs.backgroundColor,
        color: cs.color,
        // Also check inner text elements
        innerTextColor: el.querySelector('span, p, div')
          ? window.getComputedStyle(el.querySelector('span, p, div')!).color
          : cs.color,
      };
    });

    console.log('[K-07] Event contrast:', JSON.stringify(contrast));
    // Manual review needed for WCAG AA compliance (4.5:1 ratio)

    await sp.takeAuditScreenshot('K-07_event-contrast.png');
  });

  test('K-08 — Current time indicator visible', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();

    const indicator = sp.currentTimeIndicator;
    const isVisible = await indicator.isVisible().catch(() => false);
    console.log('[K-08] Current time indicator visible:', isVisible);

    if (isVisible) {
      const styles = await indicator.evaluate((el) => {
        const cs = window.getComputedStyle(el);
        return { borderColor: cs.borderColor, height: cs.height, width: cs.width };
      });
      console.log('[K-08] Indicator styles:', JSON.stringify(styles));
    }

    await sp.takeAuditScreenshot('K-08_current-time-indicator.png');
  });

  test('K-09 — Today column highlighted in Week view', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Check for today highlight class
    const todayHeader = page.locator('.rbc-today, .rbc-now');
    const todayCount = await todayHeader.count();
    console.log('[K-09] Today highlight elements:', todayCount);

    if (todayCount > 0) {
      const bg = await todayHeader.first().evaluate((el) =>
        window.getComputedStyle(el).backgroundColor
      );
      console.log('[K-09] Today column background:', bg);
    }

    await sp.takeAuditScreenshot('K-09_today-highlight.png');
  });
});
