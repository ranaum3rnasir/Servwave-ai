import { test, expect } from '@playwright/test';
import { SchedulePage } from '../pages/schedule.page';
import {
  getAdminToken,
  createTechnicianUser,
  deleteUser,
  createUrgentJob,
  assignJob,
  deleteJob,
  getFirstCustomerWithLocation,
} from '../helpers/api-helpers';

test.describe('Schedule page — assign job workflow', () => {
  let token: string;
  let techId: string;
  let jobId: string;
  let jobNumber: string;
  const suffix = Date.now().toString(36);

  test.beforeAll(async () => {
    token = await getAdminToken();
    techId = await createTechnicianUser(token, suffix);
    const customer = await getFirstCustomerWithLocation(token);
    if (!customer) throw new Error('No customer with location found for assign test');
    const job = await createUrgentJob(token, customer.customerId, customer.locationId);
    jobId = job.id;
    jobNumber = job.job_number;
  });

  test.afterAll(async () => {
    if (techId) await deleteUser(token, techId).catch(() => {});
    if (jobId) await deleteJob(token, jobId).catch(() => {});
  });

  test('AssignJobDialog shows technician and schedule fields', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.clickSidebarJob(jobNumber);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Technician')).toBeVisible();
    await expect(dialog.getByText('Scheduled Start')).toBeVisible();
    await expect(dialog.getByText('Scheduled End')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('assign job to technician — job disappears from sidebar', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.clickSidebarJob(jobNumber);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Select the technician
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: new RegExp(`Tech-${suffix}`, 'i') }).click();

    // Submit
    await dialog.getByRole('button', { name: 'Assign' }).click();
    await page.waitForTimeout(1500);

    // Dialog closed, job card gone from sidebar
    await expect(dialog).not.toBeVisible();
    await expect(sp.getSidebarJobCard(jobNumber)).not.toBeVisible();
  });

  test('re-assigning job with different scheduled end updates duration', async ({ page }) => {
    const customer = await getFirstCustomerWithLocation(token);
    if (!customer) { test.skip(); return; }
    const jobForDuration = await createUrgentJob(token, customer.customerId, customer.locationId);

    // First assign via API with 9am–10am window
    const todayBase = new Date();
    todayBase.setHours(9, 0, 0, 0);
    const start1 = todayBase.toISOString();
    todayBase.setHours(10, 0, 0, 0);
    const end1 = todayBase.toISOString();
    await assignJob(token, jobForDuration.id, techId, start1, end1);

    // Navigate to job detail and reassign with extended end
    await page.goto(`/jobs/${jobForDuration.id}`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /Reassign/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Change end time to 12:00 (same date)
    const endInput = dialog.locator('input[type="datetime-local"]').nth(1);
    const datePart = start1.slice(0, 10);
    await endInput.fill(`${datePart}T12:00`);

    await dialog.getByRole('button', { name: /Reassign|Assign/i }).click();
    await page.waitForTimeout(1500);
    await expect(dialog).not.toBeVisible();

    // Verify via API that scheduled_end was updated
    const apiRes = await page.request.get(`/api/jobs/${jobForDuration.id}`);
    const body = await apiRes.json() as { job: { scheduled_end: string } };
    expect(body.job.scheduled_end).toContain('12:00');

    await deleteJob(token, jobForDuration.id).catch(() => {});
  });

  test('submitting without selecting technician keeps Assign button disabled', async ({ page }) => {
    const customer = await getFirstCustomerWithLocation(token);
    if (!customer) { test.skip(); return; }
    const job2 = await createUrgentJob(token, customer.customerId, customer.locationId);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.clickSidebarJob(job2.job_number);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Assign button disabled without tech selected
    const submitBtn = dialog.getByRole('button', { name: 'Assign' });
    await expect(submitBtn).toBeDisabled();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await deleteJob(token, job2.id).catch(() => {});
  });

});
