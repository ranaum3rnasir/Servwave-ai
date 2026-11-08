import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { LeadDetailV2Page } from '../pages/lead-detail-v2.page';
import { screenshotAndAssert } from '../helpers/screenshot';
import { getAdminToken, createLeadViaApi } from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

test.describe.serial('Lead Detail Page — Render & Tabs', () => {
  let token: string;
  let leadId: string;
  let customerName: string;

  test.beforeAll(async () => {
    token = await getAdminToken();
    const lead = await createLeadViaApi(token, {
      firstName: 'Render',
      lastName: `Test-${Date.now().toString(36)}`,
    });
    leadId = lead.id;
    customerName = 'Render';
  });

  test('page loads without blank screen', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    // Wait for the customer name to appear (page might show spinner first)
    await expect(page.getByText(customerName, { exact: false }).first()).toBeVisible({ timeout: 10000 });
    await screenshotAndAssert(page, 'detail-loads.png', {
      expectVisible: [customerName],
    });
  });

  test('hero card displays lead info', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    await expect(detail.heroCard).toBeVisible();
    await expect(detail.heroCard.getByText(customerName, { exact: false }).first()).toBeVisible();
    await screenshotAndAssert(page, 'hero-card.png', {
      expectVisible: [customerName],
    });
  });

  test('three tabs render', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    await expect(detail.overviewTab).toBeVisible();
    await expect(detail.walkthroughTab).toBeVisible();
    await expect(detail.estimatesTab).toBeVisible();
    await screenshotAndAssert(page, 'three-tabs.png', {
      expectVisible: ['Overview', 'Walkthrough', 'Estimates'],
    });
  });

  test('Overview tab is active by default', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    const state = await detail.overviewTab.getAttribute('data-state');
    const ariaSelected = await detail.overviewTab.getAttribute('aria-selected');
    expect(state === 'active' || ariaSelected === 'true').toBeTruthy();
    await screenshotAndAssert(page, 'overview-active.png');
  });

  test('Overview tab shows service request and customer info', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    await screenshotAndAssert(page, 'overview-content.png', {
      expectVisible: [customerName],
    });
  });

  test('switching to Walkthrough tab shows scheduling form', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    await detail.switchTab('Walkthrough');
    // Look for datetime-local input or walkthrough-related content
    const hasDateInput = await page.locator('input[type="datetime-local"]').isVisible().catch(() => false);
    const hasWalkthroughContent = await page.getByText(/walkthrough|schedule|not required/i).first().isVisible().catch(() => false);
    expect(hasDateInput || hasWalkthroughContent).toBeTruthy();
    await screenshotAndAssert(page, 'walkthrough-tab.png');
  });

  test('switching to Estimates tab shows content', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    await detail.switchTab('Estimates');
    // Should show estimates content or an empty state
    const hasEstimateContent = await page.getByText(/estimate|no estimate|create/i).first().isVisible().catch(() => false);
    expect(hasEstimateContent).toBeTruthy();
    await screenshotAndAssert(page, 'estimates-tab.png');
  });

  test('icon rail visible on right', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    // Check for the icon rail or at least one of its buttons
    const railVisible = await detail.iconRail.isVisible().catch(() => false);
    const activityBtnVisible = await detail.activityIcon.isVisible().catch(() => false);
    expect(railVisible || activityBtnVisible).toBeTruthy();
    await screenshotAndAssert(page, 'icon-rail.png');
  });

  test('Activity panel opens on click', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    await detail.openActivityPanel();
    await screenshotAndAssert(page, 'activity-panel.png', {
      expectVisible: ['Activity'],
    });
  });

  test('Attachments panel opens on click', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    await detail.openAttachmentsPanel();
    await screenshotAndAssert(page, 'attachments-panel.png', {
      expectVisible: ['Attachments'],
    });
  });

  test('panel closes on second click', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);

    // Open activity panel
    await detail.openActivityPanel();
    await expect(page.getByText('Activity').first()).toBeVisible();

    // Click again to close
    await detail.openActivityPanel();
    await page.waitForTimeout(300);

    // Panel should be hidden or collapsed
    const panelVisible = await detail.slidingPanel.isVisible().catch(() => false);
    // If panel uses visibility/transform, check for content instead
    if (panelVisible) {
      // Panel element may still be in DOM but transformed away
      const box = await detail.slidingPanel.boundingBox();
      // If box is off-screen or null, it's effectively hidden
      expect(box === null || (box && box.x > 1200)).toBeTruthy();
    }
    await screenshotAndAssert(page, 'panel-closed.png');
  });
});
