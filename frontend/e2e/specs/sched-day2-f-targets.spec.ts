/**
 * Day 2 — F-Category: Drop Targets (F-01 to F-14)
 * Screenshot-Verify-Proceed protocol on every step.
 *
 * Tests every valid drag source→target combination with before/during/after screenshots.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import { type ScheduleSeed, seedScheduleData } from '../helpers/schedule-seed';
import { createStepCapture } from '../helpers/capture-step';
import { createUrgentJob, assignJob, deleteJob } from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');

test.use({
  storageState: authFile,
  viewport: { width: 1920, height: 1080 },
});

test.describe.serial('Day 2 — F-Category Drop Targets', () => {
  let seed: ScheduleSeed;
  const extraJobIds: string[] = [];

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'd2f' });
  });

  test.afterAll(async () => {
    for (const id of extraJobIds) await deleteJob(seed.token, id).catch(() => {});
    await seed.cleanup();
  });

  async function createJobAt(hour: number, techId?: string) {
    const job = await createUrgentJob(seed.token, seed.customerId, seed.locationId);
    extraJobIds.push(job.id);
    if (techId) {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0);
      const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
      await assignJob(seed.token, job.id, techId, start.toISOString(), end.toISOString());
    }
    return job;
  }

  // ═══════════════════════════════════════════════════════════
  // F-01: Same day, different time (vertical drag)
  // ═══════════════════════════════════════════════════════════

  test('F-01 — Same day, different time', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'F-01');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);
    await step('01_initial', 'Day view with seed events');

    const jobNum = seed.scheduledJobs[0].job_number; // 9 AM
    const event = sp.getEventByText(jobNum);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) return;

    await step('02_before_drag', `Event ${jobNum} at 9 AM position`, { element: event });

    // Drag down ~150px (approximately 2-3 hours)
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 15, { steps: 5 });
    await page.mouse.move(cx, cy + 150, { steps: 15 });
    await page.waitForTimeout(200);
    await step('03_mid_drag', 'Dragging down ~150px. Check: ghost visible? Target slot highlighted?');

    await page.mouse.up();
    await page.waitForTimeout(1000);
    await step('04_after_drop', 'After drop. Check: event moved? Conflict dialog? Error?');

    // Dismiss any dialog
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════════════════════
  // F-02: Different day, same time (horizontal drag)
  // ═══════════════════════════════════════════════════════════

  test('F-02 — Different day, same time', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'F-02');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    const jobNum = seed.scheduledJobs[1].job_number; // 11 AM
    const event = sp.getEventByText(jobNum);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) return;

    await step('01_before', `${jobNum} at 11 AM, current day column`);

    // Drag horizontally ~150px (one day column)
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 15, cy, { steps: 5 });
    await page.mouse.move(cx + 150, cy, { steps: 15 });
    await page.waitForTimeout(200);
    await step('02_mid_drag', 'Dragging horizontally to next day. Same time slot.');

    await page.mouse.up();
    await page.waitForTimeout(1000);
    await step('03_after_drop', 'After horizontal drop. Check: date changed? Same time?');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════════════════════
  // F-03: Diagonal drag (different day + different time)
  // ═══════════════════════════════════════════════════════════

  test('F-03 — Diagonal drag', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'F-03');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    const jobNum = seed.scheduledJobs[2].job_number; // 2 PM
    const event = sp.getEventByText(jobNum);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) return;

    await step('01_before', `${jobNum} at 2 PM`);

    // Diagonal: right + up
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 10, cy - 10, { steps: 3 });
    await page.mouse.move(cx + 150, cy - 100, { steps: 15 });
    await page.waitForTimeout(200);
    await step('02_mid_drag', 'Diagonal drag: right + up. Different day, earlier time.');

    await page.mouse.up();
    await page.waitForTimeout(1000);
    await step('03_after_drop', 'After diagonal drop. Check: both date and time changed?');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════════════════════
  // F-07: Sidebar → Week view (already verified by Ran, capture screenshots)
  // ═══════════════════════════════════════════════════════════

  test('F-07 — Sidebar to Week view calendar', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'F-07');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    const jobNum = seed.unassignedJobs[0].job_number;
    const card = sp.getSidebarJobCard(jobNum);

    if (await card.isVisible().catch(() => false)) {
      await step('01_sidebar_card', `Unassigned job ${jobNum} in sidebar`, { element: card });

      const cardBox = await card.boundingBox();
      if (!cardBox) return;

      // Drag toward calendar
      const calBox = await sp.calendarCard.boundingBox();
      if (!calBox) return;

      await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(cardBox.x + cardBox.width / 2 + 10, cardBox.y, { steps: 3 });
      await page.mouse.move(calBox.x + calBox.width / 3, calBox.y + 300, { steps: 15 });
      await page.waitForTimeout(300);
      await step('02_over_calendar', 'Card dragged over calendar. Check: drop preview visible?');

      await page.mouse.up();
      await page.waitForTimeout(800);
      await step('03_after_drop', 'After drop. Check: AssignDialog opened? Times correct?');

      // Dismiss dialog
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } else {
      await step('01_no_card', 'Sidebar card not visible');
    }
  });

  // ═══════════════════════════════════════════════════════════
  // F-09: Sidebar → Grid tech column
  // ═══════════════════════════════════════════════════════════

  test('F-09 — Sidebar to Grid tech column', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'F-09');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);
    await step('01_grid_view', 'Member Grid Day view with tech columns');

    const jobNum = seed.unassignedJobs[1].job_number;
    const card = sp.getSidebarJobCard(jobNum);

    if (await card.isVisible().catch(() => false)) {
      const cardBox = await card.boundingBox();
      if (!cardBox) return;

      // Find a drop zone in the grid
      const dropZones = sp.getGridDropZones();
      const zoneCount = await dropZones.count();
      await step('02_drop_zones', `Grid has ${zoneCount} drop zones`);

      if (zoneCount > 5) {
        const zoneBox = await dropZones.nth(5).boundingBox(); // ~11 AM slot
        if (zoneBox) {
          await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
          await page.mouse.down();
          await page.mouse.move(cardBox.x + cardBox.width / 2 + 5, cardBox.y, { steps: 3 });
          await page.mouse.move(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height / 2, { steps: 15 });
          await page.waitForTimeout(300);
          await step('03_over_grid', 'Card over grid drop zone. Check: "Drop here" label?');

          await page.mouse.up();
          await page.waitForTimeout(800);
          await step('04_after_drop', 'After drop on grid. Check: AssignDialog or direct assign?');

          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }
      }
    } else {
      await step('02_no_card', 'Sidebar card not visible');
    }
  });

  // ═══════════════════════════════════════════════════════════
  // F-12: Drop on exact same position (no-op)
  // ═══════════════════════════════════════════════════════════

  test('F-12 — Drop on same position is no-op', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'F-12');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    const jobNum = seed.scheduledJobs[1].job_number;
    const event = sp.getEventByText(jobNum);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) return;

    // Track API calls
    let apiCalls = 0;
    page.on('request', (req) => {
      if (req.url().includes('/assign') && req.method() === 'POST') apiCalls++;
    });

    await step('01_before', `${jobNum} before same-position drag`);

    // Tiny drag and return
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 3, cy + 3, { steps: 2 });
    await page.mouse.move(cx, cy, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    console.log(`[F-12] API calls fired: ${apiCalls}`);
    await step('02_after', `After same-position drop. API calls: ${apiCalls}. Should be 0.`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════════════════════
  // F-13: Drop outside calendar bounds
  // ═══════════════════════════════════════════════════════════

  test('F-13 — Drop outside calendar bounds', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'F-13');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    const jobNum = seed.scheduledJobs[2].job_number;
    const event = sp.getEventByText(jobNum);
    await expect(event).toBeVisible({ timeout: 5000 });
    const origBox = await event.boundingBox();
    if (!origBox) return;

    await step('01_before', `${jobNum} at original position`);

    // Drag toward header (outside calendar time grid)
    const cx = origBox.x + origBox.width / 2;
    const cy = origBox.y + origBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 15, { steps: 3 });
    await page.mouse.move(cx, 50, { steps: 15 }); // Top of page — header area
    await page.waitForTimeout(200);
    await step('02_over_header', 'Event dragged to header area (outside calendar bounds)');

    await page.mouse.up();
    await page.waitForTimeout(500);
    await step('03_after_release', 'After release outside bounds. Event should snap back.');

    // Verify event is back at original position
    const afterBox = await event.boundingBox();
    if (afterBox) {
      const delta = Math.abs(afterBox.y - origBox.y);
      console.log(`[F-13] Position delta after outside drop: ${delta}px`);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // F-14: Drop onto conflicting slot
  // ═══════════════════════════════════════════════════════════

  test('F-14 — Drop onto conflicting slot', async ({ page }) => {
    // Create two jobs on same tech at different times
    const job1 = await createJobAt(8, seed.techId1);
    const job2 = await createJobAt(15, seed.techId1);

    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'F-14');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);
    await step('01_two_jobs', `Two jobs: ${job1.job_number} at 8AM, ${job2.job_number} at 3PM`);

    // Drag job2 onto job1's time (create overlap)
    const event2 = sp.getEventByText(job2.job_number);
    const event1 = sp.getEventByText(job1.job_number);
    if (!(await event2.isVisible().catch(() => false)) || !(await event1.isVisible().catch(() => false))) {
      await step('02_events_not_visible', 'One or both events not visible');
      return;
    }

    const box1 = await event1.boundingBox();
    const box2 = await event2.boundingBox();
    if (!box1 || !box2) return;

    await step('02_before_conflict_drag', `Will drag ${job2.job_number} (3PM) onto ${job1.job_number} (8AM)`);

    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await page.mouse.down();
    await page.mouse.move(box2.x + box2.width / 2, box2.y - 15, { steps: 3 });
    await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2, { steps: 15 });
    await page.waitForTimeout(200);
    await step('03_mid_drag_to_conflict', 'Dragging onto occupied slot');

    await page.mouse.up();
    await page.waitForTimeout(1000);
    await step('04_conflict_dialog', 'After drop. Check: conflict dialog? "Schedule Anyway" + "Cancel" buttons?');

    // Check for conflict dialog elements
    const scheduleAnyway = page.getByRole('button', { name: /Schedule Anyway/i });
    const cancelBtn = page.getByRole('button', { name: /Cancel/i });
    const saVisible = await scheduleAnyway.isVisible().catch(() => false);
    const cancelVisible = await cancelBtn.isVisible().catch(() => false);
    console.log(`[F-14] Schedule Anyway visible: ${saVisible}, Cancel visible: ${cancelVisible}`);

    // Click Cancel to revert
    if (cancelVisible) {
      await cancelBtn.click();
      await page.waitForTimeout(500);
      await step('05_after_cancel', 'Clicked Cancel. Event should revert to original position.');
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════════════════════
  // F-10: Sidebar → Month view
  // ═══════════════════════════════════════════════════════════

  test('F-10 — Sidebar to Month view', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'F-10');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMonthView();
    await page.waitForTimeout(500);
    await step('01_month_view', 'Month view with sidebar visible');

    // Check if unassigned cards exist (they may have been consumed by prior tests)
    const cards = sp.getSidebarDraggableCards();
    const count = await cards.count();
    console.log(`[F-10] Sidebar draggable cards: ${count}`);

    if (count > 0) {
      const card = cards.first();
      const cardBox = await card.boundingBox();
      if (!cardBox) return;

      // Find a day cell in month view
      const dayCells = page.locator('.rbc-date-cell');
      const cellCount = await dayCells.count();

      if (cellCount > 15) {
        const targetCell = dayCells.nth(15); // Mid-month cell
        const cellBox = await targetCell.boundingBox();
        if (cellBox) {
          await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
          await page.mouse.down();
          await page.mouse.move(cardBox.x + cardBox.width / 2 + 5, cardBox.y, { steps: 3 });
          await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2, { steps: 15 });
          await page.waitForTimeout(300);
          await step('02_over_month_cell', 'Card dragged over month day cell');

          await page.mouse.up();
          await page.waitForTimeout(800);
          await step('03_after_drop', 'After drop on month cell. Check: dialog? No time precision in month.');
        }
      }
    } else {
      await step('02_no_cards', 'No unassigned cards in sidebar (consumed by prior tests)');
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════════════════════
  // F-11: Calendar → sidebar (should be no-op)
  // ═══════════════════════════════════════════════════════════

  test('F-11 — Calendar to sidebar (no-op)', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'F-11');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    const jobNum = seed.scheduledJobs[0].job_number;
    const event = sp.getEventByText(jobNum);
    await expect(event).toBeVisible({ timeout: 5000 });
    const origBox = await event.boundingBox();
    if (!origBox) return;

    const sidebarBox = await sp.sidebar.boundingBox();
    if (!sidebarBox) return;

    await step('01_before', `${jobNum} on calendar, sidebar on left`);

    // Drag toward the sidebar
    const cx = origBox.x + origBox.width / 2;
    const cy = origBox.y + origBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 15, cy, { steps: 3 });
    await page.mouse.move(sidebarBox.x + sidebarBox.width / 2, cy, { steps: 15 });
    await page.waitForTimeout(200);
    await step('02_over_sidebar', 'Event dragged over sidebar area. Should show not-allowed or no indicator.');

    await page.mouse.up();
    await page.waitForTimeout(500);
    await step('03_after_release', 'After release on sidebar. Event should snap back to calendar.');

    const afterBox = await event.boundingBox();
    if (afterBox) {
      const delta = Math.abs(afterBox.y - origBox.y);
      console.log(`[F-11] Position delta: ${delta}px (should be ~0)`);
    }
  });
});
