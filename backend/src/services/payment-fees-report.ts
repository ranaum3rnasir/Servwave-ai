// Payment processing fees report (Task 4.1, Phase 4 - follow-on to the Phase 3
// per-payment fee breakdown, spec §7.3) - pure aggregation, no Prisma/Express
// so it unit-tests with fixtures (activity-report / inventory-usage-report
// doctrine).
//
// Sums Payment.amount (Gross) / stripe_fee_amount / platform_fee_amount /
// net_amount over a date window, for the admin-facing "payment processing
// costs at a glance" summary. `net` sums the stored net_amount column
// directly rather than re-deriving it (gross - stripeFees - platformFees) so
// the total matches the same per-payment rounding the reconciliation job
// already committed (reconcile-stripe-fees.ts), not a second independent
// rounding.
//
// TWO BASES, BOTH REPORTED (2026-08-04). `gross` and `net` are not measured
// against the same amount, and that is deliberate rather than a defect to
// collapse:
//   - `gross` is Sigma Payment.amount, the invoice FACE value. The service fee
//     and the tip are the customer's money and never enter Payment.amount or
//     invoice totals (D1/D10 of the card-service-fee plan - load-bearing, and
//     unchanged here), so gross is the revenue figure and ties to revenue
//     reporting elsewhere.
//   - `net` is Sigma Payment.net_amount, which reconcile-stripe-fees.ts derives
//     from Stripe's `charge.amount` - the FULL amount that hit the card, face
//     + service fee + tip - because that is what Stripe's fees were actually
//     taken out of. It is the cash that landed in the org's balance.
// So `net` can legitimately EXCEED `gross`: the customer funded the fee stack
// and the org keeps the tip on top of face value. That was true but
// unexplainable before `charged` existed, because no figure in the payload
// bridged the two bases (live staging 2026-08-04: gross 543.13 / net 617.76).
// `charged` is that bridge - Sigma (face + fee + tip) over the same rows - and it
// satisfies, exactly, `charged - stripeFees - platformFees === net`.
//
// `charged - gross` is NOT interchangeable with `serviceFees + tips` below.
// They are drawn from different populations (see the next paragraph) and the
// extras figures are refund-prorated, so the two differ whenever an
// unreconciled or refunded payment carries a fee. Report each for what it is.
//
// HONEST NUMBERS (authoritative doctrine - Plan A, 2026-08-04): the
// controller's Prisma `where` for the cost query is what actually restricts
// costRows to succeeded CARD payments with reconciled fee data (method CARD,
// voided_at/refunded_at null, all three fee columns NOT NULL) - a CARD
// payment before Task 3.3's post-commit reconciliation lands, or a non-CARD
// payment, has no fee data at all and must never be treated as a $0
// contributor. This pure function trusts that the caller already filtered
// correctly; it only re-clips by date defensively.
//
// The service fee and the tip are a SEPARATE population (extraRows), fed by
// its own query with none of the cost-side gating above. The service fee is
// known at charge time, is the customer's money rather than the org's, and
// is never reconstructed from a Stripe balance transaction - so waiting on
// reconciliation to report it would understate a figure that was never in
// doubt. Same reasoning for the tip (D-A4). Each is prorated by the refunded
// share instead of dropped on any refund, because a refund returns only that
// share to the customer (mirrors proportionalRefundExtras in
// invoice.controller.ts).
//
// Known limitation, documented not fixed: refunded_at/refunded_amount are
// only stamped when a single source payment is identified
// (invoice.controller.ts's `if (sourcePayment)` branch). A refund that
// identifies no source payment leaves the Payment row looking unrefunded, so
// its fee and tip report in full. Predates this change; not fixed here.

/** One cost-reconciled Payment row, normalized from the Prisma row by the controller. */
export interface PaymentFeeRow {
  /** Payment.amount — the invoice FACE amount, not the total charged to the card
   *  (the service fee and tip sit outside it, per D1/D10). */
  amount: number;
  /** Payment.stripe_fee_amount — Stripe's processing cut, taken from the full charge. */
  stripeFeeAmount: number;
  /** Payment.platform_fee_amount — ServWave's platform cut. */
  platformFeeAmount: number;
  /** Payment.net_amount — the cash that landed, measured against the full charge
   *  (face + fee + tip) by reconcile-stripe-fees.ts, NOT against `amount`. */
  netAmount: number;
  /** Payment.service_fee_amount — null for non-fee and pre-feature payments. Needed
   *  here (not only in the extras population) to reconstruct net_amount's own basis. */
  serviceFeeAmount: number | null;
  /** Payment.tip_amount — null when no tip was given. Same reason as above. */
  tipAmount: number | null;
  paidAt: Date;
}

/**
 * One customer-extras Payment row - a CARD payment carrying a service fee
 * and/or a tip, independent of cost-side reconciliation state (D-A2/D-A6).
 */
export interface PaymentExtraRow {
  /** Payment.amount - the original face amount charged, before any refund. */
  amount: number;
  /** Payment.refunded_amount - cumulative amount refunded against this payment, if any. */
  refundedAmount: number | null;
  /** Payment.service_fee_amount - null when this payment carries no card service fee. */
  serviceFeeAmount: number | null;
  /** Payment.tip_amount - null when this payment carries no tip. */
  tipAmount: number | null;
  paidAt: Date;
}

export interface PaymentFeesReport {
  from: string;
  to: string;
  /** Σ Payment.amount - invoice face value collected in the window (cost-reconciled
   *  rows only). The revenue basis: excludes the service fee and the tip (D1/D10). */
  gross: number;
  /** Σ (face + service fee + tip) over the SAME rows as `gross` - the total actually
   *  charged to those cards, and the basis `net` is measured against. Satisfies
   *  `charged - stripeFees - platformFees === net`. Equals `gross` on any window
   *  whose payments carry no fee and no tip. */
  charged: number;
  /** Σ Payment.stripe_fee_amount. */
  stripeFees: number;
  /** Σ Payment.platform_fee_amount. */
  platformFees: number;
  /** Σ Payment.net_amount - cash landed, on the `charged` basis (may exceed `gross`). */
  net: number;
  /** Number of cost-reconciled payments summed into gross/stripeFees/platformFees/net. */
  reconciledCount: number;
  /** Σ Payment.service_fee_amount, prorated by refunded share - collected from the
   *  customer, on top of Gross (D1). Independent of cost-side reconciliation. */
  serviceFees: number;
  /** Number of payments contributing to serviceFees. */
  serviceFeeCount: number;
  /** Σ Payment.tip_amount, prorated by refunded share - collected from the customer,
   *  kept in full by the org (D10). Independent of cost-side reconciliation. */
  tips: number;
  /** Number of payments contributing to tips. */
  tipCount: number;
}

/** Float-drift guard — same 2-dp rounding used throughout the money-math codebase
 *  (reconcile-stripe-fees.ts, invoice-totals.ts, estimate/job controllers). */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The share of `amount` still kept by the org after `refundedAmount` (D-A1).
 * Clamped so a refund can never exceed the face amount it prorates against
 * (defensive - proportionalRefundExtras' contract already guarantees partials
 * sum to exactly 100%, never more).
 */
function keptShare(amount: number, refundedAmount: number | null): number {
  if (!(amount > 0)) return 0; // zero/negative face amount - avoid 0/0
  const kept = amount - Math.min(refundedAmount ?? 0, amount);
  return kept / amount;
}

export function buildPaymentFeesReport(
  costRows: PaymentFeeRow[],
  extraRows: PaymentExtraRow[],
  range: { from: Date; to: Date },
): PaymentFeesReport {
  let gross = 0;
  let charged = 0;
  let stripeFees = 0;
  let platformFees = 0;
  let net = 0;
  let reconciledCount = 0;

  for (const row of costRows) {
    if (row.paidAt < range.from || row.paidAt > range.to) continue; // range clip (defensive)
    gross += row.amount;
    // The fee and the tip are added here and NOWHERE else - `gross` stays the
    // face basis (D1/D10). Unlike the extras population below, these are not
    // refund-prorated: the cost query drops any row with refunded_at set, so a
    // surviving row was charged in full and its stored net_amount reflects that.
    charged += row.amount + (row.serviceFeeAmount ?? 0) + (row.tipAmount ?? 0);
    stripeFees += row.stripeFeeAmount;
    platformFees += row.platformFeeAmount;
    net += row.netAmount;
    reconciledCount += 1;
  }

  let serviceFees = 0;
  let serviceFeeCount = 0;
  let tips = 0;
  let tipCount = 0;

  for (const row of extraRows) {
    if (row.paidAt < range.from || row.paidAt > range.to) continue; // range clip (defensive)
    const share = keptShare(row.amount, row.refundedAmount);
    if (row.serviceFeeAmount != null) {
      serviceFees += row.serviceFeeAmount * share;
      serviceFeeCount += 1;
    }
    if (row.tipAmount != null) {
      tips += row.tipAmount * share;
      tipCount += 1;
    }
  }

  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    gross: round2(gross),
    charged: round2(charged),
    stripeFees: round2(stripeFees),
    platformFees: round2(platformFees),
    net: round2(net),
    reconciledCount,
    serviceFees: round2(serviceFees),
    serviceFeeCount,
    tips: round2(tips),
    tipCount,
  };
}
