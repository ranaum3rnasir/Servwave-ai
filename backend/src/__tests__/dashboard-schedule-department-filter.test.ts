/**
 * Multi-visit spec slice S8 (D6) - the dashboard's Today's Schedule department filter.
 *
 * `Job.assignees` is gone with `job_assignees`, so the schedule-lane job query has to reach crew
 * through the trips. The `job.findMany` fake here THROWS on a Job-level `assignees` key, exactly
 * as the real client does once the relation is dropped, because the conditional spread that
 * builds that clause is invisible to tsc and inert under an ordinary `mockResolvedValue`.
 *
 * The blast radius is the reason this is worth its own file: every dashboard query runs inside
 * ONE Promise.all, so a single rejected query takes the whole endpoint to 500 and blanks every
 * tile, not just the schedule strip.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';

const DEPT_PLUMBING = '00000000-0000-0000-0000-0000000000d1';
const DEPT_HVAC = '00000000-0000-0000-0000-0000000000d2';
const PAT = { id: 'user-pat', first_name: 'Pat', last_name: 'Plumber', avatar_path: null, department_id: DEPT_PLUMBING };
const HAL = { id: 'user-hal', first_name: 'Hal', last_name: 'Hvac', avatar_path: null, department_id: DEPT_HVAC };

function scheduleJobRow(id: string, jobNumber: string, crew: typeof PAT[]) {
  const now = new Date();
  return {
    id,
    job_number: jobNumber,
    status: 'SCHEDULED',
    scope_notes: null,
    // S8 repoint (D14): the widget derives its displayed time from the matching VISIT now, not
    // job-level scheduled_start/scheduled_end — so the fixture's time lives on the visit item.
    visits: [{
      scheduled_at: now,
      scheduled_end: new Date(now.getTime() + 2 * 60 * 60_000),
      status: 'SCHEDULED',
      assignees: crew.map((u) => ({ user: { id: u.id, first_name: u.first_name, last_name: u.last_name, avatar_path: u.avatar_path } })),
    }],
    customer: { first_name: 'Cust', last_name: 'Omer', company_name: null },
    service_location: { address_line1: '1 Main St', city: 'Springfield' },
  };
}

/** Which department does this job's trip crew belong to? Keyed off the seeded users. */
const CREW_DEPARTMENT: Record<string, string> = { 'job-plumbing': DEPT_PLUMBING, 'job-hvac': DEPT_HVAC };

/**
 * S8 repoint (D14): the department clause moved from a bare `where.visits` key into
 * `where.AND` (alongside the window clause it now shares that key with — see the controller's
 * site-4 comment on why a second bare `visits` key would have silently clobbered the first).
 * Search the AND array for the shape rather than assuming a fixed position.
 */
function extractWantedDept(where: any): string | undefined {
  const and = Array.isArray(where?.AND) ? where.AND : [];
  for (const clause of and) {
    const dept = clause?.visits?.some?.assignees?.some?.user?.department_id;
    if (dept !== undefined) return dept;
  }
  return undefined;
}

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

  // The schedule-lane query (site 4) is the only job.findMany that names `visits` AND `customer`
  // in its SELECT; every other one gets an empty list. S8 repoint (D14): the "needs attention:
  // past start" query (site 3) ALSO now selects `visits`+`job_number` (to resolve its own
  // winning visit), so `customer` is the piece that disambiguates the two — site 3 never
  // selects it. Identified by select shape, not by call order, so a reordering of the
  // Promise.all does not silently retarget this fake.
  (prisma.job.findMany as Mock).mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if ('assignees' in where) {
      // `Job.assignees` was dropped with `job_assignees` in S8.
      throw new Error("Unknown argument `assignees`. Available options are marked with ?.");
    }
    if (!args?.select?.visits || !args?.select?.job_number || !args?.select?.customer) return [];

    const rows = [
      scheduleJobRow('job-plumbing', 'J-PLUMBING', [PAT]),
      scheduleJobRow('job-hvac', 'J-HVAC', [HAL]),
    ];
    const wantedDept = extractWantedDept(where);
    if (wantedDept === undefined) return rows;
    return rows.filter((r) => CREW_DEPARTMENT[r.id] === wantedDept);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  stubEveryDashboardQuery();
});

describe("GET /api/dashboard - Today's Schedule department filter", () => {
  it('returns only the jobs whose TRIP crew is in the chosen department', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get(`/api/dashboard?department_id=${DEPT_PLUMBING}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const lanes = res.body.schedule_today as { user_id: string | null; jobs: { job_number: string }[] }[];
    expect(lanes.flatMap((l) => l.jobs.map((j) => j.job_number))).toEqual(['J-PLUMBING']);
  });

  it('shows every lane when no department is chosen', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const lanes = res.body.schedule_today as { user_id: string | null; jobs: { job_number: string }[] }[];
    expect(lanes.flatMap((l) => l.jobs.map((j) => j.job_number)).sort()).toEqual(['J-HVAC', 'J-PLUMBING']);
  });
});
