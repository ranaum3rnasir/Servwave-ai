import { test, expect } from '@playwright/test';
import { LeadDetailPage } from '../pages/lead-detail.page';
import { LeadFormPage } from '../pages/lead-form.page';
import { createTestLead } from '../helpers/test-data';

test.describe('Edit Lead', () => {
  test('edit lead fields and verify persistence', async ({ page }) => {
    // Create a fresh lead
    await createTestLead(page);
    const detailUrl = page.url();
    const detailPage = new LeadDetailPage(page);

    // Click Edit
    await detailPage.clickEdit();

    // Update the service request
    const updatedRequest = `Updated service request ${Date.now()}`;
    const formPage = new LeadFormPage(page);
    await formPage.fillEditForm({ serviceRequest: updatedRequest });
    await formPage.submit();

    // Should redirect back to detail page
    await page.waitForURL(detailUrl, { timeout: 10_000 });

    // Verify the updated text is visible
    await expect(page.getByText(updatedRequest)).toBeVisible();

    // Reload to confirm persistence
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(updatedRequest)).toBeVisible();
  });

  test('walkthrough save persists after reload', async ({ page }) => {
    await createTestLead(page);
    const detailUrl = page.url();
    const detailPage = new LeadDetailPage(page);

    const wtNotes = `Walkthrough notes ${Date.now()}`;
    // Use a date in the near future
    const scheduledDate = '2026-03-15T10:00';

    await detailPage.fillWalkthrough({
      scheduledDate,
      notes: wtNotes,
    });

    // Reload and verify
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Switch to Walkthrough tab
    await detailPage.clickTab('Walkthrough');
    await page.waitForTimeout(500);

    // Verify the notes persisted
    await expect(page.getByPlaceholder('Notes from the walkthrough...')).toHaveValue(wtNotes);
  });
});
