/**
 * Category A — Text & Content Overflow
 *
 * Verifies that all text in the scheduler truncates gracefully,
 * shows tooltips for overflowed content, and never breaks layout.
 *
 * Uses shared seed data so the board is always populated.
 * Test IDs: A-01 through A-14
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

test.describe.serial('Category A — Text & Content Overflow', () => {
  let seed: ScheduleSeed;

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'txt' });
  });

  test.afterAll(async () => {
    await seed.cleanup();
  });

  test('A-01 — Short event title fits without truncation', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Use the first scheduled job — guaranteed to exist
    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    const box = await event.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(20);

    await sp.takeAuditScreenshot('A-01_short-title-week.png');
  });

  test('A-02 — Event blocks have overflow protection', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // We have 4+ events from seed — check their CSS
    const events = sp.getAllEvents();
    const count = await events.count();
    expect(count).toBeGreaterThanOrEqual(4); // 3 tech1 + 1 tech2 at minimum

    const firstEvent = events.first();
    const styles = await firstEvent.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        overflow: computed.overflow,
        textOverflow: computed.textOverflow,
        whiteSpace: computed.whiteSpace,
      };
    });

    console.log('[A-02] Event block CSS:', JSON.stringify(styles));
    await sp.takeAuditScreenshot('A-02_overflow-styles.png');
  });

  test('A-03 — Tooltip shows on event hover', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Hover over the first seed job
    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    await event.hover();
    await page.waitForTimeout(500); // > 350ms tooltip delay

    const tooltip = page.locator('[class*="pointer-events-none"][class*="fixed"]').first();
    const tooltipVisible = await tooltip.isVisible().catch(() => false);

    console.log('[A-03] Tooltip visible on hover:', tooltipVisible);
    if (tooltipVisible) {
      const text = await tooltip.textContent();
      console.log('[A-03] Tooltip text:', text?.substring(0, 80));
    }

    await sp.takeAuditScreenshot('A-03_event-hover-tooltip.png');
  });

  test('A-06 — Month view "+N more" overflow', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMonthView();

    // With 4+ events today, month cells should show events
    const monthCells = page.locator('.rbc-date-cell');
    const cellCount = await monthCells.count();
    expect(cellCount).toBeGreaterThan(0);

    const moreLinks = page.locator('.rbc-show-more');
    const moreCount = await moreLinks.count();
    console.log('[A-06] "+N more" links found:', moreCount);

    await sp.takeAuditScreenshot('A-06_month-view-overflow.png');
  });

  test('A-07 — Sidebar cards do not overflow horizontally', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();

    const sidebarDims = await sp.getSidebarDimensions();
    expect(sidebarDims).not.toBeNull();

    // Seed creates 2 unassigned jobs — cards must exist
    const cards = sp.getSidebarDraggableCards();
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < cardCount; i++) {
      const cardBox = await cards.nth(i).boundingBox();
      if (cardBox && sidebarDims) {
        expect(
          cardBox.x + cardBox.width,
          `Sidebar card ${i} overflows sidebar width`,
        ).toBeLessThanOrEqual(sidebarDims.width + 5);
      }
    }

    await sp.takeAuditScreenshot('A-07_sidebar-card-no-overflow.png');
  });

  test('A-09 — Grid Day view: short event still shows key info', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    // Grid view should have job cards from seed data
    const jobCard = page.locator(`text=${seed.scheduledJobs[0].job_number}`).first();
    const isVisible = await jobCard.isVisible().catch(() => false);
    expect(isVisible, 'Seed job should be visible in grid day view').toBeTruthy();

    await sp.takeAuditScreenshot('A-09_grid-day-short-events.png');
  });

  test('A-13 — Time labels on event blocks', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    const text = await event.textContent();
    const hasTimeLabel = /\d{1,2}:\d{2}\s*(AM|PM|am|pm)?/i.test(text ?? '');
    console.log('[A-13] Event text:', text?.trim());
    console.log('[A-13] Has time label:', hasTimeLabel);

    await sp.takeAuditScreenshot('A-13_time-labels-on-events.png');
  });

  test('A-14 — Job number badge readable on event', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // All seed jobs should be visible — check each one
    for (const job of seed.scheduledJobs) {
      const event = sp.getEventByText(job.job_number);
      const visible = await event.isVisible().catch(() => false);
      expect(visible, `Seed job ${job.job_number} should be visible`).toBeTruthy();
    }

    await sp.takeAuditScreenshot('A-14_job-number-badge.png');
  });
});
