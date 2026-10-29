import { test, expect, assertGatesClean, assertNoErrorBoundary } from '../../fixtures/gated-test';
import { screenshotAndAssert } from '../../helpers/screenshot';
import { ApiClient } from '../../helpers/api-client';
import { maEstimateSentWithDeposit } from '../../helpers/workflow-builders';

// Mirrors frontend/src/lib/customer-name.ts customerDisplayName (kept local to avoid coupling
// the e2e spec to the src module graph). "Last, First" when both present.
function customerDisplayName(c: { first_name?: string | null; last_name?: string | null; company_name?: string | null } | null | undefined): string {
  if (!c) return 'Customer';
  const first = c.first_name?.trim();
  const last = c.last_name?.trim();
  if (last && first) return `${last}, ${first}`;
  return last || first || c.company_name?.trim() || 'Customer';
}

/**
 * Stage 0 — App-health & render-safety (Task D0, rows R0-01..R0-06).
 *
 * UI tier (🖥️): drives the browser against a provisioned-admin storageState (the UI config's
 * `setup` project produces .auth/admin.json). Seeds the deposit/job-less invoice + customer via the
 * shared ApiClient in beforeAll, then asserts the redesign render surfaces never throw / never trip
 * the top-level ErrorBoundary, asserting POSITIVE seeded values (not merely "no error").
 *
 * Shared serial org (workers:1): never assert absolute counts; assert presence of seeded values.
 */

let api: ApiClient;

// R0-02 / R0-03 / R0-06 — a job-less kind=DEPOSIT invoice spawned on a SENT estimate.
let depositInvoiceId: string;
let depositNumber: string;
let customerId: string;
let customerName: string;

test.beforeAll(async () => {
  api = await new ApiClient().init();

  // maEstimateSentWithDeposit spawns estimate.invoices[0] = the job-less kind=DEPOSIT invoice
  // (job_id=null) — the exact surface the jobless-render regression fix targets.
  const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
  customerId = ctx.customerId;

  const estimate = await api.getEstimate(ctx.estimateId);
  const dep = estimate.invoices[0];
  depositInvoiceId = dep.id;
  // estimate.invoices[0] omits invoice_number — read the deposit's full record for it.
  depositNumber = (await api.getInvoice(dep.id)).invoice_number;

  // The display name the InvoiceDetailPage will render for this job-less invoice's customer
  // ("Last, First"). createMaCustomerWithLocation seeds first_name = `MA-${api.suffix}`, so this is
  // a unique positive value.
  const customer = await api.getCustomer(customerId);
  customerName = customerDisplayName(customer);
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe('Stage 0 — App-health & render-safety', () => {
  test('R0-01: every primary nav page renders — gate clean, no ErrorBoundary', async ({ gatedPage: page, gate }) => {
    // /settings redirects to /settings/company; assert the final landing route renders content.
    const navPages: Array<{ label: string; path: string }> = [
      { label: 'Dashboard', path: '/' },
      { label: 'Leads', path: '/leads' },
      { label: 'Estimates', path: '/estimates' },
      { label: 'Jobs', path: '/jobs' },
      { label: 'Invoices', path: '/invoices' },
      { label: 'Customers', path: '/customers' },
      { label: 'Settings', path: '/settings' },
    ];

    for (const { label, path } of navPages) {
      await page.goto(path);
      // <main> with children = not blank; ErrorBoundary fallback never rendered.
      await expect(page.locator('main')).toBeVisible();
      expect(await page.locator('main > *').count(), `${label} (${path}) <main> is empty`).toBeGreaterThan(0);
      await assertNoErrorBoundary(page);
    }

    await assertGatesClean(gate, 'R0-01');
  });

  test('R0-02: seeded kind=DEPOSIT (job-less) invoice detail renders with the deposit number', async ({ gatedPage: page, gate }) => {
    await page.goto(`/invoices/${depositInvoiceId}`);

    await expect(page.getByTestId('invoice-detail')).toBeVisible();
    // Positive seeded value — the per-org deposit invoice number, not just "no error".
    await expect(page.getByText(depositNumber, { exact: false }).first()).toBeVisible();
    // kind==='DEPOSIT' renders the "Deposit" badge.
    await expect(page.getByText('Deposit', { exact: false }).first()).toBeVisible();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'R0-02');
    await screenshotAndAssert(page, 'R0-02-deposit-invoice-detail.png', { expectVisible: [depositNumber] });
  });

  test('R0-03: job-less invoice detail renders the customer name (jobless-render regression)', async ({ gatedPage: page, gate }) => {
    // Same job-less invoice (job_id=null). InvoiceDetailPage resolves
    // customer = invoice.customer ?? invoice.job?.customer (a null job must NOT throw) — the 2026-06-05 fix.
    await page.goto(`/invoices/${depositInvoiceId}`);

    await expect(page.getByTestId('invoice-detail')).toBeVisible();
    // The customer name comes from the top-level invoice.customer (always present), proving the
    // regression is fixed: with job=null the page still surfaces the customer.
    await expect(page.getByText(customerName, { exact: false }).first()).toBeVisible();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'R0-03');
    await screenshotAndAssert(page, 'R0-03-jobless-invoice-customer.png', { expectVisible: [customerName] });
  });

  test('R0-04: statement page renders (customer route /customers/:customerId/statement)', async ({ gatedPage: page, gate }) => {
    // Route param is :customerId (not :id); the customer has at least one invoice (the deposit) so
    // totals/lines are non-empty, but the page renders even with zero lines.
    await page.goto(`/customers/${customerId}/statement`);

    await expect(page.getByTestId('statement-page')).toBeVisible();
    await expect(page.getByTestId('statement-running-balance')).toBeVisible();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'R0-04');
    // Hero title "Customer Statement" is always rendered for the customer scope (stable positive
    // value independent of the billing-group member list).
    await screenshotAndAssert(page, 'R0-04-statement-page.png', { expectVisible: ['Customer Statement'] });
  });

  test('R0-05: customer form renders with the billing-group section', async ({ gatedPage: page, gate }) => {
    // /customers/new renders the empty form; no seeding required.
    await page.goto('/customers/new');

    await expect(page.getByTestId('customer-form')).toBeVisible();
    await expect(page.getByTestId('customer-billing-group')).toBeVisible();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'R0-05');
    await screenshotAndAssert(page, 'R0-05-customer-form-billing-group.png', { expectVisible: ['More Details'] });
  });

  test('R0-06: ErrorBoundary fallback absent on all four seeded surfaces (R0-02..R0-05)', async ({ gatedPage: page, gate }) => {
    // Re-walk each render surface and assert the top-level ErrorBoundary fallback count is 0.
    const surfaces: string[] = [
      `/invoices/${depositInvoiceId}`,        // R0-02 deposit invoice
      `/invoices/${depositInvoiceId}`,        // R0-03 job-less invoice (same row, job=null)
      `/customers/${customerId}/statement`,   // R0-04 statement
      '/customers/new',                       // R0-05 customer form
    ];

    for (const path of surfaces) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      await expect(page.getByTestId('error-boundary-fallback')).toHaveCount(0);
    }

    await assertGatesClean(gate, 'R0-06');
  });
});
