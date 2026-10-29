/**
 * Day 3 — Sidebar, Features, Resize, Responsive
 * Screenshot-Verify-Proceed protocol.
 *
 * Focus: sidebar space, staff filter, slot popover, overlay stacking,
 * resize behavior, responsive layouts.
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

test.describe.serial('Day 3 — Sidebar, Features, Resize, Responsive', () => {
  let seed: ScheduleSeed;

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'd3' });
  });

  test.afterAll(async () => {
    await seed.cleanup();
  });

  // ═══════════════════════════════════════════════════════════
  // C — Sidebar Space Utilization
  // ═══════════════════════════════════════════════════════════

  test('C-01/C-12 — Sidebar width, card compactness', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'C-01');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    // Full page with sidebar
    await step('01_full_layout', 'Full page — sidebar + calendar at 1920x1080');

    // Sidebar closeup
    const sidebar = sp.sidebar;
    if (await sidebar.isVisible()) {
      await step('02_sidebar_closeup', 'Sidebar closeup — check card spacing, padding, width', { element: sidebar });

      const dims = await sp.getSidebarDimensions();
      console.log(`[C-01] Sidebar dimensions: ${JSON.stringify(dims)}`);

      // Card compactness
      const cards = sp.getSidebarDraggableCards();
      const cardCount = await cards.count();
      if (cardCount > 0) {
        await step('03_job_card_closeup', 'Unassigned job card — check padding, text layout', { element: cards.first() });
      }

      const wtCards = sp.getSidebarWalkthroughCards();
      const wtCount = await wtCards.count();
      if (wtCount > 0) {
        await step('04_wt_card_closeup', 'Walkthrough card — check padding, text layout', { element: wtCards.first() });
      }

      // Card gap measurement
      if (cardCount >= 2) {
        const box1 = await cards.nth(0).boundingBox();
        const box2 = await cards.nth(1).boundingBox();
        if (box1 && box2) {
          const gap = box2.y - (box1.y + box1.height);
          console.log(`[C-12] Gap between sidebar cards: ${gap}px`);
        }
      }
    }
  });

  test('C-09/C-11 — Section collapse behavior', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'C-09');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await page.waitForTimeout(500);

    await step('01_both_open', 'Both sections open');

    // Collapse walkthroughs
    await sp.walkthroughsSectionHeader.click();
    await page.waitForTimeout(300);
    await step('02_wt_collapsed', 'Walkthroughs collapsed — jobs section should expand', { element: sp.sidebar });

    // Collapse jobs too
    await sp.jobsSectionHeader.click();
    await page.waitForTimeout(300);
    await step('03_both_collapsed', 'Both sections collapsed — minimal sidebar', { element: sp.sidebar });

    // Re-expand both
    await sp.walkthroughsSectionHeader.click();
    await page.waitForTimeout(200);
    await sp.jobsSectionHeader.click();
    await page.waitForTimeout(300);
    await step('04_both_reopened', 'Both sections re-opened', { element: sp.sidebar });
  });

  // ═══════════════════════════════════════════════════════════
  // N-E — Staff Filter
  // ═══════════════════════════════════════════════════════════

  test('N-13/N-14 — Staff filter: Technicians / Sales / All', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'N-13');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);
    await step('01_grid_all_staff', 'Grid Day — All staff filter (default)');

    // Find staff filter dropdown
    const staffFilter = page.locator('select').first();
    const filterVisible = await staffFilter.isVisible().catch(() => false);
    console.log(`[N-13] Staff filter visible: ${filterVisible}`);

    if (filterVisible) {
      // Technicians only
      await staffFilter.selectOption('TECHNICIAN');
      await page.waitForTimeout(500);
      await step('02_technicians_only', 'Grid Day — Technicians filter. Check: only tech columns visible');

      // Sales only
      await staffFilter.selectOption('SALES');
      await page.waitForTimeout(500);
      await step('03_sales_only', 'Grid Day — Sales filter. Check: only sales columns visible');

      // Back to All
      await staffFilter.selectOption('all');
      await page.waitForTimeout(500);
      await step('04_all_again', 'Grid Day — All filter restored');
    } else {
      await step('02_no_filter', 'Staff filter dropdown not visible in grouped view');
    }
  });

  // ═══════════════════════════════════════════════════════════
  // N-15 — Month button hidden in grouped view
  // ═══════════════════════════════════════════════════════════

  test('N-15 — Month button hidden in grouped view', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'N-15');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await page.waitForTimeout(300);

    // Standard view — month button should exist
    const monthBefore = await sp.monthButton.isVisible().catch(() => false);
    console.log(`[N-15] Month button in Standard: ${monthBefore}`);
    await step('01_standard_view', `Standard view. Month button visible: ${monthBefore}`);

    // Member view — month should be hidden
    await sp.switchToMemberView();
    await page.waitForTimeout(300);
    const monthAfter = await sp.monthButton.isVisible().catch(() => false);
    console.log(`[N-15] Month button in Member: ${monthAfter}`);
    await step('02_member_view', `Member view. Month button visible: ${monthAfter}. Expected: false`);
  });

  // ═══════════════════════════════════════════════════════════
  // N-B — Slot Popover (empty space click)
  // ═══════════════════════════════════════════════════════════

  test('N-05/N-06 — Slot popover appears and dismisses', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'N-05');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    // Click on an empty time slot (far down the page, likely no events)
    const calBox = await sp.calendarCard.boundingBox();
    if (!calBox) return;

    // Scroll to an empty area first
    await page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content');
      if (el) el.scrollTop = el.scrollHeight * 0.7; // Scroll to ~5-6 PM area
    });
    await page.waitForTimeout(300);

    // Click empty slot
    await page.mouse.click(calBox.x + calBox.width / 2, calBox.y + calBox.height / 2);
    await page.waitForTimeout(500);
    await step('01_slot_clicked', 'Clicked empty time slot. Check: "Schedule a Job" popover appeared? Has X button?');

    // Check for close button
    const closeBtn = page.locator('[aria-label="Close"]');
    const closeBtnVisible = await closeBtn.first().isVisible().catch(() => false);
    console.log(`[N-05] Close button visible: ${closeBtnVisible}`);

    // Dismiss with Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await step('02_after_escape', 'After Escape. Popover should be dismissed.');
  });

  // ═══════════════════════════════════════════════════════════
  // N-G — Overlay Stacking
  // ═══════════════════════════════════════════════════════════

  test('N-18/N-19 — Overlay stacking: tooltip → context menu', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'N-18');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    const events = sp.getAllEvents();
    const count = await events.count();
    if (count === 0) { return; }

    // Hover to trigger tooltip
    await events.first().hover();
    await page.waitForTimeout(500);
    await step('01_tooltip_visible', 'Hovering on event — tooltip should appear');

    // Right-click same event — tooltip should dismiss, context menu appears
    await events.first().click({ button: 'right' });
    await page.waitForTimeout(300);
    await step('02_context_menu', 'Right-clicked. Check: tooltip gone? Context menu visible? No overlap?');

    // Click elsewhere to dismiss
    await page.mouse.click(10, 10);
    await page.waitForTimeout(300);

    // Click event to open popup, then right-click another
    if (count >= 2) {
      await events.first().click();
      await page.waitForTimeout(500);
      await step('03_click_popup', 'Click popup on first event');

      await events.nth(1).click({ button: 'right' });
      await page.waitForTimeout(300);
      await step('04_popup_then_context', 'Right-clicked second event. Check: first popup dismissed? Context menu for second?');
    }

    await page.keyboard.press('Escape');
  });

  // ═══════════════════════════════════════════════════════════
  // G-01 — Resize handle visibility
  // ═══════════════════════════════════════════════════════════

  test('G-01/G-02 — Resize handle + extend duration', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'G-01');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) return;

    // Hover near bottom edge to reveal resize handle
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3);
    await page.waitForTimeout(300);
    await step('01_resize_handle_hover', 'Hovering at bottom edge. Check: resize handle visible? Cursor ns-resize?');

    // Check for resize handle
    const handles = sp.getResizeHandles();
    const handleCount = await handles.count();
    console.log(`[G-01] Resize handles found: ${handleCount}`);

    // Try to resize
    if (handleCount > 0) {
      const handleBox = await handles.first().boundingBox();
      if (handleBox) {
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 60, { steps: 10 });
        await page.waitForTimeout(200);
        await step('02_resizing', 'Dragging resize handle down ~60px. Check: event growing?');

        await page.mouse.up();
        await page.waitForTimeout(800);
        await step('03_after_resize', 'After resize. Check: event taller? Duration changed? Or snapped back?');
      }
    } else {
      await step('02_no_handles', 'No resize handles found on hover');
    }

    await page.keyboard.press('Escape');
  });

  // ═══════════════════════════════════════════════════════════
  // Responsive — 3 viewports
  // ═══════════════════════════════════════════════════════════

  test('J-01/J-02/J-03 — Responsive at 1440, 1366, 1024', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'J-responsive');

    for (const vp of [
      { w: 1440, h: 900, name: '1440x900' },
      { w: 1366, h: 768, name: '1366x768' },
      { w: 1024, h: 768, name: '1024x768' },
    ]) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await sp.goto();
      await sp.waitForCalendarReady();
      await sp.goToToday();
      await sp.switchToWeekView();
      await page.waitForTimeout(500);

      const sidebarVisible = await sp.sidebar.isVisible().catch(() => false);
      console.log(`[J] ${vp.name}: sidebar visible = ${sidebarVisible}`);

      await step(`${vp.name}`, `Layout at ${vp.name}. Sidebar visible: ${sidebarVisible}`);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // N-20 — Off-hours dimming
  // ═══════════════════════════════════════════════════════════

  test('N-20 — Off-hours dimming', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'N-20');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();

    // Scroll to top (early morning)
    await page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content');
      if (el) el.scrollTop = 0;
    });
    await page.waitForTimeout(300);
    await step('01_early_morning', 'Day view scrolled to top (6 AM). Check: off-hours dimming before 7 AM?');

    // Scroll to bottom (evening)
    await page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    await step('02_late_evening', 'Day view scrolled to bottom (10-11 PM). Check: off-hours dimming after 7 PM?');
  });
});
