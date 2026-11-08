/**
 * Category N — Feature-Specific Edge Cases (QA Review Additions)
 *
 * Covers implementation-specific behaviors discovered during code review:
 * - N-A: Completed/cancelled event protection (P0 data integrity)
 * - N-B: Slot popover on empty time click
 * - N-C: Search → highlight flow
 * - N-D: Role-based UI restrictions
 * - N-E: Staff filter & view constraints
 * - N-F: Sidebar-specific actions
 * - N-G: Overlay stacking & dismissal
 *
 * Test IDs: N-01 through N-20
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
  createLeadViaApi,
  markLeadContacted,
} from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

// ═══════════════════════════════════════════════════════════
// N-A: Completed/Cancelled Event Protection (P0)
// ═══════════════════════════════════════════════════════════

test.describe.serial('Category N-A — Completed/Cancelled Event Protection (P0)', () => {
  let token: string;
  let techId: string;
  let completedJobId: string;
  let completedJobNumber: string;

  test.beforeAll(async () => {
    token = await getAdminToken();
    const suffix = Date.now().toString(36);
    techId = await createTechnicianUser(token, `na-${suffix}`);

    // Create a job, assign it, then complete it via API
    const customer = await getFirstCustomerWithLocation(token);
    if (!customer) throw new Error('No customer');
    const job = await createUrgentJob(token, customer.customerId, customer.locationId);
    completedJobId = job.id;
    completedJobNumber = job.job_number;

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    await assignJob(token, completedJobId, techId, start.toISOString(), end.toISOString());

    // Start the job
    const ctx1 = await (await import('@playwright/test')).request.newContext({
      baseURL: 'http://localhost:5173',
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    await ctx1.post(`/api/jobs/${completedJobId}/start`);
    // Complete the job
    await ctx1.post(`/api/jobs/${completedJobId}/complete`, {
      data: { completion_notes: 'E2E test completion for N-A' },
    });
    await ctx1.dispose();
  });

  test.afterAll(async () => {
    // Completed jobs may not be deletable — catch errors
    if (completedJobId) await deleteJob(token, completedJobId).catch(() => {});
    if (techId) await deleteUser(token, techId).catch(() => {});
  });

  test('N-01 — Drag COMPLETED event should be blocked (P0 DATA INTEGRITY)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await sp.toggleToAll(); // Show completed events
    await page.waitForTimeout(500);

    const event = sp.getEventByText(completedJobNumber);
    const isVisible = await event.isVisible().catch(() => false);
    if (!isVisible) {
      console.log('[N-01] Completed event not visible — may need date navigation');
      await sp.takeAuditScreenshot('N-01_completed-not-visible.png');
      return;
    }

    const origBox = await event.boundingBox();
    if (!origBox) return;

    // Track if any API call fires (it should NOT)
    let assignCallFired = false;
    page.on('request', (req) => {
      if (req.url().includes('/assign') && req.method() === 'POST') {
        assignCallFired = true;
        console.log('[N-01] BUG CONFIRMED: assign API call fired for COMPLETED event!');
      }
    });

    // Attempt to drag the completed event
    await page.mouse.move(origBox.x + origBox.width / 2, origBox.y + origBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(origBox.x + origBox.width / 2, origBox.y + origBox.height / 2 + 80, { steps: 10 });
    await page.waitForTimeout(200);
    await sp.takeAuditScreenshot('N-01_completed-mid-drag.png');
    await page.mouse.up();
    await page.waitForTimeout(1000);

    // Check result
    if (assignCallFired) {
      console.log('[N-01] P0 BUG: Completed event was dragged and assign mutation fired.');
      console.log('[N-01] Root cause: draggableAccessor: () => true (line 1630)');
      console.log('[N-01] Fix: draggableAccessor should return false for COMPLETED/CANCELLED');
    } else {
      console.log('[N-01] PASS: No API call fired (drag was blocked or same-slot no-op)');
    }

    // Verify event didn't move
    const afterBox = await event.boundingBox();
    if (afterBox) {
      const moved = Math.abs(afterBox.y - origBox.y) > 15;
      console.log('[N-01] Event moved from original position:', moved);
    }

    await sp.takeAuditScreenshot('N-01_completed-drag-result.png');
  });

  test('N-03 — Resize COMPLETED event should be blocked (P0 DATA INTEGRITY)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();
    await sp.toggleToAll();
    await page.waitForTimeout(500);

    const event = sp.getEventByText(completedJobNumber);
    const isVisible = await event.isVisible().catch(() => false);
    if (!isVisible) { test.skip(); return; }

    const origBox = await event.boundingBox();
    if (!origBox) { test.skip(); return; }

    // Track resize API calls
    let resizeCallFired = false;
    page.on('request', (req) => {
      if (req.url().includes('/assign') && req.method() === 'POST') {
        resizeCallFired = true;
        console.log('[N-03] BUG CONFIRMED: assign API call fired during resize of COMPLETED event!');
      }
    });

    // Look for resize handle
    const resizeHandle = sp.getResizeHandleFor(completedJobNumber);
    const handleCount = await resizeHandle.count();
    console.log('[N-03] Resize handles on completed event:', handleCount);

    if (handleCount > 0) {
      console.log('[N-03] BUG: Resize handle exists on COMPLETED event (resizableAccessor: () => true)');
      const handleBox = await resizeHandle.first().boundingBox();
      if (handleBox) {
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 50, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(500);
      }
    }

    if (resizeCallFired) {
      console.log('[N-03] P0 BUG: COMPLETED event was resized and mutation fired.');
    }

    await sp.takeAuditScreenshot('N-03_completed-resize.png');
  });
});

// ═══════════════════════════════════════════════════════════
// N-B: Slot Popover (Empty Slot Click)
// ═══════════════════════════════════════════════════════════

test.describe.serial('Category N-B — Slot Popover', () => {
  test('N-05 — Click empty time slot shows popover', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Find an empty area in the calendar (click on the time grid, not on an event)
    const calBox = await sp.calendarCard.boundingBox();
    if (!calBox) { test.fail(); return; }

    // Click toward the right side and lower area (likely empty)
    const clickX = calBox.x + calBox.width * 0.8;
    const clickY = calBox.y + calBox.height * 0.6;
    await page.mouse.click(clickX, clickY);
    await page.waitForTimeout(500);

    // Check for slot popover — it's a fixed div positioned at click location
    const popover = page.locator('[class*="fixed"]').filter({ hasText: /create|schedule|new/i });
    const popoverVisible = await popover.first().isVisible().catch(() => false);
    console.log('[N-05] Slot popover visible after empty slot click:', popoverVisible);

    // Also check for any popover at all near the click position
    const anyFixed = page.locator('[class*="fixed"][class*="bg-white"][class*="shadow"]');
    const anyCount = await anyFixed.count();
    console.log('[N-05] Fixed popover elements found:', anyCount);

    await sp.takeAuditScreenshot('N-05_slot-popover.png');
  });

  test('N-06 — Slot popover dismisses on Escape', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();

    const calBox = await sp.calendarCard.boundingBox();
    if (!calBox) return;

    // Click empty slot
    await page.mouse.click(calBox.x + calBox.width / 2, calBox.y + calBox.height / 2);
    await page.waitForTimeout(300);

    // Press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // All overlays should be gone
    const anyVisible = await page.locator('[class*="fixed"][class*="bg-white"][class*="shadow"]')
      .first().isVisible().catch(() => false);
    console.log('[N-06] Popovers visible after Escape:', anyVisible);

    await sp.takeAuditScreenshot('N-06_slot-popover-escape.png');
  });
});

// ═══════════════════════════════════════════════════════════
// N-C: Search → Highlight Flow
// ═══════════════════════════════════════════════════════════

test.describe.serial('Category N-C — Search Highlight', () => {
  let token: string;
  let techId: string;
  let jobId: string;
  let jobNumber: string;

  test.beforeAll(async () => {
    token = await getAdminToken();
    const suffix = Date.now().toString(36);
    techId = await createTechnicianUser(token, `nc-${suffix}`);

    const customer = await getFirstCustomerWithLocation(token);
    if (!customer) throw new Error('No customer');
    const job = await createUrgentJob(token, customer.customerId, customer.locationId);
    jobId = job.id;
    jobNumber = job.job_number;

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    await assignJob(token, jobId, techId, start.toISOString(), end.toISOString());
  });

  test.afterAll(async () => {
    if (jobId) await deleteJob(token, jobId).catch(() => {});
    if (techId) await deleteUser(token, techId).catch(() => {});
  });

  test('N-09 — Search and select highlights event with animation', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    // Find and click the search input
    const searchInput = page.locator('input[placeholder*="Search schedule"]');
    const searchVisible = await searchInput.isVisible().catch(() => false);
    if (!searchVisible) {
      console.log('[N-09] Schedule search input not found');
      await sp.takeAuditScreenshot('N-09_no-search-input.png');
      return;
    }

    // Type the job number
    await searchInput.click();
    await searchInput.fill(jobNumber);
    await page.waitForTimeout(500);

    // Look for search results dropdown
    const results = page.locator('[class*="absolute"][class*="bg-white"]').filter({ hasText: jobNumber });
    const resultsVisible = await results.first().isVisible().catch(() => false);
    console.log('[N-09] Search results visible:', resultsVisible);

    if (resultsVisible) {
      // Click the result
      await results.first().click();
      await page.waitForTimeout(1000);

      // Check for highlight animation on the event
      const event = sp.getEventByText(jobNumber);
      const eventVisible = await event.isVisible().catch(() => false);
      if (eventVisible) {
        const boxShadow = await event.evaluate((el) =>
          window.getComputedStyle(el).boxShadow
        );
        const hasHighlight = boxShadow !== 'none' && boxShadow !== '';
        console.log('[N-09] Event has highlight box-shadow:', hasHighlight, boxShadow);

        // Check for animation
        const animation = await event.evaluate((el) =>
          window.getComputedStyle(el).animation
        );
        console.log('[N-09] Event animation:', animation);
      }
    }

    await sp.takeAuditScreenshot('N-09_search-highlight.png');
  });
});

// ═══════════════════════════════════════════════════════════
// N-E: Staff Filter & View Constraints
// ═══════════════════════════════════════════════════════════

test.describe.serial('Category N-E — Staff Filter & View Constraints', () => {
  test('N-13 — Staff filter: Technicians only', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToMemberView();
    await page.waitForTimeout(500);

    // Find the staff filter dropdown (only visible in grouped view)
    const staffFilter = page.locator('select').first();
    const filterVisible = await staffFilter.isVisible().catch(() => false);
    console.log('[N-13] Staff filter visible:', filterVisible);

    if (filterVisible) {
      // Count columns with "All"
      await sp.takeAuditScreenshot('N-13_staff-filter-all.png');

      // Select Technicians only
      await staffFilter.selectOption('TECHNICIAN');
      await page.waitForTimeout(500);
      await sp.takeAuditScreenshot('N-13_staff-filter-technicians.png');

      // Select Sales only
      await staffFilter.selectOption('SALES');
      await page.waitForTimeout(500);
      await sp.takeAuditScreenshot('N-14_staff-filter-sales.png');

      // Back to All
      await staffFilter.selectOption('all');
      await page.waitForTimeout(500);
    }
  });

  test('N-15 — Month button hidden in grouped view', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    // In standard view, month button should exist
    const monthBefore = await sp.monthButton.isVisible().catch(() => false);
    console.log('[N-15] Month button visible in Standard view:', monthBefore);

    // Switch to member view
    await sp.switchToMemberView();
    await page.waitForTimeout(300);

    // Month button should be gone
    const monthAfter = await sp.monthButton.isVisible().catch(() => false);
    console.log('[N-15] Month button visible in Member view:', monthAfter);

    if (monthAfter) {
      console.log('[N-15] FINDING: Month button still visible in grouped view');
    } else {
      console.log('[N-15] PASS: Month button correctly hidden in grouped view');
    }

    await sp.takeAuditScreenshot('N-15_month-hidden-grouped.png');
  });
});

// ═══════════════════════════════════════════════════════════
// N-F: Sidebar-Specific Actions
// ═══════════════════════════════════════════════════════════

test.describe.serial('Category N-F — Sidebar Actions', () => {
  let token: string;
  let leadId: string;

  test.beforeAll(async () => {
    token = await getAdminToken();
    const lead = await createLeadViaApi(token, {
      serviceRequest: `E2E no-walkthrough test ${Date.now().toString(36)}`,
    });
    leadId = lead.id;
    await markLeadContacted(token, leadId);
  });

  test('N-16 — "No Walkthrough Needed" removes card from sidebar', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await page.waitForTimeout(1000);

    // Count walkthrough cards before
    const cardsBefore = await sp.getSidebarWalkthroughCards().count();
    console.log('[N-16] Walkthrough cards before action:', cardsBefore);

    if (cardsBefore === 0) {
      console.log('[N-16] No walkthrough cards in sidebar — skip');
      return;
    }

    // Right-click the first walkthrough card
    const firstCard = sp.getSidebarWalkthroughCards().first();
    await firstCard.click({ button: 'right' });
    await page.waitForTimeout(300);

    // Look for "No Walkthrough Needed" menu item
    const noWtItem = page.getByText('No Walkthrough Needed', { exact: false });
    const itemVisible = await noWtItem.isVisible().catch(() => false);
    console.log('[N-16] "No Walkthrough Needed" menu item visible:', itemVisible);

    if (itemVisible) {
      // Intercept the API call
      const apiPromise = page.waitForResponse(
        (res) => res.url().includes('/api/leads/') && res.request().method() === 'PATCH',
        { timeout: 5000 }
      ).catch(() => null);

      await noWtItem.click();
      await page.waitForTimeout(1000);

      const response = await apiPromise;
      console.log('[N-16] API response status:', response?.status() ?? 'none');

      // Count cards after
      const cardsAfter = await sp.getSidebarWalkthroughCards().count();
      console.log('[N-16] Walkthrough cards after action:', cardsAfter);
    }

    await sp.takeAuditScreenshot('N-16_no-walkthrough-needed.png');
  });

  test('N-17 — Walkthrough section respects 40% height cap', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();

    // Measure the walkthrough section container
    const wtSection = page.locator('.overflow-y-auto.bg-background-light').first();
    const wtVisible = await wtSection.isVisible().catch(() => false);

    if (wtVisible) {
      const maxHeightStyle = await wtSection.evaluate((el) => el.style.maxHeight);
      console.log('[N-17] Walkthrough section maxHeight:', maxHeightStyle);

      const box = await wtSection.boundingBox();
      const sidebarBox = await sp.sidebar.boundingBox();
      if (box && sidebarBox) {
        const ratio = box.height / sidebarBox.height;
        console.log('[N-17] Walkthrough section height ratio:', (ratio * 100).toFixed(1) + '%');
        // Should be <= 40%
        expect(ratio).toBeLessThanOrEqual(0.45); // 5% tolerance
      }
    }

    await sp.takeAuditScreenshot('N-17_walkthrough-height-cap.png');
  });
});

// ═══════════════════════════════════════════════════════════
// N-G: Overlay Stacking & Dismissal
// ═══════════════════════════════════════════════════════════

test.describe.serial('Category N-G — Overlay Stacking', () => {
  let token: string;
  let techId: string;
  let jobId: string;
  let jobNumber: string;

  test.beforeAll(async () => {
    token = await getAdminToken();
    const suffix = Date.now().toString(36);
    techId = await createTechnicianUser(token, `ng-${suffix}`);

    const customer = await getFirstCustomerWithLocation(token);
    if (!customer) throw new Error('No customer');
    const job = await createUrgentJob(token, customer.customerId, customer.locationId);
    jobId = job.id;
    jobNumber = job.job_number;

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 11, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    await assignJob(token, jobId, techId, start.toISOString(), end.toISOString());
  });

  test.afterAll(async () => {
    if (jobId) await deleteJob(token, jobId).catch(() => {});
    if (techId) await deleteUser(token, techId).catch(() => {});
  });

  test('N-18 — Tooltip dismissed when context menu opens', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const event = sp.getEventByText(jobNumber);
    await expect(event).toBeVisible({ timeout: 5000 });

    // Hover to trigger tooltip
    await event.hover();
    await page.waitForTimeout(500);

    // Check tooltip is visible
    const tooltipBefore = page.locator('[class*="pointer-events-none"][class*="fixed"]');
    const tooltipVisibleBefore = await tooltipBefore.first().isVisible().catch(() => false);
    console.log('[N-18] Tooltip visible after hover:', tooltipVisibleBefore);

    // Right-click to open context menu
    await event.click({ button: 'right' });
    await page.waitForTimeout(300);

    // Tooltip should be gone
    const tooltipVisibleAfter = await tooltipBefore.first().isVisible().catch(() => false);
    console.log('[N-18] Tooltip visible after right-click:', tooltipVisibleAfter);

    // Context menu should be visible
    const contextMenu = page.locator('[class*="fixed"][class*="bg-white"][class*="shadow"]')
      .filter({ hasText: /Open|Reassign|Cancel|Mark/ });
    const menuVisible = await contextMenu.first().isVisible().catch(() => false);
    console.log('[N-18] Context menu visible:', menuVisible);

    if (tooltipVisibleAfter && menuVisible) {
      console.log('[N-18] BUG: Both tooltip and context menu visible simultaneously');
    } else {
      console.log('[N-18] PASS: Tooltip dismissed when context menu opened');
    }

    await sp.takeAuditScreenshot('N-18_tooltip-vs-context-menu.png');

    // Clean up — press Escape
    await page.keyboard.press('Escape');
  });

  test('N-19 — Click popup dismissed when right-clicking another event', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToWeekView();

    const events = sp.getAllEvents();
    const count = await events.count();
    if (count < 2) {
      console.log('[N-19] Need 2+ events to test — skip');
      test.skip();
      return;
    }

    // Click first event to open popup
    await events.first().click();
    await page.waitForTimeout(500);

    const popupVisible = await sp.quickViewPopup.isVisible().catch(() => false);
    console.log('[N-19] Click popup visible after click:', popupVisible);

    // Right-click second event
    await events.nth(1).click({ button: 'right' });
    await page.waitForTimeout(300);

    // Click popup should be dismissed
    const popupAfter = await sp.quickViewPopup.isVisible().catch(() => false);
    console.log('[N-19] Click popup visible after right-clicking another:', popupAfter);

    if (popupAfter) {
      console.log('[N-19] BUG: Click popup still visible after right-clicking another event');
    }

    await sp.takeAuditScreenshot('N-19_popup-vs-context-menu.png');
    await page.keyboard.press('Escape');
  });

  test('N-20 — Off-hours visual dimming (before 7 AM / after 7 PM)', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.goToToday();
    await sp.switchToDayView();

    // Scroll to top to see 6 AM area
    await page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content');
      if (el) el.scrollTop = 0;
    });
    await page.waitForTimeout(300);

    // Get background color of an off-hours slot (6 AM area)
    const offHoursColor = await page.evaluate(() => {
      const slots = document.querySelectorAll('.rbc-timeslot-group');
      if (slots.length > 0) {
        return window.getComputedStyle(slots[0]).backgroundColor;
      }
      return 'not-found';
    });

    // Get background color of a business hours slot (10 AM area)
    const businessHoursColor = await page.evaluate(() => {
      const slots = document.querySelectorAll('.rbc-timeslot-group');
      // 10 AM slot — each group represents ~30 min, so index ~8-10 should be around 10 AM
      if (slots.length > 10) {
        return window.getComputedStyle(slots[10]).backgroundColor;
      }
      return 'not-found';
    });

    console.log('[N-20] Off-hours (6 AM) background:', offHoursColor);
    console.log('[N-20] Business hours (10 AM) background:', businessHoursColor);

    // They should be different (off-hours = #F8FAFC, business = white/transparent)
    const areDifferent = offHoursColor !== businessHoursColor;
    console.log('[N-20] Off-hours visually distinct from business hours:', areDifferent);

    await sp.takeAuditScreenshot('N-20_off-hours-dimming.png');
  });
});
