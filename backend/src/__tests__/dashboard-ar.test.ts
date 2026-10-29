/**
 * Dashboard AR KPI — DEPOSIT exclusion (issue #497).
 *
 * The dashboard "A/R" KPI total must exclude DEPOSIT-kind invoices so it
 * matches the AR Aging report's total for the same org. Both paths now share
 * the `arOutstandingWhere` filter (backend/src/lib/ar.ts). This test drives
 * GET /api/dashboard with a two-row invoice fixture (one STANDARD, one
 * DEPOSIT) and asserts the AR total reflects the STANDARD balance only.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { mockAuthAs, authHeader } from './helpers';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
});

describe('GET /api/dashboard — AR KPI excludes DEPOSIT invoices (#497)', () => {
  it('AR total = STANDARD invoice balance only (DEPOSIT excluded)', async () => {
    mockAuthAs('orgB_admin');

    // Stub every dashboard query so the endpoint returns 200.
    (prisma.job.groupBy as Mock).mockResolvedValue([]);
    (prisma.job.count as Mock).mockResolvedValue(0);
    (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {}, _avg: {}, _count: { _all: 0 } });
    (prisma.estimate.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.job.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.groupBy as Mock).mockResolvedValue([]);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
    (prisma.user.findMany as Mock).mockResolvedValue([]);
    (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
    (prisma.$queryRaw as Mock).mockResolvedValue([]);

    // Simulate the DB for invoice.findMany. Distinguish the AR query (query 7,
    // select { amount_due, due_date } only) from the overdue-list query
    // (query 11, select includes id/invoice_number). The mock HONORS the
    // where the controller passes so the test is genuinely red pre-fix: only
    // once the controller adds `kind: { not: 'DEPOSIT' }` is the DEPOSIT row
    // filtered out. The DEPOSIT row is deliberately status SENT so ONLY the
    // kind filter can exclude it.
    const arRows = [
      { kind: 'STANDARD', status: 'SENT', amount_due: 1000, due_date: null },
      { kind: 'DEPOSIT', status: 'SENT', amount_due: 500, due_date: null },
    ];
    (prisma.invoice.findMany as Mock).mockImplementation((args: any) => {
      const isArQuery =
        args?.select?.amount_due === true &&
        args?.select?.due_date === true &&
        !args?.select?.id;
      if (isArQuery) {
        const excludeDeposit = args?.where?.kind?.not === 'DEPOSIT';
        const rows = excludeDeposit ? arRows.filter((r) => r.kind !== 'DEPOSIT') : arRows;
        return Promise.resolve(rows.map((r) => ({ amount_due: r.amount_due, due_date: r.due_date })));
      }
      // Query 11 overdue list (and any other shape) → empty.
      return Promise.resolve([]);
    });

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    // AC #3: STANDARD balance only.
    expect(res.body.kpis.ar.total).toBe(1000);
    expect(res.body.kpis.ar.current).toBe(1000);
    // AC #1: the AR query filters out DEPOSIT invoices.
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: { not: 'DEPOSIT' } }),
        select: expect.objectContaining({ amount_due: true, due_date: true }),
      })
    );
  });
});
