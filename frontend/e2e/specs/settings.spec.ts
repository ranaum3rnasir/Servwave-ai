import { test, expect } from '@playwright/test';
import { SettingsPage } from '../pages/settings.page';

test.describe('Organization Settings module', () => {
  test('reaches Settings from the header user menu', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.openFromUserMenu();
    await expect(page).toHaveURL(/\/settings\/company/);
  });

  test('settings menu lists the org screens (admin)', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('company');
    await expect(settings.menuItem('Company Profile')).toBeVisible();
    await expect(settings.menuItem('Branding & Templates')).toBeVisible();
    await expect(settings.menuItem('Locations')).toBeVisible();
    await expect(settings.menuItem('Users & Teams')).toBeVisible();
    await expect(settings.menuItem('Roles & Permissions')).toBeVisible();
    await expect(settings.menuItem('Login & Security')).toBeVisible();
  });

  test('Company Profile shows Profile and Numbering tabs', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('company');
    await expect(settings.tab('Profile')).toBeVisible();
    await expect(settings.tab('Identifiers & Numbering')).toBeVisible();
    await settings.tab('Identifiers & Numbering').click();
    await expect(page.getByText('Customers', { exact: true })).toBeVisible();
  });

  test('Roles screen loads a role and its permission matrix', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('roles');
    await settings.waitForApi('/api/roles');
    await page.getByRole('button', { name: /Sales/ }).first().click();
    await expect(settings.tab('Permissions')).toBeVisible();
    await expect(settings.tab('Data Scope')).toBeVisible();
  });

  test('each settings screen renders without error', async ({ page }) => {
    const settings = new SettingsPage(page);
    for (const screen of ['company', 'branding', 'locations', 'users', 'roles', 'security'] as const) {
      await settings.goto(screen);
      await expect(page.getByText('Settings', { exact: false }).first()).toBeVisible();
    }
  });

  // ─── Effect-asserting round-trips (#115) ───────────────────────────────
  // These persist a change and assert it survives a reload, rather than only
  // rendering the screen. They require the org_settings migration applied and a
  // seeded admin org (the same prerequisite as #117's deploy step).

  test('Company Profile: a save persists across reload', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('company');

    const dba = page.locator('input[name="display_name"]');
    await expect(dba).toBeVisible();
    const value = `DBA ${Date.now()}`;
    await dba.fill(value);

    await settings.saveButton().click();
    await settings.waitForApi('/api/organization'); // PATCH round-trip
    await expect(page.getByText('Settings saved')).toBeVisible();

    await page.reload();
    await settings.waitForNavigation();
    await expect(page.locator('input[name="display_name"]')).toHaveValue(value);
  });

  test('Roles: save then reset clears the dirty bar', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('roles');
    await settings.waitForApi('/api/roles');
    await page.getByRole('button', { name: /Sales/ }).first().click();

    // Toggle the first permission cell → the Save bar enables.
    await page.getByRole('switch').first().click();
    await expect(settings.saveButton()).toBeEnabled();

    await settings.saveButton().click();
    await settings.waitForApi('/api/roles/SALES/permissions'); // PUT
    await expect(settings.saveButton()).toBeDisabled(); // dirty cleared

    await page.getByRole('button', { name: 'Reset to default' }).click();
    await settings.waitForApi('/api/roles/SALES/reset'); // POST
  });
});
