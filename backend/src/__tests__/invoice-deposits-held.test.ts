/**
 * "Deposits Held" — deposit money taken but not yet applied to an invoice.
 *
 * The app excludes DEPOSIT invoices from every revenue figure it reports, and
 * that exclusion is correct: a deposit is money held against work not yet done.
 * The cost of the correctness was that the money became invisible. On one
 * production org the gap was ~$1.02M of collected deposits against $15.6k ever
 * applied, showing nowhere in the product.
 *
 * The figure is NOT `sum(total_amount)` over deposit invoices. It is the same
 * subtraction `remainingDepositCredit` (lib/deposit-credit.ts) performs per
 * deposit, summed org-wide:
 *
 *     held = paid(non-voided, on DEPOSIT invoices)
 *          − applied(active DepositCreditApplication)
 *          − refunded(on DEPOSIT invoices)
 *
 * These tests drive the controller through real Express with a mocked Prisma, so
 * they prove the ARITHMETIC and the SCOPING the controller asked for. The three
 * aggregates' own correctness is Prisma's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';

/**
 * `payment.aggregate` is called twice by `list()` — collected-this-month and the
 * deposit leg. Keying the stub on the `where` rather than on call ORDER means a
 * later reordering of the Promise.all cannot silently swap the two numbers and
 * still pass.
 */
function stubDepositAggregates({ paid, applied, refunded }: { paid: number; applied: number; refunded: number }) {
  (prisma.payment.aggregate as Mock).mockImplementation((args: { where?: { invoice?: { kind?: string } } }) =>
    Promise.resolve(
      args?.where?.invoice?.kind === 'DEPOSIT'
        ? { _sum: { amount: paid }, _count: 0 }
        : { _sum: { amount: 0 }, _count: 0 },
    ),
  );
  (prisma.depositCreditApplication.aggregate as Mock).mockResolvedValue({ _sum: { amount: applied } });
  (prisma.refund.aggregate as Mock).mockResolvedValue({ _sum: { amount: refunded } });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  mockAuthAs('admin');
  (prisma.invoice.findMany as Mock).mockResolvedValue([]);
  (prisma.invoice.count as Mock).mockResolvedValue(0);
  (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
  (prisma.job.count as Mock).mockResolvedValue(0);
  (prisma.tagAssignment.findMany as Mock).mockResolvedValue([]);
  (prisma.organization.findUnique as Mock).mockResolvedValue({ timezone: 'America/New_York' });
  stubDepositAggregates({ paid: 0, applied: 0, refunded: 0 });
});

const getStats = async () => {
  const res = await request(app).get('/api/invoices').set(authHeader('admin'));
  expect(res.status).toBe(200);
  return res.body.stats;
};

describe('GET /api/invoices — the Deposits Held tile', () => {
  it('subtracts applied credit and refunds from deposit money taken', async () => {
    stubDepositAggregates({ paid: 1_034_147.91, applied: 15_564.18, refunded: 347.08 });

    // The production figures that motivated the tile, to the cent.
    expect((await getStats()).deposits_held).toBeCloseTo(1_018_236.65, 2);
  });

  it('reports nothing held once every deposit has been applied', async () => {
    stubDepositAggregates({ paid: 5_000, applied: 5_000, refunded: 0 });

    expect((await getStats()).deposits_held).toBe(0);
  });

  it('never reports negative money when the legs disagree', async () => {
    // Three independently-aggregated sets: a reversal landing between them can
    // make `applied` momentarily exceed `paid`. That must read as "nothing
    // held", never as a negative balance on the tile.
    stubDepositAggregates({ paid: 100, applied: 250, refunded: 0 });

    expect((await getStats()).deposits_held).toBe(0);
  });

  it('is not the face value of deposit invoices — an unpaid deposit is not money held', async () => {
    // `paid` is the PAYMENT sum, so a deposit that was invoiced but never paid
    // contributes nothing here. That figure is the separate "Deposits Awaiting".
    stubDepositAggregates({ paid: 0, applied: 0, refunded: 0 });

    expect((await getStats()).deposits_held).toBe(0);
  });

  it('scopes all three legs to the tenant, through the deposit invoice', async () => {
    await getStats();

    const depositLeg = (prisma.payment.aggregate as Mock).mock.calls
      .map((c) => c[0])
      .find((a) => a?.where?.invoice?.kind === 'DEPOSIT');
    expect(depositLeg.where.voided_at).toBeNull();
    expect(depositLeg.where.invoice.organization_id).toBeDefined();

    const appliedLeg = (prisma.depositCreditApplication.aggregate as Mock).mock.calls[0][0];
    expect(appliedLeg.where.reversed_at).toBeNull();
    expect(appliedLeg.where.deposit_invoice.organization_id).toBeDefined();

    const refundLeg = (prisma.refund.aggregate as Mock).mock.calls[0][0];
    expect(refundLeg.where.invoice.kind).toBe('DEPOSIT');
    expect(refundLeg.where.invoice.organization_id).toBeDefined();
  });
});
