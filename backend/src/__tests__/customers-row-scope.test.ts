/**
 * #2041 — row-scope composition on list / stats / `_count` / getById, per role, including the
 * filter-composition cases (`has_leads`, `open_leads`, `search`, `city`) that prove the scope
 * survives alongside an existing `OR` / `leads` / `jobs` clause (decision 1's clobber hazard).
 *
 * These assert the actual `where`/`select` shapes reaching the mocked Prisma call — reverting any
 * ONE composition line in `customer.controller.ts` reddens the matching assertion here (mutation
 * over reading, per the test plan).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, mockRoleGrantsWithout, CUSTOMER_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { logger } from '../lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const SALES_ID = TEST_USERS.sales.id;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  mockPrisma.customer.findMany.mockResolvedValue([]);
  mockPrisma.customer.count.mockResolvedValue(0);
});

/** Does `where` (or any AND-nested fragment) carry the OWN_CUSTOMER shape tied to `userId`? */
function hasOwnCustomerScope(where: unknown, userId: string): boolean {
  const s = JSON.stringify(where ?? {});
  return s.includes(userId) && (s.includes('lead_assignees') || s.includes('created_by_id'));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// GET /api/customers — list where composition
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /api/customers — row-scope composition', () => {
  it('SALES: where carries the OWN_CUSTOMER scope under AND', async () => {
    mockAuthAs('sales');

    await request(app).get('/api/customers').set(authHeader('sales'));

    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(hasOwnCustomerScope(where, SALES_ID)).toBe(true);
  });

  it('SALES + has_leads=true: the scope survives alongside the has_leads filter (decision 1 clobber hazard)', async () => {
    mockAuthAs('sales');

    await request(app).get('/api/customers?has_leads=true').set(authHeader('sales'));

    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    // has_leads sets where.leads directly — the scope's OWN OR-union must NOT have overwritten it.
    expect(where.leads).toEqual({ some: {} });
    expect(hasOwnCustomerScope(where, SALES_ID)).toBe(true);
  });

  it('SALES + open_leads=true: survives alongside where.leads.some.status', async () => {
    mockAuthAs('sales');

    await request(app).get('/api/customers?open_leads=true').set(authHeader('sales'));

    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(where.leads?.some?.status).toBeDefined();
    expect(hasOwnCustomerScope(where, SALES_ID)).toBe(true);
  });

  it('SALES + search=qa: survives alongside the search where.OR', async () => {
    mockAuthAs('sales');

    await request(app).get('/api/customers?search=qa-2041').set(authHeader('sales'));

    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(Array.isArray(where.OR)).toBe(true);
    expect(hasOwnCustomerScope(where, SALES_ID)).toBe(true);
  });

  it('SALES + city=Austin: survives alongside the location filter', async () => {
    mockAuthAs('sales');

    await request(app).get('/api/customers?city=Austin').set(authHeader('sales'));

    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(where.service_locations?.some?.city).toBeDefined();
    expect(hasOwnCustomerScope(where, SALES_ID)).toBe(true);
  });

  it('SALES + page=2: the scope still applies on later pages', async () => {
    mockAuthAs('sales');

    await request(app).get('/api/customers?page=2&limit=10').set(authHeader('sales'));

    const call = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(call.skip).toBe(10);
    expect(hasOwnCustomerScope(call.where, SALES_ID)).toBe(true);
  });

  it('ADMIN: no row-scope AND clause is added (unconditional)', async () => {
    mockAuthAs('admin');

    await request(app).get('/api/customers').set(authHeader('admin'));

    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(where.AND).toBeUndefined();
  });

  it('DISPATCHER: unchanged, unconditional read Customer', async () => {
    mockAuthAs('dispatcher');

    await request(app).get('/api/customers').set(authHeader('dispatcher'));

    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(where.AND).toBeUndefined();
  });

  it('a role with NO read Customer grant at all fails closed — 403 at the route guard, findMany never runs', async () => {
    mockAuthAs('sales');
    mockRoleGrantsWithout('SALES', ['read', 'Customer']);

    const res = await request(app).get('/api/customers').set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('_count follows the requester\'s OWN Lead/Job scope, not a bare {leads:true,jobs:true}', async () => {
    mockAuthAs('sales');

    await request(app).get('/api/customers').set(authHeader('sales'));

    const select = mockPrisma.customer.findMany.mock.calls[0][0].select;
    expect(select._count.select.leads).not.toBe(true);
    expect(select._count.select.jobs).not.toBe(true);
    expect(select._count.select.leads.where).toBeDefined();
    expect(select._count.select.jobs.where).toBeDefined();
  });

  // Visits slice 06 (defense in depth): a job or lead row another organization points at one of
  // this org's customers is never counted - the tenant arm sits beside the row scope, which is `{}`
  // for ADMIN and so cannot be relied on to carry it.
  it('the list\'s _count is tenant-scoped too: a cross-org job or lead pointing at a customer is not counted', async () => {
    mockAuthAs('admin');

    await request(app).get('/api/customers').set(authHeader('admin'));

    const tenant = { organization_id: TEST_USERS.admin.organization_id };
    const counts = mockPrisma.customer.findMany.mock.calls[0][0].select._count.select;
    expect(counts.jobs.where).toEqual({ AND: expect.arrayContaining([tenant]) });
    expect(counts.leads.where).toEqual({ AND: expect.arrayContaining([tenant]) });
  });

  it('the export\'s _count is tenant-scoped too', async () => {
    mockAuthAs('admin');

    await request(app).get('/api/customers/export').set(authHeader('admin'));

    const tenant = { organization_id: TEST_USERS.admin.organization_id };
    const counts = mockPrisma.customer.findMany.mock.calls[0][0].select._count.select;
    expect(counts.jobs.where).toEqual({ AND: expect.arrayContaining([tenant]) });
    expect(counts.leads.where).toEqual({ AND: expect.arrayContaining([tenant]) });
  });

  it('R1 — a proof-carrying lead-assigned row (not created-by) survives the in-memory pass', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([
      {
        ...CUSTOMER_FIXTURE,
        id: 'c-lead-assigned',
        created_by_id: null,
        leads: [{ lead_assignees: [{ user_id: SALES_ID }] }],
        jobs: [],
      },
    ]);
    mockPrisma.customer.count.mockResolvedValue(1);

    const res = await request(app).get('/api/customers').set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.customers.map((c: { id: string }) => c.id)).toContain('c-lead-assigned');
    // Proof keys never leak onto the wire.
    expect(res.body.customers[0]).not.toHaveProperty('leads');
    expect(res.body.customers[0]).not.toHaveProperty('jobs');
    expect(res.body.customers[0]).not.toHaveProperty('created_by_id');
  });

  it('R1 — a row the SQL where let through but that fails the in-memory proof check is dropped and warn-logged', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([
      { ...CUSTOMER_FIXTURE, id: 'c-unowned', created_by_id: null, leads: [], jobs: [] },
    ]);
    mockPrisma.customer.count.mockResolvedValue(1);

    const res = await request(app).get('/api/customers').set(authHeader('sales'));

    expect(res.body.customers.map((c: { id: string }) => c.id)).not.toContain('c-unowned');
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// GET /api/customers/stats
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /api/customers/stats — row-scope composition', () => {
  it('SALES: every one of the four counts carries the scope', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.count.mockResolvedValue(3);

    await request(app).get('/api/customers/stats').set(authHeader('sales'));

    const wheres = mockPrisma.customer.count.mock.calls.map((c: unknown[]) => (c[0] as { where: unknown }).where);
    expect(wheres.length).toBe(4);
    for (const w of wheres) expect(hasOwnCustomerScope(w, SALES_ID)).toBe(true);
  });

  it('SALES: the leads/jobs-filtered counts (3rd/4th) keep BOTH their own filter AND the scope (decision 1)', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.count.mockResolvedValue(1);

    await request(app).get('/api/customers/stats').set(authHeader('sales'));

    const wheres = mockPrisma.customer.count.mock.calls.map((c: unknown[]) => (c[0] as { where: Record<string, unknown> }).where);
    const leadsCountWhere = wheres[2];
    const jobsCountWhere = wheres[3];
    expect(leadsCountWhere.leads).toBeDefined();
    expect(hasOwnCustomerScope(leadsCountWhere, SALES_ID)).toBe(true);
    expect(jobsCountWhere.jobs).toBeDefined();
    expect(hasOwnCustomerScope(jobsCountWhere, SALES_ID)).toBe(true);
  });

  it('ADMIN: no AND scope on any count', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.count.mockResolvedValue(9);

    await request(app).get('/api/customers/stats').set(authHeader('admin'));

    const wheres = mockPrisma.customer.count.mock.calls.map((c: unknown[]) => (c[0] as { where: Record<string, unknown> }).where);
    for (const w of wheres) expect(w.AND).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// GET /api/customers/:id — 404 on an unassociated customer, 200 on an owned one
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /api/customers/:id — row-scope 404, per role', () => {
  function mockSummaryQueries() {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ lifetime_revenue: '0', total_invoiced: '0', past_due_balance: '0', due_balance: '0', unpaid_invoice_count: '0', paid_invoice_count: '0' }])
      .mockResolvedValueOnce([{ total: '0', pending: '0', approved: '0', total_value: '0' }])
      .mockResolvedValueOnce([{ deposits_collected: '0', deposits_pending: '0' }]);
  }

  it('SALES, unassociated customer -> 404, same body a cross-org id gets', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: null });

    const res = await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });
  });

  it('SALES, associated (created_by_id) customer -> 200', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: SALES_ID });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    const res = await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('DISPATCHER: unchanged, 200 regardless of association', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: null });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    const res = await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
  });

  it('getById\'s own _count follows the requester\'s Lead/Job scope', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: SALES_ID });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('sales'));

    // The decision-3 probe call has no `_count`; the detail Promise.all call does.
    const withCount = mockPrisma.customer.findUnique.mock.calls.find((c: unknown[]) => (c[0] as { select?: { _count?: unknown } }).select?._count);
    expect(withCount).toBeDefined();
    const countSelect = (withCount![0] as { select: { _count: { select: { leads: { where: unknown }; jobs: { where: unknown } } } } }).select._count.select;
    expect(countSelect.leads.where).toBeDefined();
    expect(countSelect.jobs.where).toBeDefined();
  });

  // Visits slice 06: every count the customer page shows counts only the rows its reader can open.
  function detailCall() {
    return mockPrisma.customer.findUnique.mock.calls.find((c: unknown[]) => (c[0] as { select?: { _count?: unknown } }).select?._count)![0] as {
      select: { jobs: { where: unknown }; _count: { select: { jobs: { where: unknown } } } };
    };
  }

  it('the embedded jobs follow the requester\'s Job scope - the same scope as the _count beside them', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: SALES_ID });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('sales'));

    const { select } = detailCall();
    expect(JSON.stringify(select.jobs.where)).toContain(SALES_ID);
    expect(select.jobs.where).toEqual(select._count.select.jobs.where);
  });

  it('the embedded jobs and the job count are tenant-scoped too: a cross-org job pointing at this customer is excluded from both', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: null });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('admin'));

    // ADMIN has no row scope, so the tenant arm is the only thing between this customer and a job
    // row another organization points at it.
    const { select } = detailCall();
    const tenant = { organization_id: TEST_USERS.admin.organization_id };
    expect(select.jobs.where).toEqual(expect.objectContaining({ AND: expect.arrayContaining([tenant]) }));
    expect(select._count.select.jobs.where).toEqual(expect.objectContaining({ AND: expect.arrayContaining([tenant]) }));
  });

  it('the lead count beside them is tenant-scoped too: a cross-org lead pointing at this customer is not counted', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: null });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('admin'));

    const counts = (detailCall().select._count.select as unknown as { leads: { where: unknown } });
    expect(counts.leads.where).toEqual({ AND: expect.arrayContaining([{ organization_id: TEST_USERS.admin.organization_id }]) });
  });

  it('Active Jobs counts the requester\'s active jobs across every page, not the embedded newest 20', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: SALES_ID, jobs: [] });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(23);
    mockSummaryQueries();

    const res = await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.summary.jobs).toEqual({ active: 23 });
    const where = JSON.stringify(mockPrisma.job.count.mock.calls[0][0].where);
    expect(where).toContain(SALES_ID);
    expect(where).toContain(CUSTOMER_FIXTURE.id);
    expect(where).toContain(TEST_USERS.sales.organization_id);
    for (const status of ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS']) expect(where).toContain(status);
  });

  it('Open Leads and Active Leads count only the leads the requester can open', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: SALES_ID });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('sales'));

    const leadCounts = mockPrisma.lead.count.mock.calls.map((c: unknown[]) => JSON.stringify((c[0] as { where: unknown }).where));
    expect(leadCounts).toHaveLength(2);
    for (const where of leadCounts) expect(where).toContain(SALES_ID);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// GET /api/customers/:id/communications — row-scope 404 (round-2 fix-up)
//
// This sub-route was the one AC2 miss the localhost acceptance round found live: the handler
// (job-communications.controller.ts::getCustomerCommunications) kept the bare subject-level
// `req.ability?.can('read','Customer')` probe and a tenant-only `findUnique`, so an in-org
// customer the requester is not associated with came back 200 `{"items":[]}` instead of the same
// 404 every sibling sub-route (`/:id`, `/summary`, `POST /:id/notes`, ...) already gives. That is
// an enumeration oracle — a SALES rep could tell "exists, not mine" (200) apart from "doesn't
// exist" (404) on this one route.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /api/customers/:id/communications — row-scope 404', () => {
  function mockEmptyCommSources() {
    mockPrisma.callSession.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
    mockPrisma.manualCommunicationLog.findMany.mockResolvedValue([]);
  }

  it('SALES, unassociated customer -> 404, byte-identical to the nonexistent-id 404', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: null });
    mockEmptyCommSources();

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}/communications`)
      .set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });

    mockPrisma.customer.findUnique.mockResolvedValue(null);
    const missing = await request(app)
      .get(`/api/customers/00000000-0000-0000-0000-0000000000ee/communications`)
      .set(authHeader('sales'));

    expect(missing.status).toBe(res.status);
    expect(missing.body).toEqual(res.body);
  });

  it('SALES, associated (created_by_id) customer -> 200', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: SALES_ID });
    mockEmptyCommSources();

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}/communications`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('ADMIN: unchanged, 200 regardless of association', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: null });
    mockEmptyCommSources();

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}/communications`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });
});
