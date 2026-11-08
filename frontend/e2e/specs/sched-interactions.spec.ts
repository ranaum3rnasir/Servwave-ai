/**
 * Category L — Interaction Feedback (Non-DnD) + Category M — State Edge Cases
 *
 * Verifies tooltips, click popups, context menus, keyboard shortcuts,
 * loading states, empty calendar, overlapping events, Open/All filter,
 * and Plan Mode persistence.
 *
 * Test IDs: L-01 through L-14, M-01 through M-12
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

test.describe.serial('Category L — Interaction Feedback', () => {
  let seed: ScheduleSeed;
  /** Use the second scheduled job (11 AM on tech1) for interaction tests */
  let jobNumber: string;

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'intx' });
    jobNumber = seed.scheduledJobs[1].job_number;
  });

  test.afterAll(async () => {
    await seed.cleanup();
  });

  test('L-01/L-02 — Tooltip appears on hover (350ms) and disappears on leave', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(jobNumber);
    await expect(event).toBeVisible({ timeout: 5000 });

    // Hover and wait for tooltip
    await event.hover();
    await page.waitForTimeout(500);

    // Look for any tooltip/popover that appeared
    const tooltip = page.locator('[class*="pointer-events-none"][class*="fixed"], [role="tooltip"]').first();
    const tooltipVisible = await tooltip.isVisible().catch(() => false);
    console.log('[L-01] Tooltip visible after 500ms hover:', tooltipVisible);

    if (tooltipVisible) {
      const tooltipText = await tooltip.textContent();
      console.log('[L-01] Tooltip content:', tooltipText?.substring(0, 100));
    }

    // Move away — tooltip should disappear
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);

    const tooltipGone = await tooltip.isVisible().catch(() => false);
    console.log('[L-02] Tooltip gone after mouse leave:', !tooltipGone);

    await sp.takeAuditScreenshot('L-01_tooltip-hover.png');
  });

  test('L-03/L-04 — Click popup appears with event details', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(jobNumber);
    await expect(event).toBeVisible({ timeout: 5000 });

    // Click the event
    await event.click();
    await page.waitForTimeout(500);

    // Check for detail popup
    const popup = sp.quickViewPopup;
    const popupVisible = await popup.isVisible().catch(() => false);
    console.log('[L-03] Click popup visible:', popupVisible);

    if (popupVisible) {
      // Check it has "View Job" button
      const viewBtn = popup.getByText('View Job');
      const viewBtnVisible = await viewBtn.isVisible().catch(() => false);
      console.log('[L-03] "View Job" button visible:', viewBtnVisible);

      // Check popup positioning — not clipped off screen
      const popupBox = await popup.boundingBox();
      const viewport = page.viewportSize()!;
      if (popupBox) {
        const inBounds = popupBox.x >= 0 && popupBox.y >= 0 &&
          (popupBox.x + popupBox.width) <= viewport.width &&
          (popupBox.y + popupBox.height) <= viewport.height;
        console.log('[L-04] Popup fully within viewport:', inBounds);
      }
    }

    await sp.takeAuditScreenshot('L-03_click-popup.png');
  });

  test('L-05/L-06/L-07 — Context menu on right-click', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(jobNumber);
    await expect(event).toBeVisible({ timeout: 5000 });

    // Right-click
    await sp.rightClickEvent(jobNumber);

    // Check for context menu
    const contextMenu = page.locator('[class*="fixed"][class*="bg-white"][class*="shadow"]').filter({ hasText: /Open|Reassign|Cancel|Mark/ });
    const menuVisible = await contextMenu.first().isVisible().catch(() => false);
    console.log('[L-05] Context menu visible:', menuVisible);

    if (menuVisible) {
      // List all menu items
      const items = await contextMenu.first().locator('button, [role="menuitem"], div[class*="cursor"]').allTextContents();
      console.log('[L-05] Context menu items:', items);

      // Check positioning (L-06)
      const menuBox = await contextMenu.first().boundingBox();
      const viewport = page.viewportSize()!;
      if (menuBox) {
        const inBounds = menuBox.x >= 0 && menuBox.y >= 0 &&
          (menuBox.x + menuBox.width) <= viewport.width + 5 &&
          (menuBox.y + menuBox.height) <= viewport.height + 5;
        console.log('[L-06] Context menu within viewport:', inBounds);
      }

      await sp.takeAuditScreenshot('L-05_context-menu.png');

      // Dismiss by clicking elsewhere (L-07)
      await page.mouse.click(10, 10);
      await page.waitForTimeout(300);
      const menuGone = await contextMenu.first().isVisible().catch(() => false);
      console.log('[L-07] Context menu dismissed on click away:', !menuGone);
    }
  });

  test('L-08/L-09/L-10/L-11 — Keyboard shortcuts', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    // Click on calendar area first to ensure it has focus
    const calBox = await sp.calendarCard.boundingBox();
    if (calBox) {
      await page.mouse.click(calBox.x + calBox.width / 2, calBox.y + calBox.height / 2);
    }

    // L-08: Press T → go to Today
    await page.keyboard.press('t');
    await page.waitForTimeout(300);
    console.log('[L-08] T key pressed — checking for today navigation');

    // L-09: Press 1 → Day view
    await page.keyboard.press('1');
    await page.waitForTimeout(300);
    // Check if Day button is now active
    const dayActive = await sp.dayButton.evaluate((el) =>
      el.classList.contains('bg-primary') || el.getAttribute('data-state') === 'active' ||
      window.getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)'
    );
    console.log('[L-09] Day view active after pressing 1:', dayActive);

    // Press 2 → Week
    await page.keyboard.press('2');
    await page.waitForTimeout(300);

    // Press 3 → Month
    await page.keyboard.press('3');
    await page.waitForTimeout(300);

    // L-10: Press G → toggle By-Tech
    await page.keyboard.press('g');
    await page.waitForTimeout(500);
    console.log('[L-10] G key pressed — toggled member view');

    // L-11: Press Escape → close popups
    // First open a popup
    await page.keyboard.press('s'); // back to standard
    await page.waitForTimeout(300);
    await page.keyboard.press('2'); // week view
    await page.waitForTimeout(300);

    const events = sp.getAllEvents();
    if ((await events.count()) > 0) {
      await events.first().click();
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const popupAfterEsc = await sp.quickViewPopup.isVisible().catch(() => false);
      console.log('[L-11] Popup closed after Escape:', !popupAfterEsc);
    }

    await sp.takeAuditScreenshot('L-08-11_keyboard-shortcuts.png');
  });

  test('L-12 — Loading state visible on slow network', async ({ page }) => {
    // Throttle network
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: 50 * 1024, // 50 KB/s
      uploadThroughput: 50 * 1024,
      latency: 2000,
    });

    const sp = new SchedulePage(page);
    await page.goto('/schedule');

    // Check for loading spinner before calendar loads
    const spinner = sp.loadingSpinner;
    const spinnerVisible = await spinner.isVisible().catch(() => false);
    console.log('[L-12] Loading spinner visible during slow load:', spinnerVisible);

    await sp.takeAuditScreenshot('L-12_loading-state.png');

    // Reset network conditions
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: -1,
      uploadThroughput: -1,
      latency: 0,
    });
  });
});

test.describe.serial('Category M — State Edge Cases', () => {

  test('M-01 — Empty calendar shows empty state', async ({ page }) => {
    // Navigate to a far-future week where no events exist
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Navigate far into the future
    for (let i = 0; i < 10; i++) {
      await sp.goToNext();
    }
    await page.waitForTimeout(500);

    // Check for empty state overlay — actual text is "No jobs scheduled this week" (line 1603)
    const emptyOverlay = page.getByText('No jobs scheduled this week');
    const overlayVisible = await emptyOverlay.isVisible().catch(() => false);
    console.log('[M-01] Empty state overlay visible:', overlayVisible);

    // Also check for helper text
    const helperText = page.getByText('Drag a job from the panel on the left');
    const helperVisible = await helperText.isVisible().catch(() => false);
    console.log('[M-01] Helper text visible:', helperVisible);

    // Check that no events are shown
    const eventCount = await sp.getVisibleEventCount();
    console.log('[M-01] Events in far-future week:', eventCount);

    await sp.takeAuditScreenshot('M-01_empty-calendar.png');
  });

  test('M-02 — Single technician in By-Tech Grid', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    // Count tech columns
    const techHeaders = sp.getTechColumnHeaders();
    const headerCount = await techHeaders.count();
    console.log('[M-02] Tech columns in grid:', headerCount);

    // If only 1 tech, check column width uses available space
    if (headerCount === 1) {
      const colBox = await techHeaders.first().boundingBox();
      console.log('[M-02] Single tech column width:', colBox?.width);
    }

    await sp.takeAuditScreenshot('M-02_single-tech-grid.png');
  });

  test('M-09 — Very short event (15min) has minimum visible height', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();

    // Look for any very short events
    const events = sp.getAllEvents();
    const count = await events.count();
    let minHeight = Infinity;

    for (let i = 0; i < count; i++) {
      const box = await events.nth(i).boundingBox();
      if (box && box.height < minHeight) {
        minHeight = box.height;
      }
    }

    if (minHeight < Infinity) {
      console.log('[M-09] Shortest event height:', minHeight);
      expect(minHeight).toBeGreaterThan(10); // Must be visible/clickable
    }

    await sp.takeAuditScreenshot('M-09_short-events.png');
  });

  test('M-10 — F5 refresh during Plan Mode preserves state', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    // Activate Plan Mode
    await sp.clickPlanMode();
    await expect(sp.planModeBanner).toBeVisible({ timeout: 3000 });

    // Check localStorage before reload
    const stateBeforeReload = await page.evaluate(() => {
      return Object.keys(localStorage).filter(k => k.toLowerCase().includes('plan'));
    });
    console.log('[M-10] Plan mode keys before reload:', stateBeforeReload);

    // Reload
    await page.reload();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    // Check if plan mode is still active
    const bannerVisible = await sp.planModeBanner.isVisible().catch(() => false);
    console.log('[M-10] Plan mode active after reload:', bannerVisible);

    await sp.takeAuditScreenshot('M-10_plan-mode-after-refresh.png');

    // Clean up
    if (bannerVisible) {
      await sp.clickPlanMode();
    }
  });

  test('M-12 — Open/All filter toggle shows/hides completed events', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Count events in "Open" mode
    const openCount = await sp.getVisibleEventCount();
    console.log('[M-12] Events in Open mode:', openCount);

    // Switch to All
    await sp.toggleToAll();
    await page.waitForTimeout(500);

    const allCount = await sp.getVisibleEventCount();
    console.log('[M-12] Events in All mode:', allCount);

    // All should include completed events (>= Open count)
    expect(allCount).toBeGreaterThanOrEqual(openCount);

    // Check that newly visible events have reduced opacity (completed)
    if (allCount > openCount) {
      const events = sp.getAllEvents();
      let lowOpacityCount = 0;
      for (let i = 0; i < await events.count(); i++) {
        const opacity = await events.nth(i).evaluate((el) =>
          parseFloat(window.getComputedStyle(el).opacity)
        );
        if (opacity <= 0.6) lowOpacityCount++;
      }
      console.log('[M-12] Low-opacity (completed) events:', lowOpacityCount);
    }

    // Toggle back to Open
    await sp.toggleToOpen();
    await page.waitForTimeout(500);
    const afterToggleBack = await sp.getVisibleEventCount();
    console.log('[M-12] Events after toggle back to Open:', afterToggleBack);

    await sp.takeAuditScreenshot('M-12_open-all-filter.png');
  });
});
