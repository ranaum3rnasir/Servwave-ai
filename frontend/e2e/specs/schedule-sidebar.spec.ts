import { test, expect } from '@playwright/test';
import { SchedulePage } from '../pages/schedule.page';
import {
  getAdminToken,
  createUrgentJob,
  deleteJob,
  getFirstCustomerWithLocation,
} from '../helpers/api-helpers';

test.describe('Schedule page — unassigned sidebar', () => {
  let token: string;
  let jobId: string;
  let jobNumber: string;

  test.beforeAll(async () => {
    token = await getAdminToken();
    const customer = await getFirstCustomerWithLocation(token);
    if (!customer) throw new Error('No customer with service location found in DB for sidebar test');
    const job = await createUrgentJob(token, customer.customerId, customer.locationId);
    jobId = job.id;
    jobNumber = job.job_number;
  });

  test.afterAll(async () => {
    if (jobId) await deleteJob(token, jobId).catch(() => {});
  });

  test('unassigned job card shows job number and is visible in sidebar', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await expect(sp.getSidebarJobCard(jobNumber)).toBeVisible();
  });

  test('unassigned job count badge shows non-zero count', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    // Badge is a small rounded element next to the "Unassigned Jobs" heading
    const badge = sp.sidebar.locator('span, div').filter({ hasText: /^\d+$/ }).first();
    const badgeText = await badge.innerText();
    expect(Number(badgeText)).toBeGreaterThanOrEqual(1);
  });

  test('clicking an unassigned job card opens AssignJobDialog', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.clickSidebarJob(jobNumber);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Assign Technician')).toBeVisible();
    // Close dialog
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

});
