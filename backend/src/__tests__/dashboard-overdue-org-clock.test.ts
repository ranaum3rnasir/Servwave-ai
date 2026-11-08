/**
 * Defect A, site 3 — the dashboard's Needs Attention overdue-invoice query.
 *
 * This one contradicts itself inside a SINGLE response: the query selected on the raw server
 * instant (`due_date: { lt: now }`), then the label computed `orgDayDiff(inv.due_date, now,
 * timeZone)`. An invoice due earlier today is therefore selected by the query and labelled
 * `0 days past due`, badge `0d` — "Invoice INV-123 overdue · 0 days past due".
 *
 * The second test asserts that invariant end-to-end. To make it meaningful against a mocked
 * Prisma, the `invoice.findMany` stub below APPLIES the `where.due_date.lt` predicate the
 * controller passed it, instead of returning its canned row unconditionally. That is the one
 * place in this file where the stub does more than record a call, and it is deliberate: it is
 * what makes "no attention item can read 0d" depend on the boundary the controller computed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';

const DENVER = 'America/Denver'; // staging: Riverbend Septic, LLC
const NOW = '2026-08-25T18:00:00.000Z';
const DENVER_DAY_START = '2026-08-25T06:00:00.000Z';

/** Due at 08:00 MDT TODAY. Overdue on the server instant, not overdue on the org calendar. */
const DUE_EARLIER_TODAY = new Date('2026-08-25T14:00:00.000Z');

const OVERDUE_ROW = {
  id: 'inv-today',
  invoice_number: 'INV-TODAY',
  due_date: DUE_EARLIER_TODAY,
  amount_due: 1234,
  job: { customer: { first_name: 'Pat', last_name: 'Doe', company_name: null } },
};

/**
 * The Needs Attention overdue query is the only invoice.findMany whose status is exactly
 * `{ in: ['SENT','PARTIAL'] }` — the AR call at :216 carries arOutstandingWhere's four
 * statuses and no due_date at all.
 */
function isOverdueAttentionCall(args: any): boolean {
  const statuses = args?.where?.status?.in;
  return Array.isArray(statuses) && statuses.length === 2
    && statuses.includes('SENT') && statuses.includes('PARTIAL');
}

function overdueAttentionCall(): any {
  const calls = (prisma.invoice.findMany as Mock).mock.calls
    .map((c: any[]) => c[0])
    .filter(isOverdueAttentionCall);
  expect(calls).toHaveLength(1);
  return calls[0];
}

function stubEveryDashboardQuery(overdueRows: any[] = []) {
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
  (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
  (prisma.user.findMany as Mock).mockResolvedValue([]);
  (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
  (prisma.visit.findMany as Mock).mockResolvedValue([]);
  (prisma.$queryRaw as Mock).mockResolvedValue([]);
  (prisma.job.findMany as Mock).mockResolvedValue([]);

  // Honour the boundary the controller passed, so the invariant test below is a real test.
  (prisma.invoice.findMany as Mock).mockImplementation(async (args: any) => {
    if (!isOverdueAttentionCall(args)) return [];
    const lt: Date | undefined = args?.where?.due_date?.lt;
    return overdueRows.filter((r) => lt === undefined || r.due_date < lt);
  });
}

// toFake:['Date'] only — faking all timers deadlocks supertest's real HTTP IO.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  vi.clearAllMocks();
  clearTokenCache();
  mockAuthAs('admin');
  (prisma.organization.findUnique as Mock).mockResolvedValue({ timezone: DENVER });
  stubEveryDashboardQuery();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/dashboard — Needs Attention reads the org clock', () => {
  it('the Needs Attention overdue-invoice query cuts at the org day start (America/Denver)', async () => {
    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
    expect(res.status).toBe(200);

    const lt: Date = overdueAttentionCall().where.due_date.lt;
    expect(lt.toISOString()).toBe(DENVER_DAY_START);
    // Not the server instant, and not UTC midnight.
    expect(lt.toISOString()).not.toBe(NOW);
    expect(lt.toISOString()).not.toBe('2026-08-25T00:00:00.000Z');
  });

  it('a Needs Attention item can never read 0 days past due', async () => {
    stubEveryDashboardQuery([OVERDUE_ROW]);

    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
    expect(res.status).toBe(200);

    const items: any[] = res.body.needs_attention ?? [];
    // The invariant the two clocks jointly violate. This still catches the bug if someone
    // reverted the query fix but kept the label on the org clock.
    expect(items.some((i) => i.badge === '0d')).toBe(false);
    expect(items.some((i) => typeof i.meta === 'string' && i.meta.includes('0 days past due'))).toBe(false);
    // ...because the row is not overdue on the org calendar at all: it must not be selected.
    expect(items.some((i) => i.type === 'overdue_invoice')).toBe(false);
  });

  it('a genuinely overdue invoice is still selected and still labelled', async () => {
    // Guard against "make it pass by selecting nothing": due 08:00 MDT YESTERDAY.
    stubEveryDashboardQuery([{ ...OVERDUE_ROW, id: 'inv-yday', due_date: new Date('2026-08-24T14:00:00.000Z') }]);

    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
    expect(res.status).toBe(200);

    const overdue = (res.body.needs_attention ?? []).filter((i: any) => i.type === 'overdue_invoice');
    expect(overdue).toHaveLength(1);
    expect(overdue[0].badge).toBe('1d');
  });
});
