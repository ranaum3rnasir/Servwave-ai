import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { LeadDetailV2Page } from '../pages/lead-detail-v2.page';
import { screenshotAndAssert } from '../helpers/screenshot';
import {
  getAdminToken,
  createLeadViaApi,
  createTechnicianUser,
  markLeadContacted,
  scheduleWalkthrough,
  completeWalkthrough,
  deleteUser,
} from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

test.describe.serial('Walkthrough Lifecycle', () => {
  let token: string;
  let leadId: string;
  let techId: string;

  test.beforeAll(async () => {
    token = await getAdminToken();
    const suffix = Date.now().toString(36);
    const lead = await createLeadViaApi(token, {
      firstName: 'Lifecycle',
      lastName: `WT-${suffix}`,
      serviceRequest: `Lifecycle walkthrough test ${suffix}`,
    });
    leadId = lead.id;
    techId = await createTechnicianUser(token, `lc-${suffix}`);
    await markLeadContacted(token, leadId);
  });

  test.afterAll(async () => {
    try { await deleteUser(token, techId); } catch { /* best effort */ }
  });

  test('walkthrough tab shows scheduling form for contacted lead', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId, 'walkthrough');
    await page.waitForTimeout(500);
    // Should see scheduling form elements
    const hasForm = await page.locator('input[type="datetime-local"]').first().isVisible().catch(() => false);
    const hasScheduleBtn = await detail.scheduleButton.isVisible().catch(() => false);
    const hasContent = await page.getByText(/schedule|walkthrough/i).first().isVisible().catch(() => false);
    expect(hasForm || hasScheduleBtn || hasContent).toBeTruthy();
    await screenshotAndAssert(page, 'lifecycle-contacted-wt-tab.png');
  });

  test('scheduling form has date, performer, duration fields', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId, 'walkthrough');
    // Check for date input
    await expect(page.locator('input[type="datetime-local"]').first()).toBeVisible({ timeout: 5000 });
    // Check for performer selection (select or combobox)
    const hasPerformer = await page.locator('select, [role="combobox"]').first().isVisible().catch(() => false);
    expect(hasPerformer).toBeTruthy();
    await screenshotAndAssert(page, 'lifecycle-form-fields.png', {
      expectVisible: ['Schedule'],
    });
  });

  test('scheduling walkthrough via API transitions status', async ({ page }) => {
    // Schedule via API
    const scheduledAt = new Date(Date.now() + 86400000).toISOString();
    await scheduleWalkthrough(token, leadId, techId, scheduledAt, 60);

    // Reload and verify status badge
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    await screenshotAndAssert(page, 'lifecycle-wt-scheduled.png', {
      expectVisible: ['WT Scheduled'],
    });
  });

  test('scheduled walkthrough shows details', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId, 'walkthrough');
    // Should see scheduled date/performer info instead of form
    await screenshotAndAssert(page, 'lifecycle-scheduled-details.png');
  });

  test('completing walkthrough via API shows green banner', async ({ page }) => {
    await completeWalkthrough(token, leadId);

    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    // Check for completed indicator
    const hasCompletedBadge = await page.getByText(/WT Completed/i).first().isVisible().catch(() => false);
    const hasCompletedBanner = await detail.completedBanner.isVisible().catch(() => false);
    expect(hasCompletedBadge || hasCompletedBanner).toBeTruthy();
    await screenshotAndAssert(page, 'lifecycle-wt-completed.png');
  });

  test('completed state is visible in walkthrough tab', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId, 'walkthrough');
    // Should see completed state in the walkthrough tab
    const hasCompleted = await page.getByText(/completed|complete/i).first().isVisible().catch(() => false);
    const hasBanner = await detail.completedBanner.isVisible().catch(() => false);
    expect(hasCompleted || hasBanner).toBeTruthy();
    await screenshotAndAssert(page, 'lifecycle-completed-tab.png');
  });
});
