import { test, expect, assertGatesClean, assertNoErrorBoundary } from '../../fixtures/gated-test';
import type { Page } from '@playwright/test';
import { screenshotAndAssert } from '../../helpers/screenshot';
import { ApiClient } from '../../helpers/api-client';
import { maEstimateSentWithDeposit } from '../../helpers/workflow-builders';

/**
 * SEL-36 — Public estimate page with a REQUIRED deposit (catalog P0 — the highest-value
 * UI row in the whole effort). WRITTEN 2026-06-10, NOT YET EXECUTED — predicted-fail
 * items marked below.
 *
 * ████████████████████████████████████████████████████████████████████████████████████
 * ██  RED BY DESIGN — DO NOT flagKnownBug / DO NOT GREEN-FLIP THIS FILE.            ██
 * ██                                                                                ██
 * ██  Map §6.3 predicts this page is BROKEN at baseline, and static analysis        ██
 * ██  confirms the chain:                                                           ██
 * ██   · estimatePublicSelect (backend/src/controllers/estimate.controller.ts       ██
 * ██     :151-210) returns send_config + invoices[] (kind=DEPOSIT) and has NO       ██
 * ██     `deposit` key — the legacy Deposit model is gone (entity-redesign §6).     ██
 * ██   · PublicEstimatePage.tsx:266 computes                                        ██
 * ██       depositRequired = !!(send_config?.deposit_required && estimate.deposit)  ██
 * ██     so depositRequired is ALWAYS false → the "Deposit required" info card      ██
 * ██     (:630) never renders, needsPayment (:270) never flips, the payment-method  ██
 * ██     picker (:741) never renders, and the customer is offered the no-deposit    ██
 * ██     "Approve Estimate" button which POSTs payment_method:null → the server     ██
 * ██     400s 'Payment method is required' (estimate.controller.ts:1817).           ██
 * ██     = the GOLDEN PATH breaks at step 9 in the UI (API path unaffected).        ██
 * ██                                                                                ██
 * ██  This spec asserts the CORRECT behavior. If the page is broken, SEL-36a and    ██
 * ██  SEL-36b go RED at baseline and BLOCK shipping — that is the intended gate     ██
 * ██  semantics for a golden-path breaker. A failure here CONFIRMS the bug:         ██
 * ██  file a CRITICAL GitHub issue (/to-issues) and fix the page (read the deposit  ██
 * ██  amount from estimate.invoices[0] kind=DEPOSIT / send_config.deposit_amount);  ██
 * ██  do NOT soften these assertions to pin the broken state.                       ██
 * ██  SEL-36c is the negative control — it passes in BOTH worlds.                   ██
 * ████████████████████████████████████████████████████████████████████████████████████
 *
 * Mirrors specs/redesign/02-public.spec.ts: the public page (/p/estimates/:id?token=)
 * sits OUTSIDE ProtectedRoute and is reached by a LOGGED-OUT visitor, so every test
 * drives a FRESH browser context with no storageState (admin auth deliberately absent)
 * and hand-wires the same gate listeners the gatedPage fixture installs. Seeding goes
 * through the provisioned-admin ApiClient in beforeAll.
 *
 * Page-shape notes driving the locators (all read from PublicEstimatePage.tsx):
 *  - Renders into `<div className="fixed inset-0">`, NOT <main> → noBlankScreen:false.
 *  - Deposit info card (:630): "Deposit required:" + formatCurrency(amount).
 *  - Method picker (renderPaymentMethodButtons :353): h3 "Select Payment Method";
 *    collapseCardMethods(['CARD','CHECK']) → one "Pay with Credit/Debit Card" button
 *    (METHOD_LABELS.CARD = 'Credit/Debit Card'; isCard → 'with') + one "Pay by Check"
 *    button. Picker renders ONLY after the signature is drawn (needsPayment :270).
 *  - Non-CARD selection (:335-349) expands inline instructions + a "Confirm & Approve"
 *    button → POST approve {payment_method:'CHECK'} → Branch 3 (controller :1959) sets
 *    estimate.status = PENDING → the page re-renders the "Deposit Pending" banner (:542).
 *  - Signature pad = react-signature-canvas <canvas> (:691); its ResizeObserver (:216)
 *    re-syncs the pixel buffer shortly after mount and RESETS sigDrawn — settle first.
 *  - The provisioned e2e org has estimate_terms ('E2E terms', lib/e2e-org.ts:63) → the
 *    T&C card + "I agree to the terms and conditions" checkbox render. Today the T&C
 *    checkbox only gates the no-deposit Approve button (approveDisabled :271), not the
 *    method picker — we tick it anyway so the journey stays valid if that gap (#21) is
 *    ever closed.
 */

let api: ApiClient;

// SEL-36a + SEL-36c share a READ-ONLY seeded estimate (viewing + signing never mutates
// the server — the signature only posts on approve). SEL-36b APPROVES (→ PENDING), so
// it gets its OWN estimate; tests stay order-independent.
let viewEstimateId: string;
let viewEstimateNumber: string;
let viewToken: string;
let viewDepositAmountText: string; // formatCurrency-style, e.g. "$3,187.50"

let approveEstimateId: string;
let approveEstimateNumber: string;
let approveToken: string;

/** "$3,187.50" — matches frontend formatCurrency (Intl en-US USD). */
function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

test.beforeAll(async () => {
  api = await new ApiClient().init();

  // $10,000 taxable line @ MA 6.25% → total $10,625; org deposit_percentage pinned to
  // 30% by the builder → kind=DEPOSIT invoice total $3,187.50. Methods CARD+CHECK so
  // the picker must offer exactly one card option and one check option.
  const view = await maEstimateSentWithDeposit(api, 10_000, 30, ['CARD', 'CHECK']);
  viewEstimateId = view.estimateId;
  viewEstimateNumber = view.estimate.estimate_number;
  viewToken = view.publicToken;
  // Read the REAL deposit amount off the kind=DEPOSIT invoice (estimate.invoices[0]) —
  // the page (fixed) must derive its figure from this document / send_config.
  const viewDep = await api.getDepositInvoice(viewEstimateId);
  if (!viewDep) throw new Error('seed: deposit-required send did not spawn a kind=DEPOSIT invoice');
  viewDepositAmountText = money(Number(viewDep.total_amount));

  const appr = await maEstimateSentWithDeposit(api, 10_000, 30, ['CARD', 'CHECK']);
  approveEstimateId = appr.estimateId;
  approveEstimateNumber = appr.estimate.estimate_number;
  approveToken = appr.publicToken;
});

test.afterAll(async () => {
  await api.dispose();
});

/**
 * Wire the same gate listeners the `gatedPage` fixture installs (pageerror /
 * console.error / unexpected /api 5xx) onto an arbitrary logged-out page, so
 * `assertGatesClean(gate, ...)` remains meaningful for these fresh contexts.
 * (Copied from specs/redesign/02-public.spec.ts.)
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

/**
 * Draw a zig-zag stroke on the react-signature-canvas <canvas> with real mouse events
 * (signature_pad binds pointer events; Playwright's mouse API emits them; onEnd fires
 * on pointer-up → the page sets sigDrawn=true).
 *
 * The page's ResizeObserver (PublicEstimatePage.tsx:216-235) re-syncs the canvas pixel
 * buffer shortly after mount and calls setSigDrawn(false) — changing the canvas
 * width/height attributes also wipes the bitmap. Settle BEFORE drawing or the stroke
 * (and sigDrawn) is silently lost.
 */
async function drawSignature(page: Page) {
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => { /* polling — proceed */ });
  await page.waitForTimeout(600); // let the ResizeObserver canvas re-size settle
  const box = await canvas.boundingBox();
  if (!box) throw new Error('signature canvas is not laid out (no bounding box)');
  const midY = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.2, midY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, midY - 20, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.6, midY + 18, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.8, midY - 10, { steps: 6 });
  await page.mouse.up();
}

test.describe('SEL-36 — Public estimate page with required deposit (P0, predicted-fail)', () => {
  test('SEL-36a: deposit info visible; after signing, the method picker offers Card + Check [PREDICTED FAIL — map §6.3]', async ({ browser, gate }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    wireGate(page, gate);

    try {
      await page.goto(`/p/estimates/${viewEstimateId}?token=${viewToken}`);

      // The page itself loads in BOTH worlds — the estimate number renders via
      // EstimateDocumentView (cold public fetch on staging can exceed 3s).
      await expect(page.getByText(viewEstimateNumber, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
      await screenshotAndAssert(page, 'SEL-36a-public-deposit-load.png', {
        noBlankScreen: false, // public page renders into fixed inset-0, not <main>
        expectVisible: [viewEstimateNumber],
      });

      // Sanity (true in both worlds): the picker must NOT render before the signature.
      await expect(page.getByText('Select Payment Method')).toHaveCount(0);

      // ── CORRECT BEHAVIOR #1 (map §6.3 predicts FAIL at baseline) ──
      // The deposit info card renders pre-signature, with the amount derived from the
      // kind=DEPOSIT invoice / send_config — NOT from the legacy estimate.deposit.
      await expect(page.getByText(/deposit required/i).first()).toBeVisible();
      await expect(page.getByText(viewDepositAmountText).first()).toBeVisible();

      // ── CORRECT BEHAVIOR #2 (map §6.3 predicts FAIL at baseline) ──
      // After the customer signs, needsPayment flips and the method picker renders:
      // collapseCardMethods(['CARD','CHECK']) → one Credit/Debit Card button + Check.
      await drawSignature(page);
      await expect(page.getByText('Select Payment Method')).toBeVisible();
      await expect(page.getByRole('button', { name: /pay with credit\/debit card/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /pay by check/i })).toBeVisible();

      await screenshotAndAssert(page, 'SEL-36a-method-picker.png', {
        noBlankScreen: false,
        expectVisible: ['Select Payment Method'],
      });
      await assertNoErrorBoundary(page);
      await assertGatesClean(gate, 'SEL-36a');
    } finally {
      await context.close();
    }
  });

  test('SEL-36b: sign → pick CHECK → approve → PENDING banner in UI + estimate PENDING via API [PREDICTED FAIL — map §6.3]', async ({ browser, gate }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    wireGate(page, gate);

    try {
      await page.goto(`/p/estimates/${approveEstimateId}?token=${approveToken}`);
      await expect(page.getByText(approveEstimateNumber, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

      // The provisioned org has estimate_terms → the T&C checkbox renders. Today it only
      // gates the no-deposit Approve button (PublicEstimatePage.tsx:271) — tick it anyway
      // so the ceremony stays valid if the deposit path ever gains T&C gating (#21).
      const terms = page.getByRole('checkbox', { name: /i agree to the terms/i });
      if (await terms.isVisible().catch(() => false)) {
        await terms.check();
      }

      await drawSignature(page);

      // ← The assertion map §6.3 predicts fails at baseline: the picker never renders
      //   because depositRequired keys on the absent legacy estimate.deposit.
      await expect(page.getByRole('button', { name: /pay by check/i })).toBeVisible();
      await page.getByRole('button', { name: /pay by check/i }).click();

      // Non-CARD selection expands the inline instructions view with the explicit
      // confirmation control (PublicEstimatePage.tsx:384-393).
      const confirmBtn = page.getByRole('button', { name: /confirm & approve/i });
      await expect(confirmBtn).toBeVisible();
      await confirmBtn.click();

      // Branch 3 (deposit + non-Stripe method): server sets estimate → PENDING and the
      // page re-renders the pending banner (heading text at PublicEstimatePage.tsx:542).
      await expect(page.getByText('Deposit Pending')).toBeVisible({ timeout: 15_000 });

      // Server-state proof via the authed ApiClient: status is PENDING (not WON —
      // approval lands when the back office records the check payment).
      const est = await api.getEstimate(approveEstimateId);
      expect(est.status, 'estimate status after CHECK approval ceremony').toBe('PENDING');

      await screenshotAndAssert(page, 'SEL-36b-check-pending.png', {
        noBlankScreen: false,
        expectVisible: ['Deposit Pending'],
      });
      await assertNoErrorBoundary(page);
      await assertGatesClean(gate, 'SEL-36b');
    } finally {
      await context.close();
    }
  });

  // Negative control — mirrors PUB-03 but on a DEPOSIT-required estimate. Passes in BOTH
  // worlds (pre-signature, approveDisabled = !sigDrawn → the rendered Approve control is
  // disabled), so a red SEL-36a/b + green SEL-36c isolates the failure to the deposit
  // surface specifically, not page load/auth/token plumbing.
  test('SEL-36c: approve control disabled before signature on a deposit estimate (negative control)', async ({ browser, gate }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    wireGate(page, gate);

    try {
      await page.goto(`/p/estimates/${viewEstimateId}?token=${viewToken}`);
      await expect(page.getByText(viewEstimateNumber, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

      // Pre-signature the "Approve Estimate" button renders (needsPayment is false until
      // signed — true in both worlds) and MUST be disabled.
      const approveBtn = page.getByRole('button', { name: /approve estimate/i });
      await expect(approveBtn).toBeVisible();
      await expect(approveBtn).toBeDisabled();

      // Sign-gate hint: "Please sign above to approve" (broken world) and/or
      // "Please sign above to proceed to payment" (correct world) — both match.
      await expect(page.getByText(/please sign above/i).first()).toBeVisible();

      await assertNoErrorBoundary(page);
      await assertGatesClean(gate, 'SEL-36c');
      await screenshotAndAssert(page, 'SEL-36c-approve-disabled.png', {
        noBlankScreen: false,
        expectVisible: [viewEstimateNumber],
      });
    } finally {
      await context.close();
    }
  });
});
