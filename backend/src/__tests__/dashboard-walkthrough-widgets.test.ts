import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';

// Walkthrough-as-entity redesign, PR-B2: dashboard.controller.ts's attention-item "needs
// scheduling" query and its schedule-widget "today's walkthroughs" query both repointed off the
// legacy Lead.walkthrough_* columns onto the Walkthrough table.

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
  (prisma.job.findMany as Mock).mockResolvedValue([]);
  (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
  (prisma.user.findMany as Mock).mockResolvedValue([]);
  (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
  (prisma.invoice.findMany as Mock).mockResolvedValue([]);
  (prisma.visit.findMany as Mock).mockResolvedValue([]);
  (prisma.$queryRaw as Mock).mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  stubEveryDashboardQuery();
});

describe('GET /api/dashboard — walkthrough attention query', () => {
  // Multi-visit D22a: the bucket flipped from "has a REQUESTED placeholder" to "has NO live
  // visit". REQUESTED described a lead needing a visit, not a state of a visit, and it cannot
  // survive multi-visit - with several live visits there is no single row to be the placeholder.
  it('filters the "needs scheduling" attention query by the ABSENCE of a live visit, not lead status/columns', async () => {
    mockAuthAs('orgB_admin');

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    const leadFindManyCalls = (prisma.lead.findMany as Mock).mock.calls;
    const attentionCall = leadFindManyCalls.find((c: any[]) => c[0]?.where?.visits !== undefined);
    expect(attentionCall).toBeDefined();
    expect(attentionCall![0].where.visits).toEqual({
      none: { status: { in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] } },
    });
    // The old legacy-column filters must be gone.
    expect(attentionCall![0].where.walkthrough_needed).toBeUndefined();
    expect(attentionCall![0].where.walkthrough_scheduled_at).toBeUndefined();
  });
});

describe('GET /api/dashboard — schedule widget walkthroughs', () => {
  it('queries the Walkthrough table (SCHEDULED/COMPLETED) instead of Lead.walkthrough_scheduled_at', async () => {
    mockAuthAs('orgB_admin');

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    expect(prisma.visit.findMany).toHaveBeenCalled();
    // The walkthrough lane is the visit query scoped to LEAD visits (`lead_id` in its where).
    // Located by that predicate, not by call position: the endpoint also asks the visit table
    // for unstaffed job visits (needs attention), and Promise.all issues that one first.
    const call = (prisma.visit.findMany as Mock).mock.calls
      .map((c: any[]) => c[0])
      .find((args: any) => args?.where?.lead_id !== undefined);
    expect(call).toBeDefined();
    expect(call.where.status).toEqual({ in: ['SCHEDULED', 'COMPLETED'] });
    expect(call.where.scheduled_at).toBeDefined();
  });

  it('the schedule lane entity keeps the LEAD id (not the Walkthrough row id) for the frontend link contract', async () => {
    mockAuthAs('orgB_admin');
    (prisma.visit.findMany as Mock).mockResolvedValue([
      {
        id: 'wt-1',
        scheduled_at: new Date(),
        duration_minutes: 60,
        completed_at: null,
        lead: {
          id: 'lead-1',
          lead_number: 'L00001',
          service_request: 'AC repair',
          customer: { first_name: 'John', last_name: 'Doe', company_name: null },
          service_location: { address_line1: '123 Main St', city: 'Austin' },
        },
        assignees: [{ user: { id: 'u1', first_name: 'Test', last_name: 'Tech' } }],
      },
    ]);

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    const lanes = res.body.schedule_today ?? [];
    const walkthroughEntry = lanes
      .flatMap((lane: any) => lane.jobs ?? [])
      .find((item: any) => item.entity === 'walkthrough');
    expect(walkthroughEntry).toBeDefined();
    expect(walkthroughEntry.id).toBe('lead-1');
  });
});

describe('GET /api/dashboard - job visits are not walkthroughs (multi-visit S2)', () => {
  // The S2 migration backfills one WORK visit per already-scheduled job, and POST
  // /api/jobs/:id/visits mints more. Those rows have NO lead, so a walkthrough query that
  // selects every visit on the date hands the schedule builder a lead-less row and the whole
  // dashboard 500s for any org with a job scheduled that day.
  it('still answers, and lists only the LEAD walkthrough, when a job visit falls on the same day', async () => {
    mockAuthAs('orgB_admin');
    (prisma.visit.findMany as Mock).mockResolvedValue([
      {
        id: 'visit-job-1',
        scheduled_at: new Date(),
        duration_minutes: 150,
        completed_at: null,
        // A job visit: D5 says exactly one parent, so `lead` is null here.
        lead: null,
        assignees: [],
      },
      {
        id: 'visit-lead-1',
        scheduled_at: new Date(),
        duration_minutes: 60,
        completed_at: null,
        lead: {
          id: 'lead-1',
          lead_number: 'L00001',
          service_request: 'AC repair',
          customer: { first_name: 'John', last_name: 'Doe', company_name: null },
          service_location: { address_line1: '123 Main St', city: 'Austin' },
        },
        assignees: [{ user: { id: 'u1', first_name: 'Test', last_name: 'Tech' } }],
      },
    ]);

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    const walkthroughEntries = (res.body.schedule_today ?? [])
      .flatMap((lane: any) => lane.jobs ?? [])
      .filter((item: any) => item.entity === 'walkthrough');
    expect(walkthroughEntries.map((w: any) => w.id)).toEqual(['lead-1']);
  });
});
