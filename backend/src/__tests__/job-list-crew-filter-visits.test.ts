/**
 * Multi-visit spec slice S8 - the jobs-list CREW FILTERS (`assigned_to`, `department_id`) have to
 * traverse the visit set, because `Job.assignees` is gone with `job_assignees`.
 *
 * Driven through the HTTP API against the real Express app with Prisma mocked. The `job.findMany`
 * fake HONOURS the `where` it receives against seeded decoys AND THROWS on a Job-level `assignees`
 * key, exactly as the real client does once the relation is dropped
 * (`PrismaClientValidationError: Unknown argument 'assignees'`). That throw is the whole point of
 * the file: `buildJobListWhere` writes into a `Record<string, unknown>`, so tsc cannot see a dead
 * relation name there and an ordinary `mockResolvedValue` fixture comes back green over a 500.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, TEST_USERS, ALPHA_ORG_ID } from './helpers';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as Record<string, any>;

const TECH_ID = TEST_USERS.technician.id;
const OTHER_ID = TEST_USERS.dispatcher.id;
const DEPT_PLUMBING = '00000000-0000-0000-0000-0000000000d1';
const DEPT_HVAC = '00000000-0000-0000-0000-0000000000d2';

type CrewRow = { user_id: string; department_id: string };
type Decoy = {
  id: string;
  job_number: string;
  organization_id: string;
  created_by_id: string | null;
  /** crew reached through the job's trips - the only crew there is from S8 */
  visitCrew: CrewRow[];
};

function decoys(): Decoy[] {
  return [
    { id: 'j-tech-plumbing', job_number: 'J-TECH-PLUMBING', organization_id: ALPHA_ORG_ID, created_by_id: OTHER_ID, visitCrew: [{ user_id: TECH_ID, department_id: DEPT_PLUMBING }] },
    { id: 'j-other-hvac', job_number: 'J-OTHER-HVAC', organization_id: ALPHA_ORG_ID, created_by_id: OTHER_ID, visitCrew: [{ user_id: OTHER_ID, department_id: DEPT_HVAC }] },
    { id: 'j-nocrew', job_number: 'J-NOCREW', organization_id: ALPHA_ORG_ID, created_by_id: OTHER_ID, visitCrew: [] },
  ];
}

/** Evaluate one `visits: { some: ... }` fragment against a decoy's trips. */
function matchesVisitSome(row: Decoy, some: Record<string, any>): boolean {
  const wantedUser = some?.assignees?.some?.user_id;
  const wantedDept = some?.assignees?.some?.user?.department_id;
  // The board's date-window clause also arrives as `visits: { some: ... }`; it carries no
  // assignees predicate and is not what this file is about.
  if (wantedUser === undefined && wantedDept === undefined) return true;
  return row.visitCrew.some((c) => {
    const userOk = wantedUser === undefined
      ? true
      : Array.isArray(wantedUser?.in) ? wantedUser.in.includes(c.user_id) : wantedUser === c.user_id;
    const deptOk = wantedDept === undefined
      ? true
      : Array.isArray(wantedDept?.in) ? wantedDept.in.includes(c.department_id) : wantedDept === c.department_id;
    return userOk && deptOk;
  });
}

function matchesFragment(row: Decoy, frag: Record<string, any>): boolean {
  return Object.entries(frag).every(([key, value]) => {
    switch (key) {
      case 'organization_id':
        return row.organization_id === value;
      case 'created_by_id':
        return row.created_by_id === value;
      case 'visits':
        return matchesVisitSome(row, value?.some ?? {});
      case 'OR':
        return (value as Record<string, any>[]).some((v) => matchesFragment(row, v));
      case 'AND':
        return (value as Record<string, any>[]).every((v) => matchesFragment(row, v));
      case 'id':
        return value?.in ? value.in.includes(row.id) : row.id === value;
      case 'source_plan_id':
      case 'status':
      case 'scheduled_start':
      case 'NOT':
        return true;
      case 'assignees':
        // `Job.assignees` was dropped with `job_assignees` in S8. The real client rejects the
        // key outright - it does not filter on nothing and it does not fail open.
        throw new Error("Unknown argument `assignees`. Available options are marked with ?.");
      default:
        throw new Error(`honouring fake does not understand where key: ${key}`);
    }
  });
}

function projected(row: Decoy) {
  return {
    id: row.id,
    job_number: row.job_number,
    status: 'SCHEDULED',
    created_by_id: row.created_by_id,
    sub_status: null,
    job_type: 'SERVICE',
    scope_notes: null,
    visits: row.visitCrew.map((c, i) => ({
      id: `${row.id}-v${i + 1}`,
      visit_seq: i + 1,
      status: 'SCHEDULED',
      scheduled_at: new Date('2026-08-20T13:00:00.000Z'),
      scheduled_end: new Date('2026-08-20T15:00:00.000Z'),
      is_all_day: false,
      customer_email_sent_at: null,
      assignees: [{ user_id: c.user_id, user: { id: c.user_id, first_name: 'X', last_name: 'Y' } }],
    })),
    created_at: new Date('2026-08-01T00:00:00.000Z'),
    customer: null,
    service_location: null,
    estimate: null,
    invoices: [],
  };
}

function seedHonouringJobReads() {
  const table = decoys();
  mockPrisma.job.findMany.mockImplementation(async (args: any) =>
    table.filter((r) => matchesFragment(r, args?.where ?? {})).map(projected),
  );
  mockPrisma.job.count.mockImplementation(async (args: any) =>
    table.filter((r) => matchesFragment(r, args?.where ?? {})).length,
  );
  mockPrisma.job.groupBy.mockResolvedValue([]);
  return table;
}

function jobNumbers(res: { body: { jobs?: { job_number: string }[] } }): string[] {
  return (res.body.jobs ?? []).map((j) => j.job_number).sort();
}

describe('S8 - the jobs-list crew filters ask the visit set', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    seedHonouringJobReads();
  });

  it('department_id returns the jobs whose TRIP crew is in that department', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get(`/api/jobs?department_id=${DEPT_PLUMBING}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(jobNumbers(res)).toEqual(['J-TECH-PLUMBING']);
  });

  it('assigned_to returns the jobs that person is on a TRIP for', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get(`/api/jobs?assigned_to=${OTHER_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(jobNumbers(res)).toEqual(['J-OTHER-HVAC']);
  });

  it('SECURITY: assigned_to cannot widen a row-scoped technician past their own trips', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get(`/api/jobs?assigned_to=${OTHER_ID}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    // The technician is on J-TECH-PLUMBING and nothing else; asking for somebody else's jobs
    // narrows to the empty intersection rather than handing over J-OTHER-HVAC.
    expect(jobNumbers(res)).toEqual([]);
  });
});
