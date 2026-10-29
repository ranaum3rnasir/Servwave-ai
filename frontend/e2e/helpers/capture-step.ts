/**
 * Step-based screenshot capture helper.
 *
 * Used by agents to capture + describe what they see at each test step.
 * Each step produces a named screenshot that agents then READ visually.
 *
 * Usage in a Playwright spec:
 *   const step = createStepCapture(page, 'F-01');
 *   await step('01_before_drag', 'Week view with scheduled event at 9 AM');
 *   // ... perform action ...
 *   await step('02_mid_drag', 'Event being dragged down 2 hours');
 *   // ... drop ...
 *   await step('03_after_drop', 'Event moved to 11 AM slot');
 */
import { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const AUDIT_DIR = path.resolve(
  process.cwd(),
  'e2e',
  'screenshots',
  'scheduler-audit',
);

export function createStepCapture(page: Page, testId: string) {
  // Ensure directory exists
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }

  let stepCount = 0;

  /**
   * Capture a screenshot for a test step.
   * @param name Short description (e.g., '01_before_drag')
   * @param description What this step shows (logged to console for agent context)
   * @param opts.element Optional locator to screenshot just that element
   * @param opts.fullPage Whether to capture full page (default: false = viewport only)
   */
  return async function captureStep(
    name: string,
    description: string,
    opts?: { element?: import('@playwright/test').Locator; fullPage?: boolean },
  ) {
    stepCount++;
    const filename = `${testId}_${name}.png`;
    const filepath = path.join(AUDIT_DIR, filename);

    // Wait for stability
    await page.waitForTimeout(200);

    if (opts?.element) {
      await opts.element.screenshot({ path: filepath });
    } else {
      await page.screenshot({
        path: filepath,
        fullPage: opts?.fullPage ?? false,
      });
    }

    console.log(
      `[SCREENSHOT] ${testId} step ${stepCount}: ${filename} — ${description}`,
    );
    console.log(`[SCREENSHOT_PATH] ${filepath}`);

    return filepath;
  };
}

/**
 * Capture a single named screenshot (not part of a step sequence).
 * Useful for one-off captures outside of a step flow.
 */
export async function captureScreenshot(
  page: Page,
  name: string,
  opts?: {
    element?: import('@playwright/test').Locator;
    fullPage?: boolean;
  },
): Promise<string> {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }

  const filepath = path.join(AUDIT_DIR, name);
  await page.waitForTimeout(200);

  if (opts?.element) {
    await opts.element.screenshot({ path: filepath });
  } else {
    await page.screenshot({
      path: filepath,
      fullPage: opts?.fullPage ?? false,
    });
  }

  console.log(`[SCREENSHOT] ${name}`);
  console.log(`[SCREENSHOT_PATH] ${filepath}`);

  return filepath;
}
