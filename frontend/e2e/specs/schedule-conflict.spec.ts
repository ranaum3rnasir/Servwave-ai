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

// Fixed far-future dates to isolate conflict logic from calendar view
const SLOT_A_START = '2099-01-10T10:00:00.000Z';
const SLOT_A_END   = '2099-01-10T12:00:00.000Z';

test.describe('Schedule page — conflict detection', () => {
  let token: string;
  let techId: string;
  let jobAId: string;
  let jobBId: string;
  let jobBNumber: string;
  const suffix = Date.now().toString(36);

  test.beforeAll(async () => {
    token = await getAdminToken();
    techId = await createTechnicianUser(token, `conflict-${suffix}`);
    const customer = await getFirstCustomerWithLocation(token);
    if (!customer) throw new Error('No customer with location found for conflict test');

    // Job A: assigned to tech at 10am–12pm (bypasses UI conflict check)
    const jobA = await createUrgentJob(token, customer.customerId, customer.locationId);
    jobAId = jobA.id;
    await assignJob(token, jobAId, techId, SLOT_A_START, SLOT_A_END);

    // Job B: unassigned — will be assigned via UI with overlapping time
    const jobB = await createUrgentJob(token, customer.customerId, customer.locationId);
    jobBId = jobB.id;
    jobBNumber = jobB.job_number;
  });

  test.afterAll(async () => {
    await deleteUser(token, techId).catch(() => {});
    await deleteJob(token, jobBId).catch(() => {});
    // Job A is SCHEDULED — cannot delete; leave it
  });

  test('assigning job with overlapping time shows conflict warning in dialog', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.clickSidebarJob(jobBNumber);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Select the conflicting technician
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: new RegExp(`Tech-conflict-${suffix}`, 'i') }).click();

    // Fill overlapping times in local datetime-local format
    await dialog.locator('input[type="datetime-local"]').nth(0).fill('2099-01-10T10:00');
    await dialog.locator('input[type="datetime-local"]').nth(1).fill('2099-01-10T13:00');

    await dialog.getByRole('button', { name: 'Assign' }).click();
    await page.waitForTimeout(1500);

    // Conflict warning appears inside dialog
    await expect(dialog.getByText(/Scheduling Conflict/)).toBeVisible();
    await expect(sp.scheduleAnywayButton).toBeVisible();

    // Cancel without forcing
    await page.getByRole('button', { name: 'Cancel' }).first().click();
  });

  test('"Schedule Anyway" overrides conflict and assigns job', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.clickSidebarJob(jobBNumber);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: new RegExp(`Tech-conflict-${suffix}`, 'i') }).click();
    await dialog.locator('input[type="datetime-local"]').nth(0).fill('2099-01-10T10:00');
    await dialog.locator('input[type="datetime-local"]').nth(1).fill('2099-01-10T13:00');
    await dialog.getByRole('button', { name: 'Assign' }).click();
    await page.waitForTimeout(1500);

    await expect(dialog.getByText(/Scheduling Conflict/)).toBeVisible();
    await sp.scheduleAnywayButton.click();
    await page.waitForTimeout(1500);

    // Dialog closes after force-assign succeeds
    await expect(dialog).not.toBeVisible();
    await expect(sp.getSidebarJobCard(jobBNumber)).not.toBeVisible();
  });

  test('main Assign button is disabled while conflict warning is showing', async ({ page }) => {
    const customer = await getFirstCustomerWithLocation(token);
    if (!customer) { test.skip(); return; }
    const jobC = await createUrgentJob(token, customer.customerId, customer.locationId);

    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.clickSidebarJob(jobC.job_number);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: new RegExp(`Tech-conflict-${suffix}`, 'i') }).click();
    await dialog.locator('input[type="datetime-local"]').nth(0).fill('2099-01-10T10:00');
    await dialog.locator('input[type="datetime-local"]').nth(1).fill('2099-01-10T13:00');
    await dialog.getByRole('button', { name: 'Assign' }).click();
    await page.waitForTimeout(1500);

    // While conflict is showing, main Assign button must be disabled
    await expect(dialog.getByText(/Scheduling Conflict/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Assign' })).toBeDisabled();

    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await deleteJob(token, jobC.id).catch(() => {});
  });

});
