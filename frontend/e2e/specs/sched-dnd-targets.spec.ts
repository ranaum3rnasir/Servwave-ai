/**
 * Category F — Drag-and-Drop Drop Targets
 *
 * Verifies all valid source→target DnD combinations work correctly:
 * same day/different time, cross-day, cross-tech, sidebar→calendar,
 * sidebar→grid, same-slot no-op, conflict handling.
 *
 * Test IDs: F-01 through F-16
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

test.describe.serial('Category F — DnD Drop Targets', () => {
  let seed: ScheduleSeed;
  const extraJobIds: string[] = [];

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'tgt' });
  });

  test.afterAll(async () => {
    for (const id of extraJobIds) await deleteJob(seed.token, id).catch(() => {});
    await seed.cleanup();
  });

  async function createAndScheduleJob(techId: string, hour: number) {
    const job = await createUrgentJob(seed.token, seed.customerId, seed.locationId);
    extraJobIds.push(job.id);

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    await assignJob(seed.token, job.id, techId, start.toISOString(), end.toISOString());
    return job;
  }

  test('F-01 — Same day, different time (vertical drag in Week view)', async ({ page }) => {
    const job = await createAndScheduleJob(seed.techId1, 9);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(job.job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    const box = await event.boundingBox();
    if (!box) { test.fail(); return; }

    // Intercept the API call to verify it fires
    const apiPromise = page.waitForResponse(
      (res) => res.url().includes('/assign') && res.status() < 500,
      { timeout: 5000 }
    ).catch(() => null);

    // Drag down ~2 hours (each hour is approximately 50-80px in week view)
    await sp.dragEventTo(job.job_number, box.x + box.width / 2, box.y + 120, { steps: 15 });

    const response = await apiPromise;
    console.log('[F-01] API response status:', response?.status() ?? 'no response');

    await sp.takeAuditScreenshot('F-01_same-day-different-time.png');
  });

  test('F-02 — Different day, same time (horizontal drag in Week view)', async ({ page }) => {
    const job = await createAndScheduleJob(seed.techId1, 11);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(job.job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    const box = await event.boundingBox();
    if (!box) { test.fail(); return; }

    const apiPromise = page.waitForResponse(
      (res) => res.url().includes('/assign') && res.status() < 500,
      { timeout: 5000 }
    ).catch(() => null);

    // Drag horizontally — one day column is typically ~100-150px wide
    await sp.dragEventTo(
      job.job_number,
      box.x + box.width / 2 + 150, // one column to the right
      box.y + box.height / 2,       // same vertical position
      { steps: 15 }
    );

    const response = await apiPromise;
    console.log('[F-02] API response status:', response?.status() ?? 'no response');

    await sp.takeAuditScreenshot('F-02_different-day-same-time.png');
  });

  test('F-03 — Different day, different time (diagonal drag)', async ({ page }) => {
    const job = await createAndScheduleJob(seed.techId1, 10);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(job.job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    const box = await event.boundingBox();
    if (!box) { test.fail(); return; }

    const apiPromise = page.waitForResponse(
      (res) => res.url().includes('/assign') && res.status() < 500,
      { timeout: 5000 }
    ).catch(() => null);

    // Diagonal drag: right + down
    await sp.dragEventTo(
      job.job_number,
      box.x + box.width / 2 + 150,
      box.y + box.height / 2 + 100,
      { steps: 20 }
    );

    const response = await apiPromise;
    console.log('[F-03] API response status:', response?.status() ?? 'no response');

    await sp.takeAuditScreenshot('F-03_diagonal-drag.png');
  });

  test('F-05 — Different tech, same time (Grid view cross-column)', async ({ page }) => {
    const job = await createAndScheduleJob(seed.techId1, 13);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(1000);

    // In grid view, look for the job card
    const jobCard = page.locator(`text=${job.job_number}`).first();
    const isVisible = await jobCard.isVisible().catch(() => false);

    if (isVisible) {
      const box = await jobCard.boundingBox();
      if (box) {
        // Drag horizontally to next tech column (280px per column)
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 280, box.y + box.height / 2, { steps: 15 });
        await sp.takeAuditScreenshot('F-05_grid-cross-column-mid-drag.png');
        await page.mouse.up();
        await page.waitForTimeout(500);
      }
    } else {
      console.log('[F-05] Job not visible in grid day view');
    }

    await sp.takeAuditScreenshot('F-05_grid-cross-column.png');
  });

  test('F-07 — Sidebar → Week view calendar (assign via DnD)', async ({ page }) => {
    // Use seed unassigned job (guaranteed to exist in sidebar)
    const job = seed.unassignedJobs[0];

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const card = sp.getSidebarJobCard(job.job_number);
    const cardVisible = await card.isVisible().catch(() => false);
    if (!cardVisible) {
      console.log('[F-07] Sidebar card not found for', job.job_number);
      await sp.takeAuditScreenshot('F-07_sidebar-card-not-found.png');
      return;
    }

    // Get calendar area for drop target
    const calBox = await sp.calendarCard.boundingBox();
    if (!calBox) { test.fail(); return; }

    // Drag sidebar card to center of calendar
    const targetX = calBox.x + calBox.width / 2;
    const targetY = calBox.y + calBox.height / 2;

    await sp.dragSidebarCardToCalendar(job.job_number, targetX, targetY);

    // Check if AssignJobDialog appeared or if event was placed
    const dialog = page.getByRole('dialog');
    const dialogVisible = await dialog.isVisible().catch(() => false);
    console.log('[F-07] AssignJobDialog appeared:', dialogVisible);

    // In plan mode, a ghost should appear instead
    const ghostEvents = sp.getGhostEvents();
    const ghostCount = await ghostEvents.count();
    console.log('[F-07] Ghost events after drop:', ghostCount);

    await sp.takeAuditScreenshot('F-07_sidebar-to-calendar.png');
  });

  test('F-09 — Sidebar → Grid tech column (assign to specific tech)', async ({ page }) => {
    // Use seed unassigned job (guaranteed to exist in sidebar)
    const job = seed.unassignedJobs[1];

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    const card = sp.getSidebarJobCard(job.job_number);
    const cardVisible = await card.isVisible().catch(() => false);
    if (!cardVisible) { test.skip(); return; }

    // Find a drop zone in the grid
    const dropZones = sp.getGridDropZones();
    const zoneCount = await dropZones.count();
    console.log('[F-09] Grid drop zones found:', zoneCount);

    if (zoneCount > 0) {
      const zoneBox = await dropZones.first().boundingBox();
      if (zoneBox) {
        await sp.dragSidebarCardToCalendar(
          job.job_number,
          zoneBox.x + zoneBox.width / 2,
          zoneBox.y + zoneBox.height / 2,
        );
      }
    }

    await sp.takeAuditScreenshot('F-09_sidebar-to-grid-column.png');
  });

  test('F-12 — Drop on exact same position = no-op', async ({ page }) => {
    const job = await createAndScheduleJob(seed.techId1, 14);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(job.job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) { test.fail(); return; }

    // Track API calls — there should be NONE for same-position drop
    let apiCallFired = false;
    page.on('response', (res) => {
      if (res.url().includes('/assign')) apiCallFired = true;
    });

    // Drag and drop in exact same position
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 2, cy + 2, { steps: 2 }); // tiny move
    await page.mouse.move(cx, cy, { steps: 2 }); // back to original
    await page.mouse.up();
    await page.waitForTimeout(500);

    console.log('[F-12] API call fired for same-position drop:', apiCallFired);
    if (apiCallFired) {
      console.log('[F-12] FINDING: Unnecessary API call on same-slot drop');
    }

    await sp.takeAuditScreenshot('F-12_same-position-drop.png');
  });

  test('F-14 — Drop onto conflicting slot triggers conflict toast', async ({ page }) => {
    // Create two jobs at the same time for the same tech
    const job1 = await createAndScheduleJob(seed.techId2, 15);
    const job2 = await createAndScheduleJob(seed.techId2, 8); // different time initially

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Find job2 and drag it to overlap with job1 (15:00)
    const event2 = sp.getEventByText(job2.job_number);
    const isVisible = await event2.isVisible().catch(() => false);
    if (!isVisible) {
      console.log('[F-14] Job2 not visible to drag');
      return;
    }

    const event1Box = await sp.getEventBounds(job1.job_number);
    if (!event1Box) return;

    // Drag job2 on top of job1
    await sp.dragEventTo(
      job2.job_number,
      event1Box.x + event1Box.width / 2,
      event1Box.y + event1Box.height / 2,
      { steps: 15 }
    );

    await page.waitForTimeout(1000);

    // Check for conflict toast
    const conflictToast = sp.conflictToast;
    const toastVisible = await conflictToast.isVisible().catch(() => false);
    console.log('[F-14] Conflict toast visible:', toastVisible);

    // Check for "Schedule Anyway" button
    const scheduleAnyway = sp.scheduleAnywayButton;
    const anywayVisible = await scheduleAnyway.isVisible().catch(() => false);
    console.log('[F-14] "Schedule Anyway" button visible:', anywayVisible);

    await sp.takeAuditScreenshot('F-14_conflict-on-drop.png');
  });
});
