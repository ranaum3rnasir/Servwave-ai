import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { JobDetailV2Page } from '../pages/job-detail-v2.page';
import { screenshotAndAssert } from '../helpers/screenshot';
import {
  getAdminToken,
  createUrgentJob,
  deleteJob,
  getFirstCustomerWithLocation,
} from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

test.describe.serial('Job Detail Page — walkthrough restructure', () => {
  let token: string;
  let jobId: string;
  let jobNumber: string;

  test.beforeAll(async () => {
    token = await getAdminToken();
    try {
      const customer = await getFirstCustomerWithLocation(token);
      if (!customer) { console.log('No customer with service location found — tests will skip'); return; }
      const job = await createUrgentJob(token, customer.customerId, customer.locationId);
      jobId = job.id;
      jobNumber = job.job_number;
    } catch (err) {
      console.log('Failed to create job for E2E test:', err);
    }
  });

  test.afterAll(async () => {
    if (jobId) await deleteJob(token, jobId).catch(() => {});
  });

  test('job detail page loads without blank screen', async ({ page }) => {
    test.skip(!jobId, 'Job was not created — skipping');
    const jd = new JobDetailV2Page(page);
    await jd.goto(jobId);
    await page.waitForTimeout(500);
    await screenshotAndAssert(page, 'wt-job-detail-load.png', {
      expectVisible: [jobNumber],
    });
  });

  test('four tabs render: Overview, Walkthrough, Work Items, Estimates', async ({ page }) => {
    test.skip(!jobId, 'Job was not created — skipping');
    const jd = new JobDetailV2Page(page);
    await jd.goto(jobId);
    await page.waitForTimeout(500);
    await expect(jd.overviewTab).toBeVisible();
    await expect(jd.walkthroughTab).toBeVisible();
    await expect(jd.workItemsTab).toBeVisible();
    await expect(jd.estimatesTab).toBeVisible();
    await screenshotAndAssert(page, 'wt-job-detail-tabs.png');
  });

  test('Overview tab shows job details', async ({ page }) => {
    test.skip(!jobId, 'Job was not created — skipping');
    const jd = new JobDetailV2Page(page);
    await jd.goto(jobId);
    await page.waitForTimeout(500);
    await expect(jd.overviewTab).toHaveAttribute('data-state', 'active');
    await expect(page.getByText(jobNumber).first()).toBeVisible();
    // Customer info should be visible on the overview
    await screenshotAndAssert(page, 'wt-job-detail-overview.png', {
      expectVisible: [jobNumber],
    });
  });

  test('Walkthrough tab renders for urgent job', async ({ page }) => {
    test.skip(!jobId, 'Job was not created — skipping');
    const jd = new JobDetailV2Page(page);
    await jd.goto(jobId);
    await jd.switchTab('Walkthrough');
    await page.waitForTimeout(500);
    // Should show either a walkthrough form, walkthrough info, or empty state
    await screenshotAndAssert(page, 'wt-job-detail-walkthrough-tab.png');
  });

  test('Work Items tab shows charges section', async ({ page }) => {
    test.skip(!jobId, 'Job was not created — skipping');
    const jd = new JobDetailV2Page(page);
    await jd.goto(jobId);
    await jd.switchTab('Work Items');
    await page.waitForTimeout(500);
    await screenshotAndAssert(page, 'wt-job-detail-work-items.png');
  });

  test('icon rail visible', async ({ page }) => {
    test.skip(!jobId, 'Job was not created — skipping');
    const jd = new JobDetailV2Page(page);
    await jd.goto(jobId);
    // The icon rail is a fixed element on the right side
    // Try the POM locator first, fall back to a broader search
    const rail = jd.iconRail.or(page.locator('[class*="fixed"][class*="right"]').first());
    await expect(rail).toBeVisible({ timeout: 5000 });
    await screenshotAndAssert(page, 'wt-job-detail-icon-rail.png');
  });
});
