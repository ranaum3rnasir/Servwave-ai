import { test, expect } from '@playwright/test';
import { SchedulePage } from '../pages/schedule.page';

test.describe('Schedule page — initial render', () => {

  test('page loads and calendar is visible', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await expect(sp.calendarCard).toBeVisible();
  });

  test('unassigned jobs sidebar is visible with heading and help text', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await expect(sp.unassignedHeading).toBeVisible();
    await expect(sp.sidebarHelpText).toBeVisible();
  });

  test('calendar controls are all visible', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await expect(sp.todayButton).toBeVisible();
    await expect(sp.standardButton).toBeVisible();
    await expect(sp.byTechnicianButton).toBeVisible();
    await expect(sp.dayButton).toBeVisible();
    await expect(sp.weekButton).toBeVisible();
    await expect(sp.monthButton).toBeVisible();
  });

  test('color legend shows all four event types', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await expect(page.getByText('Scheduled')).toBeVisible();
    await expect(page.getByText('In Progress')).toBeVisible();
    await expect(page.getByText('Walkthrough')).toBeVisible();
    await expect(page.getByText('Urgent')).toBeVisible();
  });

  test('default view is WEEK — week date range shown in label', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    // Week label contains an en-dash (e.g. "Mar 7 – 13, 2026")
    const label = page.locator('span[class*="font-semibold"][class*="min-w"]');
    await expect(label).toContainText('–');
  });

});
