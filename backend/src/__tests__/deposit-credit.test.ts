import { describe, it, expect, vi } from 'vitest';
import { applyDepositCredit, computeDepositCredit, remainingDepositCredit } from '../lib/deposit-credit';

// Unit tests for the deposit-credit drawdown ledger (entity-redesign §6/§8, Phase 1, seam 4).
// The lib is invoice-id-agnostic; it operates against a Prisma TransactionClient passed in.
// We build a minimal mock tx that wires only the three aggregates + the application create.

function buildTx(overrides: {
  paymentSum?: number | null;
  applicationSum?: number | null;
  refundSum?: number | null;
} = {}) {
  const paymentAggregate = vi.fn().mockResolvedValue({ _sum: { amount: overrides.paymentSum ?? 0 } });
  const applicationAggregate = vi.fn().mockResolvedValue({ _sum: { amount: overrides.applicationSum ?? 0 } });
  const refundAggregate = vi.fn().mockResolvedValue({ _sum: { amount: overrides.refundSum ?? 0 } });
  const applicationCreate = vi.fn().mockImplementation((args: any) => Promise.resolve({ id: 'dca-1', ...args.data }));

  const tx = {
    payment: { aggregate: paymentAggregate },
    depositCreditApplication: { aggregate: applicationAggregate, create: applicationCreate },
    refund: { aggregate: refundAggregate },
  };
  return { tx, paymentAggregate, applicationAggregate, refundAggregate, applicationCreate };
}

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const DEPOSIT_INVOICE_ID = 'dep00000-0000-0000-0000-000000000001';
const TARGET_INVOICE_ID = 'tgt00000-0000-0000-0000-000000000001';

describe('remainingDepositCredit', () => {
  it('= Σ payments on deposit invoice − Σ active applications − Σ refunds on deposit invoice', async () => {
    const { tx, paymentAggregate, applicationAggregate, refundAggregate } = buildTx({
      paymentSum: 1000,
      applicationSum: 600,
      refundSum: 100,
    });

    const remaining = await remainingDepositCredit(tx as any, DEPOSIT_INVOICE_ID);

    // 1000 paid − 600 already-applied (active) − 100 refunded = 300
    expect(remaining).toBe(300);

    // Payments aggregate must scope to the deposit invoice, non-voided payments only.
    expect(paymentAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ invoice_id: DEPOSIT_INVOICE_ID, voided_at: null }),
        _sum: { amount: true },
      }),
    );
    // Applications aggregate must exclude reversed rows (reversed_at: null).
    expect(applicationAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deposit_invoice_id: DEPOSIT_INVOICE_ID, reversed_at: null }),
        _sum: { amount: true },
      }),
    );
    // Refunds aggregate must scope to the deposit invoice.
    expect(refundAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ invoice_id: DEPOSIT_INVOICE_ID }),
        _sum: { amount: true },
      }),
    );
  });

  it('treats null aggregate sums as 0', async () => {
    const { tx } = buildTx({ paymentSum: null, applicationSum: null, refundSum: null });
    const remaining = await remainingDepositCredit(tx as any, DEPOSIT_INVOICE_ID);
    expect(remaining).toBe(0);
  });

  it('rounds to cents', async () => {
    const { tx } = buildTx({ paymentSum: 100.005, applicationSum: 0, refundSum: 0 });
    const remaining = await remainingDepositCredit(tx as any, DEPOSIT_INVOICE_ID);
    expect(remaining).toBe(100.01);
  });
});

describe('applyDepositCredit', () => {
  it('writes a DepositCreditApplication for min(remaining, targetTotal) and returns the applied amount', async () => {
    // remaining = 1000 − 0 − 0 = 1000; target total 2468 ⇒ applied = min(1000, 2468) = 1000
    const { tx, applicationCreate } = buildTx({ paymentSum: 1000 });

    const applied = await applyDepositCredit(tx as any, DEPOSIT_INVOICE_ID, TARGET_INVOICE_ID, 2468, ORG_ID);

    expect(applied).toBe(1000);
    expect(applicationCreate).toHaveBeenCalledWith({
      data: {
        deposit_invoice_id: DEPOSIT_INVOICE_ID,
        target_invoice_id: TARGET_INVOICE_ID,
        amount: 1000,
        organization_id: ORG_ID,
      },
    });
  });

  it('caps the application at the target total when the deposit exceeds it', async () => {
    // remaining = 5000; target total 800 ⇒ applied = min(5000, 800) = 800
    const { tx, applicationCreate } = buildTx({ paymentSum: 5000 });

    const applied = await applyDepositCredit(tx as any, DEPOSIT_INVOICE_ID, TARGET_INVOICE_ID, 800, ORG_ID);

    expect(applied).toBe(800);
    expect(applicationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 800 }) }),
    );
  });

  it('writes NO row and returns 0 when remaining is 0', async () => {
    // 1000 paid but 1000 already applied ⇒ remaining 0
    const { tx, applicationCreate } = buildTx({ paymentSum: 1000, applicationSum: 1000 });

    const applied = await applyDepositCredit(tx as any, DEPOSIT_INVOICE_ID, TARGET_INVOICE_ID, 2468, ORG_ID);

    expect(applied).toBe(0);
    expect(applicationCreate).not.toHaveBeenCalled();
  });
});

// V7-12a pin (no overpaid invoices, BE-14 row 9): the cumulative credit is capped by a shrinking
// `room` that starts at the invoice total, so two deposits can never over-credit an invoice.
describe('computeDepositCredit - two deposits cannot over-credit', () => {
  function twoDeposits(paid: number[]) {
    let call = 0;
    const tx = {
      payment: { aggregate: vi.fn().mockImplementation(() => Promise.resolve({ _sum: { amount: paid[call++] } })) },
      depositCreditApplication: { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 0 } }) },
      refund: { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 0 } }) },
    };
    return tx;
  }

  it('two $800 deposits on a $1,000 invoice credit $1,000 in total, not $1,600', async () => {
    const credit = await computeDepositCredit(twoDeposits([800, 800]) as any, [{ id: 'dep-a' }, { id: 'dep-b' }], 1000);
    expect(credit).toBe(1000);
  });

  it('once the invoice is covered, later deposits are not even read', async () => {
    const tx = twoDeposits([1000, 500]);
    const credit = await computeDepositCredit(tx as any, [{ id: 'dep-a' }, { id: 'dep-b' }], 1000);
    expect(credit).toBe(1000);
    expect(tx.payment.aggregate).toHaveBeenCalledTimes(1);
  });

  it('deposits smaller than the invoice add up exactly', async () => {
    const credit = await computeDepositCredit(twoDeposits([300, 200]) as any, [{ id: 'dep-a' }, { id: 'dep-b' }], 1000);
    expect(credit).toBe(500);
  });
});
