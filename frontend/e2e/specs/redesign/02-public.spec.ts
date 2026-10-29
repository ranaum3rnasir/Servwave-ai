import { test, expect, assertGatesClean, assertNoErrorBoundary } from '../../fixtures/gated-test';
import type { Page } from '@playwright/test';
import { screenshotAndAssert } from '../../helpers/screenshot';
import { ApiClient } from '../../helpers/api-client';
import {
  maEstimateSentWithDeposit,
  fullStandardFlowToInvoiceSent,
  leadToSentEstimate,
} from '../../helpers/workflow-builders';

/**
 * Stage 12 — Public surfaces (Task D12 · PUB-01..04).
 *
 * The customer-facing public pages (/p/invoices/:id, /p/estimates/:id) sit OUTSIDE
 * ProtectedRoute (App.tsx) and are reached by a LOGGED-OUT visitor with a `?token=`.
 * So every test here drives a FRESH browser context with no storageState (the UI
 * config's admin storageState is deliberately NOT applied), seeded through the
 * provisioned-admin ApiClient in beforeAll.
 *
 * Page-shape notes that drive the assertions:
 *  - Both public pages render into `<div className="fixed inset-0">`, NOT `<main>`.
 *    `screenshotAndAssert`'s default blank-screen probe waits for `<main>`, so these
 *    tests pass `{ noBlankScreen: false }` and instead assert a POSITIVE seeded value
 *    (invoice/estimate number, the rendered amount) is visible.
 *  - Pay / approve controls are CONDITIONALLY rendered. We assert control PRESENCE,
 *    and prefer a NON-CARD method (staging has no live Stripe) — see PUB-04.
 */

let api: ApiClient;

// Seeded fixtures (populated in beforeAll, consumed by the tests).
let depositInvoiceId: string;
let depositInvoiceNumber: string;
let depositInvoiceToken: string;

let stdInvoiceId: string;
let stdInvoiceNumber: string;
let stdInvoiceToken: string;
let stdAmountDue: number;

let estimateId: string;
let estimateNumber: string;
let estimateToken: string;

test.beforeAll(async () => {
  api = await new ApiClient().init();

  // ── PUB-01: a SENT kind=DEPOSIT invoice (estimate.invoices[0]). Do NOT pay it —
  // isPayable requires status SENT/PARTIAL, so it must stay unpaid for the pay control.
  const dep = await maEstimateSentWithDeposit(api, 5000, 30, ['CHECK', 'CASH', 'CARD']);
  const depositInvoice = await api.getDepositInvoice(dep.estimateId);
  depositInvoiceId = depositInvoice.id;
  // estimate.invoices[0] omits BOTH invoice_number AND public_token — read the deposit's full
  // record for them (using the projection's public_token gives token=undefined → "no longer available").
  const depFull = await api.getInvoice(depositInvoice.id);
  depositInvoiceNumber = depFull.invoice_number;
  depositInvoiceToken = depFull.public_token;

  // ── PUB-02: a standard (job-backed) invoice driven to SENT with amount_due>0.
  const std = await fullStandardFlowToInvoiceSent(api);
  stdInvoiceId = std.invoiceId;
  stdInvoiceNumber = std.invoice.invoice_number;
  stdInvoiceToken = std.publicToken;
  stdAmountDue = Number(std.invoice.amount_due);

  // ── PUB-03: a SENT estimate (NO deposit) so the "Approve Estimate" control is the
  // one rendered (deposit-required estimates hide Approve behind the signature→pay
  // branch). Approve is DISABLED until a signature is drawn — we assert PRESENCE only.
  const est = await leadToSentEstimate(api, { deposit: false });
  estimateId = est.estimateId;
  estimateNumber = est.estimate.estimate_number;
  estimateToken = est.publicToken;
});

test.afterAll(async () => {
  await api.dispose();
});

/**
 * Wire the same gate listeners the `gatedPage` fixture installs (pageerror /
 * console.error / unexpected /api 5xx) onto an arbitrary logged-out page, so
 * `assertGatesClean(gate, ...)` remains meaningful for these fresh contexts.
 */
function wireGate(page: Page, gate: { pageErrors: string[]; bad5xx: string[]; allow5xx: RegExp[] }) {
  const CONSOLE_ALLOW = [/Download the React DevTools/i, /\[vite\]/i, /source-?map/i, /HMR/i];
  page.on('pageerror', (err) => gate.pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !CONSOLE_ALLOW.some((re) => re.test(msg.text()))) {
      gate.pageErrors.push(`console.error: ${msg.text()}`);
    }
  });
  page.on('response', (resp) => {
    const u = resp.url();
    if (/\/api\//.test(u) && resp.status() >= 500 && !gate.allow5xx.some((re) => re.test(u))) {
      gate.bad5xx.push(`${resp.status()} ${u}`);
    }
  });
}

test.describe('Stage 12 — Public surfaces', () => {
  test('PUB-01: deposit invoice public page renders logged-out + a non-card pay control is present', async ({ browser, gate }) => {
    // Logged-out: a fresh context with NO storageState (admin auth deliberately absent).
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    wireGate(page, gate);

    try {
      await page.goto(`/p/invoices/${depositInvoiceId}?token=${depositInvoiceToken}`);

      // The public page fetches the invoice async; give the number a generous wait before the
      // screenshot helper's shorter visibility check (cold public fetch on staging can exceed 3s).
      await expect(page.getByText(depositInvoiceNumber, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

      // The page renders (public, no login): the INVOICE document + the deposit's number.
      await screenshotAndAssert(page, 'pub-01-deposit-public.png', {
        noBlankScreen: false,
        expectVisible: ['INVOICE', depositInvoiceNumber],
      });

      // SENT + amount_due>0 + methods present → the Payment Options block renders.
      // Assert a NON-CARD pay button is present (CHECK/CASH render without live Stripe).
      await expect(page.getByText('Payment Options')).toBeVisible();
      const nonCardPay = page.getByRole('button', { name: /pay by (check|cash)/i }).first();
      await expect(nonCardPay).toBeVisible();

      await assertNoErrorBoundary(page);
      await assertGatesClean(gate, 'PUB-01');
    } finally {
      await context.close();
    }
  });

  test('PUB-02: standard invoice public page renders logged-out + amount shown', async ({ browser, gate }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    wireGate(page, gate);

    try {
      await page.goto(`/p/invoices/${stdInvoiceId}?token=${stdInvoiceToken}`);

      // formatCurrency renders the amount_due (e.g. "$5,418.75") in the Amount Due row.
      const amountText = `$${stdAmountDue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      await screenshotAndAssert(page, 'pub-02-standard-public.png', {
        noBlankScreen: false,
        expectVisible: ['INVOICE', stdInvoiceNumber, amountText],
      });

      // The amount-due figure is shown explicitly in the totals block.
      await expect(page.getByText('Amount Due')).toBeVisible();
      await expect(page.getByText(amountText).first()).toBeVisible();

      // A non-card pay control is present (SENT + amount_due>0 + methods).
      const nonCardPay = page.getByRole('button', { name: /pay by (check|cash)/i }).first();
      await expect(nonCardPay).toBeVisible();

      await assertNoErrorBoundary(page);
      await assertGatesClean(gate, 'PUB-02');
    } finally {
      await context.close();
    }
  });

  test('PUB-03: estimate public page renders logged-out + approve control present (disabled until signature)', async ({ browser, gate }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    wireGate(page, gate);

    try {
      await page.goto(`/p/estimates/${estimateId}?token=${estimateToken}`);

      await screenshotAndAssert(page, 'pub-03-estimate-public.png', {
        noBlankScreen: false,
        expectVisible: [estimateNumber],
      });

      // isActionable (SENT && !expired) renders the Approve control. It is PRESENT in
      // the DOM but DISABLED until a signature is drawn — assert presence + disabled,
      // not clickability (the full approve journey needs the signature pad, see PUB-04).
      const approveBtn = page.getByRole('button', { name: /approve estimate/i });
      await expect(approveBtn).toBeVisible();
      await expect(approveBtn).toBeDisabled();

      // Sign-prompt hint confirms the approve flow is gated on signature.
      await expect(page.getByText(/please sign above to approve/i)).toBeVisible();

      await assertNoErrorBoundary(page);
      await assertGatesClean(gate, 'PUB-03');
    } finally {
      await context.close();
    }
  });

  // PUB-04 — live Stripe Checkout redirect / card entry. MANUAL-ONLY.
  //
  // The "Pay by Card" control (PublicInvoicePage → handleCheckout →
  // POST /api/invoices/:id/public/checkout) creates a REAL Stripe Checkout session and
  // redirects to Stripe-hosted card capture. Staging has Stripe disabled (no live key),
  // so this cannot be automated and is not safe to drive against a real card.
  //
  // ✋ MANUAL SIGN-OFF (qa-matrix.md): in a Stripe-connected env, open a SENT invoice with
  // the CARD method enabled, click "Pay … by Card", confirm the redirect to a live Stripe
  // Checkout session, complete card entry, and verify the invoice flips PAID via webhook.
  test.skip('PUB-04: live Stripe Checkout redirect / card entry [MANUAL-ONLY — Stripe off on staging]', async () => {
    // Intentionally skipped. See the comment above and the ✋ row in qa-matrix.md.
  });
});
