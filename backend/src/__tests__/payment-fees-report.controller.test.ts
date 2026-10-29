/**
 * payment-fees-report.controller.test.ts — Task 4.1: GET /api/reports/payment-fees
 *
 * Route gate: `read Report` (Admin + Dispatcher) like every live report.
 * Tenancy via the invoice relation (Payment has no own organization_id - same
 * shape as getRevenueReport's `collected` stream). Default trailing-12-month
 * window (mirrors inventory-usage).
 *
 * Two independent Prisma queries, in a fixed call order (0, 1) the tests
 * below assert on directly - doctrine: payment-fees-report.ts:
 *   - cost query (call 0): succeeded CARD payments with reconciled fee data
 *     (method CARD, voided_at/refunded_at null, stripe_fee_amount/
 *     platform_fee_amount/net_amount all NOT NULL) -> gross/stripeFees/
 *     platformFees/net/reconciledCount.
 *   - extras query (call 1): any CARD payment carrying a service fee and/or
 *     a tip, gated on neither the three cost columns nor refunded_at ->
 *     serviceFees/serviceFeeCount/tips/tipCount, prorated by refunded share.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

const mockPrisma = prisma as unknown as {
  payment: { findMany: ReturnType<typeof vi.fn> };
};

function paymentRow(over: Record<string, unknown> = {}) {
  return {
    amount: '500.00',
    stripe_fee_amount: '14.80',
    platform_fee_amount: '2.50',
    net_amount: '482.70',
    paid_at: new Date('2026-07-01T10:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.payment.findMany.mockResolvedValue([]);
});

describe('GET /api/reports/payment-fees', () => {
  it('fetches succeeded CARD payments, tenant-scoped via invoice, with the default trailing-12-month window', async () => {
    mockAuthAs('admin');
    const before = Date.now();
    const res = await request(app).get('/api/reports/payment-fees').set(authHeader('admin'));
    const after = Date.now();
    expect(res.status).toBe(200);

    const where = mockPrisma.payment.findMany.mock.calls[0][0].where;
    expect(where.method).toBe('CARD');
    expect(where.voided_at).toBeNull();
    expect(where.refunded_at).toBeNull();
    expect(where.stripe_fee_amount).toEqual({ not: null });
    expect(where.platform_fee_amount).toEqual({ not: null });
    expect(where.net_amount).toEqual({ not: null });
    expect(where.invoice.is.organization_id).toBe(ALPHA_ORG_ID);

    const { gte, lte } = where.paid_at;
    expect(lte.getTime()).toBeGreaterThanOrEqual(before);
    expect(lte.getTime()).toBeLessThanOrEqual(after);
    expect(lte.getTime() - gte.getTime()).toBe(365 * 86_400_000);
  });

  it('honors an explicit from/to range, bumping a date-only "to" to end-of-day (inclusive of the whole last day)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .get('/api/reports/payment-fees?from=2026-06-01&to=2026-06-30')
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    const where = mockPrisma.payment.findMany.mock.calls[0][0].where;
    expect(where.paid_at.gte).toEqual(new Date('2026-06-01'));
    // A date-only "to" must resolve to the END of that day (23:59:59.999), not
    // its midnight START — z.coerce.date() parses "2026-06-30" as
    // 2026-06-30T00:00:00.000Z, and an inclusive `lte` on that raw value would
    // silently exclude every payment made later that same day.
    expect(where.paid_at.lte).toEqual(new Date('2026-06-30T23:59:59.999Z'));
    expect(res.body.from).toBe(new Date('2026-06-01').toISOString());
    expect(res.body.to).toBe(new Date('2026-06-30T23:59:59.999Z').toISOString());
  });

  // Regression: the bug above meant a real same-day payment was silently
  // dropped from the aggregate (reconciledCount/gross/etc. all read 0), not
  // just a wrong echoed boundary - pin the actual end-to-end symptom, not
  // just the `where` shape. (Prisma is mocked in this suite, so `findMany`
  // doesn't itself enforce `lte` - but the controller passes the SAME `to`
  // value into buildPaymentFeesReport's own defensive date-re-clip, so an
  // un-bumped `to` still causes the pure aggregator to drop the row, exactly
  // reproducing the silent-zero failure mode even under a mocked Prisma
  // client.)
  it('includes a payment made later in the day when "to" is a date-only string for that same day (regression)', async () => {
    mockAuthAs('admin');
    mockPrisma.payment.findMany.mockResolvedValue([
      paymentRow({ paid_at: new Date('2026-06-30T14:00:00Z') }), // 2pm on the range's last day
    ]);
    const res = await request(app)
      .get('/api/reports/payment-fees?from=2026-06-01&to=2026-06-30')
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.reconciledCount).toBe(1);
    expect(res.body.gross).toBe(500);
  });

  it('sums Gross/Stripe fee/Platform fee/Net across the returned rows', async () => {
    mockAuthAs('admin');
    mockPrisma.payment.findMany.mockResolvedValue([
      paymentRow(),
      paymentRow({ amount: '100.00', stripe_fee_amount: '3.20', platform_fee_amount: '0.50', net_amount: '96.30' }),
    ]);
    const res = await request(app).get('/api/reports/payment-fees').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ gross: 600, stripeFees: 18, platformFees: 3, net: 579, reconciledCount: 2 });
  });

  // ─── The charged basis (2026-08-04) - net_amount's own basis ───
  // reconcile-stripe-fees.ts derives net_amount from Stripe's charge.amount
  // (face + service fee + tip), so the cost query has to read those two
  // columns too or the payload carries a `net` no other figure can explain.
  it('selects the service fee and tip on the COST query so the charged basis can be reported', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/reports/payment-fees').set(authHeader('admin'));
    expect(res.status).toBe(200);
    const costSelect = mockPrisma.payment.findMany.mock.calls[0][0].select;
    expect(costSelect.service_fee_amount).toBe(true);
    expect(costSelect.tip_amount).toBe(true);
  });

  it('reports charged = face + fee + tip so that charged - stripeFees - platformFees === net (live staging repro)', async () => {
    mockAuthAs('admin');
    mockPrisma.payment.findMany
      .mockResolvedValueOnce([
        // The live row: payment 8b17c520-… on org 00000000-…-0001. 631.79 hit
        // the card; net_amount was captured against that, not against the face.
        paymentRow({
          amount: '533.13',
          service_fee_amount: '18.66',
          tip_amount: '80.00',
          stripe_fee_amount: '20.98',
          platform_fee_amount: '2.36',
          net_amount: '608.45',
        }),
      ])
      .mockResolvedValueOnce([]);
    const res = await request(app).get('/api/reports/payment-fees').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.gross).toBe(533.13);
    expect(res.body.charged).toBe(631.79);
    expect(res.body.net).toBe(608.45);
    expect(Math.round((res.body.charged - res.body.stripeFees - res.body.platformFees) * 100) / 100)
      .toBe(res.body.net);
  });

  it('reports charged === gross for a pre-feature payment carrying neither a fee nor a tip', async () => {
    mockAuthAs('admin');
    mockPrisma.payment.findMany
      .mockResolvedValueOnce([paymentRow({ service_fee_amount: null, tip_amount: null })])
      .mockResolvedValueOnce([]);
    const res = await request(app).get('/api/reports/payment-fees').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.gross).toBe(500);
    expect(res.body.charged).toBe(500);
  });

  // ─── Plan A (2026-08-04) - the extras (service fee + tip) query is independent ───
  it('issues a separate extras query that does not carry the cost-side reconciliation filters, while the cost query still carries both', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/reports/payment-fees').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.payment.findMany).toHaveBeenCalledTimes(2);

    const costWhere = mockPrisma.payment.findMany.mock.calls[0][0].where;
    expect(costWhere.refunded_at).toBeNull();
    expect(costWhere.stripe_fee_amount).toEqual({ not: null });
    expect(costWhere.platform_fee_amount).toEqual({ not: null });
    expect(costWhere.net_amount).toEqual({ not: null });

    const extrasWhere = mockPrisma.payment.findMany.mock.calls[1][0].where;
    expect(extrasWhere).not.toHaveProperty('refunded_at');
    expect(extrasWhere).not.toHaveProperty('stripe_fee_amount');
    expect(extrasWhere).not.toHaveProperty('platform_fee_amount');
    expect(extrasWhere).not.toHaveProperty('net_amount');
    expect(extrasWhere.voided_at).toBeNull();
    expect(extrasWhere.invoice.is.organization_id).toBe(ALPHA_ORG_ID);
    expect(extrasWhere.OR).toEqual([
      { service_fee_amount: { not: null } },
      { tip_amount: { not: null } },
    ]);
  });

  // A tip is not card-only: a tech can be tipped in cash. The CARD gate belongs to the cost
  // query, and to the service fee, which only a card checkout can produce - the extras query
  // must not inherit it, or every cash/check/bank tip is silently dropped. Found on live
  // staging data 2026-08-04: the first two tips in the system were one CARD and one CASH, and
  // the CASH one did not appear on the report.
  it('does not gate the extras query on method, so a non-card tip is still counted', async () => {
    mockAuthAs('admin');
    mockPrisma.payment.findMany
      .mockResolvedValueOnce([]) // cost query
      .mockResolvedValueOnce([
        // Mirrors live payment 4ad29109-...: a CASH payment carrying a tip, no service fee.
        paymentRow({
          amount: '10.53',
          tip_amount: '2.11',
          service_fee_amount: null,
          stripe_fee_amount: null,
          platform_fee_amount: null,
          net_amount: null,
        }),
      ]);
    const res = await request(app).get('/api/reports/payment-fees').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.tips).toBe(2.11);
    expect(res.body.tipCount).toBe(1);
    expect(res.body.serviceFeeCount).toBe(0);

    expect(mockPrisma.payment.findMany.mock.calls[1][0].where).not.toHaveProperty('method');
    // The cost query keeps it - processing costs really are card-only.
    expect(mockPrisma.payment.findMany.mock.calls[0][0].where.method).toBe('CARD');
  });

  // ─── Slice 6 (card service fee) - the report shows what the customer paid, separately ───
  it('sums the service fee column from an independent extras population, not gated by cost-side reconciliation', async () => {
    mockAuthAs('admin');
    mockPrisma.payment.findMany
      .mockResolvedValueOnce([]) // cost query: nothing reconciled yet
      .mockResolvedValueOnce([
        // Mirrors the live evidence row: cost columns all NULL, service fee present.
        paymentRow({
          amount: '1035.00',
          service_fee_amount: '35.00',
          stripe_fee_amount: null,
          platform_fee_amount: null,
          net_amount: null,
        }),
      ]);
    const res = await request(app).get('/api/reports/payment-fees').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.serviceFees).toBe(35);
    expect(res.body.serviceFeeCount).toBe(1);
    expect(res.body.reconciledCount).toBe(0);
    expect(res.body.gross).toBe(0);

    // The extras `where` must NOT gate on service_fee_amount being non-null - the OR
    // clause (asserted above) is what restricts the population, not a top-level filter.
    const extrasWhere = mockPrisma.payment.findMany.mock.calls[1][0].where;
    expect(extrasWhere).not.toHaveProperty('service_fee_amount');
  });

  it('sums the tip column from the same extras population, and prorates both by the refunded share', async () => {
    mockAuthAs('admin');
    mockPrisma.payment.findMany
      .mockResolvedValueOnce([]) // cost query
      .mockResolvedValueOnce([
        paymentRow({
          amount: '1000.00',
          service_fee_amount: '35.00',
          tip_amount: '80.00',
          refunded_amount: '100.00',
          stripe_fee_amount: null,
          platform_fee_amount: null,
          net_amount: null,
        }),
      ]);
    const res = await request(app).get('/api/reports/payment-fees').set(authHeader('admin'));
    expect(res.status).toBe(200);
    // kept share = (1000 - 100) / 1000 = 0.9
    expect(res.body.serviceFees).toBe(31.5);
    expect(res.body.tips).toBe(72);
    expect(res.body.tipCount).toBe(1);
  });

  it('rejects a garbage date with 400', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/reports/payment-fees?from=garbage').set(authHeader('admin'));
    expect(res.status).toBe(400);
  });

  it('403s roles without read Report (Technician, Sales)', async () => {
    mockAuthAs('technician');
    expect((await request(app).get('/api/reports/payment-fees').set(authHeader('technician'))).status).toBe(403);
    mockAuthAs('sales');
    expect((await request(app).get('/api/reports/payment-fees').set(authHeader('sales'))).status).toBe(403);
    expect(mockPrisma.payment.findMany).not.toHaveBeenCalled();
  });
});
