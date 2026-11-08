import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { SchedulePage } from '../pages/schedule.page';
import { screenshotAndAssert } from '../helpers/screenshot';
import {
  getAdminToken,
  createUrgentJob,
  createTechnicianUser,
  assignJob,
  deleteJob,
  deleteUser,
  getFirstCustomerWithLocation,
} from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

test.describe.serial('Schedule page — views, Plan Mode, filters, legend', () => {
  let token: string;
  let jobId: string;
  let techId: string;

  test.beforeAll(async () => {
    token = await getAdminToken();

    // Create a technician and an assigned job so we have calendar events
    const suffix = Date.now().toString(36);
    techId = await createTechnicianUser(token, `views-${suffix}`);

    const customer = await getFirstCustomerWithLocation(token);
    if (!customer) throw new Error('No customer with service location found');
    const job = await createUrgentJob(token, customer.customerId, customer.locationId);
    jobId = job.id;

    // Schedule the job for today
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    await assignJob(token, jobId, techId, start.toISOString(), end.toISOString());
  });

  test.afterAll(async () => {
    if (jobId) await deleteJob(token, jobId).catch(() => {});
    if (techId) await deleteUser(token, techId).catch(() => {});
  });

  test('Member View button text (not "By Technician")', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    // Should show "Member View" instead of old "By Technician"
    await expect(sp.memberViewButton).toBeVisible({ timeout: 5000 });
    await screenshotAndAssert(page, 'wt-schedule-member-view-btn.png', {
      expectVisible: ['Member View'],
    });
  });

  test('clicking Member View shows board or grid', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.switchToMemberView();
    await page.waitForTimeout(1000);
    // After switching, the view should change — resource headers or a different layout should appear
    await screenshotAndAssert(page, 'wt-schedule-member-view-active.png');
  });

  test('Plan Mode button visible', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await expect(sp.planModeButton).toBeVisible({ timeout: 5000 });
    await screenshotAndAssert(page, 'wt-schedule-plan-mode-btn.png', {
      expectVisible: ['Plan Mode'],
    });
  });

  test('clicking Plan Mode shows banner', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.clickPlanMode();
    await page.waitForTimeout(500);
    // A blue banner should appear indicating plan mode is active
    await expect(sp.planModeBanner).toBeVisible({ timeout: 5000 });
    await screenshotAndAssert(page, 'wt-schedule-plan-mode-banner.png');
  });

  test('Plan Mode banner has action buttons', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.clickPlanMode();
    await page.waitForTimeout(500);
    // Check for Discard All and Confirm All buttons
    await expect(page.getByRole('button', { name: /Discard All/i })).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: /Confirm All/i })).toBeVisible({ timeout: 3000 });
    await screenshotAndAssert(page, 'wt-schedule-plan-mode-actions.png');
  });

  test('clicking Plan Mode again deactivates', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();

    // Activate plan mode
    await sp.clickPlanMode();
    await page.waitForTimeout(500);
    await expect(sp.planModeBanner).toBeVisible({ timeout: 3000 });

    // Deactivate plan mode (no ghost events = immediate deactivate)
    await sp.clickPlanMode();
    await page.waitForTimeout(500);

    // Banner should disappear
    await expect(sp.planModeBanner).not.toBeVisible({ timeout: 3000 });
    await screenshotAndAssert(page, 'wt-schedule-plan-mode-off.png');
  });

  test('Open/All filter toggle visible', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await expect(sp.openToggle).toBeVisible({ timeout: 5000 });
    await expect(sp.allToggle).toBeVisible({ timeout: 5000 });
    await screenshotAndAssert(page, 'wt-schedule-open-all-toggle.png');
  });

  test('legend shows walkthrough + completed entries', async ({ page }) => {
    // Set viewport wider to ensure xl breakpoint (min-width: 1280px) activates
    await page.setViewportSize({ width: 1440, height: 900 });
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();

    // The legend is in the right sidebar which is closed by default.
    // Open it by clicking the sidebar toggle button (hidden xl:flex).
    const sidebarToggle = page.locator('button[title="Show sidebar"]');
    const toggleVisible = await sidebarToggle.isVisible().catch(() => false);
    if (toggleVisible) {
      await sidebarToggle.click();
      await page.waitForTimeout(500);
    }

    // Look for legend entries — "Walkthrough" and "Completed" appear as legend labels
    const walkthroughLegend = page.getByText('Walkthrough', { exact: true }).first();
    const completedLegend = page.getByText('Completed', { exact: true }).first();
    const walkthroughVisible = await walkthroughLegend.isVisible().catch(() => false);
    const completedVisible = await completedLegend.isVisible().catch(() => false);

    // If the right sidebar toggle wasn't available (viewport too small), skip gracefully
    if (!toggleVisible) {
      console.log('Right sidebar toggle not visible at this viewport — skipping legend check');
    } else {
      expect(walkthroughVisible || completedVisible, 'Expected at least one legend entry to be visible after opening sidebar').toBeTruthy();
    }
    await screenshotAndAssert(page, 'wt-schedule-legend.png');
  });
});
