/**
 * Day 3 — Tests that don't need seed data (use existing DB state)
 * Staff filter, month button, slot popover, overlays, resize, responsive, off-hours
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import { createStepCapture } from '../helpers/capture-step';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');

test.use({
  storageState: authFile,
  viewport: { width: 1920, height: 1080 },
});

test.describe.serial('Day 3 — No-Seed Tests', () => {

  test('N-13/N-14 — Staff filter', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'N-13');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);
    await step('01_all', 'Grid Day — All staff');

    const staffFilter = page.locator('select').first();
    if (await staffFilter.isVisible().catch(() => false)) {
      await staffFilter.selectOption('TECHNICIAN');
      await page.waitForTimeout(500);
      await step('02_techs', 'Technicians only');

      await staffFilter.selectOption('SALES');
      await page.waitForTimeout(500);
      await step('03_sales', 'Sales only');

      await staffFilter.selectOption('all');
      await page.waitForTimeout(300);
    }
  });

  test('N-15 — Month button hidden in grouped view', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'N-15');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    const monthBefore = await sp.monthButton.isVisible().catch(() => false);
    await step('01_standard', `Standard view. Month visible: ${monthBefore}`);

    await sp.switchToMemberView();
    await page.waitForTimeout(300);

    const monthAfter = await sp.monthButton.isVisible().catch(() => false);
    console.log(`[N-15] Standard: ${monthBefore}, Member: ${monthAfter}`);
    await step('02_member', `Member view. Month visible: ${monthAfter}`);
  });

  test('N-05 — Slot popover', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'N-05');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    // Scroll to empty area
    await page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content');
      if (el) el.scrollTop = el.scrollHeight * 0.8;
    });
    await page.waitForTimeout(300);

    const calBox = await sp.calendarCard.boundingBox();
    if (calBox) {
      await page.mouse.click(calBox.x + calBox.width / 2, calBox.y + calBox.height * 0.6);
      await page.waitForTimeout(500);
      await step('01_popover', 'Clicked empty slot. Check: "Schedule a Job" popover?');
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await step('02_dismissed', 'After Escape');
  });

  test('N-18 — Tooltip then context menu', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'N-18');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    const events = sp.getAllEvents();
    if ((await events.count()) > 0) {
      await events.first().hover();
      await page.waitForTimeout(500);
      await step('01_tooltip', 'Tooltip on hover');

      await events.first().click({ button: 'right' });
      await page.waitForTimeout(300);
      await step('02_context_menu', 'Right-click after hover. Tooltip should be gone, context menu visible.');
    }

    await page.keyboard.press('Escape');
  });

  test('G-01 — Resize handle', async ({ page }) => {
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'G-01');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);

    const events = sp.getAllEvents();
    if ((await events.count()) > 0) {
      const box = await events.first().boundingBox();
      if (box) {
        // Hover at bottom edge
        await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3);
        await page.waitForTimeout(300);
        await step('01_bottom_hover', 'Hovering at bottom edge. Check: resize handle? Cursor?');

        const handles = sp.getResizeHandles();
        console.log(`[G-01] Resize handles: ${await handles.count()}`);

        // Try resize drag
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height + 50, { steps: 8 });
        await page.waitForTimeout(200);
        await step('02_resizing', 'Resize drag down 50px');

        await page.mouse.up();
        await page.waitForTimeout(800);
        await step('03_after_resize', 'After resize release. Event taller? Or snapped back?');
      }
    }

    await page.keyboard.press('Escape');
  });

  test('J — Responsive at 3 viewports', async ({ page }) => {
    const step = createStepCapture(page, 'J');

    for (const vp of [
      { w: 1440, h: 900, name: '1440x900' },
      { w: 1366, h: 768, name: '1366x768' },
      { w: 1024, h: 768, name: '1024x768' },
    ]) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      const sp = new SchedulePage(page);
      await sp.goto();
      await sp.waitForCalendarReady();
      await sp.goToToday();
      await sp.switchToWeekView();
      await page.waitForTimeout(400);

      const sidebarVisible = await sp.sidebar.isVisible().catch(() => false);
      console.log(`[J] ${vp.name}: sidebar=${sidebarVisible}`);
      await step(vp.name, `Layout at ${vp.name}. Sidebar: ${sidebarVisible}`);
    }
  });

  test('N-20 — Off-hours dimming', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const sp = new SchedulePage(page);
    const step = createStepCapture(page, 'N-20');

    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();

    await page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content');
      if (el) el.scrollTop = 0;
    });
    await page.waitForTimeout(300);
    await step('01_morning', '6 AM area — check off-hours dimming');

    await page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    await step('02_evening', '10 PM area — check off-hours dimming');
  });
});
