/**
 * Visits-and-task-categories slice 04 — GET /api/customers/:id/schedule.
 *
 * The customer page's Schedule tab lists every visit of every job and every walkthrough visit
 * of every lead as its own row. This endpoint is the per-visit feed behind it: unpaged (so
 * "every visit" holds however many jobs the customer has), tenant-scoped, and row-scoped with the
 * requester's own Job / Lead read scope - the same scope the jobs and leads lists apply.
 *
 * Prisma is mocked (the house seam), so tenancy and scoping are asserted on the `where` that
 * reaches the query, the way customers-row-scope.test.ts does it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { clearTokenCache } from '../middleware/authenticate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const URL = `/api/customers/${CUSTOMER_FIXTURE.id}/schedule`;
const ORG_ID = TEST_USERS.admin.organization_id;

const crew = (id: string, first: string, last: string) => ({ user: { id, first_name: first, last_name: last } });

function visitRow(over: Record<string, unknown>) {
  return {
    id: 'v-x',
    visit_seq: 1,
    status: 'SCHEDULED',
    scheduled_at: new Date('2026-10-01T14:00:00.000Z'),
    scheduled_end: new Date('2026-10-01T16:00:00.000Z'),
    is_all_day: false,
    created_at: new Date('2026-09-20T00:00:00.000Z'),
    assignees: [],
    ...over,
  };
}

const THREE_VISIT_JOB = {
  id: 'job-3v',
  job_number: 'J00044',
  status: 'SCHEDULED',
  scope_notes: 'Replace garage door',
  visits: [
    visitRow({ id: 'v1', visit_seq: 1, scheduled_at: new Date('2026-10-01T14:00:00.000Z'), assignees: [crew('u1', 'Ana', 'Lee')] }),
    visitRow({ id: 'v2', visit_seq: 2, scheduled_at: new Date('2026-10-03T14:00:00.000Z'), assignees: [crew('u2', 'Ben', 'Ortiz')] }),
    visitRow({ id: 'v3', visit_seq: 3, scheduled_at: new Date('2026-10-05T14:00:00.000Z'), assignees: [crew('u1', 'Ana', 'Lee'), crew('u3', 'Cy', 'Park')] }),
  ],
};

const LEAD_WITH_TWO_WALKTHROUGHS = {
  id: 'lead-2w',
  lead_number: 'L00075',
  status: 'NEW',
  service_request: 'Quote a new gate',
  visits: [
    visitRow({ id: 'w1', visit_seq: 1, status: 'CANCELLED', scheduled_at: new Date('2026-09-28T15:00:00.000Z') }),
    visitRow({ id: 'w2', visit_seq: 2, scheduled_at: new Date('2026-10-02T15:00:00.000Z'), assignees: [crew('u4', 'Dee', 'Shah')] }),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  // The resolved user (and its org_features) is cached per token; the STARTER case needs a fresh one.
  clearTokenCache();
  mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: null });
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);
});

describe('GET /api/customers/:id/schedule — one entry per visit', () => {
  it('returns every visit of a job, each with its own id, number, status, window and crew', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([THREE_VISIT_JOB]);

    const res = await request(app).get(URL).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    const job = res.body.jobs[0];
    expect(job).toMatchObject({ id: 'job-3v', job_number: 'J00044', scope_notes: 'Replace garage door' });
    expect(job.visits.map((v: { id: string }) => v.id)).toEqual(['v1', 'v2', 'v3']);
    expect(job.visits[0]).toEqual({
      id: 'v1',
      visit_seq: 1,
      status: 'SCHEDULED',
      scheduled_at: '2026-10-01T14:00:00.000Z',
      scheduled_end: '2026-10-01T16:00:00.000Z',
      is_all_day: false,
      created_at: '2026-09-20T00:00:00.000Z',
      crew: [{ id: 'u1', first_name: 'Ana', last_name: 'Lee' }],
    });
    // Crew is per visit, never the job-wide union.
    expect(job.visits[1].crew).toEqual([{ id: 'u2', first_name: 'Ben', last_name: 'Ortiz' }]);
    expect(job.visits[2].crew.map((c: { id: string }) => c.id)).toEqual(['u1', 'u3']);
  });

  it('returns every walkthrough visit of every lead, cancelled ones included (the tab marks them)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_WITH_TWO_WALKTHROUGHS]);

    const res = await request(app).get(URL).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0]).toMatchObject({ id: 'lead-2w', lead_number: 'L00075', service_request: 'Quote a new gate' });
    expect(res.body.leads[0].visits.map((v: { id: string; status: string }) => [v.id, v.status]))
      .toEqual([['w1', 'CANCELLED'], ['w2', 'SCHEDULED']]);
    expect(res.body.leads[0].visits[1].crew).toEqual([{ id: 'u4', first_name: 'Dee', last_name: 'Shah' }]);
  });

  it('is unpaged: no take/skip reaches either query', async () => {
    mockAuthAs('admin');
    await request(app).get(URL).set(authHeader('admin'));

    const jobArgs = mockPrisma.job.findMany.mock.calls[0][0];
    const leadArgs = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(jobArgs.take).toBeUndefined();
    expect(jobArgs.skip).toBeUndefined();
    expect(leadArgs.take).toBeUndefined();
    expect(leadArgs.skip).toBeUndefined();
  });
});

describe('GET /api/customers/:id/schedule — tenant and row scoping', () => {
  it('scopes jobs, leads AND their nested visits to the requester\'s organization and this customer', async () => {
    mockAuthAs('admin');
    await request(app).get(URL).set(authHeader('admin'));

    for (const call of [mockPrisma.job.findMany.mock.calls[0][0], mockPrisma.lead.findMany.mock.calls[0][0]]) {
      const where = JSON.stringify(call.where);
      expect(where).toContain(ORG_ID);
      expect(where).toContain(CUSTOMER_FIXTURE.id);
      // The nested visit relation carries its own org filter too, so a visit row from another
      // organization can never ride along on a matching parent.
      expect(call.select.visits.where).toMatchObject({ organization_id: ORG_ID });
    }
  });

  it('keeps the customer filter even when the row scope is itself a where fragment (no key clobbering)', async () => {
    mockAuthAs('sales');
    // An associated customer, so the read gate passes and the per-row scope is what narrows.
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: TEST_USERS.sales.id });

    const res = await request(app).get(URL).set(authHeader('sales'));
    expect(res.status).toBe(200);

    for (const call of [mockPrisma.job.findMany.mock.calls[0][0], mockPrisma.lead.findMany.mock.calls[0][0]]) {
      // Every piece is its own AND arm, so a scope fragment carrying the same key cannot overwrite it.
      expect(Array.isArray(call.where.AND)).toBe(true);
      expect(call.where.AND).toEqual(expect.arrayContaining([{ customer_id: CUSTOMER_FIXTURE.id }]));
      // SALES reads only its own jobs (via estimate) and its own leads: the scope names the rep.
      expect(JSON.stringify(call.where)).toContain(TEST_USERS.sales.id);
    }
  });

  it('ADMIN: no row-scope narrowing beyond tenant + customer', async () => {
    mockAuthAs('admin');
    await request(app).get(URL).set(authHeader('admin'));
    expect(mockPrisma.job.findMany.mock.calls[0][0].where).toEqual({
      AND: [{ organization_id: ORG_ID }, {}, { customer_id: CUSTOMER_FIXTURE.id }],
    });
  });

  it('404s a customer the requester cannot read, with the same body as a missing one, and runs no schedule query', async () => {
    mockAuthAs('sales');
    // SALES reads only associated customers; this one is not theirs.
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: null });

    const res = await request(app).get(URL).set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.lead.findMany).not.toHaveBeenCalled();
  });

  it('404s a customer in another organization (tenant-scoped lookup finds nothing)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(null);

    const res = await request(app).get(URL).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
  });

  it('an org without the leads feature gets jobs only - the lead query never runs', async () => {
    mockAuthAs('admin', { plan: 'STARTER' });
    mockPrisma.job.findMany.mockResolvedValue([THREE_VISIT_JOB]);

    const res = await request(app).get(URL).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.leads).toEqual([]);
    expect(mockPrisma.lead.findMany).not.toHaveBeenCalled();
  });
});
