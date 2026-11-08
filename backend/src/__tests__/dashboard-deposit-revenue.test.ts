/**
 * Issue #496 — Dashboard KPIs must NOT count DEPOSIT invoices/payments as revenue.
 *
 * Deposits are unearned revenue until applied to a final (STANDARD) invoice, so
 * the Revenue Report excludes them (report.controller.ts:385/:389). The dashboard
 * revenue queries historically omitted that guard, overstating every revenue KPI.
 *
 * This test drives GET /api/dashboard over HTTP with a mocked DB whose ONLY paid
 * invoice is a DEPOSIT (for 5000). After the fix, every revenue KPI must read 0,
 * while the intentionally deposit-scoped tiles (deposits_awaiting, pipeline
 * "deposit" stage) must still read 5000 — proving Q20/Q27 were left untouched.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { mockAuthAs, authHeader } from './helpers';

// A revenue query is "deposit-excluding" if it carries kind != 'DEPOSIT' either
// directly (invoice.aggregate) or via the invoice relation (payment.aggregate).
const excludesDeposit = (where: any) =>
  where?.kind?.not === 'DEPOSIT' || where?.invoice?.kind?.not === 'DEPOSIT';

describe('GET /api/dashboard — DEPOSIT invoices are excluded from revenue KPIs (#496)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
    mockAuthAs('admin');

    // ── Neutral mock block (mirrors tenant-attack.test.ts dashboard test) ──
    (prisma.job.groupBy as Mock).mockResolvedValue([]);
    (prisma.job.count as Mock).mockResolvedValue(0);
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.job.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.estimate.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    (prisma.lead.groupBy as Mock).mockResolvedValue([]);
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
    (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
    (prisma.user.findMany as Mock).mockResolvedValue([]);
    (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);

    // ── Scenario: the only paid invoice in the org is a DEPOSIT for 5000 ──
    // invoice.aggregate backs: invoiced-MTD (_sum.total_amount), avg-ticket
    // (_avg.total_amount), deposits-awaiting (_sum.amount_due + _count) and the
    // pipeline deposit stage (_sum.total_amount).
    (prisma.invoice.aggregate as Mock).mockImplementation(({ where }: any) => {
      if (where?.kind === 'DEPOSIT')
        // Q20 (deposits_awaiting) + Q27 (pipeline deposit stage) — must stay 5000.
        return { _sum: { amount_due: 5000, total_amount: 5000 }, _count: { _all: 1 } };
      if (excludesDeposit(where))
        // Post-fix revenue queries — the deposit is filtered out → 0.
        return { _sum: { total_amount: 0 }, _avg: { total_amount: 0 }, _count: { _all: 0 } };
      // Pre-fix leak: a revenue query that forgot the guard sees the deposit → 5000.
      return { _sum: { total_amount: 5000 }, _avg: { total_amount: 5000 }, _count: { _all: 1 } };
    });

    (prisma.payment.aggregate as Mock).mockImplementation(({ where }: any) =>
      excludesDeposit(where) ? { _sum: { amount: 0 } } : { _sum: { amount: 5000 } },
    );

    // Raw revenue-chart queries. After the fix each template carries `!= 'DEPOSIT'`;
    // the current-month row (always inside the chart window) is otherwise the only
    // data and would leak 5000 into both the invoiced and collected bars.
    (prisma.$queryRaw as Mock).mockImplementation((strings: any) => {
      const sql = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
      if (sql.includes("!= 'DEPOSIT'")) return [];
      const now = new Date();
      return [
        {
          month: new Date(now.getFullYear(), now.getMonth(), 1),
          collected: '5000',
          invoiced: '5000',
        },
      ];
    });
  });

  it('reports $0 for every revenue KPI while deposit-scoped tiles stay 5000', async () => {
    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
    expect(res.status).toBe(200);

    const { kpis, pipeline, revenue_chart } = res.body;

    // Revenue MTD (invoiced + collected)
    expect(kpis.revenue_mtd.invoiced).toBe(0);
    expect(kpis.revenue_mtd.collected).toBe(0);

    // Collected today + Avg ticket
    expect(kpis.collected_today.amount).toBe(0);
    expect(kpis.avg_ticket.amount).toBe(0);

    // Pipeline invoiced / paid stages
    expect(pipeline.find((s: any) => s.key === 'invoiced').value).toBe(0);
    expect(pipeline.find((s: any) => s.key === 'paid').value).toBe(0);

    // Revenue chart — no month bar counts the deposit
    for (const bar of revenue_chart) {
      expect(bar.invoiced).toBe(0);
      expect(bar.collected).toBe(0);
    }

    // ── Regression guard: Q20/Q27 remain deposit-scoped (must NOT be touched) ──
    expect(kpis.deposits_awaiting.amount).toBe(5000);
    expect(pipeline.find((s: any) => s.key === 'deposit').value).toBe(5000);
  });
});
