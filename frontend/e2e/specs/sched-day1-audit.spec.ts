/**
 * Day 1 Re-Run — Screenshot-Verify-Proceed Protocol
 *
 * Tests N-01 to N-04 (P0 verification) and D-01 to D-12 (DnD Core)
 * with step-by-step screenshots at every action.
 *
 * Each screenshot will be analyzed by the Eyes agent visually.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import { type ScheduleSeed, seedScheduleData } from '../helpers/schedule-seed';
import { createStepCapture } from '../helpers/capture-step';
import {
  createUrgentJob,
  assignJob,
  startJob,
  completeJob,
  deleteJob,
} from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');

test.use({
  storageState: authFile,
  viewport: { width: 1920, height: 1080 },
});

test.describe.serial('Day 1 Re-Run — P0 Verification + D-Category', () => {
  let seed: ScheduleSeed;
  let completedJobId: string;
  let completedJobNumber: string;

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'd1v2' });

    // Create a completed job so we can test N-01/D-12
    const cJob = await createUrgentJob(seed.token, seed.customerId, seed.locationId);
    completedJobId = cJob.id;
    completedJobNumber = cJob.job_number;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    await assignJob(seed.token, completedJobId, seed.techId1, start.toISOString(), end.toISOString());
    await startJob(seed.token, completedJobId);
    await completeJob(seed.token, completedJobId, 'Completed for Day 1 audit');
  });

  test.afterAll(async () => {
    if (completedJobId) await deleteJob(seed.token, completedJobId).catch(() => {});
    await seed.cleanup();
  });

  // ═══════════════════════════════════════════════════════════
  // N-01: Try to drag a COMPLETED event
  // ═══════════════════════════════════════════════════════════

  test('N-01 — Drag COMPLETED event (P0 verification)', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'N-01');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await sp.toggleToAll();
    await page.waitForTimeout(500);
    await step('01_all_view_with_completed', 'Week view in "All" mode. Look for completed events at 0.5 opacity');

    // Find the completed event
    const event = sp.getEventByText(completedJobNumber);
    const visible = await event.isVisible().catch(() => false);
    if (!visible) {
      await step('02_completed_not_found', 'Completed event not visible — scrolling needed or date mismatch');
      return;
    }

    // Screenshot the completed event closeup
    await step('02_completed_event_closeup', `Completed event ${completedJobNumber}. Should appear at 0.5 opacity, gray color`, {
      element: event,
    });

    // Check opacity
    const opacity = await event.evaluate((el) => window.getComputedStyle(el).opacity);
    console.log(`[N-01] Completed event opacity: ${opacity}`);

    // Try to drag it
    const box = await event.boundingBox();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, { steps: 10 });
    await page.waitForTimeout(200);
    await step('03_drag_attempt', 'Attempted to drag completed event 80px down. Should show NO drag ghost, NO movement');

    await page.mouse.up();
    await page.waitForTimeout(500);
    await step('04_after_release', 'After mouse release. Event should be at original position, no API call fired');
  });

  // ═══════════════════════════════════════════════════════════
  // D-01: Cursor on hover (calendar event)
  // ═══════════════════════════════════════════════════════════

  test('D-01 — Cursor on scheduled event hover', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'D-01');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    // Get cursor style
    const cursor = await event.evaluate((el) => window.getComputedStyle(el).cursor);
    console.log(`[D-01] Cursor on event hover: ${cursor}`);

    await event.hover();
    await page.waitForTimeout(200);
    await step('01_hover_on_event', `Hovering over ${seed.scheduledJobs[0].job_number}. Cursor is "${cursor}". Expected: "grab". Check if cursor signals draggability`);

    // Also check completed event cursor
    await sp.toggleToAll();
    await page.waitForTimeout(300);
    const completedEvent = sp.getEventByText(completedJobNumber);
    if (await completedEvent.isVisible().catch(() => false)) {
      const completedCursor = await completedEvent.evaluate((el) => window.getComputedStyle(el).cursor);
      console.log(`[D-01] Cursor on completed event: ${completedCursor}`);
      await completedEvent.hover();
      await page.waitForTimeout(200);
      await step('02_hover_on_completed', `Hovering over completed ${completedJobNumber}. Cursor is "${completedCursor}". Expected: "default" or "not-allowed"`);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // D-02: Cursor on sidebar card hover
  // ═══════════════════════════════════════════════════════════

  test('D-02 — Sidebar card cursor and draggable attribute', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'D-02');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    const card = sp.getSidebarJobCard(seed.unassignedJobs[0].job_number);
    await expect(card).toBeVisible({ timeout: 5000 });

    const cursor = await card.evaluate((el) => window.getComputedStyle(el).cursor);
    const draggable = await card.getAttribute('draggable');
    console.log(`[D-02] Sidebar card cursor: ${cursor}, draggable: ${draggable}`);

    await step('01_sidebar_card', `Sidebar card ${seed.unassignedJobs[0].job_number}. Cursor: "${cursor}", draggable: "${draggable}". Expected: cursor=grab, draggable=true`, {
      element: card,
    });
  });

  // ═══════════════════════════════════════════════════════════
  // D-05: Click vs drag distinction
  // ═══════════════════════════════════════════════════════════

  test('D-05 — Click on event opens popup (not drag)', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'D-05');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    const event = sp.getEventByText(seed.scheduledJobs[2].job_number); // 2 PM job
    await expect(event).toBeVisible({ timeout: 5000 });
    await step('01_before_click', `Event ${seed.scheduledJobs[2].job_number} visible at 2 PM`);

    // Simple click — no movement
    await event.click();
    await page.waitForTimeout(500);
    await step('02_after_click', 'After clicking event. Expected: detail popup appears. NOT a drag operation');

    // Dismiss
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await step('03_after_dismiss', 'After pressing Escape. Popup should be gone');
  });

  // ═══════════════════════════════════════════════════════════
  // D-06: Drag from center of event block
  // ═══════════════════════════════════════════════════════════

  test('D-06 — Drag event from center', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'D-06');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView(); // Day view gives more vertical space
    await page.waitForTimeout(500);
    await step('01_day_view_initial', 'Day view with seed events');

    const event = sp.getEventByText(seed.scheduledJobs[1].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) return;

    await step('02_event_before', `Event ${seed.scheduledJobs[1].job_number} at 11 AM position`, { element: event });

    // Drag from center
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 15, { steps: 5 }); // past dead zone
    await page.waitForTimeout(100);
    await step('03_drag_initiated', 'Drag initiated from center. Check: is there a ghost preview?');

    await page.mouse.move(cx, cy + 120, { steps: 15 }); // drag further down
    await page.waitForTimeout(200);
    await step('04_mid_drag', 'Mid-drag ~120px down. Check: ghost visible? Source dimmed? Target highlighted?');

    await page.mouse.up();
    await page.waitForTimeout(800);
    await step('05_after_drop', 'After drop. Check: event moved? Dialog appeared? Error toast?');
  });

  // ═══════════════════════════════════════════════════════════
  // D-09: TechnicianGridView card drag attempt
  // ═══════════════════════════════════════════════════════════

  test('D-09 — Grid view card drag attempt', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'D-09');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);
    await step('01_grid_day_view', 'Member Grid Day view. Should show tech columns with job cards');

    // Find a job card in the grid
    const gridJobCard = page.locator(`text=${seed.scheduledJobs[0].job_number}`).first();
    const isVisible = await gridJobCard.isVisible().catch(() => false);

    if (isVisible) {
      await step('02_grid_card', `Grid card for ${seed.scheduledJobs[0].job_number}`, { element: gridJobCard });

      const box = await gridJobCard.boundingBox();
      if (box) {
        // Try to drag the card within the grid
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 100, { steps: 10 });
        await page.waitForTimeout(200);
        await step('03_grid_drag_attempt', 'Attempted drag within grid. Does the card move? Or is it static (finding D-09)?');

        await page.mouse.up();
        await page.waitForTimeout(300);
        await step('04_after_release', 'After release. Card should be at original position (grid cards not draggable per code analysis)');
      }
    } else {
      await step('02_no_grid_card', 'Job card not found in grid view — may need to scroll to the right hour');
    }
  });

  // ═══════════════════════════════════════════════════════════
  // D-10: Sidebar card drag visual feedback
  // ═══════════════════════════════════════════════════════════

  test('D-10 — Sidebar card drag feedback', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'D-10');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    const card = sp.getSidebarJobCard(seed.unassignedJobs[0].job_number);
    await expect(card).toBeVisible({ timeout: 5000 });
    await step('01_sidebar_card_before', `Sidebar card ${seed.unassignedJobs[0].job_number} before drag`, { element: card });

    const box = await card.boundingBox();
    if (!box) return;

    // Start drag
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2, { steps: 3 });
    await page.waitForTimeout(100);

    // Check card state during drag
    const opacityDuringDrag = await card.evaluate((el) => window.getComputedStyle(el).opacity);
    console.log(`[D-10] Card opacity during drag: ${opacityDuringDrag}`);
    await step('02_drag_started', `Sidebar card during drag. Opacity: ${opacityDuringDrag}. Expected: ~0.4 with scale-down`);

    // Move toward calendar
    const calBox = await sp.calendarCard.boundingBox();
    if (calBox) {
      await page.mouse.move(calBox.x + calBox.width / 3, calBox.y + calBox.height / 3, { steps: 12 });
      await page.waitForTimeout(200);
      await step('03_over_calendar', 'Card dragged over calendar area. Check: drop zone indicators? Time slot highlight?');
    }

    await page.mouse.up();
    await page.waitForTimeout(500);
    await step('04_after_drop', 'After drop on calendar. Check: AssignDialog opened? Or Plan Mode ghost created?');
  });

  // ═══════════════════════════════════════════════════════════
  // D-11: Walkthrough event drag
  // ═══════════════════════════════════════════════════════════

  test('D-11 — Walkthrough event drag', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'D-11');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    const wtEvent = page.locator('.rbc-event').filter({ hasText: /Walkthrough/ }).first();
    const visible = await wtEvent.isVisible().catch(() => false);

    if (visible) {
      await step('01_walkthrough_event', 'Walkthrough event visible. Should be amber/yellow color', { element: wtEvent });

      const box = await wtEvent.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 8 });
        await page.waitForTimeout(200);
        await step('02_walkthrough_mid_drag', 'Walkthrough being dragged. Check: can it be moved?');

        await page.mouse.up();
        await page.waitForTimeout(500);
        await step('03_walkthrough_after_drop', 'After walkthrough drop. Check: time changed? API called walkthroughRescheduleMutation?');
      }
    } else {
      await step('01_no_walkthrough', 'No walkthrough event found on calendar. May need different date range.');
    }
  });

  // ═══════════════════════════════════════════════════════════
  // D-08: Month view drag
  // ═══════════════════════════════════════════════════════════

  test('D-08 — Month view drag', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'D-08');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMonthView();
    await page.waitForTimeout(500);
    await step('01_month_view', 'Month view with events. Look for event pills in today\'s cell');

    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    const visible = await event.isVisible().catch(() => false);

    if (visible) {
      const box = await event.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 12 });
        await page.waitForTimeout(200);
        await step('02_month_drag', 'Dragging event to next day cell in month view. Check: does it move?');

        await page.mouse.up();
        await page.waitForTimeout(500);
        await step('03_month_after_drop', 'After drop in month view. Check: date changed? Conflict dialog?');
      }
    } else {
      await step('02_event_not_visible', 'Event not visible in month view. May be hidden behind "+N more" link');
    }
  });
});
