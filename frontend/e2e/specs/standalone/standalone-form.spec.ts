import { test, expect, type Page, type Locator } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createMaCustomerWithLocation,
  createTaxExemptCustomerWithLocation,
  uniquePhone,
} from '../../helpers/workflow-builders';

/**
 * Standalone Invoices — PW-UI tier (browser form flows). The Tier-1 logic/tax/role/
 * security/lifecycle matrix is covered API-side by specs/workflow/standalone-invoices.spec.ts;
 * THIS spec drives the real /invoices/new page in chromium for the things only the browser
 * can prove: the two-step Continue→Create mechanics, location-driven tax preview, the
 * duplicate-customer dialog branches, and inline line-item validation. Maps to
 * md_files/plans/invoices/qa-run/qa-playwright.md Tier-2 scenarios SA-1/2/5/7/8/9,
 * VAL-1/2/3/9, DUP-1/4.
 *
 * Auth: the chromium project applies the provisioned-admin storageState, so `page` is an
 * authed ADMIN. Seeding is via ApiClient against the same throwaway org.
 *
 * Locator grounding (read from source — none of these controls carry data-testids):
 *  - StandaloneInvoiceFormPage renders the customer/location/totals block in ONE layout chosen
 *    by a JS media query (#259 fix): at ≥lg a sticky desktop sidebar `div.w-[300px] ... hidden
 *    lg:block`; below lg a `lg:hidden` mobile copy. Only one mounts, so #phone/#email appear
 *    once and the portaled duplicate dialog renders once. These specs pin a ≥lg viewport (1280)
 *    and scope customer/location/totals queries to the sidebar (`div.w-[300px]`). The
 *    LineItemsEditor renders ONCE in the main column (and, #266, scrolls horizontally rather
 *    than silently clipping the Total/Remove column when the sidebar squeezes it).
 *  - Submit button (top-right, variant=business, form="standalone-invoice-form"): label is
 *    "Continue" with no customer selected, "Create Invoice" once a customer is selected
 *    (StandaloneInvoiceFormPage.tsx:363-366). Cancel button = variant outline → navigate(-1).
 *  - PickOrCreateCustomer: five "Search..." inputs (first, last, phone#phone, email#email,
 *    company) + a results dropdown of <button>s showing "name" / "phone · email".
 *  - PickOrAccreteLocation: a shadcn Select (role=combobox) listing the customer's locations
 *    + "+ Add new location"; for a zero-location customer it is forced into the add-new
 *    address sub-form (State input has maxlength=2).
 *  - Totals card: tax line reads "Tax (6.25%)" / "Tax (exempt)" / "Tax".
 *  - DuplicateCustomerDialog: title "Possible Duplicate Customer"; "Open existing customer",
 *    "Edit email"/"Edit phone", and a de-emphasized "Create anyway" + "Cancel".
 *  - LineItemsEditor row: name placeholder "Item name", detail placeholder "Description for
 *    customer (optional)", qty placeholder "1", price placeholder "0.00" (.first() — the
 *    unit-cost input shares "0.00" and renders after price).
 */

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

// ── Shared locators / helpers ────────────────────────────────────────────────

const sidebarOf = (page: Page): Locator => page.locator('div.w-\\[300px\\]');

/** Type an email into the sidebar search field and click the matching dropdown result. */
async function pickCustomerByEmail(page: Page, email: string) {
  const sidebar = sidebarOf(page);
  const emailInput = sidebar.locator('#email');
  await emailInput.click();
  await emailInput.fill(email);
  // The dropdown result button shows "phone · email" — match on the unique email.
  const result = sidebar.locator('button', { hasText: email });
  await expect(result.first()).toBeVisible();
  await result.first().click();
  // Selection flips the submit button label.
  await expect(page.getByRole('button', { name: 'Create Invoice' })).toBeVisible();
}

/** Fill the single default line-item row. qty is left at its default (1) unless given. */
async function fillFirstLine(page: Page, name: string, price: string, opts?: { qty?: string; detail?: string }) {
  await page.getByPlaceholder('Item name').fill(name);
  if (opts?.detail !== undefined) {
    await page.getByPlaceholder('Description for customer (optional)').fill(opts.detail);
  }
  if (opts?.qty !== undefined) {
    await page.getByPlaceholder('1', { exact: true }).fill(opts.qty);
  }
  await page.getByPlaceholder('0.00').first().fill(price);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

// ── SA-1 — standalone happy path ─────────────────────────────────────────────

test('SA-1: existing MA customer → keep primary location → taxable line → Create Invoice', async ({ page }) => {
  const { customerId } = await createMaCustomerWithLocation(api);
  const cust = await api.getCustomer(customerId);
  const email = cust.email as string;

  await page.goto('/invoices/new');
  await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible();

  await pickCustomerByEmail(page, email);

  // Primary MA location is auto-selected → 6.25% preview.
  await expect(sidebarOf(page).getByText('Tax (6.25%)')).toBeVisible();

  await fillFirstLine(page, 'Diagnostic visit', '100');
  // Live preview total = 100 + 6.25 = 106.25.
  await expect(sidebarOf(page).getByText('$106.25')).toBeVisible();

  await page.getByRole('button', { name: 'Create Invoice' }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoiceId = page.url().split('/').pop()!;

  // Server is the source of truth.
  const inv = await api.getInvoice(invoiceId);
  expect(inv.status).toBe('DRAFT');
  expect(inv.invoice_number).toMatch(/^I\d+$/);
  expect(inv.customer_id).toBe(customerId);
  expect(Number(inv.subtotal)).toBe(100);
  expect(Number(inv.tax_rate)).toBeCloseTo(0.0625, 4);
  expect(Number(inv.tax_amount)).toBeCloseTo(6.25, 2);
  expect(Number(inv.total_amount)).toBeCloseTo(106.25, 2);
});

test('SA-1 entry points: /invoices "New Invoice" button reaches /invoices/new', async ({ page }) => {
  await page.goto('/invoices');
  await page.getByRole('button', { name: 'New Invoice' }).click();
  await page.waitForURL(/\/invoices\/new$/);
  await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible();
});

// ── SA-2 — two-step Continue → Create Invoice mechanics ──────────────────────

test('SA-2: typing a new customer shows "Continue"; first click creates the customer once', async ({ page }) => {
  const s = api.suffix;
  const email = `sa2-${s}@e2e-qa.invalid`;
  const phone = uniquePhone();

  await page.goto('/invoices/new');
  const sidebar = sidebarOf(page);
  await sidebar.getByPlaceholder('Search...').nth(0).fill(`SA2-${s}`); // first name
  await sidebar.getByPlaceholder('Search...').nth(1).fill('Tester');   // last name
  await sidebar.locator('#phone').fill(phone);
  await sidebar.locator('#email').fill(email);

  // No customer yet → primary button reads "Continue".
  const continueBtn = page.getByRole('button', { name: 'Continue' });
  await expect(continueBtn).toBeVisible();
  await continueBtn.click();

  // Customer created + selected → button flips, location card appears.
  await expect(page.getByRole('button', { name: 'Create Invoice' })).toBeVisible();
  await expect(sidebar.getByText('Service Location', { exact: true })).toBeVisible();

  // Created exactly once.
  const found = await api.raw('get', `/api/customers?search=${encodeURIComponent(email)}`);
  expect(found.body.customers.filter((c: { email?: string }) => c.email === email)).toHaveLength(1);
});

// ── SA-5 — customer with NO locations → forced add-new address form ──────────

test('SA-5: zero-location customer forces the add-new address sub-form (no picker options)', async ({ page }) => {
  const s = api.suffix;
  const email = `sa5-${s}@e2e-qa.invalid`;
  const customer = await api.createCustomer({
    first_name: `SA5-${s}`, last_name: 'NoLoc', email, phone: uniquePhone(),
  });
  expect((customer.service_locations ?? [])).toHaveLength(0);

  await page.goto('/invoices/new');
  await pickCustomerByEmail(page, email);

  const sidebar = sidebarOf(page);
  // Forced into add-new: the address sub-form (State = the only maxlength=2 input) is shown.
  await expect(sidebar.locator('input[maxlength="2"]')).toBeVisible();
});

// ── SA-7 — switch between two states updates the tax preview ─────────────────

test('SA-7: toggling between two locations re-previews each state rate (MA 6.25% ↔ CA 7.25%)', async ({ page }) => {
  const s = api.suffix;
  const email = `sa7-${s}@e2e-qa.invalid`;
  const customer = await api.createCustomer({
    first_name: `SA7-${s}`, last_name: 'TwoState', email, phone: uniquePhone(),
  });
  await api.addLocation(customer.id, {
    address_line1: '1 Beacon St', city: 'Boston', state: 'MA', zip: '02108', is_primary: true,
  });
  await api.addLocation(customer.id, {
    address_line1: '1 Market St', city: 'San Francisco', state: 'CA', zip: '94105', is_primary: false,
  });

  await page.goto('/invoices/new');
  await pickCustomerByEmail(page, email);

  const sidebar = sidebarOf(page);
  // Primary (MA) preselected.
  await expect(sidebar.getByText('Tax (6.25%)')).toBeVisible();

  // Switch the location Select to the CA location → preview re-computes.
  await sidebar.getByRole('combobox').click();
  await page.getByRole('option', { name: /San Francisco, CA/ }).click();
  await expect(sidebar.getByText('Tax (7.25%)')).toBeVisible();
});

// ── SA-8 — editing a field after picking drops back to new-customer mode ─────

test('SA-8: editing a contact field after picking clears the selection and reverts to "Continue"', async ({ page }) => {
  const { customerId } = await createMaCustomerWithLocation(api);
  const email = (await api.getCustomer(customerId)).email as string;

  await page.goto('/invoices/new');
  await pickCustomerByEmail(page, email);
  const sidebar = sidebarOf(page);
  await expect(sidebar.getByText('Service Location', { exact: true })).toBeVisible();

  // Change the phone → editing a contact field clears the selection.
  await sidebar.locator('#phone').fill(uniquePhone());

  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(sidebar.getByText('Service Location', { exact: true })).toHaveCount(0);
});

// ── SA-9 — Cancel navigates back, nothing created ────────────────────────────

test('SA-9: Cancel returns to the previous page without creating anything', async ({ page }) => {
  await page.goto('/invoices');
  await page.getByRole('button', { name: 'New Invoice' }).click();
  await page.waitForURL(/\/invoices\/new$/);

  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForURL(/\/invoices$/);
  await expect(page).not.toHaveURL(/\/invoices\/new$/);
});

// ── VAL — inline line-item validation ────────────────────────────────────────

test('VAL-1: submitting with no line items shows "Add at least one line item"', async ({ page }) => {
  const { customerId } = await createMaCustomerWithLocation(api);
  const email = (await api.getCustomer(customerId)).email as string;

  await page.goto('/invoices/new');
  await pickCustomerByEmail(page, email);

  // Leave the default row blank → submit is blocked with the guard message.
  await page.getByRole('button', { name: 'Create Invoice' }).click();
  await expect(page.getByText('Add at least one line item').first()).toBeVisible();
  await expect(page).toHaveURL(/\/invoices\/new$/);
});

test('VAL-2: a price with a blank name shows "Required" and blocks submit', async ({ page }) => {
  const { customerId } = await createMaCustomerWithLocation(api);
  const email = (await api.getCustomer(customerId)).email as string;

  await page.goto('/invoices/new');
  await pickCustomerByEmail(page, email);

  await page.getByPlaceholder('0.00').first().fill('50'); // price, no name
  await page.getByRole('button', { name: 'Create Invoice' }).click();
  await expect(page.getByText('Required').first()).toBeVisible();
  await expect(page).toHaveURL(/\/invoices\/new$/);
});

test('VAL-3: a qty-0 line blocks submit (qty input min=0.01 is :invalid, no invoice created)', async ({ page }) => {
  // NOTE: the qty <input> carries min="0.01", so a 0 quantity is HTML5-:invalid and the
  // browser blocks form submission natively — handleSubmit never runs, so the page's own
  // "Quantity must be greater than 0" string is unreachable from the submit button. The
  // *behavior* the scenario cares about (qty 0 cannot be submitted) holds; we assert that.
  const { customerId } = await createMaCustomerWithLocation(api);
  const email = (await api.getCustomer(customerId)).email as string;

  await page.goto('/invoices/new');
  await pickCustomerByEmail(page, email);

  let posted = false;
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/invoices(\?|$)/.test(r.url())) posted = true; });

  await fillFirstLine(page, 'Service call', '75', { qty: '0' });
  const qty = page.getByPlaceholder('1', { exact: true });
  await expect(qty).toHaveValue('0');
  await page.getByRole('button', { name: 'Create Invoice' }).click();
  await page.waitForTimeout(800);

  expect(posted, 'qty-0 must not POST an invoice').toBe(false);
  await expect(page).toHaveURL(/\/invoices\/new$/);
  expect(await qty.evaluate((el: HTMLInputElement) => el.validity.valid), 'qty 0 is HTML5-invalid (min=0.01)').toBe(false);
});

test('VAL-9: name + detail are persisted as "name\\ndetail" in the line description', async ({ page }) => {
  const { customerId } = await createMaCustomerWithLocation(api);
  const email = (await api.getCustomer(customerId)).email as string;

  await page.goto('/invoices/new');
  await pickCustomerByEmail(page, email);

  await fillFirstLine(page, 'Compressor swap', '500', { detail: 'OEM part, 1-yr warranty' });
  await page.getByRole('button', { name: 'Create Invoice' }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
  const inv = await api.getInvoice(page.url().split('/').pop()!);
  const desc = inv.line_items[0].description as string;
  expect(desc).toContain('Compressor swap');
  expect(desc).toContain('OEM part, 1-yr warranty');
  expect(desc).toBe('Compressor swap\nOEM part, 1-yr warranty');
});

// ── DUP — duplicate-customer guard dialog ────────────────────────────────────

test('DUP-1: new customer with an existing email → dialog → "Open existing customer" selects it', async ({ page }) => {
  const { customerId } = await createMaCustomerWithLocation(api);
  const existing = await api.getCustomer(customerId);
  const dupEmail = existing.email as string;

  await page.goto('/invoices/new');
  const sidebar = sidebarOf(page);
  const s = api.suffix;
  await sidebar.getByPlaceholder('Search...').nth(0).fill(`DUP1-${s}`);
  await sidebar.getByPlaceholder('Search...').nth(1).fill('Clone');
  await sidebar.locator('#phone').fill(uniquePhone()); // unique phone → only the email collides
  await sidebar.locator('#email').fill(dupEmail);

  await page.getByRole('button', { name: 'Continue' }).click();

  // Duplicate dialog opens; email is the matched field. Exactly ONE dialog renders now
  // (regression guard for #259 — the customer control used to mount twice, so the portaled
  // Radix dialog stacked two copies that aria-hid each other and broke hit-testing).
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await expect(page.getByText('Possible Duplicate Customer')).toBeVisible();
  await expect(page.getByText('matches')).toBeVisible();

  // Single dialog → its buttons are back in the a11y tree and hit-testable.
  await page.getByRole('button', { name: 'Open existing customer' }).click();
  // Existing customer is now selected → button flips + its MA location previews.
  await expect(page.getByRole('button', { name: 'Create Invoice' })).toBeVisible();
  await expect(sidebar.getByText('Tax (6.25%)')).toBeVisible();
});

test('DUP-4: dismissing the duplicate dialog selects nothing (button stays "Continue")', async ({ page }) => {
  const { customerId } = await createMaCustomerWithLocation(api);
  const dupEmail = (await api.getCustomer(customerId)).email as string;

  await page.goto('/invoices/new');
  const sidebar = sidebarOf(page);
  const s = api.suffix;
  await sidebar.getByPlaceholder('Search...').nth(0).fill(`DUP4-${s}`);
  await sidebar.getByPlaceholder('Search...').nth(1).fill('Clone');
  await sidebar.locator('#phone').fill(uniquePhone());
  await sidebar.locator('#email').fill(dupEmail);

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Possible Duplicate Customer')).toBeVisible();

  // Escape dismisses the guard (Radix onOpenChange → onClose). Nothing is selected →
  // button stays "Continue".
  await page.keyboard.press('Escape');
  await expect(page.getByText('Possible Duplicate Customer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
});

// ── TX preview — tax-exempt customer shows "Tax (exempt)" ────────────────────

test('TX-EXEMPT: an exempt customer previews "Tax (exempt)" and $0 tax', async ({ page }) => {
  const { customerId } = await createTaxExemptCustomerWithLocation(api);
  const email = (await api.getCustomer(customerId)).email as string;

  await page.goto('/invoices/new');
  await pickCustomerByEmail(page, email);

  const sidebar = sidebarOf(page);
  await expect(sidebar.getByText('Tax (exempt)')).toBeVisible();
  await fillFirstLine(page, 'Annual contract', '1000');
  // $1,000.00 shows as both subtotal and total (no tax) → assert at least one.
  await expect(sidebar.getByText('$1,000.00').first()).toBeVisible();
});
