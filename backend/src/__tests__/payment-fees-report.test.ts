/**
 * payment-fees-report.test.ts — Task 4.1 pure service (activity-report /
 * inventory-usage-report doctrine: no Prisma/Express, fixture-testable).
 *
 * buildPaymentFeesReport takes two independent row populations (doctrine:
 * services/payment-fees-report.ts's HONEST NUMBERS header):
 *   - costRows - succeeded CARD payments with reconciled fee data (method
 *     CARD, voided_at/refunded_at null, all three cost columns NOT NULL).
 *     Feeds gross/stripeFees/platformFees/net/reconciledCount.
 *   - extraRows - any CARD payment carrying a service fee and/or a tip,
 *     regardless of cost-side reconciliation state. Feeds
 *     serviceFees/serviceFeeCount/tips/tipCount, prorated by the refunded
 *     share (D-A1) rather than dropped on any refund.
 *
 * Both populations are re-clipped by date defensively, same as
 * buildInventoryUsageReport. The controller's Prisma `where` is what
 * actually restricts each population's shape (see
 * payment-fees-report.controller.test.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  buildPaymentFeesReport,
  type PaymentFeeRow,
  type PaymentExtraRow,
} from '../services/payment-fees-report';

const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2026-12-31T23:59:59Z');
const RANGE = { from: FROM, to: TO };

function costRow(over: Partial<PaymentFeeRow> = {}): PaymentFeeRow {
  return {
    amount: 100,
    stripeFeeAmount: 3.2,
    platformFeeAmount: 0.5,
    netAmount: 96.3,
    // Pre-feature / non-fee payments carry neither; `charged` then equals `gross`.
    serviceFeeAmount: null,
    tipAmount: null,
    paidAt: new Date('2026-06-15T12:00:00Z'),
    ...over,
  };
}

/** Same 2-dp guard the service uses, for asserting the charged-basis identity. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

function extraRow(over: Partial<PaymentExtraRow> = {}): PaymentExtraRow {
  return {
    amount: 100,
    refundedAmount: null,
    // Most payments carry neither (pre-feature, or a disabled org).
    serviceFeeAmount: null,
    tipAmount: null,
    paidAt: new Date('2026-06-15T12:00:00Z'),
    ...over,
  };
}

describe('buildPaymentFeesReport', () => {
  it('sums Gross/Stripe fee/Platform fee/Net across multiple cost-reconciled payments', () => {
    const report = buildPaymentFeesReport(
      [
        costRow(),
        costRow({ amount: 500, stripeFeeAmount: 14.8, platformFeeAmount: 2.5, netAmount: 482.7 }),
      ],
      [],
      RANGE,
    );
    expect(report.gross).toBe(600);
    expect(report.stripeFees).toBe(18);
    expect(report.platformFees).toBe(3);
    expect(report.net).toBe(579);
    expect(report.reconciledCount).toBe(2);
  });

  it('guards against floating-point drift when summing (rounds to the cent)', () => {
    // 0.1 + 0.2 famously does not equal 0.3 in raw JS float math.
    const report = buildPaymentFeesReport(
      [
        costRow({ amount: 10, stripeFeeAmount: 0.1, platformFeeAmount: 0, netAmount: 9.9 }),
        costRow({ amount: 10, stripeFeeAmount: 0.2, platformFeeAmount: 0, netAmount: 9.8 }),
      ],
      [],
      RANGE,
    );
    expect(report.stripeFees).toBe(0.3);
  });

  it('returns honest zeros (not fabricated numbers) for an empty input', () => {
    const report = buildPaymentFeesReport([], [], RANGE);
    expect(report).toMatchObject({
      gross: 0,
      charged: 0,
      stripeFees: 0,
      platformFees: 0,
      net: 0,
      reconciledCount: 0,
      serviceFees: 0,
      serviceFeeCount: 0,
      tips: 0,
      tipCount: 0,
    });
    expect(report.from).toBe(FROM.toISOString());
    expect(report.to).toBe(TO.toISOString());
  });

  it('re-clips defensively: a cost row outside [from, to] is excluded even if the caller forgot to filter', () => {
    const report = buildPaymentFeesReport(
      [
        costRow({ paidAt: new Date('2025-12-31T23:59:59Z') }), // just before the window
        costRow({ paidAt: new Date('2026-06-15T12:00:00Z') }), // inside
        costRow({ paidAt: new Date('2027-01-01T00:00:00Z') }), // just after the window
      ],
      [],
      RANGE,
    );
    expect(report.reconciledCount).toBe(1);
    expect(report.gross).toBe(100);
  });

  it('echoes the requested range back as ISO strings', () => {
    const report = buildPaymentFeesReport([], [], { from: FROM, to: TO });
    expect(report.from).toBe('2026-01-01T00:00:00.000Z');
    expect(report.to).toBe('2026-12-31T23:59:59.000Z');
  });

  // ─── The charged basis - what net_amount is actually measured against (2026-08-04) ───
  //
  // Before this, `gross` (Σ face) and `net` (Σ net_amount) were computed on
  // DIFFERENT bases and nothing in the payload reconciled them: net_amount
  // comes from reconcile-stripe-fees.ts, which derives it from Stripe's
  // `charge.amount` - the FULL amount charged to the card, face + service fee
  // + tip - while `gross` sums Payment.amount, the face value only (the fee
  // and the tip deliberately never enter invoice totals or Payment.amount,
  // per D1/D10). `charged` supplies the missing middle term so the identity
  // holds. `gross` stays on the face basis: it is the revenue figure and must
  // keep tying to revenue reporting elsewhere.
  describe('charged basis (net is measured against the total charged, not the face amount)', () => {
    it('reproduces the live staging incoherence and closes it: charged - stripeFees - platformFees === net', () => {
      // Live evidence (staging 2026-08-04, org 00000000-…-0001, payment
      // 8b17c520-58f8-4323-bcc1-2976e0ada747): face 533.13 + service fee 18.66
      // + tip 80.00 = 631.79 actually hit the card, and Stripe's fees came off
      // that. The reported symptom was net (608.45) EXCEEDING gross (533.13)
      // with no figure in the payload explaining the $98.66 gap.
      const report = buildPaymentFeesReport(
        [
          costRow({
            amount: 533.13,
            serviceFeeAmount: 18.66,
            tipAmount: 80,
            stripeFeeAmount: 20.98,
            platformFeeAmount: 2.36,
            netAmount: 608.45,
          }),
        ],
        [],
        RANGE,
      );
      expect(report.gross).toBe(533.13); // face only - D1/D10 survive untouched
      expect(report.charged).toBe(631.79); // face + fee + tip: what the card paid
      expect(round2(report.charged - report.stripeFees - report.platformFees)).toBe(report.net);
      // net > gross is still true, and is now a documented consequence of the
      // customer funding the fee stack rather than an unexplained impossibility.
      expect(report.net).toBeGreaterThan(report.gross);
    });

    it('charged equals gross when no payment carries a fee or a tip (pre-feature data is unchanged)', () => {
      const report = buildPaymentFeesReport([costRow(), costRow({ amount: 500 })], [], RANGE);
      expect(report.gross).toBe(600);
      expect(report.charged).toBe(600);
    });

    it('adds a fee-only and a tip-only row independently', () => {
      const report = buildPaymentFeesReport(
        [costRow({ amount: 100, serviceFeeAmount: 3.5 }), costRow({ amount: 200, tipAmount: 40 })],
        [],
        RANGE,
      );
      expect(report.gross).toBe(300);
      expect(report.charged).toBe(343.5);
    });

    it('guards against floating-point drift when summing the charged basis', () => {
      const report = buildPaymentFeesReport(
        [
          costRow({ amount: 0, serviceFeeAmount: 0.1, tipAmount: 0 }),
          costRow({ amount: 0, serviceFeeAmount: 0.2, tipAmount: 0 }),
        ],
        [],
        RANGE,
      );
      expect(report.charged).toBe(0.3);
    });

    it('excludes a cost row outside [from, to] from charged, same as gross', () => {
      const report = buildPaymentFeesReport(
        [
          costRow({ amount: 100, serviceFeeAmount: 3.5, paidAt: new Date('2025-12-31T23:59:59Z') }),
          costRow({ amount: 100, serviceFeeAmount: 3.5 }),
        ],
        [],
        RANGE,
      );
      expect(report.gross).toBe(100);
      expect(report.charged).toBe(103.5);
    });

    // charged comes from the COST population's own fee/tip columns, never from
    // extraRows. The two populations are deliberately different (extras is not
    // gated on reconciliation and prorates refunds), so `charged - gross` and
    // `serviceFees + tips` are NOT the same number and must not be swapped.
    it('is fed by the cost rows own fee/tip columns, not by the extras population', () => {
      const report = buildPaymentFeesReport(
        [costRow({ amount: 100 })], // reconciled, no fee
        [extraRow({ amount: 900, serviceFeeAmount: 31.5 })], // unreconciled, fee-bearing
        RANGE,
      );
      expect(report.serviceFees).toBe(31.5); // the extras population sees it
      expect(report.charged).toBe(100); // the charged basis does not
    });

    it('is 0 on empty input', () => {
      expect(buildPaymentFeesReport([], [], RANGE).charged).toBe(0);
    });
  });

  // ─── Service fee - decoupled from cost-side reconciliation (Plan A, 2026-08-04) ───
  describe('service fee column (independent of cost-side reconciliation)', () => {
    it('a service fee is summed from a row with no reconciled cost data at all - the reported bug', () => {
      // Live evidence (staging, 2026-08-04): payment 8b17c520-... had
      // service_fee_amount = 18.66 with all three cost columns NULL. This row
      // must contribute to serviceFees/serviceFeeCount and NOTHING to gross/net.
      const report = buildPaymentFeesReport(
        [], // no reconciled cost rows at all
        [extraRow({ amount: 1000, serviceFeeAmount: 18.66 })],
        RANGE,
      );
      expect(report.serviceFees).toBe(18.66);
      expect(report.serviceFeeCount).toBe(1);
      expect(report.gross).toBe(0);
      expect(report.net).toBe(0);
      expect(report.reconciledCount).toBe(0);
    });

    it('is zero for payments with no service fee (pre-feature or a disabled org)', () => {
      const report = buildPaymentFeesReport([], [extraRow(), extraRow()], RANGE);
      expect(report.serviceFees).toBe(0);
      expect(report.serviceFeeCount).toBe(0);
    });

    it('guards against floating-point drift when summing the fee column', () => {
      const report = buildPaymentFeesReport(
        [],
        [extraRow({ serviceFeeAmount: 0.1 }), extraRow({ serviceFeeAmount: 0.2 })],
        RANGE,
      );
      expect(report.serviceFees).toBe(0.3);
    });
  });

  // ─── Proration on partial refund (D-A1) ───
  describe('proration on partial refund', () => {
    it('prorates the service fee by the refunded share: $1,000 face / $35 fee / $100 refunded -> $31.50', () => {
      const report = buildPaymentFeesReport(
        [],
        [extraRow({ amount: 1000, serviceFeeAmount: 35, refundedAmount: 100 })],
        RANGE,
      );
      expect(report.serviceFees).toBe(31.5);
    });

    it('a fully-refunded payment falls out to 0 with no special case', () => {
      const report = buildPaymentFeesReport(
        [],
        [extraRow({ amount: 1000, serviceFeeAmount: 35, refundedAmount: 1000 })],
        RANGE,
      );
      expect(report.serviceFees).toBe(0);
    });

    it('a zero-face payment prorates to 0, not NaN', () => {
      const report = buildPaymentFeesReport(
        [],
        [extraRow({ amount: 0, serviceFeeAmount: 5, refundedAmount: 0 })],
        RANGE,
      );
      expect(report.serviceFees).toBe(0);
      expect(Number.isNaN(report.serviceFees)).toBe(false);
    });
  });

  // ─── Tips (D-A4) ───
  describe('tips', () => {
    it('a tip-bearing row contributes to tips and tipCount', () => {
      const report = buildPaymentFeesReport([], [extraRow({ amount: 500, tipAmount: 80 })], RANGE);
      expect(report.tips).toBe(80);
      expect(report.tipCount).toBe(1);
    });

    it('a fee-only row leaves tipCount at 0, and a tip-only row leaves serviceFeeCount at 0', () => {
      const report = buildPaymentFeesReport(
        [],
        [
          extraRow({ amount: 500, serviceFeeAmount: 17.5 }), // fee only
          extraRow({ amount: 500, tipAmount: 80 }), // tip only
        ],
        RANGE,
      );
      expect(report.serviceFeeCount).toBe(1);
      expect(report.tipCount).toBe(1);
      expect(report.serviceFees).toBe(17.5);
      expect(report.tips).toBe(80);
    });

    it('a tip prorates on partial refund by the same rule as the fee', () => {
      const report = buildPaymentFeesReport(
        [],
        [extraRow({ amount: 1000, tipAmount: 80, refundedAmount: 100 })],
        RANGE,
      );
      expect(report.tips).toBe(72); // 80 * (900 / 1000)
    });
  });
});
