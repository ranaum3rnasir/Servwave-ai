import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class LeadDetailV2Page extends BasePage {
  // Tabs
  readonly overviewTab: Locator;
  readonly walkthroughTab: Locator;
  readonly estimatesTab: Locator;

  // Icon Rail
  readonly iconRail: Locator;
  readonly activityIcon: Locator;
  readonly attachmentsIcon: Locator;
  readonly slidingPanel: Locator;
  readonly panelCloseBtn: Locator;

  // Hero
  readonly heroCard: Locator;
  readonly statusBadge: Locator;
  readonly actionsMenuButton: Locator;
  readonly contactButton: Locator;

  // Walkthrough Tab
  readonly scheduleDateInput: Locator;
  readonly performerSelect: Locator;
  readonly walkthroughNotes: Locator;
  readonly scheduleButton: Locator;
  readonly completeButton: Locator;
  readonly completedBanner: Locator;
  readonly walkthroughNotRequired: Locator;

  constructor(page: Page) {
    super(page);
    // Tabs — use button role with tab-like text
    this.overviewTab = page.getByRole('tab', { name: 'Overview' });
    this.walkthroughTab = page.getByRole('tab', { name: /Walkthrough/ });
    this.estimatesTab = page.getByRole('tab', { name: /Estimates/ });

    // Icon rail — rightmost fixed strip (w-10, right-0, bg-white border-l)
    this.iconRail = page.locator('.fixed.right-0.w-10');
    this.activityIcon = page.locator('button[title="Activity"]');
    this.attachmentsIcon = page.locator('button[title="Attachments"]');
    this.slidingPanel = page.locator('.fixed.right-10.w-80');
    this.panelCloseBtn = this.slidingPanel.locator('button').first();

    // Hero
    this.heroCard = page.locator('main').locator('.rounded-xl').first();
    // StatusBadge renders as a <div> with rounded-full border classes
    this.statusBadge = this.heroCard.locator('.rounded-full.border').first();
    this.actionsMenuButton = page.getByRole('button', { name: /Lead actions/i });
    this.contactButton = page.getByRole('menuitem', { name: /Mark.*Contacted|Mark Contacted/ });

    // Walkthrough form elements
    this.scheduleDateInput = page.locator('input[type="datetime-local"]').first();
    this.performerSelect = page.locator('[role="combobox"]').or(page.locator('select')).first();
    this.walkthroughNotes = page.getByPlaceholder(/walkthrough|notes/i).first();
    this.scheduleButton = page.getByRole('button', { name: /Schedule Walkthrough/ });
    this.completeButton = page.getByRole('button', { name: /Complete Walkthrough/ });
    this.completedBanner = page.locator('div').filter({ hasText: /Completed on/ }).first();
    this.walkthroughNotRequired = page.getByText(/not required|No walkthrough/i);
  }

  async openActionsMenu() {
    await this.actionsMenuButton.click();
  }

  async goto(leadId: string, tab?: string) {
    await this.page.goto(`/leads/${leadId}`);
    await this.page.waitForLoadState('networkidle');
    // The component does not read ?tab= from the URL, so click the tab explicitly
    if (tab) {
      await this.switchTab(tab);
    }
  }

  async switchTab(name: string) {
    await this.page.getByRole('tab', { name: new RegExp(name, 'i') }).click();
    await this.page.waitForTimeout(300);
  }

  async openActivityPanel() {
    // Try title-based first, fall back to icon position
    const btn = this.page.locator('button[title="Activity"]').or(
      this.iconRail.locator('button').first()
    );
    await btn.click();
    await this.page.waitForTimeout(300);
  }

  async openAttachmentsPanel() {
    const btn = this.page.locator('button[title="Attachments"]').or(
      this.iconRail.locator('button').nth(1)
    );
    await btn.click();
    await this.page.waitForTimeout(300);
  }

  async closePanel() {
    if (await this.slidingPanel.isVisible()) {
      await this.slidingPanel.locator('button').first().click();
      await this.page.waitForTimeout(200);
    }
  }
}
