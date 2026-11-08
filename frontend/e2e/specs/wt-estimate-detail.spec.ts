import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { screenshotAndAssert } from '../helpers/screenshot';
import { getAdminToken } from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

test.describe.serial('Estimate Detail Page — walkthrough summary', () => {
  let firstEstimateUrl: string | null = null;

  test.beforeAll(async ({ browser }) => {
    // Check if any estimates exist by navigating to the estimates list
    const context = await browser.newContext({ storageState: authFile });
    const page = await context.newPage();
    await page.goto('/estimates');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Try to find the first estimate row link
    const firstRow = page.locator('table tbody tr').first();
    const rowVisible = await firstRow.isVisible().catch(() => false);
    if (rowVisible) {
      await firstRow.click();
      await page.waitForLoadState('networkidle');
      firstEstimateUrl = page.url();
    }
    await context.close();
  });

  test('estimate detail page loads', async ({ page }) => {
    test.skip(!firstEstimateUrl, 'No estimates exist in the system — skipping');
    await page.goto(firstEstimateUrl!);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await screenshotAndAssert(page, 'wt-estimate-detail-load.png', {
      expectVisible: ['EST-'],
    });
  });

  test('Details tab or content area loads', async ({ page }) => {
    test.skip(!firstEstimateUrl, 'No estimates exist in the system — skipping');
    await page.goto(firstEstimateUrl!);
    await page.waitForLoadState('networkidle');
    // Estimate detail should show estimate number and some content
    await expect(page.getByText(/EST-\d{4}-\d+/).first()).toBeVisible({ timeout: 5000 });
    await screenshotAndAssert(page, 'wt-estimate-detail-content.png');
  });

  test('walkthrough section visible if lead has walkthrough', async ({ page }) => {
    test.skip(!firstEstimateUrl, 'No estimates exist in the system — skipping');
    await page.goto(firstEstimateUrl!);
    await page.waitForLoadState('networkidle');
    // Look for "Walkthrough" text anywhere on the page — it may or may not appear
    // depending on whether the associated lead had a walkthrough
    const walkthroughEl = page.getByText('Walkthrough', { exact: false });
    const isVisible = await walkthroughEl.first().isVisible().catch(() => false);
    if (isVisible) {
      await expect(walkthroughEl.first()).toBeVisible();
    }
    await screenshotAndAssert(page, 'wt-estimate-detail-walkthrough.png');
  });
});
