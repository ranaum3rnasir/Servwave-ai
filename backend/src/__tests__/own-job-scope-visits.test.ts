/**
 * Multi-visit spec slice S8 - the stored OWN_JOB row scope moves onto the visits path.
 *
 * Driven through the HTTP API against the real Express app (authenticate -> attachAbility ->
 * canDo -> validate -> controller) with Prisma mocked. Nothing here reaches for
 * scopeWhereFor/defaultGrants directly: the observable behaviour is "which jobs does a
 * technician's list contain, and which job can a technician open".
 *
 * The `job.findMany` fake HONOURS the `where` it receives against seeded decoys rather than
 * resolving a fixture. That is load-bearing, not decorative: 191 of the backend suites run
 * against a fully-mocked Prisma, so a query built against a DEAD relation path never throws and
 * a `mockResolvedValue` fixture comes back whatever the predicate says. Without the honouring
 * fake this whole file would be theatre - it would stay green if the row scope kept pointing at
 * job_assignees, which is the exact failure this slice exists to prevent (a silent 403, never an
 * error).
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

type Decoy = {
  id: string;
  job_number: string;
  organization_id: string;
  created_by_id: string | null;
  /** crew reached through the job's visits - the S8 target path */
  visitCrew: string[];
  /** crew reached through the dead job-level join table */
  jobCrew: string[];
};

/**
 * J-A: technician is on visit 1's crew, holds NO job-level row.
 * J-B: technician holds a job-level row only, the job has NO visit at all.
 * J-C: someone else entirely, on both paths.
 */
function decoys(): Decoy[] {
  return [
    { id: 'j-a', job_number: 'J-A', organization_id: ALPHA_ORG_ID, created_by_id: OTHER_ID, visitCrew: [TECH_ID], jobCrew: [] },
    { id: 'j-b', job_number: 'J-B', organization_id: ALPHA_ORG_ID, created_by_id: OTHER_ID, visitCrew: [], jobCrew: [TECH_ID] },
    { id: 'j-c', job_number: 'J-C', organization_id: ALPHA_ORG_ID, created_by_id: OTHER_ID, visitCrew: [OTHER_ID], jobCrew: [OTHER_ID] },
  ];
}

/** Evaluate ONE where fragment against ONE decoy. Understands only the shapes this scope uses. */
function matchesFragment(row: Decoy, frag: Record<string, any>): boolean {
  return Object.entries(frag).every(([key, value]) => {
    switch (key) {
      case 'organization_id':
        return row.organization_id === value;
      case 'created_by_id':
        return row.created_by_id === value;
      case 'assignees':
        return row.jobCrew.includes(value?.some?.user_id);
      case 'visits':
        return row.visitCrew.includes(value?.some?.assignees?.some?.user_id);
      case 'OR':
        return (value as Record<string, any>[]).some((v) => matchesFragment(row, v));
      case 'AND':
        return (value as Record<string, any>[]).every((v) => matchesFragment(row, v));
      case 'id':
        return value?.in ? value.in.includes(row.id) : row.id === value;
      case 'source_plan_id':
        return true;
      // The stats tiles run their own counts over the same scope. They are not what this file
      // is about, so their predicates are accepted rather than evaluated - but they are named
      // explicitly, so an unrecognised key still throws.
      case 'status':
      case 'first_visit_start':
      case 'scheduled_start':
      case 'NOT':
        return true;
      default:
        // An unrecognised predicate must not silently pass - that is how a wrong where
        // clause would look green here.
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
    visits: row.visitCrew.map((u, i) => ({
      id: `${row.id}-v${i + 1}`,
      visit_seq: i + 1,
      status: 'SCHEDULED',
      scheduled_at: new Date('2026-08-20T13:00:00.000Z'),
      scheduled_end: new Date('2026-08-20T15:00:00.000Z'),
      is_all_day: false,
      // S8 (A5, RATIFIED): the schedule projection's tie-break needs created_at whenever two
      // visits land on the same scheduled_at - which every multi-crew job here does, since each
      // crew member here is modelled as its OWN visit row sharing one literal date.
      created_at: new Date('2026-08-01T00:00:00.000Z'),
      customer_email_sent_at: null,
      assignees: [{ user_id: u, user: { id: u, first_name: 'X', last_name: 'Y' } }],
    })),
    created_at: new Date('2026-08-01T00:00:00.000Z'),
    customer: null,
    service_location: null,
    estimate: null,
    invoices: [],
  };
}

/** The `where` job.findMany was actually given, for the row-scope shape assertions. */
let lastListWhere: Record<string, any> | undefined;

function seedHonouringJobReads() {
  const table = decoys();
  lastListWhere = undefined;
  mockPrisma.job.findMany.mockImplementation(async (args: any) => {
    lastListWhere = args?.where ?? {};
    return table.filter((r) => matchesFragment(r, args?.where ?? {})).map(projected);
  });
  mockPrisma.job.count.mockImplementation(async (args: any) =>
    table.filter((r) => matchesFragment(r, args?.where ?? {})).length,
  );
  mockPrisma.job.groupBy.mockResolvedValue([]);
  mockPrisma.job.findFirst.mockImplementation(async (args: any) => {
    const hit = table.find((r) => matchesFragment(r, args?.where ?? {}));
    return hit ? projected(hit) : null;
  });
  return table;
}

describe('S8 behaviour 1 - a technician job list follows visit crew, not the job-assignee table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('technician');
    seedHonouringJobReads();
  });

  it('lists the job the technician is crewed on via a visit, and not the job-level-only one', async () => {
    const res = await request(app).get('/api/jobs').set(authHeader('technician'));

    expect(res.status).toBe(200);
    const numbers = (res.body.jobs as { job_number: string }[]).map((j) => j.job_number).sort();
    expect(numbers).toEqual(['J-A']);
  });

  it('builds the row scope through the visits relation and carries no top-level assignees key', async () => {
    await request(app).get('/api/jobs').set(authHeader('technician'));

    // TECHNICIAN's `read Job` is the OR shape; the OWN arm is what must have moved.
    const ownArm = (lastListWhere?.OR as Record<string, any>[]).find((m) => !('created_by_id' in m));
    expect(ownArm).toEqual({ visits: { some: { assignees: { some: { user_id: TECH_ID } } } } });
    expect(ownArm).not.toHaveProperty('assignees');
    expect(lastListWhere).not.toHaveProperty('assignees');
  });
});

describe('S8 behaviour 2 - the read-OR-created shape moves with it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('technician');
  });

  it('opens a job the technician is crewed on via visit 2 only', async () => {
    const table = seedHonouringJobReads();
    // Crewed on visit 2 only, no job-level row, not the creator.
    table[0].visitCrew = [OTHER_ID, TECH_ID];
    mockPrisma.job.findUnique.mockImplementation(async (args: any) => {
      const hit = table.find((r) => r.id === args?.where?.id);
      return hit ? projected(hit) : null;
    });

    const res = await request(app).get('/api/jobs/j-a').set(authHeader('technician'));
    expect(res.status).toBe(200);

    const readWhere = mockPrisma.job.findFirst.mock.calls.map((c: any[]) => c[0]?.where).find((w: any) => w?.OR);
    expect(readWhere.OR).toEqual([
      { visits: { some: { assignees: { some: { user_id: TECH_ID } } } } },
      { created_by_id: TECH_ID },
    ]);
    expect(readWhere.OR.some((m: Record<string, unknown>) => 'assignees' in m)).toBe(false);
  });

  it('opens a job the technician created but is not crewed on', async () => {
    const table = seedHonouringJobReads();
    table[1].visitCrew = [];
    table[1].jobCrew = [];
    table[1].created_by_id = TECH_ID;
    mockPrisma.job.findUnique.mockImplementation(async (args: any) => {
      const hit = table.find((r) => r.id === args?.where?.id);
      return hit ? projected(hit) : null;
    });

    const res = await request(app).get('/api/jobs/j-b').set(authHeader('technician'));
    expect(res.status).toBe(200);
  });
});
