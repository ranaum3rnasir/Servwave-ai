/**
 * Roles & Permissions S04.2 - the Jobs list's Need Invoices count and "needs invoice" filter follow
 * View invoices, and every tile counts only the jobs the person can open.
 *
 * Driven through GET /api/jobs against the real Express app with Prisma mocked. The people here
 * are the technician test user with switch values set on top (a person is whatever their switches
 * say; no role-name check can pass). The Prisma fakes HONOUR the `where` they are given against
 * seeded jobs for the scope arms, because a `mockResolvedValue` count comes back whatever the
 * predicate says and would make every scope assertion vacuous.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, mockRoleSwitches, matchesScopeWhere, TEST_USERS, ALPHA_ORG_ID } from './helpers';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { FINISHED_JOB_STATUSES } from './finished-job-statuses';

const mockPrisma = prisma as unknown as Record<string, any>;

const ME = TEST_USERS.technician.id;
const SOMEONE_ELSE = TEST_USERS.dispatcher.id;

interface SeededJob {
  id: string;
  job_number: string;
  organization_id: string;
  status: 'UNSCHEDULED' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'OFFICE_REVIEW';
  /** the people on the crew of the job's visits */
  crew: string[];
}

let table: SeededJob[];

/** The shape `matchesScopeWhere` reads: crew reached through visits, nothing else attached. */
function asRow(j: SeededJob): Record<string, unknown> {
  return {
    organization_id: j.organization_id,
    visits: [{ assignees: j.crew.map((user_id) => ({ user_id })) }],
    salesperson_id: null,
    dispatcher_id: null,
    estimate: { lead: { commission_owner_id: null } },
  };
}

/**
 * Whether a job is inside the `where`'s tenant + row-scope arms (and its plain status, when one is
 * given). The invoice and date-window parts of a tile are the controller's own business and are
 * not what this file is about.
 */
function inScope(j: SeededJob, where: Record<string, any> | undefined): boolean {
  const w = where ?? {};
  const scopeOnly: Record<string, unknown> = {};
  if ('organization_id' in w) scopeOnly.organization_id = w.organization_id;
  if ('OR' in w) scopeOnly.OR = w.OR;
  if (typeof w.status === 'string' && w.status !== j.status) return false;
  if (Array.isArray(w.status?.in) && !w.status.in.includes(j.status)) return false;
  return matchesScopeWhere(scopeOnly, asRow(j));
}

function seed() {
  table = [
    { id: 'j1', job_number: 'J1', organization_id: ALPHA_ORG_ID, status: 'UNSCHEDULED', crew: [ME] },
    { id: 'j2', job_number: 'J2', organization_id: ALPHA_ORG_ID, status: 'SCHEDULED', crew: [ME] },
    { id: 'j3', job_number: 'J3', organization_id: ALPHA_ORG_ID, status: 'UNSCHEDULED', crew: [SOMEONE_ELSE] },
    { id: 'j4', job_number: 'J4', organization_id: ALPHA_ORG_ID, status: 'COMPLETED', crew: [ME] },
    { id: 'j5', job_number: 'J5', organization_id: ALPHA_ORG_ID, status: 'COMPLETED', crew: [SOMEONE_ELSE] },
    // PRD 6: a completed job rests in Office review, and it still waits for its invoice.
    { id: 'j6', job_number: 'J6', organization_id: ALPHA_ORG_ID, status: 'OFFICE_REVIEW', crew: [ME] },
  ];
  mockPrisma.job.findMany.mockImplementation(async (args: any) =>
    table.filter((j) => inScope(j, args?.where)).map((j) => ({
      id: j.id, job_number: j.job_number, status: j.status, visits: [], created_at: new Date('2026-08-01'),
      customer: null, service_location: null, estimate: null, invoices: [],
    })),
  );
  mockPrisma.job.count.mockImplementation(async (args: any) =>
    table.filter((j) => inScope(j, args?.where)).length,
  );
  mockPrisma.job.groupBy.mockImplementation(async (args: any) => {
    const counts = new Map<string, number>();
    for (const j of table.filter((r) => inScope(r, args?.where))) counts.set(j.status, (counts.get(j.status) ?? 0) + 1);
    return [...counts].map(([status, _count]) => ({ status, _count }));
  });
}

/** The tile counts a list request reports, plus how many rows the list itself holds. */
async function listAs() {
  const res = await request(app).get('/api/jobs').set(authHeader('technician'));
  expect(res.status).toBe(200);
  return res.body as { jobs: { job_number: string }[]; stats: Record<string, number | undefined>; pagination: { total: number } };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('technician');
  seed();
});

describe('Jobs list - Need Invoices follows View invoices', () => {
  it('reports no Need Invoices count to a person without View invoices', async () => {
    mockRoleSwitches({ jobs_scope: 'attached', view_invoices: false });

    const body = await listAs();

    expect(body.stats.need_invoices).toBeUndefined();
    expect(mockPrisma.job.count.mock.calls.some(
      ([args]: any[]) => args?.where?.status?.in?.includes('COMPLETED') && args?.where?.NOT?.invoices,
    )).toBe(false);
    // The five status tiles are still reported.
    expect(body.stats).toMatchObject({ unassigned: 1, scheduled: 1 });
  });

  it('ignores the needs_invoice filter for a person without View invoices', async () => {
    mockRoleSwitches({ jobs_scope: 'attached', view_invoices: false });

    const res = await request(app).get('/api/jobs?needs_invoice=true').set(authHeader('technician'));

    expect(res.status).toBe(200);
    const listWhere = mockPrisma.job.findMany.mock.calls[0][0].where;
    expect(listWhere.NOT).toBeUndefined();
    expect(listWhere.status).toBeUndefined();
  });

  it('keeps the Need Invoices count and filter for a person with View invoices', async () => {
    mockRoleSwitches({ jobs_scope: 'attached', view_invoices: true });

    const body = await listAs();
    expect(typeof body.stats.need_invoices).toBe('number');

    await request(app).get('/api/jobs?needs_invoice=true').set(authHeader('technician'));
    const filtered = mockPrisma.job.findMany.mock.calls.at(-1)[0].where;
    expect(filtered.status).toEqual({ in: FINISHED_JOB_STATUSES });
    expect(filtered.NOT).toEqual({ invoices: { some: { status: { not: 'VOIDED' } } } });
  });
});

describe('Jobs list - tiles count only the jobs the person can open', () => {
  beforeEach(() => {
    mockRoleSwitches({ jobs_scope: 'attached', view_invoices: true });
  });

  it('under Jobs scope Attached the list and the tiles count only the person\'s own jobs', async () => {
    const body = await listAs();

    expect(body.jobs.map((j) => j.job_number).sort()).toEqual(['J1', 'J2', 'J4', 'J6']);
    expect(body.pagination.total).toBe(4);
    // Tiles, derived from the seeded table (not from the controller): the person's own jobs only.
    const mine = table.filter((j) => j.crew.includes(ME));
    expect(body.stats.unassigned).toBe(mine.filter((j) => j.status === 'UNSCHEDULED').length);
    expect(body.stats.scheduled).toBe(mine.filter((j) => j.status === 'SCHEDULED').length);
    expect(body.stats.need_invoices).toBe(mine.filter((j) => (FINISHED_JOB_STATUSES as string[]).includes(j.status)).length);
    expect(body.stats.need_invoices).toBe(2);
  });

  it('a job the person is removed from leaves the list and the counts on the next request', async () => {
    const before = await listAs();
    expect(before.jobs.map((j) => j.job_number)).toContain('J1');
    expect(before.stats.unassigned).toBe(1);

    table.find((j) => j.id === 'j1')!.crew = [SOMEONE_ELSE];

    const after = await listAs();
    expect(after.jobs.map((j) => j.job_number)).not.toContain('J1');
    expect(after.stats.unassigned).toBe(0);
  });
});
