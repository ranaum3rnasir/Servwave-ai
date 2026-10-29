/**
 * Demo: F-01 Screenshot-Verify-Proceed Protocol
 *
 * Tests "same day, different time" drag with step-by-step screenshots.
 * Each step captures a screenshot that agents will analyze visually.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import { type ScheduleSeed, seedScheduleData } from '../helpers/schedule-seed';
import { createStepCapture } from '../helpers/capture-step';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');

test.use({
  storageState: authFile,
  viewport: { width: 1920, height: 1080 },
});

test.describe.serial('F-01 Demo — Screenshot-Verify-Proceed', () => {
  let seed: ScheduleSeed;

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'f01demo' });
  });

  test.afterAll(async () => {
    await seed.cleanup();
  });

  test('F-01 — Same day, different time (vertical drag in Week view)', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'F-01');

    // Step 1: Navigate and verify initial state
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);
    await step('01_initial_state', 'Week view loaded with seed events visible');

    // Step 2: Find the target event and verify it exists
    const jobNum = seed.scheduledJobs[1].job_number; // 11 AM job
    const event = sp.getEventByText(jobNum);
    await expect(event).toBeVisible({ timeout: 5000 });
    const origBox = await event.boundingBox();
    expect(origBox).not.toBeNull();

    // Take closeup of the event before drag
    await step('02_event_before_drag', `Event ${jobNum} at original position (11 AM)`, {
      element: event,
    });

    // Step 3: Start dragging
    const cx = origBox!.x + origBox!.width / 2;
    const cy = origBox!.y + origBox!.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 10, { steps: 3 }); // past dead zone
    await step('03_drag_started', 'Mouse down on event, moved past dead zone');

    // Step 4: Mid-drag — move down ~100px (approximately 2 hours)
    await page.mouse.move(cx, cy + 100, { steps: 10 });
    await page.waitForTimeout(100);
    await step('04_mid_drag', 'Event being dragged down ~2 hours. Check: ghost preview visible? Source slot indicator? Target slot highlighted?');

    // Step 5: Drop the event
    await page.mouse.up();
    await page.waitForTimeout(800); // wait for API + optimistic update
    await step('05_after_drop', 'Event dropped at new time. Check: event moved to new position? API call succeeded? No error toast?');

    // Step 6: Verify the event moved
    const eventAfter = sp.getEventByText(jobNum);
    const afterBox = await eventAfter.boundingBox();
    if (afterBox) {
      const delta = afterBox.y - origBox!.y;
      console.log(`[F-01] Event Y delta: ${delta}px (positive = moved down)`);

      // Take closeup of event at new position
      await step('06_event_at_new_position', `Event ${jobNum} at new position. Delta: ${delta}px`, {
        element: eventAfter,
      });
    }

    // Step 7: Full page final state
    await step('07_final_state', 'Full page after drag-drop. Verify: no error toasts, no visual artifacts, sidebar unchanged');
  });
});
