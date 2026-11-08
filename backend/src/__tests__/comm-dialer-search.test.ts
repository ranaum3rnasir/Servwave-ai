/**
 * comm-dialer-search.test.ts — the dialer's canonical search endpoint.
 *
 * The legacy dialer searched a frontend mock index (inventory jobs + comm
 * contacts joined by demo-seed linkedJobIds) so real customers and jobs never
 * surfaced (#666, #357). GET /api/communication/dialer-search searches the
 * REAL tenant data: customers by name/number/phone (scalar + phones[] via the
 * shared phone-search clauses), jobs by job number / customer name (grant-
 * scoped), plus identity resolution for phone-shaped queries via matchByPhone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, TEST_USERS, mockAuthAs, authHeader } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const CUSTOMER_ROW = {
  id: 'c1000000-0000-0000-0000-000000000001',
  first_name: 'ZZ-TEST',
  last_name: 'CTM',
  company_name: null,
  phone: '5555550199',
  secondary_phone: null,
  phones: [{ phone: '9294039424' }],
  service_locations: [{ address_line1: '1 Main St', city: 'Newark', state: 'NJ' }],
  jobs: [
    {
      id: 'ab000000-0000-0000-0000-000000000001',
      job_number: 'J00077',
      status: 'SCHEDULED',
      service_location: { address_line1: '1 Main St', city: 'Newark' },
    },
  ],
};

const JOB_ROW = {
  id: 'ab000000-0000-0000-0000-000000000002',
  job_number: 'J00088',
  status: 'IN_PROGRESS',
  customer: { id: CUSTOMER_ROW.id, first_name: 'ZZ-TEST', last_name: 'CTM', company_name: null, phone: '5555550199' },
  service_location: { address_line1: '2 Oak Ave', city: 'Jersey City' },
};

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  p.customer.findMany.mockResolvedValue([]);
  p.job.findMany.mockResolvedValue([]);
  // matchByPhone lookups — unmatched unless a test overrides.
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
});

describe('GET /api/communication/dialer-search', () => {
  it('401s unauthenticated', async () => {
    const anon = await request(app).get('/api/communication/dialer-search?q=zz');
    expect(anon.status).toBe(401);
  });

  // Email slice 8a gave TECHNICIAN `read Communication`, so the route guard lets
  // them in. The customer group still does NOT: it is gated all-or-nothing on
  // `read Customer`, which TECHNICIAN has never held. The jobs group comes back
  // under their own OWN_JOB scope. This route degrades rather than 403s because
  // the jobs + identity groups are legitimately theirs.
  it('serves a TECHNICIAN but returns an EMPTY customer group (no read Customer)', async () => {
    mockAuthAs('technician');
    const tech = await request(app)
      .get('/api/communication/dialer-search?q=zz')
      .set(authHeader('technician'));
    expect(tech.status).toBe(200);
    expect(tech.body.customers).toEqual([]);
    expect(p.customer.findMany).not.toHaveBeenCalled();
  });

  it('400s a too-short query', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .get('/api/communication/dialer-search?q=z')
      .set(authHeader('dispatcher'));
    expect(res.status).toBe(400);
  });

  it('finds customers by name with their open jobs embedded, org-scoped', async () => {
    mockAuthAs('dispatcher');
    p.customer.findMany.mockResolvedValue([CUSTOMER_ROW]);

    const res = await request(app)
      .get('/api/communication/dialer-search?q=ZZ-TEST')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const args = p.customer.findMany.mock.calls[0][0];
    expect(args.where.organization_id).toBe(ALPHA_ORG_ID);
    expect(args.take).toBe(5);
    // Open jobs are embedded and exclude terminal statuses.
    expect(args.select.jobs.where.status).toEqual({ notIn: ['COMPLETED', 'CANCELLED'] });
    expect(args.select.jobs.take).toBe(5);

    expect(res.body.customers).toEqual([
      {
        id: CUSTOMER_ROW.id,
        name: 'ZZ-TEST CTM',
        phone: '5555550199',
        site: '1 Main St, Newark',
        openJobs: [
          { id: CUSTOMER_ROW.jobs[0].id, number: 'J00077', status: 'SCHEDULED', location: '1 Main St, Newark' },
        ],
      },
    ]);
    expect(res.body.query).toEqual({ isPhone: false, e164: null });
    expect(res.body.identity).toBeNull();
  });

  it('finds jobs by job number under the caller job grant scope', async () => {
    mockAuthAs('dispatcher');
    p.job.findMany.mockResolvedValue([JOB_ROW]);

    const res = await request(app)
      .get('/api/communication/dialer-search?q=J00088')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const args = p.job.findMany.mock.calls[0][0];
    expect(args.where.organization_id).toBe(ALPHA_ORG_ID);
    expect(args.where.OR).toEqual(
      expect.arrayContaining([{ job_number: { contains: 'J00088', mode: 'insensitive' } }]),
    );
    expect(res.body.jobs).toEqual([
      {
        id: JOB_ROW.id,
        number: 'J00088',
        status: 'IN_PROGRESS',
        location: '2 Oak Ave, Jersey City',
        customer: { id: CUSTOMER_ROW.id, name: 'ZZ-TEST CTM', phone: '5555550199' },
      },
    ]);
  });

  it('resolves identity for a phone-shaped query and searches by phone clauses', async () => {
    mockAuthAs('dispatcher');
    p.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_ROW.id,
      first_name: 'ZZ-TEST',
      last_name: 'CTM',
      company_name: null,
    });
    p.customer.findMany.mockResolvedValue([CUSTOMER_ROW]);

    const res = await request(app)
      .get('/api/communication/dialer-search?q=(555)%20555-0199')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ isPhone: true, e164: '+15555550199' });
    expect(res.body.identity).toEqual({
      kind: 'customer',
      id: CUSTOMER_ROW.id,
      label: 'ZZ-TEST CTM',
      customerId: CUSTOMER_ROW.id,
      leadId: null,
      vendorId: null,
    });
    // The customer search where carries phone clauses (scalar + phones[] relation).
    const args = p.customer.findMany.mock.calls[0][0];
    const orJson = JSON.stringify(args.where.OR);
    expect(orJson).toContain('"phone"');
    expect(orJson).toContain('"phones"');
  });

  it('returns empty groups + null identity for an unknown phone-shaped query', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .get('/api/communication/dialer-search?q=2015550000')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      query: { isPhone: true, e164: '+12015550000' },
      customers: [],
      jobs: [],
      identity: null,
    });
  });
});

/**
 * ROW-SCOPE COMPOSITION. The job group spreads the grant-driven scope fragment from
 * scopeWhereForReq(req,'Job') into the same object literal it puts its search terms in. While a
 * technician's fragment was `{ assignees: { some: … } }` those were different keys and the spread
 * survived; the technician-ownership spec (Part C) widened `read Job` to
 * `{ OR: [assigned, created] }`, and the LAST `OR:` in an object literal wins - which silently
 * deleted the scope and returned EVERY job in the org (number, status, customer name and phone,
 * service address) to any technician in a phone-enabled org.
 *
 * Asserted on the composed `where` rather than on the response, because the response is whatever
 * the mock returns - the leak is in the query, so the query is what has to be checked.
 */
describe('GET /api/communication/dialer-search - the job group keeps its row scope', () => {
  /** Every top-level clause of a where, flattened through the AND-demotion addOrFilter performs. */
  function flatten(where: Record<string, any>): Record<string, any>[] {
    const out = [where];
    for (const clause of (where.AND ?? []) as Record<string, any>[]) out.push(...flatten(clause));
    return out;
  }

  it('ANDs the search terms with a row-scoped grant instead of overwriting it', async () => {
    mockAuthAs('technician');
    await request(app).get('/api/communication/dialer-search?q=J000').set(authHeader('technician'));

    const where = p.job.findMany.mock.calls[0][0].where;
    const clauses = flatten(where);

    // The scope survives: one of the composed clauses is the technician's own read fragment.
    const scopeClause = clauses.find((c) => JSON.stringify(c.OR ?? '').includes('created_by_id'));
    expect(scopeClause, `row scope missing from ${JSON.stringify(where)}`).toBeDefined();
    expect(scopeClause!.OR).toEqual([
      // S8 (D6): the own-arm is the visits path now.
      { visits: { some: { assignees: { some: { user_id: TEST_USERS.technician.id } } } } },
      { created_by_id: TEST_USERS.technician.id },
    ]);

    // ...and so do the search terms, as a SEPARATE required clause.
    const searchClause = clauses.find((c) => JSON.stringify(c.OR ?? '').includes('job_number'));
    expect(searchClause, `search terms missing from ${JSON.stringify(where)}`).toBeDefined();
    expect(searchClause).not.toBe(scopeClause);

    // Tenancy is never in question, but assert it so a future refactor of this where cannot drop it.
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('leaves the cheap shape alone for an org-wide reader', async () => {
    // DISPATCHER's read is unconditional, so the fragment is {} and there is nothing to demote.
    mockAuthAs('dispatcher');
    await request(app).get('/api/communication/dialer-search?q=J000').set(authHeader('dispatcher'));

    const where = p.job.findMany.mock.calls[0][0].where;
    expect(where.AND).toBeUndefined();
    expect(JSON.stringify(where.OR)).toContain('job_number');
  });
});
