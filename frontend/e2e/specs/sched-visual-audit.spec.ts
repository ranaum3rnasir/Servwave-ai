/**
 * Scheduler Visual Audit — Screenshot Capture Spec
 *
 * This is NOT a test spec. It systematically captures screenshots of every
 * important scheduler state so AI agents can visually analyze the UI.
 *
 * Produces ~30 screenshots in frontend/e2e/screenshots/scheduler-audit/
 *
 * Run: npx playwright test --config=e2e/playwright.config.ts sched-visual-audit
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import { type ScheduleSeed, seedScheduleData } from '../helpers/schedule-seed';
import {
  createUrgentJob,
  assignJob,
  startJob,
  completeJob,
  deleteJob,
} from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');

test.use({
  storageState: authFile,
  viewport: { width: 1920, height: 1080 },
});

const SHOT_DIR = 'e2e/screenshots/scheduler-audit';

test.describe.serial('Scheduler Visual Audit — Screenshot Capture', () => {
  let seed: ScheduleSeed;
  let conflictJobId: string;

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'audit' });

    // Create an overlapping job on tech1 at 9 AM (conflicts with scheduledJobs[0])
    const conflictJob = await createUrgentJob(seed.token, seed.customerId, seed.locationId);
    conflictJobId = conflictJob.id;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    await assignJob(seed.token, conflictJobId, seed.techId1, start.toISOString(), end.toISOString(), true);

    // Complete tech2's job so we have a completed event for "All" view
    await startJob(seed.token, seed.tech2Job.id);
    await completeJob(seed.token, seed.tech2Job.id, 'Completed for visual audit');
  });

  test.afterAll(async () => {
    if (conflictJobId) await deleteJob(seed.token, conflictJobId).catch(() => {});
    await seed.cleanup();
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 1: Layout Overview (5 views at 1920x1080)
  // ═══════════════════════════════════════════════════════════

  test('Layout — Week view', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/layout_week_view_1920x1080.png`, fullPage: false });
  });

  test('Layout — Day view', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/layout_day_view_1920x1080.png`, fullPage: false });
  });

  test('Layout — Month view', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMonthView();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/layout_month_view_1920x1080.png`, fullPage: false });
  });

  test('Layout — Member Grid Day', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToDayView();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/layout_member_grid_day_1920x1080.png`, fullPage: false });
  });

  test('Layout — Member Grid Week', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/layout_member_grid_week_1920x1080.png`, fullPage: false });
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 2: Sidebar States
  // ═══════════════════════════════════════════════════════════

  test('Sidebar — Normal state (both sections open)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);
    // Full page shows sidebar + calendar together
    await page.screenshot({ path: `${SHOT_DIR}/sidebar_normal_state_1920x1080.png`, fullPage: false });

    // Closeup of sidebar only
    const sidebarEl = sp.sidebar;
    if (await sidebarEl.isVisible()) {
      await sidebarEl.screenshot({ path: `${SHOT_DIR}/sidebar_closeup_1920x1080.png` });
    }
  });

  test('Sidebar — Walkthroughs collapsed', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    await sp.walkthroughsSectionHeader.click();
    await page.waitForTimeout(300);
    await sp.sidebar.screenshot({ path: `${SHOT_DIR}/sidebar_walkthroughs_collapsed.png` });
  });

  test('Sidebar — Both sections collapsed', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    await sp.walkthroughsSectionHeader.click();
    await page.waitForTimeout(200);
    await sp.jobsSectionHeader.click();
    await page.waitForTimeout(300);
    await sp.sidebar.screenshot({ path: `${SHOT_DIR}/sidebar_both_collapsed.png` });
  });

  test('Sidebar — Job card closeup', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    const card = sp.getSidebarJobCard(seed.unassignedJobs[0].job_number);
    if (await card.isVisible()) {
      await card.screenshot({ path: `${SHOT_DIR}/sidebar_job_card_closeup.png` });
    }
  });

  test('Sidebar — Walkthrough card closeup', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    const cards = sp.getSidebarWalkthroughCards();
    if ((await cards.count()) > 0) {
      await cards.first().screenshot({ path: `${SHOT_DIR}/sidebar_walkthrough_card_closeup.png` });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 3: Event Detail States
  // ═══════════════════════════════════════════════════════════

  test('Event — Hover tooltip', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    await event.hover();
    await page.waitForTimeout(500); // > 350ms tooltip delay
    await page.screenshot({ path: `${SHOT_DIR}/event_hover_tooltip_1920x1080.png`, fullPage: false });
  });

  test('Event — Click popup', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(seed.scheduledJobs[1].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    await event.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/event_click_popup_1920x1080.png`, fullPage: false });
  });

  test('Event — Right-click context menu', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    await event.click({ button: 'right' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT_DIR}/event_context_menu_1920x1080.png`, fullPage: false });
  });

  test('Event — Urgent badge closeup', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // All seed jobs are urgent — take element screenshot of one
    const event = sp.getEventByText(seed.scheduledJobs[0].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    await event.screenshot({ path: `${SHOT_DIR}/event_urgent_badge_closeup.png` });
  });

  test('Event — Walkthrough amber color', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Find the walkthrough event (title contains "Walkthrough")
    const wtEvent = page.locator('.rbc-event').filter({ hasText: /Walkthrough/ }).first();
    if (await wtEvent.isVisible().catch(() => false)) {
      await wtEvent.screenshot({ path: `${SHOT_DIR}/event_walkthrough_amber_closeup.png` });
    }
    // Also full-page to show context
    await page.screenshot({ path: `${SHOT_DIR}/event_walkthrough_in_context_1920x1080.png`, fullPage: false });
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 4: DnD States (mid-action captures)
  // ═══════════════════════════════════════════════════════════

  test('DnD — Calendar event mid-drag', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(seed.scheduledJobs[1].job_number);
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) return;

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Start drag and hold
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 10, { steps: 3 }); // past dead zone
    await page.mouse.move(cx, cy + 80, { steps: 10 }); // drag down ~80px
    await page.waitForTimeout(100);

    // Screenshot while dragging
    await page.screenshot({ path: `${SHOT_DIR}/dnd_event_mid_drag_1920x1080.png`, fullPage: false });

    await page.mouse.up();
    await page.waitForTimeout(300);
  });

  test('DnD — Sidebar card mid-drag toward calendar', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const card = sp.getSidebarJobCard(seed.unassignedJobs[0].job_number);
    if (!(await card.isVisible().catch(() => false))) return;
    const box = await card.boundingBox();
    if (!box) return;

    // Start drag from sidebar card
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, { steps: 3 });
    await page.waitForTimeout(100);

    // Move toward calendar area
    const calBox = await sp.calendarCard.boundingBox();
    if (calBox) {
      await page.mouse.move(calBox.x + 200, calBox.y + 300, { steps: 15 });
      await page.waitForTimeout(200);
    }

    // Screenshot mid-drag
    await page.screenshot({ path: `${SHOT_DIR}/dnd_sidebar_card_mid_drag_1920x1080.png`, fullPage: false });

    await page.mouse.up();
    await page.waitForTimeout(300);
  });

  test('DnD — Resize handle on hover', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(seed.scheduledJobs[2].job_number); // 2 PM job
    await expect(event).toBeVisible({ timeout: 5000 });
    const box = await event.boundingBox();
    if (!box) return;

    // Hover near the bottom edge of the event to reveal resize handle
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3);
    await page.waitForTimeout(300);

    await page.screenshot({ path: `${SHOT_DIR}/dnd_resize_handle_hover_1920x1080.png`, fullPage: false });
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 5: Plan Mode
  // ═══════════════════════════════════════════════════════════

  test('Plan Mode — Banner active', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    await sp.clickPlanMode();
    await page.waitForTimeout(500);

    await page.screenshot({ path: `${SHOT_DIR}/planmode_banner_active_1920x1080.png`, fullPage: false });

    // Deactivate
    await sp.clickPlanMode();
    await page.waitForTimeout(300);
  });

  test('Plan Mode — Ghost event after sidebar drag', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Activate plan mode
    await sp.clickPlanMode();
    await expect(sp.planModeBanner).toBeVisible({ timeout: 3000 });

    // Drag sidebar card to calendar (creates ghost)
    const card = sp.getSidebarJobCard(seed.unassignedJobs[0].job_number);
    if (await card.isVisible().catch(() => false)) {
      const calBox = await sp.calendarCard.boundingBox();
      if (calBox) {
        await sp.dragSidebarCardToCalendar(
          seed.unassignedJobs[0].job_number,
          calBox.x + calBox.width / 3,
          calBox.y + calBox.height / 3,
        );
        await page.waitForTimeout(500);
      }
    }

    await page.screenshot({ path: `${SHOT_DIR}/planmode_ghost_event_1920x1080.png`, fullPage: false });

    // Discard and deactivate
    const discardAll = page.getByRole('button', { name: /Discard All/i });
    if (await discardAll.isVisible().catch(() => false)) {
      await discardAll.click();
      await page.waitForTimeout(300);
    }
    await sp.clickPlanMode();
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 6: Feature States
  // ═══════════════════════════════════════════════════════════

  test('Feature — Conflict indicators (orange border)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);

    // Conflicting events at 9 AM on tech1 should show orange borders
    await page.screenshot({ path: `${SHOT_DIR}/feature_conflict_indicators_1920x1080.png`, fullPage: false });
  });

  test('Feature — Open vs All toggle (completed at 0.5 opacity)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // "Open" mode — completed events hidden
    await page.screenshot({ path: `${SHOT_DIR}/feature_open_mode_1920x1080.png`, fullPage: false });

    // "All" mode — completed events visible at 0.5 opacity
    await sp.toggleToAll();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/feature_all_mode_completed_visible_1920x1080.png`, fullPage: false });
  });

  test('Feature — Search results dropdown', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const searchInput = page.locator('input[placeholder*="Search schedule"]');
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.click();
      await searchInput.fill(seed.scheduledJobs[0].job_number);
      await page.waitForTimeout(800); // debounce + API response
      await page.screenshot({ path: `${SHOT_DIR}/feature_search_results_1920x1080.png`, fullPage: false });
      // Clear search
      await searchInput.clear();
      await page.keyboard.press('Escape');
    }
  });

  test('Feature — Empty calendar (far future)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.switchToWeekView();

    // Navigate far into the future
    for (let i = 0; i < 12; i++) await sp.goToNext();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/feature_empty_calendar_1920x1080.png`, fullPage: false });
  });

  test('Feature — Off-hours dimming (6 AM area)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();

    // Scroll to the very top to see 6 AM (off-hours area)
    await page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content');
      if (el) el.scrollTop = 0;
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT_DIR}/feature_offhours_early_morning_1920x1080.png`, fullPage: false });

    // Scroll to late evening (off-hours after 7 PM)
    await page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT_DIR}/feature_offhours_late_evening_1920x1080.png`, fullPage: false });
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 7: Responsive Layouts
  // ═══════════════════════════════════════════════════════════

  test('Responsive — 1440x900', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/responsive_layout_1440x900.png`, fullPage: false });
  });

  test('Responsive — 1366x768', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/responsive_layout_1366x768.png`, fullPage: false });
  });

  test('Responsive — 1024x768 (sidebar boundary)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/responsive_layout_1024x768.png`, fullPage: false });
  });
});
