import { describe, it, expect } from 'vitest';
import {
  resolveDeposit,
  resolveDepositState,
  amountFromPercent,
  percentFromAmount,
  round2,
  depositInvoiceIsUnpaid,
} from './deposit';

const ORG = {
  deposit_default_type: 'PERCENTAGE' as const,
  deposit_default_percentage: 50,
  deposit_default_fixed_amount: 0,
};

describe('resolveDeposit', () => {
  it('prefers the estimate override over the org default', () => {
    // The regression this file exists for: SendEstimateDialog used to read org defaults only, so
    // this estimate previewed $53.32 (50%) and the send charged $74.64 (70%).
    const d = resolveDeposit(
      { deposit_type: 'PERCENTAGE', deposit_value: 70, total_amount: '106.63' },
      ORG,
    );
    expect(d.type).toBe('PERCENTAGE');
    expect(d.amount).toBe(74.64);
    expect(d.percent).toBe(70);
  });

  it('falls back to the org default when the estimate has no override', () => {
    const d = resolveDeposit({ total_amount: 1000 }, ORG);
    expect(d.amount).toBe(500);
    expect(d.percent).toBe(50);
  });

  it('needs BOTH override fields - a type with no value still falls back to the org default', () => {
    const d = resolveDeposit(
      { deposit_type: 'FIXED', deposit_value: null, total_amount: 1000 },
      ORG,
    );
    // hasOverride is false, so the ORG's type wins too, not the estimate's dangling FIXED.
    expect(d.type).toBe('PERCENTAGE');
    expect(d.amount).toBe(500);
  });

  it('caps a FIXED deposit at the estimate total', () => {
    const d = resolveDeposit(
      { deposit_type: 'FIXED', deposit_value: 900, total_amount: 400 },
      ORG,
    );
    expect(d.amount).toBe(400);
    expect(d.percent).toBe(100);
  });

  it('reports an effective percentage for a FIXED deposit', () => {
    const d = resolveDeposit(
      { deposit_type: 'FIXED', deposit_value: 250, total_amount: 1000 },
      ORG,
    );
    expect(d.type).toBe('FIXED');
    expect(d.amount).toBe(250);
    expect(d.percent).toBe(25);
  });

  it('defaults to 50% when the org row has no deposit columns at all', () => {
    const d = resolveDeposit({ total_amount: 200 }, null);
    expect(d.amount).toBe(100);
  });

  it('honours an org default of 0% rather than treating it as unset', () => {
    // Backend uses `?? 50`, not `|| 50` - a deliberate 0% org default must survive.
    const d = resolveDeposit(
      { total_amount: 1000 },
      { ...ORG, deposit_default_percentage: 0 },
    );
    expect(d.amount).toBe(0);
  });

  it('never produces NaN on a zero or missing total', () => {
    expect(resolveDeposit({ total_amount: 0 }, ORG)).toEqual({ type: 'PERCENTAGE', amount: 0, percent: 0 });
    expect(resolveDeposit({ total_amount: null }, ORG).amount).toBe(0);
    expect(resolveDeposit({ total_amount: 'not a number' }, ORG).amount).toBe(0);
  });

  it('derives percent from the ROUNDED amount, exactly as the backend does', () => {
    // 25% of $49.38 is $12.345, which rounds to $12.35 - and the backend's own
    // `resolveDepositAmount` (backend/src/lib/estimates/deposit-amount.ts) reads its percent back
    // off THAT rounded amount, not the raw quotient: (12.35 / 49.38) * 100 = 25.0101...%, not a
    // clean 25. This percent is what #2091's `willReprice` preview now surfaces on screen, so it
    // has to agree with what the backend would actually compute (and what a Decimal(5,2) column
    // stores), not with the tidier number the unrounded quotient happens to produce.
    const d = resolveDeposit({ deposit_type: 'PERCENTAGE', deposit_value: 25, total_amount: 49.38 }, ORG);
    expect(d.amount).toBe(12.35);
    expect(d.percent).toBe(25.01);
  });
});

describe('percent/amount conversion', () => {
  it('rounds the derived amount to cents', () => {
    // 106.63 * 0.7 = 74.64099999999999 in float - the raw value that reached the input and the
    // POST body before this helper existed.
    expect(amountFromPercent(106.63, 70)).toBe(74.64);
  });

  it('keeps the derived percentage legible rather than exact', () => {
    // 40 / 106.63 * 100 = 37.512895... - shown as 37.51, not 37.5129, because this lands in an
    // input the user reads.
    expect(percentFromAmount(106.63, 40)).toBe(37.51);
    expect(percentFromAmount(106.63, 500)).toBe(468.91);
  });

  it('round-trips a typed dollar amount back to itself', () => {
    const pct = percentFromAmount(106.63, 40);
    expect(amountFromPercent(106.63, pct)).toBe(40);
  });

  it('returns 0 rather than Infinity/NaN when the total is 0', () => {
    expect(percentFromAmount(0, 50)).toBe(0);
    expect(amountFromPercent(0, 50)).toBe(0);
  });

  it('round2 handles float noise in both directions', () => {
    expect(round2(74.64099999999999)).toBe(74.64);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

// ─── The deposit STATE (#2031 slice 2) ────────────────────────────────────────

const SENT_AT_2200 = {
  deposit_type: 'PERCENTAGE' as const,
  deposit_value: 50,
  total_amount: 2200,
  send_config: { deposit_required: true, deposit_percentage: 50, deposit_amount: 1100 },
};

describe('resolveDepositState', () => {
  it('reports a sent estimate whose total has since changed as no longer matching', () => {
    // Ran's photograph: Total $0.00, "Deposit due now 50% — $1,190.20". The estimate was sent at
    // one total and its line items were removed afterwards.
    const state = resolveDepositState({ ...SENT_AT_2200, total_amount: 0 }, ORG);

    expect(state.matchesTotal).toBe(false);
    // Held, not silently recalculated — the figure the customer was actually presented stands.
    expect(state.amount).toBe(1100);
    // …and the figure it is being judged against is reported too, so a surface can name both.
    expect(state.expectedAmount).toBe(0);
  });

  it('reports a sent estimate whose total has not moved as still matching', () => {
    const state = resolveDepositState(SENT_AT_2200, ORG);

    expect(state.matchesTotal).toBe(true);
    expect(state.amount).toBe(1100);
    expect(state.percent).toBe(50);
  });

  it('keeps a FIXED deposit matching when the total merely grows', () => {
    const sentFixed = {
      deposit_type: 'FIXED' as const,
      deposit_value: 500,
      total_amount: 3000,
      send_config: { deposit_required: true, deposit_percentage: 25, deposit_amount: 500 },
    };

    expect(resolveDepositState(sentFixed, ORG).matchesTotal).toBe(true);
  });

  it('reports a FIXED deposit that now exceeds the total as no longer matching', () => {
    const sentFixed = {
      deposit_type: 'FIXED' as const,
      deposit_value: 500,
      total_amount: 400,
      send_config: { deposit_required: true, deposit_percentage: 25, deposit_amount: 500 },
    };

    const state = resolveDepositState(sentFixed, ORG);
    expect(state.matchesTotal).toBe(false);
    expect(state.amount).toBe(500);
    expect(state.expectedAmount).toBe(400);
  });

  it('an estimate never sent resolves from current values and is editable', () => {
    const state = resolveDepositState({ total_amount: 1000 }, ORG);

    expect(state.issued).toBe(false);
    expect(state.editable).toBe(true);
    expect(state.matchesTotal).toBe(true);
    expect(state.amount).toBe(500);
    expect(state.basis).toBe('ORG_DEFAULT');
  });

  it('a sent estimate is not editable', () => {
    expect(resolveDepositState(SENT_AT_2200, ORG).editable).toBe(false);
  });

  it('names the estimate override as the basis when it carries one', () => {
    const state = resolveDepositState(
      { deposit_type: 'PERCENTAGE', deposit_value: 70, total_amount: 1000 },
      ORG,
    );

    expect(state.basis).toBe('ESTIMATE_OVERRIDE');
    expect(state.amount).toBe(700);
  });

  it('reports whether a deposit invoice has been issued and settled', () => {
    const unpaid = resolveDepositState(
      { ...SENT_AT_2200, invoices: [{ status: 'SENT', amount_due: 1100 }] },
      ORG,
    );
    expect(unpaid.invoiced).toBe(true);
    expect(unpaid.paid).toBe(false);

    const paid = resolveDepositState(
      { ...SENT_AT_2200, invoices: [{ status: 'PAID', amount_due: 0 }] },
      ORG,
    );
    expect(paid.invoiced).toBe(true);
    expect(paid.paid).toBe(true);
  });

  it('falls back to the deposit invoice when a legacy send_config carries no amount', () => {
    const state = resolveDepositState(
      {
        total_amount: 2200,
        send_config: { deposit_required: true },
        invoices: [{ status: 'SENT', total_amount: 1100, amount_due: 1100 }],
      },
      ORG,
    );

    expect(state.amount).toBe(1100);
  });

  it('the send dialog preview equals the resolver for an estimate carrying an override', () => {
    const estimate = { deposit_type: 'PERCENTAGE' as const, deposit_value: 70, total_amount: '106.63' };

    expect(resolveDepositState(estimate, ORG).amount).toBe(resolveDeposit(estimate, ORG).amount);
  });
});

// #2091 - QA staging, demo org: a 70% deposit invoice (DRAFT/SENT, unpaid) is re-priced by
// `repriceUnpaidDepositInvoice` on the very send this predicate is asked about. Mirrors that
// backend rule exactly, so the frontend never disagrees about which invoices are still movable.
describe('depositInvoiceIsUnpaid', () => {
  it('is unpaid when DRAFT with no payments', () => {
    expect(depositInvoiceIsUnpaid({ status: 'DRAFT', payments: [] })).toBe(true);
  });

  it('is unpaid when SENT with no payments', () => {
    expect(depositInvoiceIsUnpaid({ status: 'SENT', payments: [] })).toBe(true);
  });

  it('is settled once ANY payment lands against it, even while still SENT', () => {
    // A partial payment never flips status away from SENT/DRAFT in every writer - the money on
    // the row is what actually matters (estimate.controller.ts's own comment on this predicate).
    expect(depositInvoiceIsUnpaid({ status: 'SENT', payments: [{ id: 'p1' }] })).toBe(false);
  });

  it('is settled once the status leaves DRAFT/SENT (PAID, PARTIALLY_PAID, VOIDED, ...)', () => {
    expect(depositInvoiceIsUnpaid({ status: 'PAID', payments: [] })).toBe(false);
    expect(depositInvoiceIsUnpaid({ status: 'PARTIALLY_PAID', payments: [] })).toBe(false);
    expect(depositInvoiceIsUnpaid({ status: 'VOIDED', payments: [] })).toBe(false);
  });

  it('is settled (nothing to re-price) when there is no deposit invoice at all', () => {
    expect(depositInvoiceIsUnpaid(null)).toBe(false);
    expect(depositInvoiceIsUnpaid(undefined)).toBe(false);
  });
});
