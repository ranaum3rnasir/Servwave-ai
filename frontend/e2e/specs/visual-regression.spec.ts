import { test, expect, Page } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';

/**
 * Verification layer 1 (program plan §4.1) - the visual-regression gate for the phase-7
 * tracer bullet: `pages/InvoicesPage.tsx` (list) and `pages/InvoiceDetailPage.tsx` (detail).
 *
 * Run with `--config=e2e/visual-regression.config.ts`. Baselines are committed under
 * `e2e/visual-baselines/`; `--update-snapshots` rewrites them.
 *
 * WHY THIS IS NOT `visual-screenshots.spec.ts`: that spec calls `page.screenshot()` and
 * asserts nothing, so it can never fail. Everything below ends in
 * `expect(page).toHaveScreenshot()`, so a changed pixel fails the run.
 *
 * ─── Determinism ────────────────────────────────────────────────────────────────────────
 * A baseline is only worth having if the same source produces the same pixels tomorrow, on
 * another machine. Three sources of drift exist here, and all three are removed AT SOURCE
 * rather than masked - a mask is a hole in the gate, so every masked region is coverage
 * given up. There are currently NO masks.
 *
 *  1. Content. The org is provisioned fresh per run (global-setup), so this file seeds the
 *     entire customer -> lead -> estimate -> job -> invoice -> payment chain itself with
 *     fixed literals, instead of using `helpers/workflow-builders.ts` (whose customer names,
 *     emails, phones and street numbers are randomised per run - see `ApiClient.suffix` and
 *     `uniquePhone()`). Per-org numbering is race-safe and starts at 1 in a fresh org, so
 *     the invoice is always I00001 and the job always J00001.
 *  2. The clock. Both pages render `toLocaleDateString()` output and a live
 *     "due in N days" label. The browser clock is pinned with `page.clock.setFixedTime`,
 *     and the config pins `locale: 'en-US'` + `timezoneId: 'UTC'`.
 *  3. Server-written timestamps. `created_at`, `sent_at`, `due_date`, payment `paid_at` and
 *     every ledger/timeline date are written by the backend at seed time, so they move every
 *     run no matter what the browser clock says. A response interceptor rewrites any
 *     ISO-8601-shaped STRING VALUE in an `/api/**` JSON response to a fixed instant, keyed by
 *     field name. It changes values only - never shapes, never classes, never layout - so
 *     every pixel under test is still produced by the real components from a real API
 *     response.
 */

// ─── Fixed instants ─────────────────────────────────────────────────────────────────────
// FROZEN_NOW sits between SENT_AT and DUE_DATE, so the invoice renders SENT/PARTIAL and
// NOT overdue, with a stable "in N days" label. Moving FROZEN_NOW past DUE_DATE would flip
// the page to its overdue styling - which is a second baseline worth adding in a later
// phase, not a reason to leave the date floating.
const FROZEN_NOW = new Date('2026-01-20T12:00:00.000Z');
const CREATED_AT = '2026-01-05T09:00:00.000Z';
const SENT_AT = '2026-01-06T15:30:00.000Z';
const PAID_AT = '2026-01-08T11:15:00.000Z';
const DUE_DATE = '2026-02-05T00:00:00.000Z';

/** Field-name -> fixed instant. Anything date-shaped and unlisted collapses to CREATED_AT. */
const FIXED_BY_FIELD: Record<string, string> = {
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  sent_at: SENT_AT,
  due_date: DUE_DATE,
  paid_at: PAID_AT,
  approved_at: SENT_AT,
  voided_at: CREATED_AT,
  refunded_at: PAID_AT,
  date: CREATED_AT,
};

// Date-only (`2026-02-05`) or full ISO-8601. Anchored at both ends so a free-text field that
// merely CONTAINS a date is left alone.
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// The throwaway org's identity is minted per run by `provisionTestOrg` from a random 8-hex
// runId: the org is named `e2e-qa-<runId>` and the admin is `admin-<runId>@e2e-qa.invalid`.
// The org name is rendered in the top bar of EVERY page, so without this the baseline would
// differ on every single run. Same treatment as the timestamps: pinned at the value, not
// hidden behind a mask.
const RUN_ID_ORG = /^e2e-qa-[0-9a-f]{8}$/;
const RUN_ID_ADMIN_EMAIL = /^admin-[0-9a-f]{8}@e2e-qa\.invalid$/;
const FIXED_ORG_NAME = 'e2e-qa-fixture';
const FIXED_ADMIN_EMAIL = 'admin-fixture@e2e-qa.invalid';

function pinValue(node: string, key?: string): string {
  if (ISO_LIKE.test(node)) return (key && FIXED_BY_FIELD[key]) || CREATED_AT;
  if (RUN_ID_ORG.test(node)) return FIXED_ORG_NAME;
  if (RUN_ID_ADMIN_EMAIL.test(node)) return FIXED_ADMIN_EMAIL;
  return node;
}

function freezeVolatileValues(node: unknown, key?: string): unknown {
  if (typeof node === 'string') return pinValue(node, key);
  if (Array.isArray(node)) return node.map((v) => freezeVolatileValues(v, key));
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = freezeVolatileValues(v, k);
    }
    return out;
  }
  return node;
}

/** Pin the clock and neutralise server-written volatile values. Must run before the first goto. */
async function pinRenderingEnvironment(page: Page, origin: string) {
  await page.clock.setFixedTime(FROZEN_NOW);

  // Sentry's browser SDK POSTs an envelope on load. It paints nothing, but it is a real
  // outbound request that keeps `networkidle` from settling and (because its ingest path is
  // literally `/api/<projectId>/envelope/`) would otherwise be caught by the rewrite below.
  // Blocked outright - a visual baseline should not depend on a third-party endpoint.
  await page.route(/ingest\.[a-z]+\.sentry\.io/, (route) => route.abort());

  // Scoped to the app's OWN origin. A bare '**/api/**' also matches third-party hosts.
  await page.route(`${origin}/api/**`, async (route) => {
    try {
      const response = await route.fetch();
      const contentType = response.headers()['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        await route.fulfill({ response });
        return;
      }
      const raw = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await route.fulfill({ response });
        return;
      }
      await route.fulfill({ response, body: JSON.stringify(freezeVolatileValues(parsed)) });
    } catch {
      // The page can be torn down with requests still in flight; a rejected route callback
      // there fails an otherwise-passed test. Nothing is rendered after teardown, so
      // dropping the request is correct.
      await route.abort().catch(() => {});
    }
  });
}

/**
 * `toHaveScreenshot` already retries until two consecutive captures match, but it cannot
 * know the difference between "still fetching" and "settled". Wait for the real content and
 * for webfonts before letting it start, so the first capture is not of a skeleton.
 */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Prove the capture is not silently truncated.
 *
 * `AppLayout` is `h-[100dvh] overflow-hidden` with the routed page inside
 * `<main class="flex-1 overflow-y-auto">` (components/layout/AppLayout.tsx:44,106). The
 * document therefore never grows past the viewport, and `fullPage: true` captures exactly one
 * viewport - everything below the fold of `<main>` is silently outside the gate. The fix is
 * a viewport tall enough to contain the page (set per test with `test.use`); this assertion
 * is what stops that height from going stale. If the page grows past it, the run fails and
 * names the height needed, instead of quietly shrinking the gate's coverage.
 */
async function assertNothingBelowTheFold(page: Page) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return { found: false, scrollHeight: 0, clientHeight: 0 };
    return { found: true, scrollHeight: main.scrollHeight, clientHeight: main.clientHeight };
  });
  expect(overflow.found, 'AppLayout <main> not found - the layout changed').toBe(true);
  expect(
    overflow.scrollHeight,
    `<main> scrolls (${overflow.scrollHeight}px of content in ${overflow.clientHeight}px), so the ` +
      `screenshot would miss ${overflow.scrollHeight - overflow.clientHeight}px. Raise this test's ` +
      `viewport height to at least ${overflow.scrollHeight - overflow.clientHeight + 900}.`,
  ).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

// ─── Deterministic seed ─────────────────────────────────────────────────────────────────

const CUSTOMER = {
  first_name: 'Dana',
  last_name: 'Whitfield',
  company_name: 'Whitfield Property Group',
  email: 'dana.whitfield@e2e-qa.invalid',
  phone: '6175550142',
};

const LOCATION = {
  address_line1: '77 Beacon Street',
  city: 'Boston',
  state: 'MA',
  zip: '02108',
  is_primary: true,
};

const LINE_ITEMS = [
  { description: 'Condenser unit replacement - 3 ton', quantity: 1, unit_price: 2450, is_taxable: true },
  { description: 'Refrigerant recharge (R-410A), per lb', quantity: 4, unit_price: 65, is_taxable: true },
  { description: 'Labor - certified HVAC technician', quantity: 6, unit_price: 145, is_taxable: true },
];

const PARTIAL_PAYMENT = 1500;

let api: ApiClient;
let invoiceId: string;
let invoiceNumber: string;

/**
 * Fail the seed loudly at the step that broke. Without this a 4xx anywhere in the chain
 * surfaces later as a page that renders the wrong thing, and the baseline silently records
 * it. `res` is the Playwright APIResponse the ApiClient hands back.
 */
function assertOk(step: string, res: { ok(): boolean; status(): number }, body: unknown) {
  if (!res.ok()) {
    throw new Error(`visual-regression seed step "${step}" failed: ${res.status()} ${JSON.stringify(body)}`);
  }
}

test.describe('Phase 7 tracer bullet - visual regression', () => {
  test.beforeAll(async () => {
    api = await new ApiClient().init();

    // Playwright discards the worker process after a failed test and starts a fresh one,
    // which re-runs this hook. Seeding a second time hits the in-org duplicate-customer
    // guard and 409s, so the FIRST test's real screenshot failure would be reported as a
    // seed error on every later test. Reuse whatever this org already has instead: the org
    // is thrown away per run, so the only invoice in it is this fixture.
    const existing = await api.listInvoices();
    const already = existing.body?.invoices?.[0];
    if (already) {
      invoiceId = already.id;
      invoiceNumber = already.invoice_number;
      return;
    }

    const customer = await api.createCustomer(CUSTOMER);
    const location = await api.addLocation(customer.id, LOCATION);

    const lead = await api.createLead({
      customer_id: customer.id,
      service_request: 'Rooftop condenser failed - no cooling on the second floor.',
      service_location_id: location.id,
    });
    assertOk('createLead', lead.res, lead.body);
    const leadId = lead.body.lead.id;

    const contacted = await api.contactLead(leadId);
    assertOk('contactLead', contacted.res, contacted.body);

    const estimate = await api.createEstimate({
      lead_id: leadId,
      line_items: LINE_ITEMS,
      tax_rate: 0.0625,
      scope_notes:
        'Remove and dispose of the failed rooftop condenser, set the replacement on the existing ' +
        'curb, braze new line set connections, pressure test and recharge.',
    });
    assertOk('createEstimate', estimate.res, estimate.body);
    const estimateId = estimate.body.estimate.id;

    const sent = await api.sendEstimate(estimateId, { deposit_required: false });
    assertOk('sendEstimate', sent.res, sent.body);

    const approved = await api.approveEstimatePublic(estimateId, sent.body.estimate.public_token, {
      signature_data: api.testSignature,
    });
    assertOk('approveEstimatePublic', approved.res, approved.body);

    const job = await api.createJob({ estimate_id: estimateId });
    assertOk('createJob', job.res, job.body);
    const jobId = job.body.job.id;

    // A fixed-identity technician: `createTech` in workflow-builders puts a random suffix in
    // the surname, which surfaces wherever an assignee is rendered.
    const tech = await api.createUser({
      email: 'marcus.reyes@e2e-qa.invalid',
      password: 'Test123!@#',
      first_name: 'Marcus',
      last_name: 'Reyes',
      role: 'TECHNICIAN',
    });
    assertOk('createUser (technician)', tech.res, tech.body);

    const assigned = await api.assignJob(jobId, {
      assignee_ids: [tech.body.user.id],
      scheduled_start: '2026-01-07T14:00:00.000Z',
      scheduled_end: '2026-01-07T17:00:00.000Z',
    });
    assertOk('assignJob', assigned.res, assigned.body);

    const started = await api.startJob(jobId);
    assertOk('startJob', started.res, started.body);

    const completed = await api.completeJob(
      jobId,
      'Replaced the rooftop condenser with an equivalent 3 ton unit. Recovered the old charge, ' +
        'pressure tested the new line set at 400 psi, and recharged to 4 lb 6 oz per the plate. ' +
        'Verified an 18 degree supply/return split before leaving site.',
    );
    assertOk('completeJob', completed.res, completed.body);

    const invoice = await api.createInvoice(jobId);
    assertOk('createInvoice', invoice.res, invoice.body);
    invoiceId = invoice.body.invoice.id;
    invoiceNumber = invoice.body.invoice.invoice_number;

    const invoiceSent = await api.sendInvoice(invoiceId);
    assertOk('sendInvoice', invoiceSent.res, invoiceSent.body);

    // A partial payment gives the detail page a populated ledger and a non-zero balance,
    // and the list page a PARTIAL row - all still fully deterministic.
    const payment = await api.recordPayment(invoiceId, {
      amount: PARTIAL_PAYMENT,
      method: 'CHECK',
      notes: 'Check 4471, deposited same day.',
    });
    assertOk('recordPayment', payment.res, payment.body);
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test.beforeEach(async ({ page, baseURL }) => {
    await pinRenderingEnvironment(page, baseURL!);
  });

  test.afterEach(async ({ page }) => {
    // Routes can still be mid-flight when the page closes; without this a late callback
    // rejects and fails a test whose assertions all passed.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test.describe('list', () => {
    // Tall enough to contain the whole list page inside <main> - see
    // assertNothingBelowTheFold. Width stays at the config's 1440.
    test.use({ viewport: { width: 1440, height: 1600 } });

    test('invoices list page', async ({ page }) => {
      await page.goto('/invoices');
      await expect(page.getByText(invoiceNumber, { exact: true }).first()).toBeVisible();
      await settle(page);
      await assertNothingBelowTheFold(page);

      await expect(page).toHaveScreenshot('invoices-list.png', { fullPage: true });
    });
  });

  test.describe('detail', () => {
    // The detail page's default (Line Items) tab stacks Receipt, Payments, Scope of Work,
    // the line-item editor, Internal Costs and Attachments, so it needs a much taller
    // viewport than the list.
    test.use({ viewport: { width: 1440, height: 4000 } });

    test('invoice detail page', async ({ page }) => {
      await page.goto(`/invoices/${invoiceId}`);
      await expect(page.getByTestId('invoice-detail')).toBeVisible();
      await expect(page.getByTestId('invoice-amount-due')).toBeVisible();
      await settle(page);
      await assertNothingBelowTheFold(page);

      await expect(page).toHaveScreenshot('invoice-detail.png', { fullPage: true });
    });
  });
});
