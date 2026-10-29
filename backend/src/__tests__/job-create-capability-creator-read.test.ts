/**
 * Multi-visit S8 (D6) - a granted creator must still reach the job they made.
 *
 * The four self-assign-on-create writes were removed with `job_assignees`. Their stated
 * justification is TECHNICIAN's `read Job`, which is OWN_OR_CREATED_JOB and rescues a creator
 * through its `created_by_id` arm. That argument does NOT reach the per-user `create Job`
 * capability: SALES holds no role-level `create Job` at all, so the toggle is the only way to
 * hand job creation to an individual salesperson, and the paired implied read it emits has to
 * carry the creator arm too - the SALES role's own `read Job` is OWN_JOB_VIA_ESTIMATE, and a
 * standalone (urgent) job has neither an estimate nor a visit.
 *
 * Driven through the HTTP API: create the job, then open it. The `job.findFirst` the row-scope
 * check runs is HONOURED against the row the create actually wrote, so a fixture cannot answer
 * for a predicate that does not match it. The failure mode being guarded is a silent 403.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, CUSTOMER_FIXTURE, LOCATION_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

const mockPrisma = prisma as unknown as Record<string, any>;

const JOB_ID = 'j0000000-0000-0000-0000-0000000000aa';
const SALES_ID = TEST_USERS.sales.id;

/** The row the create wrote, as the database would hold it: a creator, and NO trip. */
let storedJob: { id: string; organization_id: string; created_by_id: string | null; visits: unknown[] } | null = null;

/** Honour the row-scope fragment scopeWhereFor builds, so a wrong arm is a 403 and not a pass. */
function matchesFragment(row: NonNullable<typeof storedJob>, frag: Record<string, any>): boolean {
  return Object.entries(frag).every(([key, value]) => {
    switch (key) {
      case 'id':
        return row.id === value;
      case 'organization_id':
        return row.organization_id === value;
      case 'created_by_id':
        return row.created_by_id === value;
      case 'visits':
        // No trip at all, so nothing can match a crew predicate through it.
        return false;
      case 'estimate':
        // Standalone job - no estimate to own via its lead.
        return false;
      case 'OR':
        return (value as Record<string, any>[]).some((v) => matchesFragment(row, v));
      case 'AND':
        return (value as Record<string, any>[]).every((v) => matchesFragment(row, v));
      default:
        throw new Error(`honouring fake does not understand where key: ${key}`);
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  storedJob = null;

  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
  mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

  // The per-user capability an admin toggles on for a salesperson.
  mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
    { action: 'create', subject: 'Job', effect: 'allow' },
  ]);

  mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => unknown) =>
    fn({
      job: {
        create: vi.fn().mockImplementation(async ({ data }: any) => {
          storedJob = {
            id: JOB_ID,
            organization_id: ALPHA_ORG_ID,
            created_by_id: data?.created_by_id ?? null,
            visits: [],
          };
          return { id: JOB_ID, job_number: 'J00001', visits: [] };
        }),
      },
      estimate: { update: vi.fn().mockResolvedValue({}) },
      timelineEvent: { create: vi.fn() },
    }),
  );

  // Existence probe, then the detail read - both by id, both scoped by the caller already.
  mockPrisma.job.findUnique.mockImplementation(async () =>
    storedJob ? { id: JOB_ID, job_number: 'J00001', status: 'UNSCHEDULED', created_by_id: storedJob.created_by_id, visits: [], invoices: [], dispatcher: null, estimate: null, sub_status: null } : null,
  );
  mockPrisma.job.findFirst.mockImplementation(async ({ where }: any) =>
    storedJob && matchesFragment(storedJob, where ?? {}) ? { id: JOB_ID } : null,
  );
});

describe('the `Create jobs` per-user capability', () => {
  it('lets a salesperson open the standalone job they just created', async () => {
    mockAuthAs('sales');
    // mockAuthAs resets the override default to "none", so the granted capability is re-armed
    // AFTER it - this test is about a salesperson who HAS the toggle.
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'create', subject: 'Job', effect: 'allow' },
    ]);

    const created = await request(app)
      .post('/api/jobs')
      .set(authHeader('sales'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(created.status).toBe(201);
    expect(storedJob!.created_by_id).toBe(SALES_ID);

    const opened = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('sales'));

    expect(opened.status).toBe(200);
  });
});
