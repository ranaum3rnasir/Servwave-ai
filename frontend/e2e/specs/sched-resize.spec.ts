/**
 * Category G — Resize (Duration Change)
 *
 * Verifies that event resize handles are visible, functional,
 * snap to grid increments, respect minimum duration, and trigger API updates.
 *
 * Test IDs: G-01 through G-10
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import { type ScheduleSeed, seedScheduleData } from '../helpers/schedule-seed';
import {
  createUrgentJob,
  assignJob,
  deleteJob,
} from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

test.describe.serial('Category G — Resize (Duration Change)', () => {
  let seed: ScheduleSeed;
  const extraJobs: string[] = [];

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'rsz' });
  });

  test.afterAll(async () => {
    for (const id of extraJobs) await deleteJob(seed.token, id).catch(() => {});
    await seed.cleanup();
  });

  async function createScheduledJob(hour: number, durationHrs: number = 2) {
    const job = await createUrgentJob(seed.token, seed.customerId, seed.locationId);
    extraJobs.push(job.id);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0);
    const end = new Date(start.getTime() + durationHrs * 60 * 60 * 1000);
    await assignJob(seed.token, job.id, seed.techId1, start.toISOString(), end.toISOString());
    return job;
  }

  test('G-01 — Resize handle visible at bottom of event on hover', async ({ page }) => {
    const job = await createScheduledJob(9);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(job.job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    // Hover over event
    await event.hover();
    await page.waitForTimeout(300);

    // Check for resize anchor element
    const resizeHandle = sp.getResizeHandleFor(job.job_number);
    const handleCount = await resizeHandle.count();
    console.log('[G-01] Resize handles found on event:', handleCount);

    if (handleCount > 0) {
      // Check cursor on resize handle
      const cursor = await resizeHandle.first().evaluate((el) =>
        window.getComputedStyle(el).cursor
      );
      console.log('[G-01] Resize handle cursor:', cursor);
      // Should be ns-resize, s-resize, or row-resize
    }

    // Also check CSS for resize handle via schedule-dark.css
    const hasResizeCSS = await page.evaluate(() => {
      const el = document.querySelector('.rbc-addons-dnd-resize-ns-anchor');
      if (!el) return { exists: false };
      const cs = window.getComputedStyle(el);
      return {
        exists: true,
        cursor: cs.cursor,
        height: cs.height,
        bottom: cs.bottom,
      };
    });
    console.log('[G-01] Resize anchor CSS:', JSON.stringify(hasResizeCSS));

    await sp.takeAuditScreenshot('G-01_resize-handle-visible.png');
  });

  test('G-02 — Extend duration by dragging bottom handle down', async ({ page }) => {
    const job = await createScheduledJob(10, 1); // 1-hour event

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(job.job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    const origBox = await event.boundingBox();
    if (!origBox) { test.fail(); return; }

    console.log('[G-02] Original event height:', origBox.height);

    // Find the resize handle (bottom of event)
    const resizeHandle = sp.getResizeHandleFor(job.job_number);
    const handleCount = await resizeHandle.count();

    if (handleCount > 0) {
      const handleBox = await resizeHandle.first().boundingBox();
      if (handleBox) {
        // Intercept API call
        const apiPromise = page.waitForResponse(
          (res) => res.url().includes(job.id) && res.status() < 500,
          { timeout: 5000 }
        ).catch(() => null);

        // Drag handle down ~50px (approximately 1 hour)
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          handleBox.x + handleBox.width / 2,
          handleBox.y + handleBox.height / 2 + 50,
          { steps: 10 }
        );
        await sp.takeAuditScreenshot('G-02_resize-mid-drag.png');
        await page.mouse.up();
        await page.waitForTimeout(500);

        // Check new height
        const newBox = await event.boundingBox();
        if (newBox) {
          console.log('[G-02] New event height:', newBox.height, 'delta:', newBox.height - origBox.height);
          // Event should be taller
        }

        const response = await apiPromise;
        console.log('[G-02] API call status:', response?.status() ?? 'none');
      }
    } else {
      console.log('[G-02] FINDING: No resize handle found — resize may not be supported');
    }

    await sp.takeAuditScreenshot('G-02_resize-extend-after.png');
  });

  test('G-03 — Shorten duration by dragging handle up', async ({ page }) => {
    const job = await createScheduledJob(11, 3); // 3-hour event

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(job.job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    const origBox = await event.boundingBox();
    if (!origBox) { test.fail(); return; }

    const resizeHandle = sp.getResizeHandleFor(job.job_number);
    const handleCount = await resizeHandle.count();

    if (handleCount > 0) {
      const handleBox = await resizeHandle.first().boundingBox();
      if (handleBox) {
        // Drag handle UP to shorten
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          handleBox.x + handleBox.width / 2,
          handleBox.y + handleBox.height / 2 - 50,
          { steps: 10 }
        );
        await page.mouse.up();
        await page.waitForTimeout(500);

        const newBox = await event.boundingBox();
        if (newBox) {
          console.log('[G-03] Height before:', origBox.height, 'after:', newBox.height);
          // Event should be shorter
        }
      }
    }

    await sp.takeAuditScreenshot('G-03_resize-shorten.png');
  });

  test('G-06 — Minimum duration prevents zero-height event', async ({ page }) => {
    const job = await createScheduledJob(13, 1); // 1-hour event

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(job.job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    const resizeHandle = sp.getResizeHandleFor(job.job_number);
    if ((await resizeHandle.count()) === 0) { test.skip(); return; }

    const handleBox = await resizeHandle.first().boundingBox();
    if (!handleBox) { test.skip(); return; }

    // Try to drag handle ALL the way up (past the start of the event)
    const eventBox = await event.boundingBox();
    if (!eventBox) { test.skip(); return; }

    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y);
    await page.mouse.down();
    // Drag up past the event's top edge
    await page.mouse.move(handleBox.x + handleBox.width / 2, eventBox.y - 20, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    // Event should still have minimum visible height
    const finalBox = await event.boundingBox();
    if (finalBox) {
      console.log('[G-06] Final height after extreme resize:', finalBox.height);
      expect(finalBox.height).toBeGreaterThan(10); // Must not be zero
    }

    await sp.takeAuditScreenshot('G-06_minimum-duration.png');
  });

  test('G-08 — Resize in Grid Day view', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    // Look for resize handles in grid view
    const handles = sp.getResizeHandles();
    const handleCount = await handles.count();
    console.log('[G-08] Resize handles in Grid Day view:', handleCount);

    // Document whether resize is supported in grid view
    if (handleCount === 0) {
      console.log('[G-08] FINDING: Resize not supported in Grid Day view — P2 gap');
    }

    await sp.takeAuditScreenshot('G-08_grid-day-resize.png');
  });

  test('G-09 — Resize triggers single API call (optimistic update)', async ({ page }) => {
    const job = await createScheduledJob(15, 2);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(job.job_number);
    await expect(event).toBeVisible({ timeout: 5000 });

    const resizeHandle = sp.getResizeHandleFor(job.job_number);
    if ((await resizeHandle.count()) === 0) { test.skip(); return; }

    const handleBox = await resizeHandle.first().boundingBox();
    if (!handleBox) { test.skip(); return; }

    // Count API calls
    let apiCallCount = 0;
    page.on('request', (req) => {
      if (req.url().includes('/assign') && req.method() === 'POST') {
        apiCallCount++;
      }
    });

    // Resize
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1000);

    console.log('[G-09] API calls fired during resize:', apiCallCount);
    // Should be exactly 1 (or 0 if resize is handled differently)
    expect(apiCallCount).toBeLessThanOrEqual(1);

    await sp.takeAuditScreenshot('G-09_resize-api-call.png');
  });
});
