import { test, expect, assertGatesClean, assertNoErrorBoundary } from '../../fixtures/gated-test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createMaCustomerWithLocation,
  createCustomerWithLocation,
  createNewLead,
  fullStandardFlow,
  uniquePhone,
} from '../../helpers/workflow-builders';

/**
 * #224 — PW-UI gate coverage for the standalone-invoice UI (/invoices/new), the
 * duplicate-customer guard dialog, and the estimate-less-job CreateJobInvoiceDialog
 * (wiring restored from 78305e4d after the JCC merge dropped it).
 *
 * UI tier (🖥️): provisioned-admin storageState via gatedPage; seeding via ApiClient in
 * beforeAll. Shared serial org (workers:1) — presence/delta assertions only. All seeded
 * emails are @e2e-qa.invalid so the global-teardown sweep removes them.
 *
 * Locator grounding (read from component source; no app component was modified):
 *  - Sidebar.tsx:99-102 "Create New" button; menu items = quickCreateItems
 *    (nav-config.ts:35 'New Invoice' → /invoices/new), ability-filtered (Sidebar.tsx:106-108).
 *  - NewMenu.tsx:37-45 dashboard "New ▾" button (aria-haspopup=menu); item 'New Invoice' (:10).
 *  - App.tsx:153-155 — /invoices/new behind ProtectedRoute allowedRoles=[ADMIN,DISPATCHER];
 *    a disallowed non-technician role bounces to '/' (ProtectedRoute.tsx:23-24).
 *  - StandaloneInvoiceFormPage.tsx:374-377 heading 'New Invoice'; submit (:382-385) reads
 *    'Continue' until a customer is selected, then 'Create Invoice'; validation strings
 *    (:347-357): 'Add at least one line item' / 'Required' / 'Quantity must be greater than 0';
 *    createInvoice onSuccess navigates to /invoices/:id (:241-244).
 *  - PickOrCreateCustomer.tsx:203-215 First Name Input placeholder 'Search...' with
 *    CustomerDropdown after 2 chars; #phone (:239) / #email (:254).
 *  - LineItemsEditor.tsx:398 'Item name'; :422 qty placeholder '1'; :436 price '0.00'
 *    (.first() — the unit-COST input at :448 shares the placeholder and renders AFTER,
 *    same gotcha as 07-estimate-form).
 *  - Totals card (:443-471): 'Subtotal', 'Tax (6.25%)' for an MA location, 'Total'.
 *  - DuplicateCustomerDialog.tsx: title 'Possible Duplicate Customer' (:86-89), 'Open
 *    existing customer' (:177-182), 'Edit email' (:185-192, focuses #email via
 *    handleEditField :325-328), 'Cancel' (:209-215), 'Create anyway' (:216-224 →
 *    POST /api/customers?override=true, createCustomer :207-217).
 *  - JobDetailPage.tsx: 'Create Invoice' button; estimate-less job → CreateJobInvoiceDialog
 *    (data-testid 'create-job-invoice-dialog' / 'create-job-invoice-submit',
 *    CreateJobInvoiceDialog.tsx:112/:140); button hidden on CANCELLED (canCreateInvoice :171).
 *
 * Determinism: MA = the preflight-asserted 6.25% StateTaxRate fixture, so a $1,000
 * taxable line yields Tax $62.50 / Total $1,062.50. The deliberate dup-guard 409 is a
 * 4xx — it does not trip the 5xx gate.
 */

const ROLE_PASSWORD = 'Test123!@#';

let api: ApiClient;
let maCustomerId: string;
let maFirstName: string;
let dupEmail: string;
let dupFirstName: string;
let estimateLessJobId: string;
let estimateLessJobNumber: string;
let cancelledJobId: string;
let estimateBackedJobId: string;
let dispatcherEmail: string;
let salesEmail: string;

test.beforeAll(async () => {
  test.setTimeout(300_000); // several full-pipeline seeds in one hook
  api = await new ApiClient().init();

  // Stable tax default for the form page (missing AppSetting keys 404 → console gate noise).
  await api.raw('patch', '/api/settings/default_tax_state', { value: 'MA' });

  // T3 — MA customer (6.25% fixture) with a primary location.
  const ma = await createMaCustomerWithLocation(api);
  maCustomerId = ma.customerId;
  maFirstName = (await api.getCustomer(maCustomerId)).first_name as string;

  // T5 — dup-guard target with a KNOWN email.
  const dupSuffix = api.suffix;
  dupFirstName = `Dup-${dupSuffix}`;
  dupEmail = `dup-${dupSuffix}@e2e-qa.invalid`;
  await api.createCustomer({
    first_name: dupFirstName,
    last_name: 'Target',
    email: dupEmail,
    phone: uniquePhone(),
  });

  // T6 — estimate-less job (customer + location only; no start/complete needed).
  const c1 = await createCustomerWithLocation(api);
  await createNewLead(api, c1.customerId); // keeps the org shape realistic
  const { body: j1 } = await api.createJob({
    customer_id: c1.customerId,
    service_location_id: c1.locationId,
  });
  estimateLessJobId = j1.job.id;
  estimateLessJobNumber = j1.job.job_number;

  // T6b — a CANCELLED estimate-less job (Create Invoice must be hidden).
  const c2 = await createCustomerWithLocation(api);
  const { body: j2 } = await api.createJob({
    customer_id: c2.customerId,
    service_location_id: c2.locationId,
  });
  cancelledJobId = j2.job.id;
  await api.cancelJob(cancelledJobId, 'E2E #224 — cancelled-job invoice gate');

  // T7 — estimate-backed job (RG-1 one-click regression guard).
  const flow = await fullStandardFlow(api);
  estimateBackedJobId = flow.jobId;

  // T2 — role users with known passwords.
  const s = api.suffix;
  dispatcherEmail = `dispatch-224-${s}@e2e-qa.invalid`;
  salesEmail = `sales-224-${s}@e2e-qa.invalid`;
  await api.createUser({
    email: dispatcherEmail, password: ROLE_PASSWORD,
    first_name: 'Dispatch', last_name: `T224-${s}`, role: 'DISPATCHER',
  });
  await api.createUser({
    email: salesEmail, password: ROLE_PASSWORD,
    first_name: 'Sales', last_name: `T224-${s}`, role: 'SALES',
  });
});

test.afterAll(async () => {
  await api?.dispose();
});

// ─── Shared helpers ────────────────────────────────────────────────────────────

/** Fresh context (no admin storageState) + real login form; lands on '/' for office roles. */
async function loginAs(browser: Browser, email: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
  const emailInput = page.locator('#email');
  await emailInput.click();
  await emailInput.pressSequentially(email, { delay: 20 });
  const pw = page.locator('#password');
  await pw.click();
  await pw.pressSequentially(ROLE_PASSWORD, { delay: 20 });
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
  return { context, page };
}

/** Open /invoices/new and pick the seeded MA customer through the search dropdown. */
async function pickMaCustomer(page: Page) {
  await page.goto('/invoices/new');
  await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible();
  const firstName = page.getByPlaceholder('Search...').first(); // First Name input
  await firstName.click();
  await firstName.pressSequentially(maFirstName.slice(0, 6), { delay: 20 });
  // Dropdown row: "<first> <last>" (PickOrCreateCustomer CustomerDropdown rows are buttons).
  await page.getByRole('button', { name: new RegExp(maFirstName, 'i') }).first().click();
  // Selection flips the submit label from 'Continue' to 'Create Invoice'.
  await expect(page.getByRole('button', { name: 'Create Invoice' })).toBeVisible();
}

/** Fill the default line row: name + price (unit-COST shares the '0.00' placeholder → .first()). */
async function fillLine(scope: Page, name: string, price: string) {
  await scope.getByPlaceholder('Item name').first().fill(name);
  await scope.getByPlaceholder('0.00').first().fill(price);
}

const UUID_URL = /\/invoices\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ─── T1 — both quick-create menus route to /invoices/new (admin) ────────────────

test.describe('#224 — standalone invoice UI gate', () => {
  test('T1: sidebar "Create New" and dashboard "New" menus expose New Invoice (admin)', async ({ gatedPage: page, gate }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create New' }).click();
    await page.getByRole('menuitem', { name: 'New Invoice' }).click();
    await page.waitForURL(/\/invoices\/new$/);
    await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible();

    await page.goto('/');
    await page.getByRole('button', { name: /^New\b/ }).click(); // dashboard NewMenu (aria-haspopup)
    await page.getByRole('menuitem', { name: 'New Invoice' }).click();
    await page.waitForURL(/\/invoices\/new$/);
    await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'T1 menus');
  });

  // ─── T2 — role access: DISPATCHER allowed, SALES blocked ──────────────────────

  test('T2a: DISPATCHER sees the menu items and the route renders', async ({ browser }) => {
    const { context, page } = await loginAs(browser, dispatcherEmail);
    try {
      await page.getByRole('button', { name: 'Create New' }).click();
      await page.getByRole('menuitem', { name: 'New Invoice' }).click();
      await page.waitForURL(/\/invoices\/new$/);
      await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible();
      await assertNoErrorBoundary(page);
    } finally {
      await context.close();
    }
  });

  test('T2b: SALES has no New Invoice menu item and /invoices/new bounces to /', async ({ browser }) => {
    const { context, page } = await loginAs(browser, salesEmail);
    try {
      await page.getByRole('button', { name: 'Create New' }).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'New Invoice' })).toHaveCount(0);
      await page.keyboard.press('Escape');

      await page.goto('/invoices/new');
      // ProtectedRoute.tsx:23-24 — disallowed office role → Navigate to '/'.
      await page.waitForURL((url) => url.pathname === '/');
      await expect(page.getByRole('heading', { name: 'New Invoice' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // ─── T3 — happy path (SA-1): MA customer, $1,000 line → $1,062.50 DRAFT ───────

  test('T3: happy path — pick customer, one $1,000 line, 6.25% tax, DRAFT invoice created', async ({ gatedPage: page, gate }) => {
    await pickMaCustomer(page);

    await fillLine(page, 'Annual maintenance visit', '1000');

    // Totals card: $1,000.00 subtotal, MA 6.25% → $62.50 tax, $1,062.50 total.
    await expect(page.getByText('$1,000.00').first()).toBeVisible();
    await expect(page.getByText('Tax (6.25%)')).toBeVisible();
    await expect(page.getByText('$62.50')).toBeVisible();
    await expect(page.getByText('$1,062.50')).toBeVisible();

    await page.getByRole('button', { name: 'Create Invoice' }).click();
    await page.waitForURL(UUID_URL);
    const invoiceId = page.url().split('/').pop()!;

    // Server-confirmed: DRAFT, correct money, linked to the picked customer.
    const invoice = await api.getInvoice(invoiceId);
    expect(invoice.status, 'standalone invoice status').toBe('DRAFT');
    expect(Number(invoice.total_amount), 'standalone invoice total').toBeCloseTo(1062.5, 2);
    expect(invoice.customer?.id ?? invoice.customer_id).toBe(maCustomerId);

    // Rendered detail: number + Draft badge.
    await expect(page.getByText(invoice.invoice_number as string, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'T3 happy path');
  });

  // ─── T4 — inline validation (VAL-1/2/3) blocks submission, no POST ─────────────

  test('T4: line-item validation blocks empty/price-only/zero-qty rows with no POST', async ({ gatedPage: page, gate }) => {
    let invoicePosts = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/invoices$/.test(req.url())) invoicePosts += 1;
    });

    await pickMaCustomer(page);

    // VAL-1: blank row → 'Add at least one line item'; URL unchanged.
    await page.getByRole('button', { name: 'Create Invoice' }).click();
    await expect(page.getByText('Add at least one line item')).toBeVisible();
    expect(page.url()).toContain('/invoices/new');

    // VAL-2: price without a name → 'Required'.
    await page.getByPlaceholder('0.00').first().fill('500');
    await page.getByRole('button', { name: 'Create Invoice' }).click();
    await expect(page.getByText('Required', { exact: true })).toBeVisible();

    // VAL-3: named row with qty 0 → 'Quantity must be greater than 0'.
    await page.getByPlaceholder('Item name').first().fill('Filter swap');
    await page.getByPlaceholder('1').first().fill('0');
    await page.getByRole('button', { name: 'Create Invoice' }).click();
    await expect(page.getByText('Quantity must be greater than 0')).toBeVisible();

    expect(invoicePosts, 'no invoice POST may fire on validation failures').toBe(0);
    await assertGatesClean(gate, 'T4 validation');
  });

  // ─── T5 — duplicate-customer guard, all four branches ──────────────────────────

  async function fillNewCustomerWithDupEmail(page: Page) {
    await page.goto('/invoices/new');
    await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible();
    const firstName = page.getByPlaceholder('Search...').first();
    await firstName.fill(`Fresh${Date.now().toString(36)}`);
    await page.locator('#phone').fill(uniquePhone());
    await page.locator('#email').fill(dupEmail);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Possible Duplicate Customer')).toBeVisible();
  }

  test('T5a: dup guard — Open existing customer selects the existing record', async ({ gatedPage: page, gate }) => {
    await fillNewCustomerWithDupEmail(page);
    await page.getByRole('button', { name: 'Open existing customer' }).click();
    await expect(page.getByText('Possible Duplicate Customer')).toHaveCount(0);
    // Contact fields repopulate from the existing customer (selectCustomer).
    await expect(page.getByPlaceholder('Search...').first()).toHaveValue(dupFirstName);
    await expect(page.getByRole('button', { name: 'Create Invoice' })).toBeVisible();
    await assertGatesClean(gate, 'T5a open-existing');
  });

  test('T5b: dup guard — Edit email closes the dialog and focuses #email', async ({ gatedPage: page, gate }) => {
    await fillNewCustomerWithDupEmail(page);
    await page.getByRole('button', { name: 'Edit email' }).click();
    await expect(page.getByText('Possible Duplicate Customer')).toHaveCount(0);
    await expect(page.locator('#email')).toBeFocused();
    await assertGatesClean(gate, 'T5b edit-email');
  });

  test('T5c: dup guard — Cancel dismisses and the form stays intact', async ({ gatedPage: page, gate }) => {
    await fillNewCustomerWithDupEmail(page);
    await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
    await expect(page.getByText('Possible Duplicate Customer')).toHaveCount(0);
    await expect(page.locator('#email')).toHaveValue(dupEmail);
    await assertGatesClean(gate, 'T5c dismiss');
  });

  test('T5d: dup guard — Create anyway overrides and the customer invoices end-to-end', async ({ gatedPage: page, gate }) => {
    await fillNewCustomerWithDupEmail(page);

    const overrideReq = page.waitForRequest(
      (req) => req.method() === 'POST' && req.url().includes('/api/customers?override=true'),
    );
    await page.getByRole('button', { name: 'Create anyway' }).click();
    await overrideReq;
    await expect(page.getByText('Possible Duplicate Customer')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create Invoice' })).toBeVisible();

    // Prove the override customer invoices end-to-end: add a line + submit.
    await fillLine(page, 'Override customer service call', '200');
    await page.getByRole('button', { name: 'Create Invoice' }).click();
    await page.waitForURL(UUID_URL);
    const invoice = await api.getInvoice(page.url().split('/').pop()!);
    expect(invoice.status).toBe('DRAFT');

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'T5d create-anyway');
  });

  // ─── T6 — estimate-less job dialog (JI-1/3) + cancelled-job gate (JI-6) ────────

  test('T6: estimate-less job — Create Invoice opens the dialog, validates, creates a linked DRAFT', async ({ gatedPage: page, gate }) => {
    await page.goto(`/jobs/${estimateLessJobId}`);
    await expect(page.getByText(estimateLessJobNumber).first()).toBeVisible();

    await page.getByRole('button', { name: 'Create Invoice' }).click();
    const dialog = page.getByTestId('create-job-invoice-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(`Create Invoice for ${estimateLessJobNumber}`)).toBeVisible();

    // In-dialog validation blocks empty lines.
    await page.getByTestId('create-job-invoice-submit').click();
    await expect(dialog.getByText('Add at least one line item')).toBeVisible();

    // Fill the line and submit → DRAFT invoice linked to the job.
    await dialog.getByPlaceholder('Item name').first().fill('Emergency contactor replacement');
    await dialog.getByPlaceholder('0.00').first().fill('350');
    await page.getByTestId('create-job-invoice-submit').click();
    await page.waitForURL(UUID_URL);

    const invoice = await api.getInvoice(page.url().split('/').pop()!);
    expect(invoice.status, 'estimate-less job invoice status').toBe('DRAFT');
    expect(invoice.job_id ?? invoice.job?.id, 'invoice linked to the job').toBe(estimateLessJobId);

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'T6 estimate-less dialog');
  });

  test('T6b: cancelled job — no Create Invoice button', async ({ gatedPage: page, gate }) => {
    await page.goto(`/jobs/${cancelledJobId}`);
    await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Invoice' })).toHaveCount(0);
    await assertGatesClean(gate, 'T6b cancelled gate');
  });

  // ─── T7 — RG-1: estimate-backed job still one-clicks with NO dialog ────────────

  test('T7: estimate-backed job — one-click invoice, dialog never appears', async ({ gatedPage: page, gate }) => {
    await page.goto(`/jobs/${estimateBackedJobId}`);
    await expect(page.getByRole('button', { name: 'Create Invoice' })).toBeVisible();

    await page.getByRole('button', { name: 'Create Invoice' }).click();
    await page.waitForURL(UUID_URL);
    // The estimate-less dialog must NOT have been part of the flow.
    await expect(page.getByTestId('create-job-invoice-dialog')).toHaveCount(0);

    const invoice = await api.getInvoice(page.url().split('/').pop()!);
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.job_id ?? invoice.job?.id).toBe(estimateBackedJobId);
    // One-click path snapshots the estimate's lines → a non-zero total.
    expect(Number(invoice.total_amount)).toBeGreaterThan(0);

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'T7 one-click regression');
  });
});
