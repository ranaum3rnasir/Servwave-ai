import { test, expect } from '@playwright/test';
import { SchedulePage } from '../pages/schedule.page';

test.describe('Schedule page — navigation controls', () => {

  test('switching to Day view changes date label to single date format', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.dayButton.click();
    await page.waitForTimeout(500);
    // Day label example: "Friday, March 7, 2026" — contains a comma
    const dateLabel = page.locator('span[class*="font-semibold"][class*="min-w"]');
    const label = await dateLabel.innerText();
    expect(label).toMatch(/\w+,\s+\w+\s+\d+,\s+\d{4}/);
  });

  test('switching to Month view changes date label to month/year format', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    await sp.monthButton.click();
    await page.waitForTimeout(500);
    // Month label example: "March 2026"
    const dateLabel = page.locator('span[class*="font-semibold"][class*="min-w"]');
    const label = await dateLabel.innerText();
    expect(label).toMatch(/\w+\s+\d{4}/);
    expect(label).not.toContain('–');
  });

  test('Today button resets to current week range', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    const dateLabel = page.locator('span[class*="font-semibold"][class*="min-w"]');
    // Navigate forward first
    await sp.nextButton.click();
    await page.waitForTimeout(300);
    const advancedLabel = await dateLabel.innerText();
    // Then click Today
    await sp.todayButton.click();
    await page.waitForTimeout(300);
    const todayLabel = await dateLabel.innerText();
    expect(todayLabel).not.toBe(advancedLabel);
  });

  test('Next button advances the date range forward', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    const dateLabel = page.locator('span[class*="font-semibold"][class*="min-w"]');
    const before = await dateLabel.innerText();
    await sp.nextButton.click();
    await page.waitForTimeout(300);
    const after = await dateLabel.innerText();
    expect(after).not.toBe(before);
  });

  test('Prev button moves the date range backward', async ({ page }) => {
    const sp = new SchedulePage(page);
    await sp.goto();
    await sp.waitForCalendarReady();
    const dateLabel = page.locator('span[class*="font-semibold"][class*="min-w"]');
    const before = await dateLabel.innerText();
    await sp.prevButton.click();
    await page.waitForTimeout(300);
    const after = await dateLabel.innerText();
    expect(after).not.toBe(before);
  });

});
