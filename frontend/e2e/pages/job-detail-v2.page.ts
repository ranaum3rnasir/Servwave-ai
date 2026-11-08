import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class JobDetailV2Page extends BasePage {
  readonly overviewTab: Locator;
  readonly walkthroughTab: Locator;
  readonly workItemsTab: Locator;
  readonly estimatesTab: Locator;
  readonly iconRail: Locator;
  readonly viewLeadLink: Locator;

  constructor(page: Page) {
    super(page);
    this.overviewTab = page.getByRole('tab', { name: 'Overview' });
    this.walkthroughTab = page.getByRole('tab', { name: /Walkthrough/ });
    this.workItemsTab = page.getByRole('tab', { name: /Work Items/ });
    this.estimatesTab = page.getByRole('tab', { name: /Estimates/ });
    this.iconRail = page.locator('[class*="fixed"][class*="right-0"][class*="w-10"]');
    this.viewLeadLink = page.getByText(/View Walkthrough/i);
  }

  async goto(jobId: string) {
    await this.page.goto(`/jobs/${jobId}`);
    await this.page.waitForLoadState('networkidle');
  }

  async switchTab(name: string) {
    await this.page.getByRole('tab', { name: new RegExp(name, 'i') }).click();
    await this.page.waitForTimeout(300);
  }
}
