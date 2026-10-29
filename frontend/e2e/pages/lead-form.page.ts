import { type Page, type Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class LeadFormPage extends BasePage {
  readonly heading: Locator;
  readonly submitButton: Locator;
  readonly cancelButton: Locator;

  constructor(page: Page) {
    super(page);
    this.heading = page.getByRole('heading', { name: /New Lead|Edit Lead/ });
    this.submitButton = page.getByRole('button', { name: /Create Lead|Save Changes/ });
    this.cancelButton = page.getByRole('button', { name: 'Cancel' });
  }

  /** Helper: find the textbox inside a container that has a specific label text */
  private fieldByLabel(label: string): Locator {
    // Find the <label> element with exact text, go to its parent <div> (the field wrapper),
    // then find the input/textarea inside. Using xpath=.. to get the CLOSEST parent,
    // avoiding the issue where locator('div', { has: ... }) matches the outermost form div.
    return this.page.getByText(label, { exact: true }).locator('xpath=..').locator('input, textarea').first();
  }

  /** Dismiss any customer search dropdown that may appear after typing */
  private async dismissSearchDropdown() {
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(200);
  }

  /** Fill the new lead form with new customer data */
  async fillNewCustomer(data: {
    firstName: string;
    lastName: string;
    phone: string;
    serviceRequest: string;
    address: string;
    city: string;
    state: string;
    zip: string;
  }) {
    // First Name — each field has inline customer search, dismiss dropdown after typing
    await this.fillInput(this.fieldByLabel('First Name *'), data.firstName);
    await this.dismissSearchDropdown();

    // Last Name
    await this.fillInput(this.fieldByLabel('Last Name *'), data.lastName);
    await this.dismissSearchDropdown();

    // Phone
    await this.fillInput(this.fieldByLabel('Phone *'), data.phone);
    await this.dismissSearchDropdown();

    // Email — required field, provide a generated email
    const email = `${data.firstName.toLowerCase()}.${data.lastName.toLowerCase()}@e2etest.local`;
    await this.fillInput(this.fieldByLabel('Email *'), email);
    await this.dismissSearchDropdown();

    // Service request
    await this.fillInput(this.page.getByPlaceholder('Describe the service needed...'), data.serviceRequest);

    // Address fields — use the AddressAutocomplete placeholder
    await this.fillInput(this.page.getByPlaceholder('Start typing an address...'), data.address);
    // Dismiss autocomplete dropdown before filling remaining fields
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(300);

    await this.fillInput(this.fieldByLabel('City *'), data.city);
    await this.fillInput(this.page.locator('input[maxlength="2"]'), data.state);
    await this.fillInput(this.fieldByLabel('ZIP *'), data.zip);
  }

  /** Fill the edit lead form with updated data */
  async fillEditForm(data: { serviceRequest?: string }) {
    if (data.serviceRequest) {
      const textarea = this.page.getByText('Service Request *', { exact: true })
        .locator('xpath=..')
        .locator('textarea').first();
      await this.fillInput(textarea, data.serviceRequest);
    }
  }

  /** Submit the form */
  async submit() {
    await this.submitButton.click();
  }

  /** Wait for redirect after form submission (to detail page) */
  async waitForRedirect() {
    await this.page.waitForURL(/\/leads\/[a-f0-9-]+$/, { timeout: 15_000 });
  }
}
