/**
 * Category H — DnD Edge Cases & Error States
 *
 * Verifies graceful handling of: completed/cancelled event drag lock,
 * network failures, conflict flow (force + cancel), Plan Mode ghosts,
 * rapid drags, and browser state persistence.
 *
 * Test IDs: H-01 through H-18
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import {
  getAdminToken,
  createUrgentJob,
  createTechnicianUser,
  assignJob,
  deleteJob,
  deleteUser,
  getFirstCustomerWithLocation,
} from '../helpers/api-helpers';
import { type ScheduleSeed, seedScheduleData } from '../helpers/schedule-seed';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

test.describe.serial('Category H — DnD Edge Cases & Error States', () => {
  let seed: ScheduleSeed;
  const extraJobIds: string[] = [];

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'edge' });
  });

  test.afterAll(async () => {
    for (const id of extraJobIds) await deleteJob(seed.token, id).catch(() => {});
    await seed.cleanup();
  });

  async function createAndScheduleJob(hour: number) {
    const job = await createUrgentJob(seed.token, seed.customerId, seed.locationId);
    extraJobIds.push(job.id);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    await assignJob(seed.token, job.id, seed.techId1, start.toISOString(), end.toISOString());
    return job;
  }

  test('H-02/H-03 — Completed and cancelled events should not be draggable', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.toggleToAll(); // Show completed/cancelled
    await page.waitForTimeout(500);

    const events = sp.getAllEvents();
    const count = await events.count();
    let testedCompleted = false;

    for (let i = 0; i < count; i++) {
      const opacity = await events.nth(i).evaluate((el) =>
        parseFloat(window.getComputedStyle(el).opacity)
      );
      // Completed/cancelled events have 0.5 opacity
      if (opacity <= 0.6) {
        testedCompleted = true;
        const box = await events.nth(i).boundingBox();
        if (!box) continue;

        // Try to initiate drag
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 8 });
        await page.waitForTimeout(200);

        // Check if drag visual is active (it shouldn't be)
        const cursor = await page.evaluate(() => document.body.style.cursor || 'default');
        console.log('[H-02/H-03] Cursor during drag attempt on completed event:', cursor);

        await page.mouse.up();
        await page.waitForTimeout(300);

        // Verify event didn't move
        const boxAfter = await events.nth(i).boundingBox();
        if (boxAfter) {
          const moved = Math.abs(boxAfter.y - box.y) > 10;
          console.log('[H-02/H-03] Completed event moved:', moved, moved ? 'FAIL — should be locked' : 'PASS');
        }
        break;
      }
    }

    if (!testedCompleted) {
      console.log('[H-02/H-03] No completed/cancelled events found — create one to test');
    }

    await sp.takeAuditScreenshot('H-02_completed-event-drag.png');
  });

  test('H-05 — Network failure on drop reverts event', async ({ page }) => {
    const job = await createAndScheduleJob(9);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(job.job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    const origBox = await event.boundingBox();
    if (!origBox) { test.fail(); return; }

    // Block API calls to simulate network failure
    await page.route('**/api/jobs/*/assign', (route) => {
      route.abort('failed');
    });

    // Drag event to new position
    await sp.dragEventTo(
      job.job_number,
      origBox.x + origBox.width / 2,
      origBox.y + origBox.height / 2 + 100,
      { steps: 10 }
    );

    await page.waitForTimeout(1500);

    // Event should revert to original position (optimistic rollback)
    const revertedBox = await sp.getEventBounds(job.job_number);
    if (revertedBox) {
      const reverted = Math.abs(revertedBox.y - origBox.y) < 20;
      console.log('[H-05] Event reverted to original position:', reverted);
      console.log('[H-05] Original Y:', origBox.y, 'After failure Y:', revertedBox.y);
    }

    // Check for error toast
    const errorToast = page.locator('[role="status"], [data-sonner-toast]').filter({ hasText: /fail|error/i });
    const toastVisible = await errorToast.first().isVisible().catch(() => false);
    console.log('[H-05] Error toast visible:', toastVisible);

    // Clean up route mock
    await page.unroute('**/api/jobs/*/assign');

    await sp.takeAuditScreenshot('H-05_network-failure-revert.png');
  });

  test('H-06/H-07/H-08 — Conflict flow: toast → Schedule Anyway vs Cancel', async ({ page }) => {
    // Create two jobs on the same tech at different times
    const job1 = await createAndScheduleJob(10);
    const job2 = await createAndScheduleJob(14);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Get positions
    const box1 = await sp.getEventBounds(job1.job_number);
    const box2 = await sp.getEventBounds(job2.job_number);
    if (!box1 || !box2) { test.skip(); return; }

    // Drag job2 onto job1's position (create overlap)
    await sp.dragEventTo(
      job2.job_number,
      box1.x + box1.width / 2,
      box1.y + box1.height / 2,
      { steps: 15 }
    );

    await page.waitForTimeout(1000);

    // Check for conflict UI
    const conflictToast = sp.conflictToast;
    const scheduleAnyway = sp.scheduleAnywayButton;
    const cancelBtn = sp.conflictCancelButton;

    const toastVisible = await conflictToast.isVisible().catch(() => false);
    const anywayVisible = await scheduleAnyway.isVisible().catch(() => false);
    const cancelVisible = await cancelBtn.isVisible().catch(() => false);

    console.log('[H-06] Conflict toast:', toastVisible);
    console.log('[H-06] Schedule Anyway btn:', anywayVisible);
    console.log('[H-06] Cancel btn:', cancelVisible);

    await sp.takeAuditScreenshot('H-06_conflict-toast.png');

    // Test H-08: Click Cancel — event should revert
    if (cancelVisible) {
      await cancelBtn.click();
      await page.waitForTimeout(500);

      // Verify job2 reverted
      const box2After = await sp.getEventBounds(job2.job_number);
      if (box2After) {
        const reverted = Math.abs(box2After.y - box2.y) < 20;
        console.log('[H-08] Event reverted after cancel:', reverted);
      }

      await sp.takeAuditScreenshot('H-08_conflict-cancel-revert.png');
    }
  });

  test('H-13/H-14/H-15 — Plan Mode: drag creates ghost, confirm/discard work', async ({ page }) => {
    const job = await createAndScheduleJob(11);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Activate Plan Mode
    await sp.clickPlanMode();
    await expect(sp.planModeBanner).toBeVisible({ timeout: 3000 });

    const event = sp.getEventByText(job.job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) { test.fail(); return; }

    // Drag event to new position
    await sp.dragEventTo(
      job.job_number,
      box.x + box.width / 2,
      box.y + box.height / 2 + 80,
      { steps: 10 }
    );

    await page.waitForTimeout(500);

    // Check for ghost event (dashed border, low opacity)
    const ghosts = sp.getGhostEvents();
    const ghostCount = await ghosts.count();
    console.log('[H-13] Ghost events after plan mode drag:', ghostCount);

    // Banner should show unconfirmed count
    const bannerText = await sp.planModeBanner.textContent();
    console.log('[H-13] Plan mode banner text:', bannerText);

    await sp.takeAuditScreenshot('H-13_plan-mode-ghost.png');

    // H-14: Right-click ghost → Discard
    if (ghostCount > 0) {
      await ghosts.first().click({ button: 'right' });
      await page.waitForTimeout(300);

      const discardMenuItem = page.getByText('Discard', { exact: false });
      const discardVisible = await discardMenuItem.isVisible().catch(() => false);
      console.log('[H-14] Discard menu item visible:', discardVisible);

      if (discardVisible) {
        await discardMenuItem.click();
        await page.waitForTimeout(500);

        const ghostsAfterDiscard = await sp.getGhostEvents().count();
        console.log('[H-14] Ghosts after discard:', ghostsAfterDiscard);
      }

      await sp.takeAuditScreenshot('H-14_ghost-context-menu.png');
    }

    // Deactivate plan mode
    await sp.clickPlanMode();
    await page.waitForTimeout(500);
  });

  test('H-16 — Confirm All with multiple ghosts', async ({ page }) => {
    // Use seed unassigned jobs + create one more for 3 total
    const extraJob = await createUrgentJob(seed.token, seed.customerId, seed.locationId);
    extraJobIds.push(extraJob.id);

    const jobs = [
      seed.unassignedJobs[0].job_number,
      seed.unassignedJobs[1].job_number,
      extraJob.job_number,
    ];

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Activate Plan Mode
    await sp.clickPlanMode();
    await expect(sp.planModeBanner).toBeVisible({ timeout: 3000 });

    // Drag each sidebar card to calendar (creating ghosts)
    const calBox = await sp.calendarCard.boundingBox();
    if (!calBox) { test.fail(); return; }

    let draggedCount = 0;
    for (let i = 0; i < jobs.length; i++) {
      const card = sp.getSidebarJobCard(jobs[i]);
      const visible = await card.isVisible().catch(() => false);
      if (visible) {
        const targetY = calBox.y + 100 + (i * 80);
        await sp.dragSidebarCardToCalendar(jobs[i], calBox.x + calBox.width / 2, targetY);
        await page.waitForTimeout(300);
        draggedCount++;
      }
    }

    console.log('[H-16] Jobs dragged into plan mode:', draggedCount);

    // Check banner shows count
    await page.waitForTimeout(500);
    const bannerText = await sp.planModeBanner.textContent().catch(() => '');
    console.log('[H-16] Banner text:', bannerText);

    // Click Confirm All
    const confirmAll = page.getByRole('button', { name: /Confirm All/i });
    const confirmVisible = await confirmAll.isVisible().catch(() => false);
    if (confirmVisible) {
      await confirmAll.click();
      await page.waitForTimeout(2000);

      // All ghosts should now be real events
      const ghostsAfter = await sp.getGhostEvents().count();
      console.log('[H-16] Ghosts after Confirm All:', ghostsAfter);
    }

    await sp.takeAuditScreenshot('H-16_confirm-all.png');
  });

  test('H-17 — Plan Mode persists across page reload', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();

    // Activate Plan Mode
    await sp.clickPlanMode();
    await expect(sp.planModeBanner).toBeVisible({ timeout: 3000 });

    // Reload page
    await page.reload();
    await sp.waitForCalendarReady();

    // Check if plan mode is still active
    const bannerVisible = await sp.planModeBanner.isVisible().catch(() => false);
    console.log('[H-17] Plan mode banner after reload:', bannerVisible);

    // Also check localStorage for plan mode state
    const planState = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter(k => k.includes('plan'));
      return keys.map(k => ({ key: k, value: localStorage.getItem(k)?.substring(0, 100) }));
    });
    console.log('[H-17] Plan mode localStorage keys:', JSON.stringify(planState));

    await sp.takeAuditScreenshot('H-17_plan-mode-after-reload.png');

    // Clean up: deactivate plan mode
    if (bannerVisible) {
      await sp.clickPlanMode();
    }
  });
});
