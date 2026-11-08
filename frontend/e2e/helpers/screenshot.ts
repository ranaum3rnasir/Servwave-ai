import { Page, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOTS_DIR = path.resolve(__dirname, '..', 'screenshots', 'walkthrough');

interface ScreenshotChecks {
  noBlankScreen?: boolean;     // default true
  expectVisible?: string[];    // text that MUST be visible
  expectHidden?: string[];     // text that must NOT appear
}

export async function screenshotAndAssert(page: Page, name: string, checks?: ScreenshotChecks) {
  // Ensure directory exists
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  // Wait for stability. networkidle is bounded: comms/refetch background polling can keep
  // the network busy indefinitely, so we wait up to 4s and degrade to `load` (§3.6).
  await page.waitForLoadState('load');
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => { /* polling — proceed */ });
  await page.waitForTimeout(200);

  // Blank screen detection (default ON)
  if (checks?.noBlankScreen !== false) {
    const main = page.locator('main');
    await expect(main).toBeVisible({ timeout: 5000 });
    const childCount = await main.locator('> *').count();
    expect(childCount, 'Page appears blank — <main> has no children').toBeGreaterThan(0);
  }

  // Error detection
  const defaultErrors = ['Cannot read properties', 'Something went wrong', 'Unhandled Runtime Error'];
  const errorTexts = checks?.expectHidden ?? defaultErrors;
  for (const errText of errorTexts) {
    const errorEl = page.getByText(errText, { exact: false }).first();
    const visible = await errorEl.isVisible().catch(() => false);
    expect(visible, `Unexpected error text found: "${errText}"`).toBe(false);
  }

  // Visibility checks — use .first() to avoid strict mode violations when text appears multiple times
  if (checks?.expectVisible) {
    for (const text of checks.expectVisible) {
      await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: 3000 });
    }
  }

  // Take screenshot
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, name),
    fullPage: true,
  });
}
