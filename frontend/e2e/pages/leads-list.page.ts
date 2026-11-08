import { type Page, type Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class LeadsListPage extends BasePage {
  // Locators
  readonly heading: Locator;
  readonly newLeadButton: Locator;
  readonly exportButton: Locator;
  readonly searchInput: Locator;
  readonly table: Locator;

  constructor(page: Page) {
    super(page);
    this.heading = page.getByRole('main').getByRole('heading', { name: 'Leads' });
    this.newLeadButton = page.getByRole('button', { name: 'New Lead' });
    this.exportButton = page.getByRole('button', { name: 'Export' });
    this.searchInput = page.getByPlaceholder('Search leads...');
    this.table = page.locator('table');
  }

  async goto() {
    await this.page.goto('/leads');
    await expect(this.heading).toBeVisible({ timeout: 10_000 });
  }

  /** Get all KPI labels in the strip */
  getKpiLabel(label: string): Locator {
    return this.page.getByText(label, { exact: true });
  }

  /** Get table rows (data rows only, not header) */
  getTableRows(): Locator {
    return this.table.locator('tbody tr');
  }

  /** Find a row containing specific text */
  getRowByText(text: string): Locator {
    return this.table.locator('tbody tr', { hasText: text });
  }

  /** Click a lead row by customer name */
  async clickRow(name: string) {
    await this.getRowByText(name).click();
  }

  /** Type in search input */
  async searchLeads(term: string) {
    await this.searchInput.fill(term);
  }

  /** Click the New Lead button */
  async clickNewLead() {
    await this.newLeadButton.click();
  }
}
