import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.resolve(__dirname, '..', 'screenshots');

const VIEWPORT = { width: 1440, height: 900 };

async function shot(page: any, name: string) {
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, name),
    fullPage: true,
  });
}

async function waitForContent(page: any) {
  // Wait for network idle + no loading spinners
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

test.use({ viewport: VIEWPORT });

test('01 - Login page', async ({ page }) => {
  // Login page doesn't need auth — create a fresh context
  await page.goto('/login');
  await waitForContent(page);
  await shot(page, '01-login.png');
});

test('02 - Dashboard', async ({ page }) => {
  await page.goto('/');
  await waitForContent(page);
  await shot(page, '02-dashboard.png');
});

test('03 - Leads list', async ({ page }) => {
  await page.goto('/leads');
  await waitForContent(page);
  await shot(page, '03-leads-list.png');
});

test('04 - Lead detail', async ({ page }) => {
  await page.goto('/leads');
  await waitForContent(page);
  // Click first lead row
  const firstRow = page.locator('table tbody tr').first();
  const count = await page.locator('table tbody tr').count();
  if (count > 0) {
    await firstRow.click();
    await waitForContent(page);
  }
  await shot(page, '04-lead-detail.png');
});

test('05 - Customers list', async ({ page }) => {
  await page.goto('/customers');
  await waitForContent(page);
  await shot(page, '05-customers-list.png');
});

test('06 - Customer detail', async ({ page }) => {
  await page.goto('/customers');
  await waitForContent(page);
  const count = await page.locator('table tbody tr').count();
  if (count > 0) {
    await page.locator('table tbody tr').first().click();
    await waitForContent(page);
  }
  await shot(page, '06-customer-detail.png');
});

test('07 - Estimates list', async ({ page }) => {
  await page.goto('/estimates');
  await waitForContent(page);
  await shot(page, '07-estimates-list.png');
});

test('08 - Estimate detail', async ({ page }) => {
  await page.goto('/estimates');
  await waitForContent(page);
  const count = await page.locator('table tbody tr').count();
  if (count > 0) {
    await page.locator('table tbody tr').first().click();
    await waitForContent(page);
  }
  await shot(page, '08-estimate-detail.png');
});

// 09 - Estimate form (new): removed with SERV10X-61. There is no New Estimate form any more
// (estimates are create=edit: `/estimates/new` needs a lead/customer/job anchor, creates a DRAFT
// and redirects into the workspace). An anchorless `/estimates/new` bounces straight to the list,
// so this shot was silently the estimates LIST under a filename claiming it was the form - and the
// list is already covered by "07 - Estimates list" above. There is no anchorless surface left to
// screenshot: a real one would have to create a database row first.

test('10 - Jobs list', async ({ page }) => {
  await page.goto('/jobs');
  await waitForContent(page);
  await shot(page, '10-jobs-list.png');
});

test('11 - Job detail', async ({ page }) => {
  await page.goto('/jobs');
  await waitForContent(page);
  const count = await page.locator('table tbody tr').count();
  if (count > 0) {
    await page.locator('table tbody tr').first().click();
    await waitForContent(page);
  }
  await shot(page, '11-job-detail.png');
});

test('12 - Schedule', async ({ page }) => {
  await page.goto('/schedule');
  await waitForContent(page);
  await shot(page, '12-schedule.png');
});

test('13 - Price book', async ({ page }) => {
  await page.goto('/price-book');
  await waitForContent(page);
  await shot(page, '13-price-book.png');
});
