/**
 * The per-user capability path through `canActOnRow`.
 *
 * `canActOnRow` asks two questions: can you SEE this row (the read grant, via `scopeWhereForReq`)
 * and may you do THIS VERB to it (the verb's own grant, via `actionScopeWhereForReq`). Role grants
 * feed both. Per-user ALLOW overrides feed the read half through `overrideReadGrants`, which
 * already existed - and the verb half through `overrideActionGrants`, which this PR added.
 *
 * That second function had no test at all: deleting its contribution entirely left the whole backend
 * suite green. It is not decoration. A user whose ONLY route to `manage_lines Job` is an admin's
 * per-user toggle resolves to MATCH_NOTHING without it, and 403s on every line-item and scope route
 * on every job, permanently and silently. Two populations are in that position today:
 *
 *   - SALES, which holds no `manage_lines Job` role grant at all;
 *   - every user PR 2's 20260805130000 migration copied an existing `update Job` override onto.
 *
 * Driven through real requests rather than against the helper, because the helper being right is
 * not the claim - the claim is that an admin's toggle actually opens the door.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  ALPHA_ORG_ID,
  JOB_FIXTURE,
  mockScopedFindFirst,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

const mockPrisma = prisma as unknown as Record<string, any>;
const JOB_ID = JOB_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    status: 'SUBMITTED',
    job_number: 'J00001',
    source_plan_id: null,
    customer_id: 'cust-1',
    created_by_id: TEST_USERS.sales.id,
    tax_rate: 0,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    customer: { tax_exempt: false },
    assignees: [],
    estimate: null,
    job_line_items: [],
    invoices: [],
    scopes: [],
    scheduled_start: null,
    scheduled_end: null,
    is_all_day: false,
    service_location: { state: 'CA' },
    ...over,
  };
}

/** Grant `user` the per-user capability override an admin would flip in the Users screen. */
function withOverride(userId: string, rows: { action: string; subject: string; effect: 'allow' | 'deny' }[]) {
  clearUserOverrideCache();
  mockPrisma.userPermissionOverride.findMany.mockImplementation(
    ({ where }: { where: { user_id: string } }) =>
      Promise.resolve(where.user_id === userId ? rows : []),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.jobLineItem?.create?.mockResolvedValue({ id: LINE_ID, job_id: JOB_ID });
  mockPrisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(mockPrisma) : Promise.all(arg as Promise<unknown>[]),
  );
});

describe('a per-user `manage_lines Job` toggle opens the line-item routes', () => {
  // SALES is the sharpest case: no role grant for this action exists anywhere for them, so the
  // override is the ONLY source of authority and there is nothing else that could be letting the
  // request through.
  beforeEach(() => {
    mockAuthAs('sales');
    withOverride(TEST_USERS.sales.id, [{ action: 'manage_lines', subject: 'Job', effect: 'allow' }]);
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    mockScopedFindFirst(mockPrisma.job.findFirst, { ...jobRow(), organization_id: ALPHA_ORG_ID });
  });

  it('lets the grantee add a line to a job they created', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('sales'))
      .send({ description: 'Labor', quantity: 1, unit_price: 100 });
    expect(res.status).not.toBe(403);
  });

  it('still scopes them to their own rows - a job somebody else created is refused', async () => {
    const foreign = jobRow({ created_by_id: TEST_USERS.dispatcher.id });
    mockPrisma.job.findUnique.mockResolvedValue(foreign);
    mockScopedFindFirst(mockPrisma.job.findFirst, { ...foreign, organization_id: ALPHA_ORG_ID });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('sales'))
      .send({ description: 'Labor', quantity: 1, unit_price: 100 });
    expect(res.status).toBe(403);
    expect(mockPrisma.jobLineItem.create).not.toHaveBeenCalled();
  });

  it('confers nothing without the override - the same request on the same job is refused', async () => {
    withOverride(TEST_USERS.sales.id, []);
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('sales'))
      .send({ description: 'Labor', quantity: 1, unit_price: 100 });
    expect(res.status).toBe(403);
  });

  // The override synthesizes the capability under ITS OWN action, so it must not leak into others.
  it('does not confer a DIFFERENT verb - delete Job stays refused', async () => {
    const res = await request(app).delete(`/api/jobs/${JOB_ID}`).set(authHeader('sales'));
    expect(res.status).toBe(403);
  });
});

describe('a per-user toggle on a TECHNICIAN behaves the same way', () => {
  // This is the population PR 2's backfill created: every user who held an `update Job` override
  // got a `manage_lines Job` one copied onto it. Their access now runs through the same code path.
  it('reaches the scope routes on a job they created', async () => {
    mockAuthAs('technician');
    withOverride(TEST_USERS.technician.id, [{ action: 'manage_lines', subject: 'Job', effect: 'allow' }]);
    const own = jobRow({ created_by_id: TEST_USERS.technician.id, scopes: [] });
    mockPrisma.job.findUnique.mockResolvedValue(own);
    mockScopedFindFirst(mockPrisma.job.findFirst, { ...own, organization_id: ALPHA_ORG_ID });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/scopes`)
      .set(authHeader('technician'))
      .send({ title: 'Permit fee', flat_price: 300 });
    expect(res.status).not.toBe(403);
  });
});
