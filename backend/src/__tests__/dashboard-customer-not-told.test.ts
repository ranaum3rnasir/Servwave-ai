/**
 * Needs attention: "customer not told" (scheduling-notifications slice 06).
 *
 * A job (or a lead with a walkthrough) whose live visit starts within 48 hours, and for which
 * the workflow ledger holds no scheduling enrollment that actually REACHED THE CUSTOMER, is
 * surfaced on the dashboard's needs-attention list. The ledger is read directly: an
 * enrollment on that entity, off a scheduled / rescheduled trigger, with a sent step whose
 * per-audience outcomes carry `customer: sent`. Nothing else counts - not a fired trigger, not
 * the job row's legacy dispatch stamp, not a step that only reached the crew.
 *
 * Prior art: dashboard-visit-window-repoint.test.ts (same mocked-prisma shape).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';

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
  (prisma.workflowEnrollment.findMany as Mock).mockResolvedValue([]);
}

const CUSTOMER = { first_name: 'Pat', last_name: 'Customer', company_name: null };

/** A live job visit starting `hoursAhead` hours from the frozen clock. */
function jobVisit(jobId: string, jobNumber: string, hoursAhead: number, extra: Record<string, unknown> = {}) {
  const at = new Date(Date.now() + hoursAhead * 3_600_000);
  return {
    id: `visit-${jobId}`,
    scheduled_at: at,
    status: 'SCHEDULED',
    job: { id: jobId, job_number: jobNumber, customer: CUSTOMER, ...extra },
    lead: null,
  };
}

/** A live walkthrough on a lead starting `hoursAhead` hours from the frozen clock. */
function leadVisit(leadId: string, leadNumber: string, hoursAhead: number) {
  const at = new Date(Date.now() + hoursAhead * 3_600_000);
  return {
    id: `visit-${leadId}`,
    scheduled_at: at,
    status: 'SCHEDULED',
    job: null,
    lead: { id: leadId, lead_number: leadNumber, customer: CUSTOMER },
  };
}

/**
 * Answer the slice's own visit lookup with `rows`; every other visit.findMany on the dashboard
 * keeps answering []. This is the only visit lookup on the endpoint that selects BOTH parents:
 * the unstaffed item selects the job alone, the schedule lane selects the lead alone.
 */
function isUpcomingVisitLookup(args: any): boolean {
  return Boolean(args?.select?.job && args?.select?.lead);
}
function mockUpcomingVisits(rows: unknown[]) {
  (prisma.visit.findMany as Mock).mockImplementation(async (args: any) => (isUpcomingVisitLookup(args) ? rows : []));
}

/** A ledger row as the slice's enrollment lookup returns it: one enrollment, its sent step runs. */
function enrollment(entityType: 'job' | 'lead', entityId: string, outcomes: { audience: string; outcome: string }[][]) {
  return {
    entity_type: entityType,
    entity_id: entityId,
    step_runs: outcomes.map((audience_outcomes) => ({
      audience_outcomes: audience_outcomes.map((o) => ({ ...o, label: o.audience, summary: '' })),
    })),
  };
}

function mockLedger(rows: unknown[]) {
  (prisma.workflowEnrollment.findMany as Mock).mockResolvedValue(rows);
}

type Item = { id: string; type: string; severity: string; title: string; meta: string; badge: string; link: string };

async function notTold(): Promise<Item[]> {
  const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
  expect(res.status).toBe(200);
  return (res.body.needs_attention as Item[]).filter((a) => a.type === 'customer_not_told');
}

// Frozen mid-day clock, same reasoning as the repoint suite: every fixture is relative to now,
// and a wall-clock run must never cross a day boundary under the fixtures.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-17T12:00:00Z') });
  vi.clearAllMocks();
  clearTokenCache();
  stubEveryDashboardQuery();
  mockAuthAs('admin');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/dashboard needs attention: customer not told about the schedule', () => {
  it('a scheduled job starting tomorrow with no enrollment at all appears', async () => {
    mockUpcomingVisits([jobVisit('job-1', 'J00312', 24)]);

    const items = await notTold();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: 'warning', link: '/jobs/job-1' });
    expect(items[0].title).toContain('J00312');
  });

  it('the same job with an enrollment whose customer outcome is sent does not appear (its untold sibling still does)', async () => {
    mockUpcomingVisits([jobVisit('job-1', 'J00312', 24), jobVisit('job-2', 'J00313', 25)]);
    mockLedger([enrollment('job', 'job-1', [[{ audience: 'customer', outcome: 'sent' }]])]);

    expect((await notTold()).map((i) => i.link)).toEqual(['/jobs/job-2']);
  });

  it('an enrollment whose only sent audience is the assigned team (customer skipped) still appears', async () => {
    mockUpcomingVisits([jobVisit('job-1', 'J00312', 24)]);
    mockLedger([
      enrollment('job', 'job-1', [[
        { audience: 'customer', outcome: 'skipped' },
        { audience: 'assigned_team', outcome: 'sent' },
      ]]),
    ]);

    const items = await notTold();

    expect(items.map((i) => i.link)).toEqual(['/jobs/job-1']);
  });

  it("the job's legacy dispatch stamp being set makes no difference: stamped and never reached still appears", async () => {
    mockUpcomingVisits([jobVisit('job-1', 'J00312', 24, { customer_scheduled_email_sent_at: new Date('2026-06-10T09:00:00Z') })]);

    expect((await notTold()).map((i) => i.link)).toEqual(['/jobs/job-1']);
  });

  it('a lead with a walkthrough tomorrow and no enrollment appears, linking to the lead', async () => {
    mockUpcomingVisits([leadVisit('lead-1', 'L00045', 20)]);

    const items = await notTold();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: 'warning', link: '/leads/lead-1' });
    expect(items[0].title).toContain('L00045');
  });

  it('a lead whose walkthrough enrollment reached the customer does not appear (its untold sibling still does)', async () => {
    mockUpcomingVisits([leadVisit('lead-1', 'L00045', 20), leadVisit('lead-2', 'L00046', 21)]);
    mockLedger([enrollment('lead', 'lead-1', [[{ audience: 'customer', outcome: 'sent' }]])]);

    expect((await notTold()).map((i) => i.link)).toEqual(['/leads/lead-2']);
  });

  it('a told JOB does not vouch for a lead with the same id: the ledger match is per entity kind', async () => {
    mockUpcomingVisits([leadVisit('same-id', 'L00045', 20)]);
    mockLedger([enrollment('job', 'same-id', [[{ audience: 'customer', outcome: 'sent' }]])]);

    expect((await notTold()).map((i) => i.link)).toEqual(['/leads/same-id']);
  });

  it('two visits of one job inside the window yield ONE item, on the earlier visit', async () => {
    mockUpcomingVisits([jobVisit('job-1', 'J00312', 6), { ...jobVisit('job-1', 'J00312', 30), id: 'visit-later' }]);

    const items = await notTold();

    expect(items).toHaveLength(1);
    expect(items[0].badge).toBe('6h');
  });
});

describe('GET /api/dashboard needs attention: customer not told, what the lookups ask the database', () => {
  function upcomingVisitCall() {
    const calls = (prisma.visit.findMany as Mock).mock.calls.map((c: any[]) => c[0]).filter(isUpcomingVisitLookup);
    expect(calls).toHaveLength(1);
    return calls[0];
  }

  it('the visit lookup is org-scoped, live-only, and cut at exactly 48 hours ahead, with cancelled jobs excluded', async () => {
    await notTold();

    const { where } = upcomingVisitCall();
    expect(where.organization_id).toBeDefined();
    expect(where.status.in).toEqual(['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS']);
    expect(where.scheduled_at.gte.toISOString()).toBe('2026-06-17T12:00:00.000Z');
    expect(where.scheduled_at.lte.toISOString()).toBe('2026-06-19T12:00:00.000Z');
    expect(where.OR).toEqual([
      { job: { status: { not: 'CANCELLED' } } },
      { lead_id: { not: null } },
    ]);
  });

  it('with nothing upcoming the visits are still looked up but the ledger is not consulted at all', async () => {
    await notTold();

    upcomingVisitCall();
    expect(prisma.workflowEnrollment.findMany).not.toHaveBeenCalled();
  });

  it('the ledger lookup asks for scheduling enrollments on exactly the upcoming jobs and leads, per trigger pair, with a sent send step', async () => {
    mockUpcomingVisits([jobVisit('job-1', 'J00312', 24), leadVisit('lead-1', 'L00045', 20)]);

    await notTold();

    expect(prisma.workflowEnrollment.findMany).toHaveBeenCalledTimes(1);
    const { where, select } = (prisma.workflowEnrollment.findMany as Mock).mock.calls[0][0];
    expect(where.organization_id).toBeDefined();
    expect(where.OR).toEqual([
      { entity_type: 'job', entity_id: { in: ['job-1'] }, workflow: { trigger_type: { in: ['JOB_SCHEDULED', 'JOB_RESCHEDULED'] } } },
      { entity_type: 'lead', entity_id: { in: ['lead-1'] }, workflow: { trigger_type: { in: ['WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_RESCHEDULED'] } } },
    ]);
    expect(where.step_runs.some).toEqual({ status: 'SENT', step_type: { in: ['SEND_EMAIL', 'SEND_TEXT'] } });
    expect(select.step_runs.select.audience_outcomes).toBe(true);
  });

  it('with only jobs upcoming the lead arm is absent, so no empty IN list reaches the database', async () => {
    mockUpcomingVisits([jobVisit('job-1', 'J00312', 24)]);

    await notTold();

    const { where } = (prisma.workflowEnrollment.findMany as Mock).mock.calls[0][0];
    expect(where.OR).toHaveLength(1);
    expect(where.OR[0].entity_type).toBe('job');
  });
});
