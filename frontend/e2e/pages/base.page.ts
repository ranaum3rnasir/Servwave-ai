import { type Page, type Locator, expect } from '@playwright/test';

export class BasePage {
  constructor(protected readonly page: Page) {}

  /**
   * Fill a react-hook-form registered input reliably.
   * Playwright's fill() can miss React synthetic event handlers,
   * so we clear + pressSequentially to trigger proper key events.
   */
  protected async fillInput(locator: Locator, value: string) {
    await locator.click();
    // Select all existing text then type over it — triggers proper key events
    // that react-hook-form's register() handlers can detect
    await locator.press('Control+a');
    await locator.pressSequentially(value, { delay: 5 });
  }

  /** Wait for an API response matching the URL pattern */
  async waitForApi(urlPattern: string | RegExp) {
    return this.page.waitForResponse(
      (res) =>
        (typeof urlPattern === 'string'
          ? res.url().includes(urlPattern)
          : urlPattern.test(res.url())) && res.status() < 400,
      { timeout: 10_000 },
    );
  }

  /** Get toast notification (success or error) */
  getToast(): Locator {
    return this.page.locator('[role="status"], [data-sonner-toast]');
  }

  /** Wait for page navigation to complete */
  async waitForNavigation() {
    await this.page.waitForLoadState('networkidle');
  }
}
