import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { LeadDetailV2Page } from '../pages/lead-detail-v2.page';
import { screenshotAndAssert } from '../helpers/screenshot';
import {
  getAdminToken,
  createLeadViaApi,
  createTechnicianUser,
  markLeadContacted,
  scheduleWalkthrough,
  cancelWalkthrough,
  deleteUser,
} from '../helpers/api-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.resolve(__dirname, '..', '.auth', 'admin.json');
test.use({ storageState: authFile });

test.describe.serial('Walkthrough Cancellation', () => {
  let token: string;
  let leadId: string;
  let techId: string;

  test.beforeAll(async () => {
    token = await getAdminToken();
    const suffix = Date.now().toString(36);
    const lead = await createLeadViaApi(token, {
      firstName: 'Cancel',
      lastName: `WT-${suffix}`,
      serviceRequest: `Cancel walkthrough test ${suffix}`,
    });
    leadId = lead.id;
    techId = await createTechnicianUser(token, `cn-${suffix}`);
    await markLeadContacted(token, leadId);
    const scheduledAt = new Date(Date.now() + 86400000).toISOString();
    await scheduleWalkthrough(token, leadId, techId, scheduledAt, 60);
  });

  test.afterAll(async () => {
    try { await deleteUser(token, techId); } catch { /* best effort */ }
  });

  test('Cancel Walkthrough menu item visible for scheduled lead', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);
    // "Cancel Walkthrough" is a menuitem in the "..." Lead actions menu when
    // lead.status === 'WALKTHROUGH_SCHEDULED' && canEdit
    await detail.openActionsMenu();
    const cancelItem = page.getByRole('menuitem', { name: /Cancel Walkthrough/i });
    await expect(cancelItem).toBeVisible({ timeout: 5000 });
    await screenshotAndAssert(page, 'cancel-btn-visible.png', {
      expectVisible: ['Scheduled'],
    });
  });

  test('CancelWalkthroughDialog opens with reason field', async ({ page }) => {
    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);

    // Click the Cancel Walkthrough menu item
    await detail.openActionsMenu();
    const cancelItem = page.getByRole('menuitem', { name: /Cancel Walkthrough/i });
    await expect(cancelItem).toBeVisible({ timeout: 5000 });
    await cancelItem.click();
    await page.waitForTimeout(300);

    // Dialog should be visible with a reason textarea
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    // The dialog may use either a textarea or an input for the reason
    const textarea = dialog.locator('textarea').first();
    const input = dialog.locator('input').first();
    const hasTextarea = await textarea.isVisible().catch(() => false);
    const hasInput = await input.isVisible().catch(() => false);
    expect(hasTextarea || hasInput).toBeTruthy();
    await screenshotAndAssert(page, 'cancel-dialog.png', {
      expectVisible: ['Cancel'],
    });
  });

  test('after API cancellation, lead reverts to contacted', async ({ page }) => {
    // Cancel via API
    await cancelWalkthrough(token, leadId, 'E2E cancel test');

    const detail = new LeadDetailV2Page(page);
    await detail.goto(leadId);

    // Status should revert to Contacted
    await screenshotAndAssert(page, 'cancel-reverted.png', {
      expectVisible: ['Contacted'],
    });
  });
});
