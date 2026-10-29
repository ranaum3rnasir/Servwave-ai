import { test, expect } from '@playwright/test';
import { LeadsListPage } from '../pages/leads-list.page';

test.describe('Leads List Page', () => {
  test('loads page with heading and KPI strip', async ({ page }) => {
    const leadsPage = new LeadsListPage(page);
    await leadsPage.goto();

    // Heading is visible
    await expect(leadsPage.heading).toBeVisible();

    // KPI labels are present
    await expect(leadsPage.getKpiLabel('Total Leads')).toBeVisible();
    await expect(leadsPage.getKpiLabel('New This Week')).toBeVisible();
    await expect(leadsPage.getKpiLabel('Won This Month')).toBeVisible();
  });

  test('search input is functional', async ({ page }) => {
    const leadsPage = new LeadsListPage(page);
    await leadsPage.goto();

    // Search input is present
    await expect(leadsPage.searchInput).toBeVisible();

    // Type a search term
    await leadsPage.searchLeads('nonexistent-e2e-search');

    // Wait for debounced API call
    await page.waitForTimeout(1000);

    // The table should still render (even if no results)
    await expect(leadsPage.table).toBeVisible();
  });

  test('New Lead button navigates to form', async ({ page }) => {
    const leadsPage = new LeadsListPage(page);
    await leadsPage.goto();

    await leadsPage.clickNewLead();
    await page.waitForURL('/leads/new');

    // Verify we're on the create form
    await expect(page.getByRole('heading', { name: 'New Lead' })).toBeVisible();
  });
});
