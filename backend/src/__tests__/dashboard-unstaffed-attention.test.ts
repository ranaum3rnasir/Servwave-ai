/**
 * Needs attention: unstaffed jobs within 48 hours (scheduling notifications, slice 05).
 *
 * A job with a live visit starting in the next 48 hours whose visit has no performer is a job
 * the office has to staff before the customer notices. The item is computed live in the same
 * request as the other attention items, on the org's clock, from the visit's own assignees.
 * The dispatcher and the salesperson on the job are not crew.
 *
 * Harness follows dashboard-visit-window-repoint.test.ts: Prisma is mocked, so the query the
 * controller sends is the boundary this file asserts on, and the rendered item is asserted
 * through the public response.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';
import { LIVE_VISIT_STATUSES } from '../lib/visit-status';

function stubEveryDashboardQuery() {
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
  (prisma.invoice.findMany as Mock).mockResolvedValue([]);
  (prisma.visit.findMany as Mock).mockResolvedValue([]);
  (prisma.$queryRaw as Mock).mockResolvedValue([]);
  (prisma.job.findMany as Mock).mockResolvedValue([]);
}

// Wednesday 2026-06-17 12:00Z, frozen. Mid-day in any plausible runner zone, so no relative
// fixture below can cross a day boundary (see the repoint suite for the history).
const NOW = new Date('2026-06-17T12:00:00Z');
// The org sits in Denver (UTC-6 in June). 9:00 AM Thursday in Denver is 15:00Z, 27 hours out;
// the same instant reads "Thu 11:00 AM" on the default Eastern clock, so a title that says
// 9:00 AM proves the org zone was used.
const DENVER = 'America/Denver';
const THU_9AM_DENVER = new Date('2026-06-18T15:00:00Z');

type UnstaffedRow = {
  id: string;
  scheduled_at: Date;
  assignees: { user_id: string }[];
  job: {
    id: string;
    job_number: string;
    status: string;
    customer: { first_name: string | null; last_name: string | null; company_name: string | null };
  } | null;
};

function visitRow(overrides: Partial<UnstaffedRow> = {}): UnstaffedRow {
  return {
    id: 'visit-1',
    scheduled_at: THU_9AM_DENVER,
    assignees: [],
    job: {
      id: 'job-1',
      job_number: 'J00312',
      status: 'SCHEDULED',
      customer: { first_name: 'Pat', last_name: 'Customer', company_name: null },
    },
    ...overrides,
  };
}

/** The unstaffed query is the only `visit.findMany` on this endpoint that selects the JOB parent
 *  alone (query 12b, the walkthrough lane, selects `lead`; the "customer not told" lookup
 *  selects both). Routing on the select keeps the where clause free for the tests below to
 *  assert on. */
function isUnstaffedQuery(args: any): boolean {
  return args?.select?.job !== undefined && args?.select?.lead === undefined;
}

/** Route the unstaffed-visit query to `rows`; every other visit query stays empty. */
function serveUnstaffedRows(rows: UnstaffedRow[]) {
  (prisma.visit.findMany as Mock).mockImplementation(async (args: any) => (isUnstaffedQuery(args) ? rows : []));
}

/** The unstaffed query's arguments, or undefined before the change. */
function unstaffedQuery(): { where: Record<string, any>; select: Record<string, any> } | undefined {
  return (prisma.visit.findMany as Mock).mock.calls.map((c: any[]) => c[0]).find(isUnstaffedQuery);
}

type AttentionItem = { id: string; type: string; severity: string; title: string; meta: string; badge: string; link: string };

async function fetchAttention(): Promise<AttentionItem[]> {
  const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
  expect(res.status).toBe(200);
  return res.body.needs_attention as AttentionItem[];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  vi.clearAllMocks();
  clearTokenCache();
  stubEveryDashboardQuery();
  mockAuthAs('admin');
  (prisma.organization.findUnique as Mock).mockResolvedValue({ timezone: DENVER });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/dashboard - needs attention: unstaffed jobs within 48 hours', () => {
  it('flags a scheduled job whose uncrewed visit starts tomorrow, titled on the org clock and linked to the job', async () => {
    serveUnstaffedRows([visitRow()]);

    const attention = await fetchAttention();

    const unstaffed = attention.filter((a) => a.type === 'job_unstaffed');
    expect(unstaffed).toHaveLength(1);
    expect(unstaffed[0]).toMatchObject({
      id: 'job-1',
      severity: 'warning',
      title: 'J00312 starts Thu 9:00 AM, no crew',
      link: '/jobs/job-1',
    });
  });

  it('does not flag the same job once the visit has a performer: the query asks only for visits with no assignee', async () => {
    serveUnstaffedRows([]);

    await fetchAttention();

    const q = unstaffedQuery();
    expect(q).toBeDefined();
    expect(q!.where.assignees).toEqual({ none: {} });
  });

  it('still flags a job whose only people are the dispatcher and the salesperson: neither is crew', async () => {
    serveUnstaffedRows([
      visitRow({
        job: {
          id: 'job-1',
          job_number: 'J00312',
          status: 'SCHEDULED',
          customer: { first_name: 'Pat', last_name: 'Customer', company_name: null },
          dispatcher_id: 'user-dispatcher',
          salesperson_id: 'user-sales',
        } as UnstaffedRow['job'],
      }),
    ]);

    const attention = await fetchAttention();

    expect(attention.filter((a) => a.type === 'job_unstaffed').map((a) => a.id)).toEqual(['job-1']);
    // The crew rule is the visit's assignees alone; the job's people are never part of the ask.
    const where = JSON.stringify(unstaffedQuery()!.where);
    expect(where).not.toContain('dispatcher');
    expect(where).not.toContain('salesperson');
  });

  it('does not flag a visit starting in three days: the window is the next 48 hours from now', async () => {
    serveUnstaffedRows([]);

    await fetchAttention();

    const q = unstaffedQuery();
    expect(q!.where.scheduled_at).toEqual({
      gte: NOW,
      lte: new Date(NOW.getTime() + 48 * 3_600_000),
    });
  });

  it('does not flag a cancelled visit or a cancelled job: only live visits on live jobs are asked for', async () => {
    serveUnstaffedRows([]);

    await fetchAttention();

    const q = unstaffedQuery();
    expect(q!.where.status).toEqual({ in: [...LIVE_VISIT_STATUSES] });
    expect(q!.where.job).toEqual({ status: { not: 'CANCELLED' } });
  });
});
