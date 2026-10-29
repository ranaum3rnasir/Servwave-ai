import { test, expect } from '@playwright/test';
import { LeadDetailPage } from '../pages/lead-detail.page';
import { createTestLead } from '../helpers/test-data';

test.describe('Lead Actions', () => {
  test('change status and verify persistence', async ({ page }) => {
    await createTestLead(page);
    const detailUrl = page.url();
    const detailPage = new LeadDetailPage(page);

    // Change status to Contacted
    await detailPage.changeStatus('Contacted');

    // Reload to confirm the change persisted
    await page.reload();
    await page.waitForLoadState('networkidle');

    // The status badge should show "Contacted"
    const statusText = await detailPage.getStatus();
    expect(statusText.toLowerCase()).toContain('contacted');
  });

  test('create new tag and verify persistence', async ({ page }) => {
    await createTestLead(page);
    const detailPage = new LeadDetailPage(page);

    const tagName = `E2E-${Date.now().toString(36)}`;
    await detailPage.createTag(tagName);

    // Reload to verify persistence
    await page.reload();
    await page.waitForLoadState('networkidle');

    // The tag should still be visible
    await expect(page.locator('span', { hasText: tagName })).toBeVisible();
  });

  test('remove tag and verify persistence', async ({ page }) => {
    await createTestLead(page);
    const detailPage = new LeadDetailPage(page);

    // First create a tag to remove
    const tagName = `Del-${Date.now().toString(36)}`;
    await detailPage.createTag(tagName);

    // Verify it's there
    await expect(page.locator('span', { hasText: tagName })).toBeVisible();

    // Remove it
    await detailPage.removeTag(tagName);

    // Reload to confirm removal
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Tag should not be present
    await expect(page.locator('span', { hasText: tagName })).not.toBeVisible();
  });

  test('add note and verify persistence', async ({ page }) => {
    await createTestLead(page);
    const detailPage = new LeadDetailPage(page);

    const noteText = `E2E test note ${Date.now()}`;
    await detailPage.addNote(noteText);

    // Verify note appears
    await expect(page.getByText(noteText)).toBeVisible();

    // Reload and check persistence
    await page.reload();
    await page.waitForLoadState('networkidle');

    await detailPage.clickTab('Notes');
    await page.waitForTimeout(500);

    await expect(page.getByText(noteText)).toBeVisible();
  });

  test('assign lead to user via the actions menu', async ({ page }) => {
    await createTestLead(page);
    const detailPage = new LeadDetailPage(page);

    await detailPage.clickAssign(); // opens "..." menu → clicks Assign menuitem

    // Focus-handoff gate (objection 8): the popover search input is focused and STAYS
    // open — the menu closing must not dismiss the sibling popover.
    const searchInput = page.getByPlaceholder('Search team members...');
    await expect(searchInput).toBeFocused();
    await page.waitForTimeout(400); // let the menu's animate-out + onCloseAutoFocus fire
    await expect(searchInput).toBeVisible(); // no self-dismiss

    // Pick the first roster row and confirm.
    await page.locator('[role="listbox"] button').first().click();
    await page.getByRole('button', { name: /^Assign$/ }).click();
    await page.waitForTimeout(1000);

    await detailPage.clickTab('Details');
    await expect(page.getByText('Assigned to:')).toBeVisible();
  });

  test('mark lead as lost', async ({ page }) => {
    await createTestLead(page);
    const detailPage = new LeadDetailPage(page);

    await detailPage.clickMarkLost();

    // The dialog should open
    await expect(page.getByText('Mark Lead as Lost')).toBeVisible();

    // Fill in the reason (use pressSequentially for react-hook-form compat)
    const reasonInput = page.getByPlaceholder('Why was this lead lost?');
    await reasonInput.click();
    await reasonInput.pressSequentially('E2E test: customer went with competitor', { delay: 5 });

    // Click Mark Lost button
    await page.getByRole('button', { name: 'Mark Lost' }).click();
    await page.waitForTimeout(1000);

    // Reload and verify status changed to Lost
    await page.reload();
    await page.waitForLoadState('networkidle');

    const statusText = await detailPage.getStatus();
    expect(statusText.toLowerCase()).toContain('lost');

    // The "Mark Lost" menu item should no longer appear (terminal state)
    await page.getByRole('button', { name: /Lead actions/i }).click();
    await expect(page.getByRole('menuitem', { name: 'Mark Lost' })).toHaveCount(0);
  });
});
