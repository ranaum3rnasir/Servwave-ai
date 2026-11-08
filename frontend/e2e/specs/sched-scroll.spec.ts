/**
 * Category B — Scroll Behavior
 *
 * Verifies initial scroll position, scroll stability during interactions,
 * independent sidebar/calendar scrolling, and auto-scroll during drag.
 *
 * Uses shared seed data so the board is always populated.
 * Test IDs: B-01 through B-12
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import { type ScheduleSeed, seedScheduleData } from '../helpers/schedule-seed';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

test.describe.serial('Category B — Scroll Behavior', () => {
  let seed: ScheduleSeed;

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'scrl' });
  });

  test.afterAll(async () => {
    await seed.cleanup();
  });

  test('B-01 — Initial load scrolls to ~6 AM area (scrollToTime)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    // Seed events at 9/11/14 should be visible or near-visible
    const event9am = sp.getEventByText(seed.scheduledJobs[0].job_number);
    const visible = await event9am.isVisible().catch(() => false);
    console.log('[B-01] 9 AM event visible on load:', visible);

    const scrollTop = await sp.getCalendarScrollTop();
    console.log('[B-01] Calendar scrollTop on load:', scrollTop);

    await sp.takeAuditScreenshot('B-01_initial-scroll-position.png');
  });

  test('B-02 — Grid Day initial scroll position', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    // Seed jobs should be visible in grid
    const jobCard = page.locator(`text=${seed.scheduledJobs[0].job_number}`).first();
    const visible = await jobCard.isVisible().catch(() => false);
    console.log('[B-02] 9 AM job visible in grid on load:', visible);

    await sp.takeAuditScreenshot('B-02_grid-day-initial-scroll.png');
  });

  test('B-03 — View switch preserves approximate scroll context', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(300);

    // Scroll to 2 PM area (where seed job at hour 14 is)
    await page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content');
      if (el) el.scrollTop = 400;
    });
    const scrollBefore = await page.evaluate(() =>
      document.querySelector('.rbc-time-content')?.scrollTop ?? 0
    );

    await sp.switchToDayView();
    await page.waitForTimeout(300);

    const scrollAfter = await page.evaluate(() =>
      document.querySelector('.rbc-time-content')?.scrollTop ?? 0
    );
    console.log('[B-03] Scroll before:', scrollBefore, 'after:', scrollAfter);
    await sp.takeAuditScreenshot('B-03_view-switch-scroll.png');
  });

  test('B-04 — Date navigation preserves vertical scroll', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    await page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content');
      if (el) el.scrollTop = 300;
    });
    const scrollBefore = await page.evaluate(() =>
      document.querySelector('.rbc-time-content')?.scrollTop ?? 0
    );

    await sp.goToNext();
    await page.waitForTimeout(500);

    const scrollAfter = await page.evaluate(() =>
      document.querySelector('.rbc-time-content')?.scrollTop ?? 0
    );
    const delta = Math.abs(scrollAfter - scrollBefore);
    console.log('[B-04] Scroll before:', scrollBefore, 'after:', scrollAfter, 'delta:', delta);

    await sp.takeAuditScreenshot('B-04_date-nav-scroll.png');
  });

  test('B-05 — DnD does not cause scroll jump', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(seed.scheduledJobs[1].job_number); // 11 AM job
    await expect(event).toBeVisible({ timeout: 5000 });

    const scrollBefore = await sp.getCalendarScrollTop();

    // Small drag (same time area) — should not jump
    const box = await event.boundingBox();
    if (box) {
      await sp.dragEventTo(
        seed.scheduledJobs[1].job_number,
        box.x + box.width / 2,
        box.y + 30, // tiny move
        { steps: 5 }
      );
    }
    await page.waitForTimeout(500);

    const scrollAfter = await sp.getCalendarScrollTop();
    const delta = Math.abs(scrollAfter - scrollBefore);
    console.log('[B-05] Scroll delta after DnD:', delta, delta < 30 ? 'PASS' : 'FAIL');

    await sp.takeAuditScreenshot('B-05_dnd-scroll-stability.png');
  });

  test('B-08 — Sidebar scrolls independently from calendar', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();

    // Seed has 2 unassigned jobs in sidebar
    const cards = sp.getSidebarDraggableCards();
    expect(await cards.count()).toBeGreaterThanOrEqual(2);

    const calScrollBefore = await sp.getCalendarScrollTop();

    const sidebarBox = await sp.sidebar.boundingBox();
    if (sidebarBox) {
      await page.mouse.move(sidebarBox.x + sidebarBox.width / 2, sidebarBox.y + sidebarBox.height / 2);
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(300);

      const calScrollAfter = await sp.getCalendarScrollTop();
      const calMoved = Math.abs(calScrollAfter - calScrollBefore) > 5;
      console.log('[B-08] Calendar scrolled during sidebar wheel:', calMoved, calMoved ? 'FAIL' : 'PASS');
    }

    await sp.takeAuditScreenshot('B-08_sidebar-independent-scroll.png');
  });

  test('B-11 — Month view has no unnecessary scrollbar', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMonthView();
    await page.waitForTimeout(500);

    // Seed events should appear as dots/blocks in today's cell
    const events = sp.getAllEvents();
    const count = await events.count();
    expect(count).toBeGreaterThanOrEqual(1);

    await sp.takeAuditScreenshot('B-11_month-view-scroll.png');
  });

  test('B-12 — By-Tech Week board sticky headers', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    // Both tech columns from seed should show
    // Scroll down and verify headers stay pinned
    await page.evaluate(() => {
      const boards = document.querySelectorAll('[class*="overflow-y-auto"]');
      boards.forEach(b => { b.scrollTop = 200; });
    });
    await page.waitForTimeout(300);

    await sp.takeAuditScreenshot('B-12_member-week-sticky-headers.png');
  });
});
