import { test, expect, assertGatesClean, assertNoErrorBoundary } from '../../fixtures/gated-test';
import { screenshotAndAssert } from '../../helpers/screenshot';
import { ApiClient } from '../../helpers/api-client';
import {
  maEstimateSentWithDeposit,
  leadToWalkthroughCompleted,
} from '../../helpers/workflow-builders';

/**
 * SEL-33 + SEL-34 — Estimate UI drift PROBES (catalog P1/P2). WRITTEN 2026-06-10,
 * NOT YET EXECUTED — both rows are pin-current probes: they assert the PREDICTED
 * (broken) behavior and record the correct behavior via flagKnownBug, so they are
 * green-with-a-flag at baseline. If a probe assertion FAILS at baseline, the static
 * prediction was wrong → FLIP the assertion to the observed behavior (and drop the
 * flag if the observed behavior is the correct one).
 *
 * UI tier (🖥️): drives the browser as the provisioned admin (gatedPage + the UI
 * config's admin storageState). Seeds via the shared ApiClient in beforeAll. Shared
 * serial org (workers:1) — assert PRESENCE of seeded values, never absolute counts.
 *
 * Static predictions (code-read, exact refs):
 *  - SEL-33 (map §6.5): EstimateDetailPage.tsx derives `depositInvoice` correctly from
 *    est.invoices (kind=DEPOSIT, :298) — but the Deposit KPI stat card (:544/:559), the
 *    Deposit tab (:591) and the Waive button (:932, keyed on the RETIRED deposit status
 *    'REQUESTED') all key on the LEGACY `est.deposit`, which the API's
 *    estimateDetailSelect no longer returns (estimate.controller.ts:134-148 exposes
 *    invoices + send_config, no `deposit`). Prediction: the page renders fine, the
 *    deposit panels silently DON'T. Server gates still hold — this is render drift.
 *  - SEL-34 (map §6.7, #186 FIX): NewEstimateDialog.tsx now filters offered leads through
 *    ACTIVE_STATUSES (the non-terminal set NEW/CONTACTED/WALKTHROUGH_SCHEDULED/
 *    WALKTHROUGH_COMPLETED/ESTIMATED), mirroring LeadsPage.tsx. This drops the old phantom
 *    'ESTIMATING' (not a LeadStatus) and surfaces the previously-hidden WALKTHROUGH_COMPLETED
 *    lead. Estimate-create rejects only terminal statuses (WON/LOST/CANCELLED) and is NOT
 *    gated on the walkthrough (Bug #39 — that gate lives on SEND), so every offered lead
 *    passes the server create gate. The leads query itself
 *    (GET /api/leads?customer_id=…&limit=10) applies NO status filter, so this client-side
 *    allowlist is load-bearing: it is what keeps terminal leads out of the picker.
 */

let api: ApiClient;

// SEL-33 — a SENT estimate with a required deposit (kind=DEPOSIT invoice exists).
let sel33EstimateId: string;
let sel33EstimateNumber: string;

// SEL-34 — one fresh customer with TWO leads: WALKTHROUGH_COMPLETED + NEW.
let sel34CustomerToken: string;       // unique "Test-<suffix>" first_name → search token
let wtLeadServiceRequest: string;     // the READY lead the dialog is predicted to hide
let newLeadServiceRequest: string;    // the NOT-ready lead the dialog is predicted to offer

test.beforeAll(async () => {
  api = await new ApiClient().init();

  // SEL-33: $10,000 @ MA 6.25%, 30% deposit → SENT estimate + kind=DEPOSIT invoice.
  const dep = await maEstimateSentWithDeposit(api, 10_000, 30);
  sel33EstimateId = dep.estimateId;
  sel33EstimateNumber = dep.estimate.estimate_number;

  // SEL-34: builder creates customer + lead and walks it to WALKTHROUGH_COMPLETED…
  const wt = await leadToWalkthroughCompleted(api);
  if (!wt.locationId) throw new Error('seed: walkthrough lead has no service location');
  const wtLead = await api.getLead(wt.leadId);
  wtLeadServiceRequest = wtLead.service_request as string;

  // …then a SECOND, NEW-status lead on the SAME customer with a distinctive request
  // (a lead must anchor to one of the customer's service locations or createLead 500s).
  const { body: newLeadBody } = await api.createLead({
    customer_id: wt.customerId,
    service_request: `SEL34-new-${api.suffix}`,
    service_location_id: wt.locationId,
  });
  newLeadServiceRequest = newLeadBody.lead.service_request as string;

  // The dialog's customer search token: createCustomerWithLocation seeds the unique
  // first_name "Test-<suffix>" — display name in the dialog is "Customer, Test-<suffix>".
  const customer = await api.getCustomer(wt.customerId);
  sel34CustomerToken = customer.first_name as string;
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe('SEL-33/34 — Estimate UI drift probes', () => {
  test('SEL-33: estimate-detail deposit surface renders from invoices[kind=DEPOSIT] + send_config (#185)', async ({ gatedPage: page, gate }) => {
    await page.goto(`/estimates/${sel33EstimateId}`);

    // The page ITSELF renders fine: hero number, KPI strip, tabs.
    await expect(page.getByText(sel33EstimateNumber, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /line items/i })).toBeVisible();
    await expect(page.getByText('Total', { exact: true }).first()).toBeVisible();

    // ── #185 FIX: the deposit surface now renders from est.invoices[] (kind=DEPOSIT) + send_config ──
    // The Deposit tab is present; opening it shows the Deposit Information panel, and because the
    // deposit invoice is still SENT the Waive Deposit action is offered (admin).
    await expect(page.getByRole('tab', { name: /deposit/i })).toBeVisible();
    await page.getByRole('tab', { name: /deposit/i }).click();
    await expect(page.getByText(/deposit information/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /waive deposit/i })).toBeVisible();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'SEL-33');
    await screenshotAndAssert(page, 'SEL-33-estimate-detail-deposit-surface.png', {
      expectVisible: [sel33EstimateNumber],
    });
  });

  test('SEL-34: New-Estimate dialog offers both the NEW and WALKTHROUGH_COMPLETED leads (non-terminal filter)', async ({ gatedPage: page, gate }) => {
    await page.goto('/estimates');
    await page.getByRole('button', { name: /new estimate/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Create New Estimate')).toBeVisible();

    // Search the seeded customer by its unique "Test-<suffix>" token (≥2 chars + 300ms
    // debounce inside the dialog), then expand its row to load the leads panel.
    await dialog.getByPlaceholder('Name, email, phone, or company...').fill(sel34CustomerToken);
    const customerRow = dialog.getByRole('button').filter({ hasText: sel34CustomerToken }).first();
    await expect(customerRow).toBeVisible();
    await customerRow.click();

    // ── ASSERT FIX (#186) — map §6.7 ──
    // Both leads are offered because both pass the server create gate: they are
    // non-terminal and estimate-create is NOT gated on the walkthrough (create rejects
    // only WON/LOST/CANCELLED — Bug #39; the walkthrough gate lives on SEND).
    // The NEW lead IS offered (this also gates the leads-loaded timing)…
    await expect(dialog.getByText(newLeadServiceRequest)).toBeVisible();
    // …and the WALKTHROUGH_COMPLETED lead — previously hidden by the phantom
    // ACTIONABLE_STATUSES=['NEW','CONTACTED','ESTIMATING'] filter — is now offered too.
    await expect(dialog.getByText(wtLeadServiceRequest)).toBeVisible();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'SEL-34');
    await screenshotAndAssert(page, 'SEL-34-new-estimate-dialog-leads.png', {
      noBlankScreen: false, // dialog overlays the list page
      expectVisible: ['Create New Estimate', newLeadServiceRequest, wtLeadServiceRequest],
    });

    await page.keyboard.press('Escape'); // leave the list page clean
  });
});
