/**
 * Day 2 — H-Category: Edge Cases (H-01 to H-18)
 * Screenshot-Verify-Proceed protocol on every step.
 *
 * Tests error states, conflict flow, Plan Mode, rapid drags, network failure.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import { type ScheduleSeed, seedScheduleData } from '../helpers/schedule-seed';
import { createStepCapture } from '../helpers/capture-step';
import { createUrgentJob, assignJob, startJob, completeJob, deleteJob } from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');

test.use({
  storageState: authFile,
  viewport: { width: 1920, height: 1080 },
});

test.describe.serial('Day 2 — H-Category Edge Cases', () => {
  let seed: ScheduleSeed;
  const extraJobIds: string[] = [];

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'd2h' });
  });

  test.afterAll(async () => {
    for (const id of extraJobIds) await deleteJob(seed.token, id).catch(() => {});
    await seed.cleanup();
  });

  // ═══════════════════════════════════════════════════════════
  // H-05: Network failure on drop
  // ═══════════════════════════════════════════════════════════

  test('H-05 — Network failure on drop reverts event', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'H-05');

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

    await step('01_before', `${jobNum} at original position`);

    // Block API calls
    await page.route('**/api/jobs/*/assign', (route) => route.abort('failed'));

    // Drag event down
    const cx = origBox.x + origBox.width / 2;
    const cy = origBox.y + origBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 15, { steps: 3 });
    await page.mouse.move(cx, cy + 120, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    await step('02_after_failed_drop', 'After drop with network blocked. Check: error toast? Event reverted?');

    // Check for error toast
    const errorToast = page.locator('[role="status"], [data-sonner-toast]').first();
    const toastVisible = await errorToast.isVisible().catch(() => false);
    console.log(`[H-05] Error toast visible: ${toastVisible}`);

    // Check if event reverted
    const afterBox = await event.boundingBox();
    if (afterBox) {
      const delta = Math.abs(afterBox.y - origBox.y);
      console.log(`[H-05] Position delta after failed drop: ${delta}px`);
    }

    await step('03_final_state', 'Final state after network failure');

    // Unblock
    await page.unroute('**/api/jobs/*/assign');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════════════════════
  // H-13/H-14: Plan Mode ghost creation and discard
  // ═══════════════════════════════════════════════════════════

  test('H-13/H-14 — Plan Mode: create ghost, then discard', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'H-13');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    // Activate Plan Mode
    await sp.clickPlanMode();
    await page.waitForTimeout(500);
    await step('01_plan_mode_active', 'Plan Mode activated. Check: banner visible? "Planning" button?');

    // Check banner
    const bannerVisible = await sp.planModeBanner.isVisible().catch(() => false);
    console.log(`[H-13] Plan mode banner visible: ${bannerVisible}`);

    // Drag a calendar event to create a "moved" ghost
    const jobNum = seed.scheduledJobs[1].job_number;
    const event = sp.getEventByText(jobNum);
    if (await event.isVisible().catch(() => false)) {
      const box = await event.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 15, { steps: 3 });
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(500);
        await step('02_ghost_created', 'Dragged event in Plan Mode. Check: ghost event created? Dashed border?');
      }
    }

    // Check banner ghost count
    const bannerText = await sp.planModeBanner.textContent().catch(() => '');
    console.log(`[H-13] Banner text: ${bannerText}`);
    await step('03_banner_count', `Plan mode banner says: "${bannerText}"`);

    // Right-click ghost to get context menu
    const ghosts = sp.getGhostEvents();
    const ghostCount = await ghosts.count();
    console.log(`[H-13] Ghost events found: ${ghostCount}`);

    if (ghostCount > 0) {
      await ghosts.first().click({ button: 'right' });
      await page.waitForTimeout(300);
      await step('04_ghost_context_menu', 'Right-clicked ghost. Check: Confirm/Discard options?');

      // Look for Discard option
      const discardItem = page.getByText('Discard', { exact: false });
      if (await discardItem.isVisible().catch(() => false)) {
        await discardItem.click();
        await page.waitForTimeout(500);
        await step('05_after_discard', 'Clicked Discard. Ghost should be removed.');

        const ghostsAfter = await sp.getGhostEvents().count();
        console.log(`[H-14] Ghosts after discard: ${ghostsAfter}`);
      }
    }

    // Deactivate Plan Mode
    await sp.clickPlanMode();
    await page.waitForTimeout(500);
    await step('06_plan_mode_off', 'Plan Mode deactivated');
  });

  // ═══════════════════════════════════════════════════════════
  // H-17: Plan Mode persistence after reload
  // ═══════════════════════════════════════════════════════════

  test('H-17 — Plan Mode persists after page reload', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'H-17');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    // Activate Plan Mode
    await sp.clickPlanMode();
    await page.waitForTimeout(500);
    const bannerBefore = await sp.planModeBanner.isVisible().catch(() => false);
    await step('01_before_reload', `Plan Mode active: ${bannerBefore}`);

    // Reload page
    await page.reload();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await page.waitForTimeout(500);

    // Check if Plan Mode survived reload
    const bannerAfter = await sp.planModeBanner.isVisible().catch(() => false);
    console.log(`[H-17] Plan mode after reload: ${bannerAfter}`);
    await step('02_after_reload', `Plan Mode after reload: ${bannerAfter}. Expected: persisted via localStorage.`);

    // Check localStorage
    const planKeys = await page.evaluate(() =>
      Object.keys(localStorage).filter(k => k.toLowerCase().includes('plan'))
    );
    console.log(`[H-17] Plan mode localStorage keys: ${JSON.stringify(planKeys)}`);

    // Cleanup
    if (bannerAfter) {
      await sp.clickPlanMode();
      await page.waitForTimeout(300);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // H-18: Drop at exact slot boundary
  // ═══════════════════════════════════════════════════════════

  test('H-18 — Drop at exact slot boundary', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'H-18');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);
    await step('01_initial', 'Day view loaded');

    const jobNum = seed.scheduledJobs[2].job_number; // 2 PM
    const event = sp.getEventByText(jobNum);
    await expect(event).toBeVisible({ timeout: 5000 });

    // Find the exact position of a time slot marker (e.g., 3:00 PM line)
    // In react-big-calendar, time slots are at fixed pixel intervals
    const box = await event.boundingBox();
    if (!box) return;

    // Drag to a position that aligns with a 30-min boundary
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 15, { steps: 3 });
    // Move exactly ~50px (approximately one 30-min slot)
    await page.mouse.move(cx, cy + 50, { steps: 8 });
    await page.waitForTimeout(100);
    await step('02_at_boundary', 'Dragged to approximate 30-min slot boundary');

    await page.mouse.up();
    await page.waitForTimeout(1000);
    await step('03_after_drop', 'After drop at boundary. Check: time snapped to exact 30-min increment?');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════════════════════
  // L-05b: Context menu "Mark In Progress" action
  // ═══════════════════════════════════════════════════════════

  test('L-05b — Context menu Mark In Progress', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'L-05b');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    // Find a SCHEDULED event (not the completed one)
    const jobNum = seed.scheduledJobs[0].job_number;
    const event = sp.getEventByText(jobNum);
    await expect(event).toBeVisible({ timeout: 5000 });

    await step('01_before_right_click', `${jobNum} before right-click`);

    // Right-click for context menu
    await event.click({ button: 'right' });
    await page.waitForTimeout(300);
    await step('02_context_menu', 'Context menu opened. Check: what actions are available?');

    // Look for "Mark In Progress" or "Start" action
    const startAction = page.getByText(/Mark In Progress|Start/i).first();
    const startVisible = await startAction.isVisible().catch(() => false);
    console.log(`[L-05b] "Mark In Progress" visible: ${startVisible}`);

    if (startVisible) {
      await startAction.click();
      await page.waitForTimeout(1000);
      await step('03_after_start', 'Clicked Mark In Progress. Check: event color changed to green? Status updated?');
    } else {
      await step('03_no_action', '"Mark In Progress" not found in context menu');
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════════════════════
  // L-05c: Context menu "Reassign" action
  // ═══════════════════════════════════════════════════════════

  test('L-05c — Context menu Reassign opens dialog', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'L-05c');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    const jobNum = seed.scheduledJobs[1].job_number;
    const event = sp.getEventByText(jobNum);
    await expect(event).toBeVisible({ timeout: 5000 });

    await event.click({ button: 'right' });
    await page.waitForTimeout(300);
    await step('01_context_menu', 'Context menu for reassign test');

    // Look for "Reassign" or similar action
    const reassignAction = page.getByText(/Reassign|Reschedule/i).first();
    const reassignVisible = await reassignAction.isVisible().catch(() => false);
    console.log(`[L-05c] "Reassign" visible: ${reassignVisible}`);

    if (reassignVisible) {
      await reassignAction.click();
      await page.waitForTimeout(800);
      await step('02_assign_dialog', 'Clicked Reassign. Check: AssignDialog opened?');
    } else {
      await step('02_no_action', '"Reassign" not found in context menu');
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });
});
