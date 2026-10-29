/**
 * Category E — Drag-and-Drop Visual Feedback
 *
 * These tests capture screenshots MID-DRAG to document the visual state
 * of ghost previews, source indicators, snap behavior, and drop zone highlights.
 *
 * Most E-category tests require manual video review for full assessment.
 * The Playwright specs here capture key frames and document what's observable.
 *
 * Test IDs: E-01 through E-14
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

test.describe.serial('Category E — DnD Visual Feedback', () => {
  let seed: ScheduleSeed;
  /** Use the first scheduled job (9 AM on tech1) for calendar DnD */
  let jobNumber: string;
  /** Use the first unassigned job for sidebar DnD */
  let unassignedJobNumber: string;

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'vis' });
    jobNumber = seed.scheduledJobs[0].job_number;
    unassignedJobNumber = seed.unassignedJobs[0].job_number;
  });

  test.afterAll(async () => {
    await seed.cleanup();
  });

  test('E-01 — Ghost preview follows cursor during drag (Week view)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(jobNumber);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) { test.fail(); return; }

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Start drag
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 10, { steps: 3 }); // past dead zone

    // Take screenshot at position 1 (moved ~50px)
    await page.mouse.move(cx, cy + 50, { steps: 5 });
    await page.waitForTimeout(100);
    await sp.takeAuditScreenshot('E-01_ghost-pos1.png');

    // Take screenshot at position 2 (moved ~120px)
    await page.mouse.move(cx, cy + 120, { steps: 5 });
    await page.waitForTimeout(100);
    await sp.takeAuditScreenshot('E-01_ghost-pos2.png');

    // Check for DnD preview/ghost elements
    const previewElements = await page.evaluate(() => {
      // react-big-calendar DnD creates preview elements
      const dragging = document.querySelector('.rbc-addons-dnd-drag-preview');
      const rowSeg = document.querySelector('.rbc-addons-dnd-row-body');
      return {
        dragPreview: !!dragging,
        rowBody: !!rowSeg,
        bodyClasses: document.body.classList.toString(),
      };
    });
    console.log('[E-01] DnD preview elements:', JSON.stringify(previewElements));

    await page.mouse.up();
    await page.waitForTimeout(300);
  });

  test('E-02 — Source slot indicator visible during drag', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(jobNumber);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) { test.fail(); return; }

    // Start drag
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 100, { steps: 10 });
    await page.waitForTimeout(200);

    // Check if the original event slot is still visible (dimmed)
    // Google Calendar shows a light outline where the event was
    const originalSlotState = await page.evaluate((jobNum) => {
      const events = document.querySelectorAll('.rbc-event');
      let found = false;
      events.forEach(e => {
        if (e.textContent?.includes(jobNum)) {
          found = true;
          const cs = window.getComputedStyle(e);
          console.log('Source event opacity:', cs.opacity, 'visibility:', cs.visibility);
        }
      });
      return found;
    }, jobNumber);

    console.log('[E-02] Source slot still visible during drag:', originalSlotState);
    await sp.takeAuditScreenshot('E-02_source-slot-indicator.png');

    await page.mouse.up();
    await page.waitForTimeout(300);
  });

  test('E-04 — Snap to time grid (15 or 30min increments)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(jobNumber);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) { test.fail(); return; }

    // Drag in small increments and capture positions
    const positions: { mouseY: number; previewY: number | null }[] = [];
    const cx = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    await page.mouse.move(cx, startY);
    await page.mouse.down();

    for (let offset = 10; offset <= 80; offset += 10) {
      await page.mouse.move(cx, startY + offset, { steps: 2 });
      await page.waitForTimeout(50);

      // Try to get preview element position
      const previewY = await page.evaluate(() => {
        const preview = document.querySelector('.rbc-addons-dnd-drag-preview');
        if (!preview) return null;
        return preview.getBoundingClientRect().top;
      });

      positions.push({ mouseY: startY + offset, previewY });
    }

    // Log positions to check for snap behavior
    console.log('[E-04] Drag positions (should show discrete jumps = snapping):');
    positions.forEach((p, i) => {
      console.log(`  step ${i}: mouseY=${p.mouseY.toFixed(0)} previewY=${p.previewY?.toFixed(0) ?? 'N/A'}`);
    });

    await page.mouse.up();
    await sp.takeAuditScreenshot('E-04_snap-behavior.png');
  });

  test('E-07 — Sidebar → Calendar drag shows drop indicator', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const card = sp.getSidebarJobCard(unassignedJobNumber);
    const isVisible = await card.isVisible().catch(() => false);
    if (!isVisible) { test.skip(); return; }

    const cardBox = await card.boundingBox();
    if (!cardBox) { test.skip(); return; }

    // Start drag from sidebar
    const startX = cardBox.x + cardBox.width / 2;
    const startY = cardBox.y + cardBox.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 10, startY, { steps: 3 }); // trigger drag

    // Move into calendar area
    const calBox = await sp.calendarCard.boundingBox();
    if (calBox) {
      // Move slowly across boundary
      const targetX = calBox.x + calBox.width / 3;
      const targetY = calBox.y + calBox.height / 3;

      await page.mouse.move(targetX, targetY, { steps: 15 });
      await page.waitForTimeout(300);

      // Screenshot showing drop indicator state
      await sp.takeAuditScreenshot('E-07_sidebar-to-calendar-drop-indicator.png');

      // Check for any visual drop indicators
      const dropIndicator = await page.evaluate(() => {
        // Look for highlighted time slots, active drop zones, or overlay elements
        const highlights = document.querySelectorAll('[class*="bg-blue"], [class*="bg-primary"], .rbc-addons-dnd-over');
        return highlights.length;
      });
      console.log('[E-07] Drop indicator elements found:', dropIndicator);
    }

    await page.mouse.up();
    await page.waitForTimeout(300);
  });

  test('E-08 — Sidebar → Grid drop zone shows "Drop here" label', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    const card = sp.getSidebarJobCard(unassignedJobNumber);
    const isVisible = await card.isVisible().catch(() => false);
    if (!isVisible) { test.skip(); return; }

    const cardBox = await card.boundingBox();
    if (!cardBox) { test.skip(); return; }

    // Start drag from sidebar
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cardBox.x + cardBox.width / 2 + 10, cardBox.y + cardBox.height / 2, { steps: 3 });
    await page.waitForTimeout(100);

    // Move into grid area drop zones
    const dropZones = sp.getGridDropZones();
    const zoneCount = await dropZones.count();

    if (zoneCount > 0) {
      const zoneBox = await dropZones.nth(3).boundingBox(); // Pick 4th zone (~9 AM)
      if (zoneBox) {
        await page.mouse.move(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height / 2, { steps: 10 });
        await page.waitForTimeout(300);

        // Check for "Drop here" text
        const dropHere = page.getByText('Drop here', { exact: false });
        const dropHereVisible = await dropHere.isVisible().catch(() => false);
        console.log('[E-08] "Drop here" label visible:', dropHereVisible);

        await sp.takeAuditScreenshot('E-08_grid-drop-zone-label.png');
      }
    }

    await page.mouse.up();
    await page.waitForTimeout(300);
  });

  test('E-10 — Escape cancels drag, event returns to original', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(jobNumber);
    await expect(event).toBeVisible({ timeout: 5000 });
    const origBox = await event.boundingBox();
    if (!origBox) { test.fail(); return; }

    // Start drag
    await page.mouse.move(origBox.x + origBox.width / 2, origBox.y + origBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(origBox.x + origBox.width / 2, origBox.y + origBox.height / 2 + 80, { steps: 8 });
    await page.waitForTimeout(200);

    // Press Escape to cancel
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Release mouse
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Event should be back at original position
    const afterBox = await sp.getEventBounds(jobNumber);
    if (afterBox) {
      const reverted = Math.abs(afterBox.y - origBox.y) < 15;
      console.log('[E-10] Event reverted after Escape:', reverted, 'delta:', Math.abs(afterBox.y - origBox.y));
    }

    await sp.takeAuditScreenshot('E-10_escape-cancel-drag.png');
  });

  test('E-11 — Ghost event in Plan Mode has dashed border + draft label', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Activate Plan Mode
    await sp.clickPlanMode();
    await expect(sp.planModeBanner).toBeVisible({ timeout: 3000 });

    const card = sp.getSidebarJobCard(unassignedJobNumber);
    const isVisible = await card.isVisible().catch(() => false);
    if (!isVisible) {
      console.log('[E-11] No unassigned job to drag — skipping ghost visual test');
      await sp.clickPlanMode(); // deactivate
      test.skip();
      return;
    }

    // Drag sidebar card to calendar
    const calBox = await sp.calendarCard.boundingBox();
    if (calBox) {
      await sp.dragSidebarCardToCalendar(
        unassignedJobNumber,
        calBox.x + calBox.width / 3,
        calBox.y + calBox.height / 3,
      );
    }

    await page.waitForTimeout(500);

    // Check ghost visual properties
    const ghosts = sp.getGhostEvents();
    const ghostCount = await ghosts.count();
    console.log('[E-11] Ghost events created:', ghostCount);

    if (ghostCount > 0) {
      const ghostStyle = await ghosts.first().evaluate((el) => {
        const cs = window.getComputedStyle(el);
        return {
          opacity: cs.opacity,
          borderStyle: cs.borderLeftStyle || cs.borderStyle,
          hasText: el.textContent?.substring(0, 50),
        };
      });
      console.log('[E-11] Ghost visual:', JSON.stringify(ghostStyle));
      // Should have dashed border and ~0.55 opacity
    }

    await sp.takeAuditScreenshot('E-11_plan-mode-ghost-visual.png');

    // Discard and deactivate
    const discardAll = page.getByRole('button', { name: /Discard All/i });
    if (await discardAll.isVisible().catch(() => false)) {
      await discardAll.click();
      await page.waitForTimeout(300);
    }
    await sp.clickPlanMode();
  });
});
