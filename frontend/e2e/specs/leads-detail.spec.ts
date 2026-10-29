import { test, expect } from '@playwright/test';
import { LeadDetailPage } from '../pages/lead-detail.page';
import { createTestLead } from '../helpers/test-data';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');

test.describe('Lead Detail Page', () => {
  let leadUrl: string;
  let leadLastName: string;

  test.beforeAll(async ({ browser }) => {
    // Create a test lead to use for detail page tests
    const context = await browser.newContext({
      storageState: authFile,
    });
    const page = await context.newPage();
    const created = await createTestLead(page);
    leadLastName = created.lastName;
    leadUrl = page.url();
    await context.close();
  });

  test('loads all sections correctly', async ({ page }) => {
    await page.goto(leadUrl);
    await page.waitForLoadState('networkidle');

    // Hero section with title
    const title = page.getByRole('main').getByRole('heading', { level: 1 });
    await expect(title).toContainText(leadLastName);
    await expect(title).toContainText('–'); // en-dash "L##### – Name"

    // KPI strip labels
    await expect(page.getByText('Est. Value')).toBeVisible();
    await expect(page.getByText('Days Open')).toBeVisible();
    await expect(page.getByText('Source', { exact: true })).toBeVisible();

    // Action menu items (logged in as Admin)
    await page.getByRole('button', { name: /Lead actions/i }).click();
    await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Assign' })).toBeVisible();
  });

  test('tab switching works across all 4 tabs', async ({ page }) => {
    await page.goto(leadUrl);
    await page.waitForLoadState('networkidle');

    // Details tab (default) — should show "Service Request" label
    await expect(page.getByText('Lead Information')).toBeVisible();

    // Switch to Estimates tab
    await page.getByRole('tab', { name: /Estimates/ }).click();
    await expect(page.getByText('No estimates yet.')).toBeVisible();

    // Switch to Walkthrough tab
    await page.getByRole('tab', { name: 'Walkthrough' }).click();
    await expect(page.getByText('Scheduled Date/Time')).toBeVisible();

    // Switch to Notes tab
    await page.getByRole('tab', { name: /Notes/ }).click();
    await expect(page.getByPlaceholder('Add a note...')).toBeVisible();
  });
});
