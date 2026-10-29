import { test, expect, assertGatesClean, assertNoErrorBoundary } from '../../fixtures/gated-test';
import { screenshotAndAssert } from '../../helpers/screenshot';
import { ApiClient } from '../../helpers/api-client';
import { leadToWalkthroughCompleted } from '../../helpers/workflow-builders';

/**
 * SEL-35 - Estimate create + send round-trip through the REAL UI (catalog P1). REWRITTEN
 * 2026-07-24 for SERV10X-61's create=edit flow; STILL NOT EXECUTED (there is no playwright job
 * in .github/workflows, so nothing has ever run this file).
 *
 * What changed: there is no New Estimate FORM any more. `EstimateFormPage` is deleted and
 * `/estimates/new` is a create-and-redirect shim (`NewEstimateRedirect.tsx`) that POSTs an empty
 * DRAFT for the anchor in the query string and immediately `replace`s itself with the workspace at
 * `/estimates/:id`. The previous version of this spec waited for a `/estimates/new?lead_id=…` URL
 * to settle, then drove a "New Estimate" heading, an "Item name" placeholder, a `#tax_state`
 * select and a "Create Estimate" submit button - none of which exist, so the whole spec was dead.
 *
 * The line item is seeded through the API rather than typed: the workspace's replacement for the
 * form's inline row is `AddLineDialog`, a price-book SEARCH surface whose create-a-new-item branch
 * is a multi-step flow this spec cannot ground without executing it. Guessing at those locators
 * would just re-create the rot this rewrite is clearing, so the UI assertions here stay on the two
 * surfaces that ARE grounded: the create=edit entry and the send dialog.
 *
 * UI tier: provisioned-admin storageState via gatedPage; seeding via ApiClient in beforeAll.
 * Shared serial org (workers:1) - presence/delta assertions only.
 *
 * Locator grounding (all read from current component source):
 *  - LeadDetailPage.tsx:829 - "Lead actions" dropdown trigger; :846-849 - "Create Estimate"
 *    menu item (canCreateEstimate) navigates to /estimates/new?lead_id=:id.
 *  - NewEstimateRedirect.tsx - POST /api/estimates { lead_id } then
 *    navigate(`/estimates/${id}`, { replace: true }). The `/estimates/new` URL is transient;
 *    an anchorless visit renders <Navigate to="/estimates" replace /> and fires NO request.
 *  - EstimateWorkspacePage.tsx:435-438 - estimate number + StatusBadge; :474-478 - hero "Send"
 *    button (business variant, DRAFT).
 *  - SendEstimateDialog.tsx:167 - title "Send Estimate"; :308-312 - deposit Switch
 *    id="deposit-toggle" labelled "Require deposit", default ON (:67); when toggled OFF the
 *    "Payment methods" checkbox section unmounts and canSend is unconditionally true (:137) -
 *    keeping this test deterministic w.r.t. org accepted methods; submit = `Send ${number}`.
 *  - StatusBadge labels: DRAFT -> "Draft", SENT -> "Sent" (status-badge.tsx:15-16).
 *
 * Determinism notes:
 *  - beforeAll pins deposit_percentage=30 so the send dialog's setting GET returns 200 (a missing
 *    key 404s - settings.controller:19 - and a 404 resource log would trip the console gate).
 *    default_tax_state is no longer pinned: with no form there is no jurisdiction to pick, and
 *    create() derives the rate from the lead's service location (estimate.controller.ts:1106).
 *  - Estimate numbers are container-scoped now (`L00005-1`, SERV10X-61 §5.7), so the number is
 *    always read from the server, never constructed.
 */

let api: ApiClient;
let leadId: string;

test.beforeAll(async () => {
  api = await new ApiClient().init();

  // The one AppSetting the send dialog GETs on open (see header).
  await api.raw('patch', '/api/settings/deposit_percentage', { value: '30' });

  const wt = await leadToWalkthroughCompleted(api);
  leadId = wt.leadId;
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe('SEL-35 - Estimate create=edit + send round-trip (UI)', () => {
  test('SEL-35: lead detail -> Create Estimate -> lands in the workspace on a new DRAFT -> send (deposit OFF) -> SENT + lead ESTIMATED', async ({ gatedPage: page, gate }) => {
    // 1. Lead detail -> Create Estimate. No form, no submit: the click itself creates the row.
    const before = await api.listEstimates({ lead_id: leadId, limit: '50' });
    const countBefore = (before.body.estimates ?? []).length;

    await page.goto(`/leads/${leadId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // "WT Completed" badge proves the seed is past the walkthrough gate.
    await expect(page.getByText('WT Completed', { exact: false }).first()).toBeVisible();

    await page.getByRole('button', { name: /Lead actions/i }).click();
    await page.getByRole('menuitem', { name: 'Create Estimate' }).click();

    // Straight to the workspace - `/estimates/new` is a shim the user never sits on.
    await page.waitForURL(/\/estimates\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const estimateId = page.url().split('/').pop()!;
    await assertGatesClean(gate, 'SEL-35 workspace open');

    // 2. Server truth: exactly ONE new estimate, anchored to the lead, empty DRAFT.
    const created = await api.getEstimate(estimateId);
    const estimateNumber = created.estimate_number as string;
    expect(created.status, 'estimate status right after UI create').toBe('DRAFT');
    expect(created.lead_id, 'estimate must be anchored to the lead it was created from').toBe(leadId);
    expect((created.line_items ?? []).length, 'create=edit starts from an EMPTY draft').toBe(0);

    const after = await api.listEstimates({ lead_id: leadId, limit: '50' });
    expect(
      (after.body.estimates ?? []).length - countBefore,
      'one click must create exactly one estimate (the shim guards its own double-effect)',
    ).toBe(1);

    await expect(page.getByText(estimateNumber, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
    await assertNoErrorBoundary(page);
    await screenshotAndAssert(page, 'SEL-35-draft-created.png', {
      expectVisible: [estimateNumber, 'Draft'],
    });

    // 3. Give the draft something to quote (API-seeded - see the header) and reload the workspace.
    const line = await api.raw('post', `/api/estimates/${estimateId}/line-items`, {
      description: 'Heat pump replacement',
      quantity: 1,
      unit_price: 1500,
    });
    expect(line.res.status(), 'seed line item').toBe(201);

    await page.reload();
    await expect(page.getByText('$1,500.00').first()).toBeVisible();
    await assertGatesClean(gate, 'SEL-35 line item seeded');

    // 4. Send dialog: deposit OFF (deterministic w.r.t. org methods) -> send.
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Send Estimate')).toBeVisible();

    const depositSwitch = dialog.getByRole('switch', { name: /require deposit/i });
    await expect(depositSwitch).toHaveAttribute('aria-checked', 'true'); // default ON
    await depositSwitch.click();
    await expect(depositSwitch).toHaveAttribute('aria-checked', 'false');
    // With the deposit off, the payment-methods checkbox section unmounts entirely.
    await expect(dialog.getByText('Payment methods')).toHaveCount(0);

    await dialog.getByRole('button', { name: `Send ${estimateNumber}` }).click();
    // Real success behaviour: the dialog closes and the estimate query refetches
    // (plus an "Estimate sent" toast).
    await expect(dialog).toBeHidden();

    // 5. SENT in the UI + server-state proof via ApiClient.
    await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();

    const sent = await api.getEstimate(estimateId);
    expect(sent.status, 'estimate status after UI send').toBe('SENT');
    expect(sent.public_token, 'send must mint a public token').toBeTruthy();
    // No deposit requested -> no kind=DEPOSIT invoice spawned.
    expect((sent.invoices ?? []).length, 'deposit-off send must not spawn a deposit invoice').toBe(0);

    // Lead auto-advances to ESTIMATED on send (golden path step 7 side effect).
    const lead = await api.getLead(leadId);
    expect(lead.status, 'lead status after estimate send').toBe('ESTIMATED');

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'SEL-35 send');
    await screenshotAndAssert(page, 'SEL-35-sent.png', {
      expectVisible: [estimateNumber, 'Sent'],
    });
  });

  test('SEL-35b: an anchorless /estimates/new bounces to the list and creates nothing', async ({ gatedPage: page, gate }) => {
    const before = await api.listEstimates({ limit: '1' });
    const totalBefore = before.body.pagination?.total as number;

    await page.goto('/estimates/new');
    await page.waitForURL(/\/estimates$/);
    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'SEL-35b anchorless bounce');

    const after = await api.listEstimates({ limit: '1' });
    expect(after.body.pagination?.total, 'an anchorless visit must not create a draft').toBe(totalBefore);
  });
});
