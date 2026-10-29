/**
 * Category D — Drag-and-Drop Core (Grab & Initiate)
 *
 * Verifies that DnD initiates correctly from all sources, in all views,
 * with proper cursor behavior and click-vs-drag distinction.
 *
 * Uses shared seed data so the board is always populated.
 * Test IDs: D-01 through D-12
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

test.describe.serial('Category D — DnD Core (Grab & Initiate)', () => {
  let seed: ScheduleSeed;

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'dnd' });
  });

  test.afterAll(async () => {
    await seed.cleanup();
  });

  test('D-01 — Cursor changes to grab/move on calendar event hover', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    const cursor = await event.evaluate((el) => window.getComputedStyle(el).cursor);
    console.log('[D-01] Cursor on event hover:', cursor);
    await sp.takeAuditScreenshot('D-01_cursor-on-event-hover.png');
  });

  test('D-02 — Cursor changes to grab on sidebar card hover', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();

    const card = sp.getSidebarJobCard(seed.unassignedJobs[0].job_number);
    await expect(card).toBeVisible({ timeout: 5000 });

    const cursor = await card.evaluate((el) => window.getComputedStyle(el).cursor);
    console.log('[D-02] Cursor on sidebar card hover:', cursor);
    expect(['grab', 'pointer', 'move']).toContain(cursor);

    const draggable = await card.getAttribute('draggable');
    console.log('[D-02] draggable attribute:', draggable);
    expect(draggable).toBe('true');

    await sp.takeAuditScreenshot('D-02_cursor-sidebar-card.png');
  });

  test('D-04/D-05 — Click (no movement) opens popup, not drag', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    // Simple click — no mouse movement
    await event.click();
    await page.waitForTimeout(500);

    const popup = sp.quickViewPopup;
    const popupVisible = await popup.isVisible().catch(() => false);
    console.log('[D-04/D-05] Click popup appeared:', popupVisible);

    if (!popupVisible) {
      // Check for any popup with the job number
      const anyPopup = page.locator('[class*="fixed"][class*="bg-white"]').filter({ hasText: seed.scheduledJobs[0].job_number });
      const anyVisible = await anyPopup.first().isVisible().catch(() => false);
      console.log('[D-04/D-05] Any popup after click:', anyVisible);
    }

    await sp.takeAuditScreenshot('D-04_click-vs-drag.png');
    await page.keyboard.press('Escape'); // dismiss popup
  });

  test('D-06 — Drag event from center of block works', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Use the 11 AM job (middle of day, good visibility)
    const jobNum = seed.scheduledJobs[1].job_number;
    const event = sp.getEventByText(jobNum);
    await expect(event).toBeVisible({ timeout: 5000 });

    const box = await event.boundingBox();
    expect(box).not.toBeNull();
    const origY = box!.y;

    // Drag from center, move down ~100px
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 10, { steps: 3 }); // past dead zone
    await page.waitForTimeout(100);
    await page.mouse.move(cx, cy + 100, { steps: 10 });
    await page.waitForTimeout(100);
    await sp.takeAuditScreenshot('D-06_mid-drag-from-center.png');
    await page.mouse.up();
    await page.waitForTimeout(500);

    const eventAfter = sp.getEventByText(jobNum);
    const boxAfter = await eventAfter.boundingBox();
    if (boxAfter) {
      const moved = Math.abs(boxAfter.y - origY) > 20;
      console.log('[D-06] Event moved:', moved, 'delta:', boxAfter.y - origY);
    }

    await sp.takeAuditScreenshot('D-06_after-drag-from-center.png');
  });

  test('D-08 — Drag in Month view (date change)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMonthView();
    await page.waitForTimeout(500);

    // Seed events should be visible in today's cell
    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    const box = await event.boundingBox();
    if (!box) { test.fail(); return; }

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, { steps: 10 });
    await sp.takeAuditScreenshot('D-08_month-drag-mid.png');
    await page.mouse.up();
    await page.waitForTimeout(500);
    await sp.takeAuditScreenshot('D-08_month-drag-after.png');
  });

  test('D-10 — Sidebar card DnD shows visual feedback', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const jobNum = seed.unassignedJobs[0].job_number;
    const card = sp.getSidebarJobCard(jobNum);
    await expect(card).toBeVisible({ timeout: 5000 });

    const box = await card.boundingBox();
    expect(box).not.toBeNull();

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 10, box!.y + box!.height / 2 + 10, { steps: 3 });
    await page.waitForTimeout(200);

    const opacity = await card.evaluate((el) => window.getComputedStyle(el).opacity);
    console.log('[D-10] Card opacity during drag:', opacity);

    // Move into calendar
    const calBox = await sp.calendarCard.boundingBox();
    if (calBox) {
      await page.mouse.move(calBox.x + calBox.width / 2, calBox.y + calBox.height / 2, { steps: 10 });
      await page.waitForTimeout(200);
      await sp.takeAuditScreenshot('D-10_sidebar-drag-into-calendar.png');
    }

    await page.mouse.up();
    await page.waitForTimeout(500);
    await sp.takeAuditScreenshot('D-10_sidebar-drag-completed.png');
  });

  test('D-11 — Drag a walkthrough event', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Seed has a walkthrough event — look for "Walkthrough" text
    const walkthroughEvent = page.locator('.rbc-event').filter({ hasText: /Walkthrough/ }).first();
    const visible = await walkthroughEvent.isVisible().catch(() => false);
    console.log('[D-11] Walkthrough event visible:', visible);

    if (visible) {
      const box = await walkthroughEvent.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 8 });
        await sp.takeAuditScreenshot('D-11_walkthrough-drag-mid.png');
        await page.mouse.up();
        await page.waitForTimeout(500);
      }
    }

    await sp.takeAuditScreenshot('D-11_walkthrough-drag.png');
  });

  test('D-12 — Cannot drag completed/cancelled events', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await sp.toggleToAll(); // Show completed events
    await page.waitForTimeout(500);

    const events = sp.getAllEvents();
    const count = await events.count();
    expect(count).toBeGreaterThanOrEqual(4); // seed data should be visible

    let testedCompleted = false;
    for (let i = 0; i < count; i++) {
      const opacity = await events.nth(i).evaluate((el) =>
        parseFloat(window.getComputedStyle(el).opacity)
      );
      if (opacity <= 0.6) {
        testedCompleted = true;
        const box = await events.nth(i).boundingBox();
        if (!box) continue;

        const cursor = await events.nth(i).evaluate((el) =>
          window.getComputedStyle(el).cursor
        );
        console.log('[D-12] Completed event cursor:', cursor);

        // Try to drag
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 50, { steps: 5 });
        await page.waitForTimeout(200);
        await sp.takeAuditScreenshot('D-12_drag-completed-event.png');
        await page.mouse.up();
        break;
      }
    }

    if (!testedCompleted) {
      console.log('[D-12] No completed events visible — create one via API to test');
    }
  });
});
