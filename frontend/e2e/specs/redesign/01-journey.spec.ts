import { test, expect, assertGatesClean, assertNoErrorBoundary } from '../../fixtures/gated-test';
import { screenshotAndAssert } from '../../helpers/screenshot';
import { flagKnownBug } from '../../helpers/known-bug';
import { ApiClient } from '../../helpers/api-client';
import {
  maEstimateSentWithDeposit,
  fullStandardFlowToInvoicePaid,
  fullStandardFlowToInvoiceSent,
  createMaCustomerWithLocation,
} from '../../helpers/workflow-builders';

/**
 * Stage D-J — Journey click-throughs + money-modal arm (rows J-01..J-06).
 *
 * UI tier (🖥️): drives the browser against the provisioned-admin storageState (the UI
 * config's `setup` project produces .auth/admin.json). Everything money-shaped is SEEDED
 * via the shared ApiClient in beforeAll (lead→walkthrough→estimate→job→invoice→payment),
 * then the browser drives the redesign UI surfaces and the §8 money dialogs.
 *
 * Shared serial org (workers:1) — data accumulates. Never assert absolute list/stat counts;
 * assert PRESENCE of seeded values (the unique per-customer "MA-<suffix>" token, the per-org
 * estimate/invoice numbers) and observable money deltas read off the live UI.
 *
 * Real-behaviour corrections that drive the assertions (verified against the running code):
 *  - The money dialogs do NOT fire a toast on success — `onSuccess` closes the dialog
 *    (`onOpenChange(false)`) and invalidates the `['invoice', id]` query, so the page
 *    refetches and the ledger/amount-due update. The plan's "toast" wording is wrong;
 *    we assert the real effect (dialog closes + ledger row / amount_due moves).
 *  - Refund submit (`refund-invoice-submit`) is disabled until reasonCategory AND reason
 *    are filled (amount is optional). The plan's "submit enabled" before filling reason is
 *    wrong — we fill the required reason fields, THEN assert enabled, then submit.
 *  - The "Invoice Refunded" ledger row only appears when invoice.status === 'REFUNDED'
 *    (a full refund). A partial refund leaves PARTIALLY_REFUNDED and shows no ledger row,
 *    so J-02 issues a FULL refund of the net-paid amount.
 *  - Void-payment lives in the Payments tab; the per-row "Void" button renders only for
 *    a manual (CASH/CHECK/BANK_TRANSFER), non-voided payment. The seed pays CASH.
 *  - There is NO /jobs/new route — the new-job form is the NewJobDialog (DialogTitle
 *    "Create Job"), opened from the Jobs list "New Job" button. J-05 scopes the
 *    /urgent/i count-0 assertion to that dialog.
 */

let api: ApiClient;

// J-01 — SENT-with-deposit estimate (the exemplar surface) + a full PAID flow to walk.
let depEstimateId: string;
let depEstimateNumber: string;
let stdEstimateId: string;
let stdEstimateNumber: string;
let stdJobId: string;
let stdInvoiceId: string;

// J-02 — a PAID invoice (CASH) with a refundable net-paid amount.
let refundInvoiceId: string;
let refundNetPaid: number;

// J-03 — a SENT invoice with positive amount_due so a credit reduces it.
let creditInvoiceId: string;

// J-04 — a PAID invoice (CASH) whose payment can be voided to reopen the balance.
let voidInvoiceId: string;

// J-05 — a customer to search for inside the Create Job dialog.
let newJobCustomerToken: string;

// J-06 — an ARCHIVED customer: hidden from the list, reachable by direct URL.
let archivedCustomerId: string;
let archivedCustomerName: string;
let archivedCustomerToken: string;

// Mirrors frontend/src/lib/customer-name.ts customerDisplayName (kept local to avoid
// coupling the e2e spec to the src module graph). "Last, First" when both present.
function customerDisplayName(c: { first_name?: string | null; last_name?: string | null; company_name?: string | null } | null | undefined): string {
  if (!c) return 'Customer';
  const first = c.first_name?.trim();
  const last = c.last_name?.trim();
  if (last && first) return `${last}, ${first}`;
  return last || first || c.company_name?.trim() || 'Customer';
}

/** Parse a formatCurrency string ("$1,234.56") into a number for UI delta assertions. */
function parseMoney(text: string): number {
  return Number(text.replace(/[^0-9.-]/g, ''));
}

test.beforeAll(async () => {
  api = await new ApiClient().init();

  // J-01 exemplar surface: SENT estimate with a job-less kind=DEPOSIT invoice.
  const dep = await maEstimateSentWithDeposit(api, 10_000, 30);
  depEstimateId = dep.estimateId;
  depEstimateNumber = dep.estimate.estimate_number;

  // J-01 click-through + J-02/J-04 money seeds: a full standard flow driven to invoice PAID
  // (CASH on-site payment). Gives estimate→job→invoice surfaces to walk and a refundable /
  // voidable CASH payment to drive the money dialogs against.
  const paid = await fullStandardFlowToInvoicePaid(api);
  stdEstimateId = paid.estimateId;
  stdEstimateNumber = paid.estimate.estimate_number;
  stdJobId = paid.jobId;
  stdInvoiceId = paid.invoiceId;

  // J-02 — refund target: net-paid is the full CASH payment recorded by the builder.
  refundInvoiceId = paid.invoiceId;
  refundNetPaid = Number(paid.payment.amount);

  // J-04 — void target: a SEPARATE PAID flow so voiding its payment does not perturb the
  // refund invoice's ledger (shared serial org — keep money seeds independent).
  const voidPaid = await fullStandardFlowToInvoicePaid(api);
  voidInvoiceId = voidPaid.invoiceId;

  // J-03 — credit target: a SENT (job-backed) invoice with amount_due > 0.
  const sent = await fullStandardFlowToInvoiceSent(api);
  creditInvoiceId = sent.invoiceId;

  // J-05 — a customer the Create Job dialog can find by search. The unique "MA-<suffix>"
  // first_name is the search token (and also a robust visible value).
  const njCust = await createMaCustomerWithLocation(api);
  const njCustomer = await api.getCustomer(njCust.customerId);
  newJobCustomerToken = (njCustomer.first_name as string); // "MA-<suffix>"

  // J-06 — a customer we then ARCHIVE. archiveCustomer flips it out of the default list
  // (include_archived defaults false) while /customers/:id stays reachable.
  const arch = await createMaCustomerWithLocation(api);
  archivedCustomerId = arch.customerId;
  const archCustomer = await api.getCustomer(archivedCustomerId);
  archivedCustomerName = customerDisplayName(archCustomer);
  archivedCustomerToken = (archCustomer.first_name as string); // "MA-<suffix>"
  await api.archiveCustomer(archivedCustomerId);
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe('Stage D-J — Journeys + money-modal arm', () => {
  test('J-01: standard-flow click-through — estimate→job→invoice surfaces render; final invoice PAID', async ({ gatedPage: page, gate }) => {
    // ── Exemplar surface: the SENT-with-deposit estimate renders its number, no ErrorBoundary.
    await page.goto(`/estimates/${depEstimateId}`);
    await expect(page.getByText(depEstimateNumber, { exact: false }).first()).toBeVisible();
    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'J-01 deposit estimate');
    await screenshotAndAssert(page, 'J-01-estimate.png', { expectVisible: [depEstimateNumber] });

    // ── Click-through the full PAID flow's surfaces: estimate → job → invoice.
    // (The money-critical deposit-paid + payment steps were driven via the API seed, not
    //  live Stripe — staging has no live key.)
    await page.goto(`/estimates/${stdEstimateId}`);
    await expect(page.getByText(stdEstimateNumber, { exact: false }).first()).toBeVisible();
    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'J-01 std estimate');

    await page.goto(`/jobs/${stdJobId}`);
    // Job detail renders its hero (job_number h1) — assert <main> is non-blank + no fallback.
    await expect(page.locator('main')).toBeVisible();
    expect(await page.locator('main > *').count(), 'job detail <main> is empty').toBeGreaterThan(0);
    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'J-01 job');

    await page.goto(`/invoices/${stdInvoiceId}`);
    await expect(page.getByTestId('invoice-detail')).toBeVisible();
    // Final state: the invoice is fully paid → StatusBadge renders the "Paid" label and
    // amount-due reads $0.00.
    await expect(page.getByText('Paid', { exact: false }).first()).toBeVisible();
    await expect(page.getByTestId('invoice-amount-due')).toHaveText(/\$0\.00/);
    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'J-01 invoice PAID');
    await screenshotAndAssert(page, 'J-01-invoice-paid.png', { expectVisible: ['Paid'] });
  });

  test('J-02: money-modal arm (Refund) — dialog opens, submit enables after reason, ledger shows the refund', async ({ gatedPage: page, gate }) => {
    await page.goto(`/invoices/${refundInvoiceId}`);
    await expect(page.getByTestId('invoice-detail')).toBeVisible();

    // Open the Refund dialog (rendered for ability.can('refund') && netPaid>0 && PAID/PARTIAL…).
    await page.getByRole('button', { name: /refund/i }).first().click();
    const dialog = page.getByTestId('refund-invoice-dialog');
    await expect(dialog).toBeVisible();

    // Submit is DISABLED until reasonCategory + reason are present (amount is optional).
    const submit = page.getByTestId('refund-invoice-submit');
    await expect(submit).toBeDisabled();

    // Full refund of the net-paid amount → invoice.status becomes REFUNDED, which is the
    // only state that surfaces the "Invoice Refunded" ledger row.
    await page.getByTestId('refund-amount-input').fill(String(refundNetPaid));
    // Reason category is a native <select> (NOT the first select — Refund method and the
    // per-payment select precede it). Target it by its CUSTOMER_REQUEST option, then fill
    // the required reason-details textarea.
    await dialog.locator('select', { has: page.locator('option[value="CUSTOMER_REQUEST"]') })
      .selectOption('CUSTOMER_REQUEST');
    await dialog.getByRole('textbox').last().fill('E2E full refund — money-modal arm');
    await expect(submit).toBeEnabled();
    await submit.click();

    // Real success behaviour: the dialog closes (no toast) and the invoice query refetches.
    await expect(dialog).toBeHidden();

    // The refunded figure surfaces in the ledger (Payments tab) once status === REFUNDED.
    await page.getByRole('tab', { name: /payments/i }).click();
    const ledger = page.getByTestId('invoice-ledger');
    await expect(ledger).toBeVisible();
    await expect(ledger.getByText(/refund/i).first()).toBeVisible();
    // The dollar amount (formatCurrency, with cents) appears in the ledger — match it exactly
    // (the ledger shows e.g. "703.63", not the rounded "704").
    const amount = refundNetPaid.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    await expect(ledger).toContainText(amount);

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'J-02 refund');
    await screenshotAndAssert(page, 'J-02-refund.png');

    // The plan's row wording says "toast" — the real mechanism is dialog-close + ledger
    // refetch (no toast component is wired into the money dialogs). Recorded so the matrix
    // reflects the real UX without forcing a false toast assertion.
    flagKnownBug(test.info(), {
      id: 'J-02',
      spec: '§8 refund',
      current: 'Refund success closes the dialog and refetches the ledger (no toast fires).',
      expected: 'Plan wording expects a success toast; the money dialogs intentionally have none.',
    });
  });

  test('J-03: money-modal arm (Credit) — credit-invoice-dialog opens, submit, amount_due drops', async ({ gatedPage: page, gate }) => {
    await page.goto(`/invoices/${creditInvoiceId}`);
    await expect(page.getByTestId('invoice-detail')).toBeVisible();

    // Capture amount_due BEFORE (a SENT invoice with positive balance).
    const beforeText = (await page.getByTestId('invoice-amount-due').textContent()) ?? '';
    const before = parseMoney(beforeText);
    expect(before, 'seeded credit invoice should have a positive amount_due').toBeGreaterThan(0);

    // Open the Credit dialog (rendered for ability.can('credit') && status not DRAFT/VOIDED).
    await page.getByRole('button', { name: /credit/i }).first().click();
    const dialog = page.getByTestId('credit-invoice-dialog');
    await expect(dialog).toBeVisible();

    // Credit a fixed amount strictly below the balance so it reduces (not over-pays) it.
    const creditAmount = Math.max(1, Math.min(50, Math.floor(before / 2)));
    await page.getByTestId('credit-amount-input').fill(String(creditAmount));
    await dialog.getByRole('textbox').last().fill('E2E credit — money-modal arm');
    const submit = page.getByTestId('credit-invoice-submit');
    await expect(submit).toBeEnabled();
    await submit.click();

    // Dialog closes (no toast); the invoice refetches → amount_due drops by the credit.
    await expect(dialog).toBeHidden();
    await expect(async () => {
      const afterText = (await page.getByTestId('invoice-amount-due').textContent()) ?? '';
      expect(parseMoney(afterText)).toBeLessThan(before);
    }).toPass();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'J-03 credit');
    await screenshotAndAssert(page, 'J-03-credit.png');
  });

  test('J-04: money-modal arm (Void payment) — void-payment-dialog opens, submit, amount_due reopens', async ({ gatedPage: page, gate }) => {
    await page.goto(`/invoices/${voidInvoiceId}`);
    await expect(page.getByTestId('invoice-detail')).toBeVisible();

    // Fully paid → amount_due reads $0.00 before voiding.
    const beforeText = (await page.getByTestId('invoice-amount-due').textContent()) ?? '';
    const before = parseMoney(beforeText);

    // The per-payment "Void" control lives in the Payments tab on a manual (CASH) row.
    await page.getByRole('tab', { name: /payments/i }).click();
    const ledger = page.getByTestId('invoice-ledger');
    await expect(ledger).toBeVisible();
    await ledger.getByRole('button', { name: /^void$/i }).first().click();

    const dialog = page.getByTestId('void-payment-dialog');
    await expect(dialog).toBeVisible();
    // Void requires a category + reason.
    await dialog.locator('select').first().selectOption('ERROR');
    await dialog.getByRole('textbox').last().fill('E2E void payment — money-modal arm');
    const submit = page.getByTestId('void-payment-submit');
    await expect(submit).toBeEnabled();
    await submit.click();

    // Dialog closes (no toast); voiding excludes the payment → amount_due reopens (rises).
    await expect(dialog).toBeHidden();
    await expect(async () => {
      const afterText = (await page.getByTestId('invoice-amount-due').textContent()) ?? '';
      expect(parseMoney(afterText)).toBeGreaterThan(before);
    }).toPass();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'J-04 void-payment');
    await screenshotAndAssert(page, 'J-04-void-payment.png');
  });

  test('J-05: negative-UI smoke — Create Job dialog has no "Urgent" toggle', async ({ gatedPage: page, gate }) => {
    // There is NO /jobs/new route: open the NewJobDialog from the Jobs list "New Job" button.
    await page.goto('/jobs');
    await page.getByRole('button', { name: /new job/i }).click();

    // The dialog (DialogTitle "Create Job") is the new-job form. Scope the /urgent/i count-0
    // assertion to the dialog only — "urgent" appears elsewhere in the app (schedule, etc.).
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Create Job')).toBeVisible();
    await expect(dialog.getByText(/urgent/i)).toHaveCount(0);

    // Drive the search far enough to render a customer + its locations, then re-assert that the
    // expanded form still surfaces zero "urgent" affordances (the retired urgent flow is gone).
    await dialog.getByPlaceholder(/name, email, phone/i).fill(newJobCustomerToken);
    await expect(dialog.getByText(/urgent/i)).toHaveCount(0);

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'J-05 no-urgent');
    await screenshotAndAssert(page, 'J-05-new-job-no-urgent.png', {
      noBlankScreen: false,
      expectVisible: ['Create Job'],
    });
  });

  test('J-06: archived customer — hidden from list, reachable by direct /customers/:id', async ({ gatedPage: page, gate }) => {
    // The default Customers list omits archived rows (include_archived defaults false).
    await page.goto('/customers');
    await expect(page.locator('main')).toBeVisible();
    // The archived customer's unique "MA-<suffix>" token must NOT appear in the list.
    await expect(page.getByText(archivedCustomerToken, { exact: false })).toHaveCount(0);
    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'J-06 list-hidden');

    // Direct URL still renders the CustomerDetailPage (with an Archived badge + restore control).
    await page.goto(`/customers/${archivedCustomerId}`);
    await expect(page.locator('main')).toBeVisible();
    expect(await page.locator('main > *').count(), 'archived customer detail <main> is empty').toBeGreaterThan(0);
    await expect(page.getByText(archivedCustomerName, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Archived', { exact: false }).first()).toBeVisible();
    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'J-06 detail-reachable');
    await screenshotAndAssert(page, 'J-06-archived-customer-detail.png', { expectVisible: [archivedCustomerName] });
  });
});
