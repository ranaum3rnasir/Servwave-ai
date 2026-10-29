import { type Locator } from '@playwright/test';
import { BasePage } from './base.page';

/** Page object for the Organization Settings module. */
export class SettingsPage extends BasePage {
  async goto(screen: 'company' | 'branding' | 'locations' | 'users' | 'roles' | 'security' = 'company') {
    await this.page.goto(`/settings/${screen}`);
    await this.waitForNavigation();
  }

  /** Open settings from the top-right header user menu. */
  async openFromUserMenu() {
    await this.page.goto('/');
    // The user pill is the only avatar button at the top-right of the header.
    await this.page.getByRole('button').filter({ has: this.page.locator('.bg-primary-subtle') }).last().click();
    await this.page.getByRole('menuitem', { name: 'Settings' }).click();
    await this.page.waitForURL(/\/settings\/company/);
  }

  menuItem(label: string): Locator {
    return this.page.getByRole('link', { name: label });
  }

  tab(name: string): Locator {
    return this.page.getByRole('tab', { name });
  }

  saveButton(): Locator {
    return this.page.getByRole('button', { name: 'Save Changes' });
  }
}
