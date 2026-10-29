/**
 * Visits-and-task-categories slice 06 — GET /api/customers/:id/jobs, the customer page's Jobs tab
 * served page by page.
 *
 * The customer detail payload used to embed only the 20 newest jobs, so a long-standing customer's
 * older work was unreachable from their page. This endpoint pages through all of them, with a
 * stable order (newest first, id as the tie-break) and a total that counts exactly the rows the
 * requester can open: the same tenant + Job row scope as the Schedule tab's feed.
 *
 * Prisma is mocked (the house seam), so paging, tenancy and scoping are asserted on the arguments
 * that reach the query, the way customer-schedule.test.ts does it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, CUSTOMER_FIXTURE, ORG_B_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { clearTokenCache } from '../middleware/authenticate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const URL = `/api/customers/${CUSTOMER_FIXTURE.id}/jobs`;
const ORG_ID = TEST_USERS.admin.organization_id;

const crew = (id: string, first: string, last: string) => ({ user: { id, first_name: first, last_name: last } });

/** One job row as the paged query returns it (visits carry only the crew the tab shows). */
function jobRow(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `job-${n}`,
    job_number: `J${String(n).padStart(5, '0')}`,
    status: 'SCHEDULED',
    scope_notes: null,
    completed_at: null,
    created_at: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000),
    service_location: { address_line1: `${n} Main St`, city: 'Springfield', state: 'IL' },
    invoices: [],
    visits: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  clearTokenCache();
  mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: null });
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.job.count.mockResolvedValue(0);
});

describe('GET /api/customers/:id/jobs — numbered pages', () => {
  it('serves page 2 of a 45-job customer: rows 21-40, with the total and the page count', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([jobRow(21)]);
    mockPrisma.job.count.mockResolvedValue(45);

    const res = await request(app).get(URL).query({ page: 2, limit: 20 }).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j: { id: string }) => j.id)).toEqual(['job-21']);
    expect(res.body.pagination).toEqual({ page: 2, limit: 20, total: 45, totalPages: 3 });
    const args = mockPrisma.job.findMany.mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(20);
  });

  it('orders newest first with the id as the tie-break, so no row repeats or goes missing across pages', async () => {
    mockAuthAs('admin');
    await request(app).get(URL).set(authHeader('admin'));

    expect(mockPrisma.job.findMany.mock.calls[0][0].orderBy).toEqual([{ created_at: 'desc' }, { id: 'asc' }]);
  });

  it('keeps every column the Jobs tab shows: location, crew (the union over the visits) and invoice status', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([
      jobRow(7, {
        visits: [
          { assignees: [crew('u1', 'Ana', 'Lee')] },
          { assignees: [crew('u1', 'Ana', 'Lee'), crew('u2', 'Ben', 'Ortiz')] },
        ],
        invoices: [{ id: 'inv-1', status: 'VOIDED' }, { id: 'inv-2', status: 'SENT' }],
      }),
    ]);
    mockPrisma.job.count.mockResolvedValue(1);

    const res = await request(app).get(URL).set(authHeader('admin'));

    expect(res.status).toBe(200);
    const job = res.body.jobs[0];
    expect(job).toMatchObject({
      id: 'job-7',
      job_number: 'J00007',
      status: 'SCHEDULED',
      service_location: { address_line1: '7 Main St', city: 'Springfield', state: 'IL' },
      invoices: [{ id: 'inv-1', status: 'VOIDED' }, { id: 'inv-2', status: 'SENT' }],
    });
    expect(job.assignees.map((a: { user: { id: string } }) => a.user.id)).toEqual(['u1', 'u2']);
    // The crew union is all the tab needs from the visits; the per-visit rows stay on the schedule feed.
    expect(job.visits).toBeUndefined();
  });

  it('reads one page in a single job query plus one count (the nested relations are batched, never per row)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue(Array.from({ length: 20 }, (_, i) => jobRow(i + 1)));
    mockPrisma.job.count.mockResolvedValue(150);

    await request(app).get(URL).query({ page: 1, limit: 20 }).set(authHeader('admin'));

    expect(mockPrisma.job.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.count).toHaveBeenCalledTimes(1);
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
    const { select } = mockPrisma.job.findMany.mock.calls[0][0];
    expect(select.invoices.select).toEqual({ id: true, status: true });
    expect(select.invoices.orderBy).toEqual({ created_at: 'asc' });
  });

  it("leaves another organization's invoice out of the Invoice column, even one that points at this job", async () => {
    // Defense in depth, like the visits select: the job is in this org, but the nested invoice read
    // must carry its own tenant filter rather than trust every row hanging off the job to share it.
    // The job query is mocked, so it honours the nested `where` against this in-memory invoice table.
    const invoiceTable = [
      { id: 'inv-own', status: 'SENT', organization_id: ORG_ID, job_id: 'job-1' },
      { id: 'inv-foreign', status: 'PAID', organization_id: ORG_B_ID, job_id: 'job-1' },
    ];
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockImplementation(async ({ select }: { select: { invoices: { where?: { organization_id?: string } } } }) => {
      const where = select.invoices.where ?? {};
      const invoices = invoiceTable
        .filter((i) => i.job_id === 'job-1')
        .filter((i) => where.organization_id === undefined || i.organization_id === where.organization_id)
        .map(({ id, status }) => ({ id, status }));
      return [jobRow(1, { invoices })];
    });
    mockPrisma.job.count.mockResolvedValue(1);

    const res = await request(app).get(URL).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.jobs[0].invoices).toEqual([{ id: 'inv-own', status: 'SENT' }]);
  });
});

describe('GET /api/customers/:id/jobs — tenant and row scoping', () => {
  it('ADMIN: tenant + customer, and the count asks the same question as the page', async () => {
    mockAuthAs('admin');
    await request(app).get(URL).set(authHeader('admin'));

    const pageWhere = mockPrisma.job.findMany.mock.calls[0][0].where;
    expect(pageWhere).toEqual({ AND: [{ organization_id: ORG_ID }, {}, { customer_id: CUSTOMER_FIXTURE.id }] });
    expect(mockPrisma.job.count.mock.calls[0][0].where).toEqual(pageWhere);
  });

  it('a scoped role pages only the jobs it can open, and its total counts only those', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: TEST_USERS.sales.id });

    const res = await request(app).get(URL).set(authHeader('sales'));
    expect(res.status).toBe(200);

    const pageWhere = mockPrisma.job.findMany.mock.calls[0][0].where;
    expect(pageWhere.AND).toEqual(expect.arrayContaining([{ organization_id: ORG_ID }, { customer_id: CUSTOMER_FIXTURE.id }]));
    // SALES reads only its own jobs: the scope arm names the rep.
    expect(JSON.stringify(pageWhere)).toContain(TEST_USERS.sales.id);
    expect(mockPrisma.job.count.mock.calls[0][0].where).toEqual(pageWhere);
  });

  it('pages the same job set the Schedule tab feed reads (one where, so the two tabs cannot drift)', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: TEST_USERS.sales.id });
    mockPrisma.lead.findMany.mockResolvedValue([]);

    await request(app).get(URL).set(authHeader('sales'));
    await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}/schedule`).set(authHeader('sales'));

    const [pageCall, scheduleCall] = mockPrisma.job.findMany.mock.calls;
    expect(pageCall[0].where).toEqual(scheduleCall[0].where);
  });

  it('404s a customer the requester cannot read, with the same body as a missing one, and runs no job query', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: null });

    const res = await request(app).get(URL).set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.job.count).not.toHaveBeenCalled();
  });

  it('404s a customer in another organization (the tenant-scoped lookup finds nothing)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(null);

    const res = await request(app).get(URL).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/customers/:id/jobs — each job carries its Scheduled date, computed by the job-window rule', () => {
  // The same rule every job payload's `scheduled_start` follows (lib/job-schedule-projection.ts),
  // so the Jobs tab needs no per-visit feed and cannot disagree with the Schedule tab.
  const v = (status: string, iso: string | null, over: Record<string, unknown> = {}) => ({
    status,
    scheduled_at: iso ? new Date(iso) : null,
    scheduled_end: iso ? new Date(new Date(iso).getTime() + 2 * 3_600_000) : null,
    is_all_day: false,
    created_at: new Date('2020-01-01T00:00:00.000Z'),
    assignees: [],
    ...over,
  });

  async function scheduled(visits: unknown[]) {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([jobRow(1, { visits })]);
    mockPrisma.job.count.mockResolvedValue(1);
    const res = await request(app).get(URL).set(authHeader('admin'));
    expect(res.status).toBe(200);
    return res.body.jobs[0];
  }

  it('is the next upcoming live visit, not the job\'s first or last one', async () => {
    const job = await scheduled([
      v('COMPLETED', '2020-10-01T14:00:00.000Z'),
      v('SCHEDULED', '2099-10-05T14:00:00.000Z'),
      v('SCHEDULED', '2099-10-03T14:00:00.000Z', { is_all_day: true }),
    ]);
    expect(job.scheduled_start).toBe('2099-10-03T14:00:00.000Z');
    expect(job.is_all_day).toBe(true);
    expect(job.visits).toBeUndefined();
  });

  it('never picks a cancelled visit, however soon it is', async () => {
    const job = await scheduled([v('CANCELLED', '2099-10-02T09:00:00.000Z'), v('SCHEDULED', '2099-10-06T14:00:00.000Z')]);
    expect(job.scheduled_start).toBe('2099-10-06T14:00:00.000Z');
  });

  it('a finished job (no live visit left) keeps its earliest non-cancelled visit', async () => {
    const job = await scheduled([
      v('CANCELLED', '2020-09-01T14:00:00.000Z'),
      v('COMPLETED', '2020-09-10T14:00:00.000Z'),
      v('COMPLETED', '2020-09-12T14:00:00.000Z'),
    ]);
    expect(job.scheduled_start).toBe('2020-09-10T14:00:00.000Z');
  });

  it('a job running late (only an elapsed live visit) shows that visit', async () => {
    const job = await scheduled([v('COMPLETED', '2020-09-01T14:00:00.000Z'), v('SCHEDULED', '2020-09-20T14:00:00.000Z')]);
    expect(job.scheduled_start).toBe('2020-09-20T14:00:00.000Z');
  });

  it('a job with no visit, only untimed ones, or only cancelled ones has no date', async () => {
    expect((await scheduled([])).scheduled_start).toBeNull();
    expect((await scheduled([v('SCHEDULED', null)])).scheduled_start).toBeNull();
    expect((await scheduled([v('CANCELLED', '2099-01-01T14:00:00.000Z')])).scheduled_start).toBeNull();
  });

  it('asks the visit query for exactly the columns the rule reads, tenant-filtered', async () => {
    mockAuthAs('admin');
    await request(app).get(URL).set(authHeader('admin'));
    const { visits } = mockPrisma.job.findMany.mock.calls[0][0].select;
    expect(visits.where).toEqual({ organization_id: ORG_ID });
    expect(visits.select).toMatchObject({ status: true, scheduled_at: true, scheduled_end: true, is_all_day: true, created_at: true });
  });
});
