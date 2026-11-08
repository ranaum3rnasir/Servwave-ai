import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { mockAuthAs, authHeader } from './helpers';

// #355 — dashboard "Collected" KPIs must exclude DEPOSIT-invoice payments and
// voided payments (an applied deposit otherwise counts twice: once as the cash
// payment on the DEPOSIT invoice, once as the DEPOSIT-CREDIT payment on the
// STANDARD invoice). The revenue report (report.controller.ts) is the reference.
describe('Dashboard collected KPIs — deposit double-count (#355)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
  });

  it('collected KPIs exclude DEPOSIT-invoice payments and voided payments', async () => {
    mockAuthAs('admin');

    // Benign empties for everything the dashboard touches (200-path requires
    // correct aggregate shapes — post-processing dereferences _sum/_avg/_count).
    (prisma.job.groupBy as Mock).mockResolvedValue([]);
    (prisma.job.count as Mock).mockResolvedValue(0);
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.job.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {}, _avg: {}, _count: { _all: 0 } });
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    (prisma.estimate.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.groupBy as Mock).mockResolvedValue([]);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
    (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
    (prisma.user.findMany as Mock).mockResolvedValue([]);
    (prisma.$queryRaw as Mock).mockResolvedValue([]);

    // The behavioral pivot: a correctly-filtered payment aggregation (kind !=
    // DEPOSIT) "sees" 5000; an unfiltered one "sees" 6000 (deposit counted twice).
    (prisma.payment.aggregate as Mock).mockImplementation((args: any) =>
      args?.where?.invoice?.kind?.not === 'DEPOSIT'
        ? { _sum: { amount: 5000 } }
        : { _sum: { amount: 6000 } },
    );

    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));

    // AC #3: the deposit is not double-counted in collectedMtd (nor collected_today).
    expect(res.status).toBe(200);
    expect(res.body.kpis.revenue_mtd.collected).toBe(5000);
    expect(res.body.kpis.collected_today.amount).toBe(5000);

    // Structural: every payment aggregation carries both exclusions.
    expect(prisma.payment.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          voided_at: null,
          invoice: expect.objectContaining({ kind: { not: 'DEPOSIT' } }),
        }),
      }),
    );

    // Raw revenue-chart query (14a) — not exercised by the aggregate mock, so
    // assert its tagged-template SQL text carries both predicates.
    expect(
      (prisma.$queryRaw as Mock).mock.calls.some(
        (c) =>
          Array.isArray(c[0]) &&
          c[0].join('?').includes("i.kind != 'DEPOSIT'") &&
          c[0].join('?').includes('p.voided_at IS NULL'),
      ),
    ).toBe(true);
  });
});
