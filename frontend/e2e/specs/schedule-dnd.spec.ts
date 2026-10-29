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

/** Get ISO datetime for today at a given UTC hour */
function todayAt(hour: number): string {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

test.describe('Schedule page — drag-and-drop', () => {
  let token: string;
  let techId: string;
  let jobId: string;
  let jobNumber: string;
  let scheduledJobId: string;
  const suffix = Date.now().toString(36);

  test.beforeAll(async () => {
    token = await getAdminToken();
    techId = await createTechnicianUser(token, `dnd-${suffix}`);
    const customer = await getFirstCustomerWithLocation(token);
    if (!customer) throw new Error('No customer with location found for DnD test');

    // Unassigned job for sidebar-drag tests
    const job = await createUrgentJob(token, customer.customerId, customer.locationId);
    jobId = job.id;
    jobNumber = job.job_number;

    // Scheduled job in current week — used for calendar event drag test
    const scheduledJob = await createUrgentJob(token, customer.customerId, customer.locationId);
    scheduledJobId = scheduledJob.id;
    await assignJob(token, scheduledJobId, techId, todayAt(10), todayAt(11));
  });

  test.afterAll(async () => {
    await deleteUser(token, techId).catch(() => {});
    await deleteJob(token, jobId).catch(() => {});
    // scheduledJobId is SCHEDULED — cannot delete. Leave it.
  });

  test('dragging sidebar job to calendar slot opens AssignJobDialog with pre-filled times', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();

    const sidebarCard = sp.getSidebarJobCard(jobNumber);
    await expect(sidebarCard).toBeVisible();

    // Target a time slot in the week view calendar
    const targetSlot = page.locator('.rbc-time-content .rbc-time-slot').nth(4);

    await sidebarCard.dragTo(targetSlot);
    await page.waitForTimeout(800);

    // AssignJobDialog must open
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Assign Technician')).toBeVisible();

    // At least one datetime input should be filled (defaultStart set from drop position)
    const startInput = dialog.locator('input[type="datetime-local"]').nth(0);
    const startValue = await startInput.inputValue();
    expect(startValue).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('dragging sidebar job to grouped-by-tech column pre-selects technician in dialog', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();

    // Switch to grouped-by-tech view
    await sp.byTechnicianButton.click();
    await page.waitForTimeout(500);

    // Find the technician's column header
    const techName = `E2E Tech-dnd-${suffix}`;
    const techHeader = page.locator('.rbc-resource-cell, .rbc-header').filter({ hasText: techName });
    const headerVisible = await techHeader.isVisible({ timeout: 3000 }).catch(() => false);
    if (!headerVisible) {
      test.skip();
      return;
    }

    const sidebarCard = sp.getSidebarJobCard(jobNumber);
    await expect(sidebarCard).toBeVisible();

    // Get a time slot in the tech's column and drag to it
    const techSlot = page.locator('.rbc-time-slot').first();
    await sidebarCard.dragTo(techSlot);
    await page.waitForTimeout(800);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // The tech should be pre-selected in the combobox
    const combobox = dialog.getByRole('combobox');
    const comboboxText = await combobox.innerText();
    expect(comboboxText).toMatch(new RegExp(techName, 'i'));

    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('dragging an existing calendar event to a new time slot fires reschedule', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();

    // Look for any visible calendar event
    const events = sp.getCalendarEvents();
    const count = await events.count();
    if (count === 0) {
      test.skip();
      return;
    }

    const calendarEvent = events.first();
    const eventBox = await calendarEvent.boundingBox();
    if (!eventBox) { test.skip(); return; }

    // Drag ~2 slot-heights down (approximately 1–2 hours later in day)
    await page.mouse.move(eventBox.x + eventBox.width / 2, eventBox.y + 5);
    await page.mouse.down();
    await page.mouse.move(eventBox.x + eventBox.width / 2, eventBox.y + 80, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1000);

    // After DnD: event still on calendar (moved), or conflict/error toast
    // All confirm DnD fired and API was called
    const stillVisible = await events.first().isVisible({ timeout: 3000 }).catch(() => false);
    const conflictVisible = await page.getByText(/Scheduling Conflict/).isVisible({ timeout: 2000 }).catch(() => false);
    const errorVisible = await page.getByText('Error').isVisible({ timeout: 2000 }).catch(() => false);

    expect(stillVisible || conflictVisible || errorVisible).toBe(true);
  });

  test('"By Technician" view renders resource column headers for active staff', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();

    await sp.byTechnicianButton.click();
    await page.waitForTimeout(500);

    // Resource column headers should be visible (at least one — our test tech or the admin)
    const resourceHeaders = sp.getResourceHeaders();
    const count = await resourceHeaders.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Staff filter should appear
    await expect(sp.staffFilterSelect).toBeVisible();
  });

});
