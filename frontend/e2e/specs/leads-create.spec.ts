import { test, expect } from '@playwright/test';
import { LeadsListPage } from '../pages/leads-list.page';
import { LeadFormPage } from '../pages/lead-form.page';
import { createTestLead } from '../helpers/test-data';

test.describe('Create Lead', () => {
  test('creates a new lead with new customer and redirects to detail', async ({
    page,
  }) => {
    const { serviceRequest, firstName, lastName } = await createTestLead(page);

    // Should be on the detail page now
    expect(page.url()).toMatch(/\/leads\/[a-f0-9-]+$/);

    // Verify the lead title shows the customer name (scope to main to avoid header h1)
    const title = page.getByRole('main').getByRole('heading', { level: 1 });
    await expect(title).toContainText(firstName);
    await expect(title).toContainText(lastName);

    // Verify the service request is visible in the Details tab
    await expect(page.getByText(serviceRequest)).toBeVisible();
  });

  test('created lead appears in the leads list', async ({ page }) => {
    const { serviceRequest } = await createTestLead(page);

    // Navigate back to leads list
    const listPage = new LeadsListPage(page);
    await listPage.goto();

    // Search for our specific lead (use full unique suffix to avoid matching other E2E leads)
    await listPage.searchLeads(serviceRequest);
    await page.waitForTimeout(1500);

    // The lead should appear in the table
    const row = listPage.getRowByText(serviceRequest);
    await expect(row.first()).toBeVisible({ timeout: 10_000 });
  });
});
