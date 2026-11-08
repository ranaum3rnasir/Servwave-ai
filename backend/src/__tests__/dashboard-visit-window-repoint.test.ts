/**
 * S8 repoint (contract 09 — multi-visit close-out, Workstream A / A1). `jobs.scheduled_start` /
 * `scheduled_end` / `is_all_day` was a forward-looking write-through MIRROR of a job's next
 * upcoming LIVE visit (D14). This slice retires it: every dashboard reader below is repointed
 * onto the `visits` relation directly, BEFORE the column can be dropped.
 *
 * The semantic split is the whole job:
 *   - BACKWARD-LOOKING / reporting sites (1 "jobs today", 2 "jobs yesterday", 4 "today's
 *     schedule", 5 "jobs this week") ask "did this job have a trip in this window" — the visit
 *     SET, via the reference AND/OR pattern from job.controller.ts's buildJobListWhere.
 *   - FORWARD-LOOKING sites (3 "needs attention: past start", 6 "coming up") ask "when is this
 *     job next happening" — `resolveNextJobVisit`, the same function the retired mirror was
 *     written from.
 * Getting the two swapped would silently delete every historical job whose mirror had already
 * gone stale/null (D16's collapse) from a reporting count — this file exists to catch that.
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
}

/** Does any node anywhere in a where/select tree contain `key`? */
function deepHas(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((n) => deepHas(n, key));
  if (node && typeof node === 'object') {
    if (key in (node as Record<string, unknown>)) return true;
    return Object.values(node as Record<string, unknown>).some((v) => deepHas(v, key));
  }
  return false;
}

/** Every `job.findMany` call whose `where` carries an `AND` array (i.e. touched by this repoint). */
function findManyCallsWithAnd(): { where: Record<string, any>; select: Record<string, any> }[] {
  return (prisma.job.findMany as Mock).mock.calls
    .map((c: any[]) => c[0])
    .filter((args: any) => Array.isArray(args?.where?.AND));
}

// Frozen clock. Every fixture below is built RELATIVE to now ("90 minutes ago", "3 hours ago"),
// and site 3's past-start window resolves against the server's local day - so on a real clock
// the overdue fixture crosses local midnight during the first 90 minutes of every day and
// silently leaves the window: this file failed on every CI run between 00:00 and 01:30 runner
// time and passed the rest of the day (the midnight-crossing red the A4 lane predicted when it
// flagged resolveNextJobVisit's un-injectable clock). 12:00Z is mid-day in any zone a runner
// plausibly sits in, so no relative fixture can cross a day boundary. Only `Date` is faked -
// timers, promises and supertest IO stay real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-17T12:00:00Z') });
  vi.clearAllMocks();
  clearTokenCache();
  stubEveryDashboardQuery();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Sites 1/2/5 — backward-looking KPI counts (groupBy/count) ─────────────────────────────

describe('GET /api/dashboard — sites 1/2/5 (jobs today/yesterday/this-week) read the visit set', () => {
  it('groupBy #1 (jobs today) composes the window under AND, never a bare where.visits, and does not filter on scheduled_start', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
    expect(res.status).toBe(200);

    const windowedCalls = (prisma.job.groupBy as Mock).mock.calls
      .map((c: any[]) => c[0])
      .filter((args: any) => Array.isArray(args?.where?.AND));
    expect(windowedCalls.length).toBe(1);
    const where = windowedCalls[0].where;
    expect(where.scheduled_start).toBeUndefined();
    const clause = where.AND[0];
    expect(clause.OR).toHaveLength(2);
    expect(deepHas(clause.OR[0], 'visits')).toBe(true);
    expect(clause.OR[1].status).toBe('CANCELLED');
  });

  it('count calls for #2 (yesterday) and #19 (this week) both carry the same AND-composed window, never scheduled_start', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
    expect(res.status).toBe(200);

    const windowedCalls = (prisma.job.count as Mock).mock.calls
      .map((c: any[]) => c[0])
      .filter((args: any) => Array.isArray(args?.where?.AND));
    // Site #2 (yesterday) and site #5/#19 (this week) — two independent windowed counts.
    expect(windowedCalls.length).toBe(2);
    for (const args of windowedCalls) {
      expect(args.where.scheduled_start).toBeUndefined();
      expect(args.where.AND[0].OR).toHaveLength(2);
      expect(deepHas(args.where.AND[0].OR[0], 'visits')).toBe(true);
    }
    // The two windows are genuinely different (yesterday vs. this week), proving they're not
    // the same call counted twice.
    const [a, b] = windowedCalls.map((args: any) => JSON.stringify(args.where.AND[0].OR[0]));
    expect(a).not.toEqual(b);
  });
});

// ─── Site 4 — Today's Schedule: backward-looking WHERE, but display sourced from the matching visit ───

describe("GET /api/dashboard — site 4 (Today's Schedule) resolves the trip actually happening today", () => {
  it('picks the ONE visit inside the viewed day out of a job with three trips, and keeps crew unioned across all of them', async () => {
    mockAuthAs('admin');
    const yesterday = new Date(Date.now() - 24 * 3_600_000);
    const today = new Date();
    const nextWeek = new Date(Date.now() + 7 * 24 * 3_600_000);

    (prisma.job.findMany as Mock).mockImplementation(async (args: any) => {
      if (!args?.select?.visits || !args?.select?.job_number || !args?.select?.customer) return [];
      return [
        {
          id: 'job-multi',
          job_number: 'J-MULTI',
          status: 'SCHEDULED',
          scope_notes: null,
          visits: [
            { scheduled_at: yesterday, scheduled_end: new Date(yesterday.getTime() + 3_600_000), status: 'COMPLETED', assignees: [{ user: { id: 'u-yesterday', first_name: 'Y', last_name: 'Day', avatar_path: null } }] },
            { scheduled_at: today, scheduled_end: new Date(today.getTime() + 3_600_000), status: 'SCHEDULED', assignees: [{ user: { id: 'u-today', first_name: 'T', last_name: 'Day', avatar_path: null } }] },
            { scheduled_at: nextWeek, scheduled_end: new Date(nextWeek.getTime() + 3_600_000), status: 'SCHEDULED', assignees: [{ user: { id: 'u-week', first_name: 'W', last_name: 'Eek', avatar_path: null } }] },
          ],
          customer: { first_name: 'Cust', last_name: 'Omer', company_name: null },
          service_location: { address_line1: '1 Main St', city: 'Springfield' },
        },
      ];
    });

    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
    expect(res.status).toBe(200);

    const lanes = res.body.schedule_today as { jobs: { job_number: string; scheduled_start: string | null }[] }[];
    const entries = lanes.flatMap((l) => l.jobs).filter((j) => j.job_number === 'J-MULTI');
    // Crew fan-out: J-MULTI appears once per assignee across ALL three trips (S8/D6, untouched).
    expect(entries.length).toBe(3);
    // But every entry's DISPLAYED time is TODAY's visit, not yesterday's or next week's.
    for (const e of entries) {
      expect(e.scheduled_start).toBe(today.toISOString());
    }
  });

  it('composes the department filter and the window filter as two separate AND entries (neither bare-overwrites where.visits)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .get('/api/dashboard')
      .query({ department_id: '00000000-0000-0000-0000-0000000000d1' })
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    const call = findManyCallsWithAnd().find((c) => c.select.customer && c.select.job_number);
    expect(call).toBeDefined();
    expect(call!.where.AND.length).toBe(2);
    expect(call!.where.AND.some((c: any) => 'OR' in c)).toBe(true);
    expect(call!.where.AND.some((c: any) => c?.visits?.some?.assignees !== undefined)).toBe(true);
  });
});

// ─── Site 3 — needs attention: past start (forward-looking) ────────────────────────────────

describe('GET /api/dashboard — site 3 (needs attention: past start) resolves the winning live visit', () => {
  function attentionRow(id: string, jobNumber: string, visits: any[]) {
    return { id, job_number: jobNumber, scope_notes: null, visits };
  }

  it('flags a job whose overdue visit is its ONLY live visit; skips one whose next live visit is actually in the future', async () => {
    mockAuthAs('admin');
    const now = Date.now();
    const overdue = new Date(now - 90 * 60_000); // 90 minutes ago
    // A visit that both STARTED and ENDED hours ago (unlike `overdue` above, whose scheduled_end
    // is still ahead of `now`) — resolveNextJobVisit's "upcoming" rule needs the whole visit,
    // start AND end, in the past before a later live visit can supersede it.
    const elapsedHoursAgo = new Date(now - 3 * 3_600_000);
    const nextWeek = new Date(now + 7 * 24 * 3_600_000);

    (prisma.job.findMany as Mock).mockImplementation(async (args: any) => {
      if (args?.select?.job_number && !args?.select?.customer) {
        // Site 3: needs-attention candidates.
        return [
          attentionRow('job-overdue-only', 'J-OVERDUE', [
            { scheduled_at: overdue, scheduled_end: new Date(overdue.getTime() + 3_600_000), created_at: overdue, assignees: [{ user: { first_name: 'Pat', last_name: 'Plumber' } }] },
          ]),
          attentionRow('job-superseded', 'J-FUTURE-WINS', [
            { scheduled_at: elapsedHoursAgo, scheduled_end: new Date(elapsedHoursAgo.getTime() + 3_600_000), created_at: elapsedHoursAgo, assignees: [{ user: { first_name: 'Old', last_name: 'Crew' } }] },
            { scheduled_at: nextWeek, scheduled_end: new Date(nextWeek.getTime() + 3_600_000), created_at: nextWeek, assignees: [{ user: { first_name: 'New', last_name: 'Crew' } }] },
          ]),
          // Only live visit was cancelled — the nested select would never return it in real
          // Prisma (filtered to LIVE statuses), simulated here as an empty visit list.
          attentionRow('job-cancelled-only', 'J-CANCELLED-VISIT', []),
        ];
      }
      return [];
    });

    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
    expect(res.status).toBe(200);

    const attention = res.body.needs_attention as { type: string; title: string }[];
    const pastStart = attention.filter((a) => a.type === 'job_past_start');
    expect(pastStart.map((a) => a.title)).toEqual(['J-OVERDUE past start time']);
  });
});

// ─── Site 6 — coming up (forward-looking) ───────────────────────────────────────────────────

describe('GET /api/dashboard — site 6 (coming up) resolves the next live visit, future beats past', () => {
  it('a job with a past AND a future live visit surfaces with the FUTURE instant; a job with only a past visit is dropped', async () => {
    mockAuthAs('admin');
    const now = Date.now();
    const past = new Date(now - 3 * 24 * 3_600_000);
    const future = new Date(now + 2 * 24 * 3_600_000);
    const onlyPast = new Date(now - 5 * 24 * 3_600_000);

    (prisma.job.findMany as Mock).mockImplementation(async (args: any) => {
      if (args?.select?.customer && !args?.select?.job_number) {
        // Site 6: coming-up candidates (id + customer + service_location + visits, no job_number).
        return [
          {
            id: 'job-past-and-future',
            customer: { first_name: 'A', last_name: 'One', company_name: null },
            service_location: { address_line1: '1 A St', city: 'Town' },
            visits: [
              { scheduled_at: past, scheduled_end: new Date(past.getTime() + 3_600_000), created_at: past },
              { scheduled_at: future, scheduled_end: new Date(future.getTime() + 3_600_000), created_at: future },
            ],
          },
          {
            id: 'job-only-past',
            customer: { first_name: 'B', last_name: 'Two', company_name: null },
            service_location: { address_line1: '2 B St', city: 'Town' },
            visits: [
              { scheduled_at: onlyPast, scheduled_end: new Date(onlyPast.getTime() + 3_600_000), created_at: onlyPast },
            ],
          },
        ];
      }
      return [];
    });

    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
    expect(res.status).toBe(200);

    const comingUp = res.body.coming_up as { id: string }[];
    expect(comingUp.map((c) => c.id)).toEqual(['job-past-and-future']);
  });
});
