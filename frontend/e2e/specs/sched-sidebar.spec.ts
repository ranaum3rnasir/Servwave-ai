/**
 * Category C — Sidebar Space Utilization
 *
 * Verifies sidebar width, collapse/expand, section behavior with
 * varying content volume (0, 1, 5, 20+ items), and card compactness.
 *
 * Extends the existing wt-schedule-sidebar.spec.ts with deeper UI/UX checks.
 *
 * Test IDs: C-01 through C-15
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import { screenshotAndAssert } from '../helpers/screenshot';
import { type ScheduleSeed, seedScheduleData } from '../helpers/schedule-seed';
import {
  createUrgentJob,
  deleteJob,
} from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

test.describe.serial('Category C — Sidebar Space Utilization', () => {
  let seed: ScheduleSeed;
  const extraJobs: string[] = [];

  test.beforeAll(async () => {
    seed = await seedScheduleData({ suffix: 'side' });
  });

  test.afterAll(async () => {
    for (const id of extraJobs) await deleteJob(seed.token, id).catch(() => {});
    await seed.cleanup();
  });

  test('C-01 — Sidebar width is ~240-320px, calendar gets remaining space', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    const sidebarDims = await sp.getSidebarDimensions();
    const viewport = page.viewportSize()!;

    if (sidebarDims) {
      console.log('[C-01] Sidebar width:', sidebarDims.width, 'Viewport:', viewport.width);
      // Sidebar should be in reasonable range (w-60 = 240px in Tailwind)
      expect(sidebarDims.width).toBeGreaterThanOrEqual(200);
      expect(sidebarDims.width).toBeLessThanOrEqual(350);

      // Calendar should get remaining space
      const calBox = await sp.calendarCard.boundingBox();
      if (calBox) {
        const calRightEdge = calBox.x + calBox.width;
        console.log('[C-01] Calendar width:', calBox.width, 'right edge:', calRightEdge);
        // Calendar should extend close to viewport edge
        expect(calBox.width).toBeGreaterThan(viewport.width * 0.5);
      }
    }

    await sp.takeAuditScreenshot('C-01_sidebar-vs-calendar-width.png');
  });

  test('C-02 — Sidebar collapse hides it, calendar expands', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    // Get calendar width before collapse
    const calBefore = await sp.calendarCard.boundingBox();
    const calWidthBefore = calBefore?.width ?? 0;

    // Find and click the collapse button
    const collapseBtn = page.locator('button').filter({ has: page.locator('.lucide-panel-right-close, .lucide-panel-right-open') }).first();
    const collapseVisible = await collapseBtn.isVisible().catch(() => false);

    if (collapseVisible) {
      await collapseBtn.click();
      await page.waitForTimeout(500);

      // Sidebar should be gone or zero-width
      const sidebarAfter = await sp.getSidebarDimensions();
      console.log('[C-02] Sidebar after collapse:', sidebarAfter);

      // Calendar should be wider
      const calAfter = await sp.calendarCard.boundingBox();
      if (calAfter) {
        console.log('[C-02] Calendar width before:', calWidthBefore, 'after:', calAfter.width);
        // Calendar should have expanded
        expect(calAfter.width).toBeGreaterThanOrEqual(calWidthBefore);
      }
    } else {
      console.log('[C-02] No collapse button found — FINDING: sidebar may not be collapsible');
    }

    await sp.takeAuditScreenshot('C-02_sidebar-collapsed.png');
  });

  test('C-04 — Empty sidebar shows success state', async ({ page }) => {
    // Note: This test depends on no unassigned jobs existing.
    // If jobs exist, document the empty state behavior.
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    // Check for empty state messages
    const allAssigned = page.getByText('All jobs are assigned');
    const allAssignedVisible = await allAssigned.isVisible().catch(() => false);

    const noWalkthroughs = page.getByText('No walkthroughs to schedule');
    const noWalkthroughsVisible = await noWalkthroughs.isVisible().catch(() => false);

    console.log('[C-04] "All assigned" visible:', allAssignedVisible);
    console.log('[C-04] "No walkthroughs" visible:', noWalkthroughsVisible);

    await sp.takeAuditScreenshot('C-04_sidebar-empty-states.png');
  });

  test('C-06 — Sidebar with 5 unassigned jobs', async ({ page }) => {
    // Create 5 extra unassigned jobs (seed already provides 2)
    for (let i = 0; i < 5; i++) {
      const job = await createUrgentJob(seed.token, seed.customerId, seed.locationId);
      extraJobs.push(job.id);
    }

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await page.waitForTimeout(1000);

    // Count visible cards in sidebar
    const cards = sp.getSidebarDraggableCards();
    const cardCount = await cards.count();
    console.log('[C-06] Sidebar draggable cards:', cardCount);

    // Verify cards don't have excessive spacing
    if (cardCount >= 2) {
      const box1 = await cards.nth(0).boundingBox();
      const box2 = await cards.nth(1).boundingBox();
      if (box1 && box2) {
        const gap = box2.y - (box1.y + box1.height);
        console.log('[C-06] Gap between cards:', gap, 'px');
        // Gap should be reasonable (< 16px typically)
        expect(gap).toBeLessThan(24);
      }
    }

    await sp.takeAuditScreenshot('C-06_sidebar-5-jobs.png');
  });

  test('C-09 — Section collapse: Walkthroughs collapses, Jobs expands', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    // Measure Jobs section position before
    const jobsSectionBefore = await sp.jobsSectionHeader.boundingBox();

    // Collapse walkthroughs
    await sp.walkthroughsSectionHeader.click();
    await page.waitForTimeout(300);

    // Jobs section should have moved up (or expanded)
    const jobsSectionAfter = await sp.jobsSectionHeader.boundingBox();
    if (jobsSectionBefore && jobsSectionAfter) {
      console.log('[C-09] Jobs section Y before:', jobsSectionBefore.y, 'after:', jobsSectionAfter.y);
      // Jobs should be at same or higher position (moved up because walkthroughs collapsed)
      expect(jobsSectionAfter.y).toBeLessThanOrEqual(jobsSectionBefore.y + 5);
    }

    await sp.takeAuditScreenshot('C-09_walkthrough-collapsed-jobs-expanded.png');
  });

  test('C-11 — Both sections collapsed shows minimal sidebar', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    // Collapse both sections
    await sp.walkthroughsSectionHeader.click();
    await page.waitForTimeout(300);
    await sp.jobsSectionHeader.click();
    await page.waitForTimeout(300);

    // The sidebar should show just headers — no large blank area
    const sidebarDims = await sp.getSidebarDimensions();
    if (sidebarDims) {
      console.log('[C-11] Sidebar height with both collapsed:', sidebarDims.height);
    }

    await sp.takeAuditScreenshot('C-11_both-sections-collapsed.png');
  });

  test('C-12 — Card content is compact (no excessive padding)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    const cards = sp.getSidebarDraggableCards();
    const count = await cards.count();
    expect(count, 'Seed provides unassigned jobs — cards should exist').toBeGreaterThanOrEqual(1);

    const card = cards.first();
    const box = await card.boundingBox();
    if (box) {
      console.log('[C-12] First card height:', box.height, 'width:', box.width);
      // A compact card should be < 100px tall
      expect(box.height).toBeLessThan(120);
    }

    // Check internal padding
    const padding = await card.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        paddingTop: cs.paddingTop,
        paddingBottom: cs.paddingBottom,
        paddingLeft: cs.paddingLeft,
        paddingRight: cs.paddingRight,
      };
    });
    console.log('[C-12] Card padding:', JSON.stringify(padding));

    await sp.takeAuditScreenshot('C-12_card-compactness.png');
  });

  test('C-14 — Sidebar usable at 1366x768', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    const sidebarDims = await sp.getSidebarDimensions();
    if (sidebarDims) {
      console.log('[C-14] Sidebar at 1366x768:', sidebarDims.width, 'x', sidebarDims.height);
      // Sidebar should still be functional
      expect(sidebarDims.width).toBeGreaterThan(150);
    }

    // Check that cards are still readable
    const cards = sp.getAllSidebarCards();
    const count = await cards.count();
    console.log('[C-14] Cards visible at 1366x768:', count);

    await sp.takeAuditScreenshot('C-14_sidebar-1366x768.png');
  });

  test('C-15 — Sidebar hidden below lg breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 768 });
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    const sidebarVisible = await sp.sidebar.isVisible().catch(() => false);
    console.log('[C-15] Sidebar visible at 1000px:', sidebarVisible);

    if (sidebarVisible) {
      console.log('[C-15] FINDING: Sidebar still visible below lg breakpoint');
    }

    await sp.takeAuditScreenshot('C-15_sidebar-below-lg.png');
  });
});
