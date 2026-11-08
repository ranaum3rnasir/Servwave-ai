import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { allocateNumber } from '../lib/numbering';
import {
  TEST_USERS,
  ALPHA_ORG_ID,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
} from './helpers';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  customer: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  serviceLocation: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  lead: { count: ReturnType<typeof vi.fn> };
  job: { count: ReturnType<typeof vi.fn> };
  task: { count: ReturnType<typeof vi.fn> };
  invoice: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  payment: { count: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  note: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  $queryRaw: ReturnType<typeof vi.fn>;
  $transaction: ReturnType<typeof vi.fn>;
  timelineEvent: { create: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  // Duplicate-customer guard runs prisma.customer.findMany before the create
  // transaction. Default to "no existing match" so create-path tests that don't
  // care about the guard keep their pre-guard behavior; per-test overrides win.
  mockPrisma.customer.findMany.mockResolvedValue([]);
});

// ═══════════════════════════════════════════════════════
// GET /api/customers
// ═══════════════════════════════════════════════════════

describe('GET /api/customers', () => {
  it('returns paginated customer list', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_FIXTURE]);
    mockPrisma.customer.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/customers')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ page: 1, total: 1 });
  });

  it('returns only the primary location for each customer in list view', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app).get('/api/customers').set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.select.service_locations).toEqual({
      where: { is_primary: true },
      take: 1,
      select: expect.objectContaining({ address_line1: true }),
    });
  });

  it('passes search param to where clause', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?search=John')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.where.OR).toBeDefined();
    expect(findManyArgs.where.OR.length).toBeGreaterThan(0);
  });

  it('includes extra_emails in search OR conditions', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?search=billing@test.com')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    const orConditions = findManyArgs.where.OR;
    const hasExtraEmailCondition = orConditions.some(
      (c: Record<string, unknown>) => c.extra_emails !== undefined
    );
    expect(hasExtraEmailCondition).toBe(true);
  });

  it('digit-normalizes a phone search so a digits-only query matches a formatted store (#350)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?search=5551234567')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    const phoneContains = (findManyArgs.where.OR as Array<Record<string, unknown>>)
      .filter((c) => (c as { phone?: { contains?: string } }).phone?.contains !== undefined)
      .map((c) => (c as { phone: { contains: string } }).phone.contains);

    // Must offer both the digits-only form (digits-stored match) AND the canonical
    // formatted form (so the same query finds a `(555) 123-4567` store).
    expect(phoneContains).toContain('5551234567');
    expect(phoneContains).toContain('(555) 123-4567');
  });

  it('includes phones[] relation clause in search OR (#460)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?search=5551234567')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    const phonesContains = (findManyArgs.where.OR as Array<Record<string, unknown>>)
      .filter((c) => (c as { phones?: { some?: { phone?: { contains?: string } } } }).phones?.some?.phone?.contains !== undefined)
      .map((c) => (c as { phones: { some: { phone: { contains: string } } } }).phones.some.phone.contains);

    // A number stored only in phones[] must be reachable by both the digits-only
    // and the canonical formatted form of the query.
    expect(phonesContains).toContain('5551234567');
    expect(phonesContains).toContain('(555) 123-4567');
  });

  it('adds NO phones clause for a non-phone search term (#460)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?search=John')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    const hasPhonesClause = (findManyArgs.where.OR as Array<Record<string, unknown>>).some(
      (c) => (c as { phones?: unknown }).phones !== undefined,
    );
    expect(hasPhonesClause).toBe(false);
  });

  it('includes service_locations when search is present', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?search=John')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.select.service_locations).toBeDefined();
  });

  it('applies multi-value ad_source filter with { in: [] }', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?ad_source[]=Google&ad_source[]=Facebook')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.where.ad_source).toEqual({ in: ['Google', 'Facebook'] });
  });

  it('applies single ad_source as exact match for backward compat', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?ad_source=Google')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.where.ad_source).toBe('Google');
  });

  it('applies multi-value state filter via service_locations', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?state[]=TX&state[]=CA')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.where.service_locations).toEqual({
      some: { state: { in: ['TX', 'CA'] } },
    });
  });

  it('applies multi-value payment_type filter', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?payment_type[]=COD&payment_type[]=NET 30')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.where.payment_type).toEqual({ in: ['COD', 'NET 30'] });
  });

  it('applies tax_exempt=true as a boolean filter', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?tax_exempt=true')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.where.tax_exempt).toBe(true);
  });

  it('applies tax_exempt=false as a boolean filter', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?tax_exempt=false')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.where.tax_exempt).toBe(false);
  });

  it('ignores tax_exempt when both true and false are selected (no filter)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers?tax_exempt[]=true&tax_exempt[]=false')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.where.tax_exempt).toBeUndefined();
  });

  // Task 16 — # of Leads countRange facet, wired through the live endpoint.
  it('filters by leads_min/leads_max (countRange facet)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    const atLeastOne = ['cust-with-3-leads'];
    (prisma.lead.groupBy as any).mockImplementation((args: any) => {
      const having = args?.having?.customer_id?._count;
      if (having?.gte !== undefined) return Promise.resolve(atLeastOne.map((id) => ({ customer_id: id })));
      return Promise.resolve([]);
    });

    await request(app)
      .get('/api/customers?leads_min=1')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.where.id).toEqual({ in: atLeastOne });
  });

  // Task 16 — # of Jobs countRange facet, exercising both min AND max on the
  // SAME facet (single-facet in/notIn merge via mergeIdFilter).
  it('filters by jobs_min/jobs_max (countRange facet)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    const atLeastOne = ['cust-with-2-jobs', 'cust-with-5-jobs'];
    const overThree = ['cust-with-5-jobs'];
    (prisma.job.groupBy as any).mockImplementation((args: any) => {
      const having = args?.having?.customer_id?._count;
      if (having?.gte !== undefined) return Promise.resolve(atLeastOne.map((id) => ({ customer_id: id })));
      if (having?.gt !== undefined) return Promise.resolve(overThree.map((id) => ({ customer_id: id })));
      return Promise.resolve([]);
    });

    await request(app)
      .get('/api/customers?jobs_min=1&jobs_max=3')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.where.AND).toEqual([
      { id: { in: atLeastOne } },
      { id: { notIn: overThree } },
    ]);
  });

  // Task 16 — the DOUBLE countRange case: leads_min AND jobs_min together.
  // This is exactly the scenario Task 3's mergeIdFilter was built and
  // reviewed for — neither facet's id-filter may clobber the other's.
  it('composes leads_min AND jobs_min without either clobbering the other (double countRange)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    const leadsAtLeastOne = ['cust-a', 'cust-b'];
    const jobsAtLeastOne = ['cust-b', 'cust-c'];
    (prisma.lead.groupBy as any).mockImplementation((args: any) => {
      const having = args?.having?.customer_id?._count;
      if (having?.gte !== undefined) return Promise.resolve(leadsAtLeastOne.map((id) => ({ customer_id: id })));
      return Promise.resolve([]);
    });
    (prisma.job.groupBy as any).mockImplementation((args: any) => {
      const having = args?.having?.customer_id?._count;
      if (having?.gte !== undefined) return Promise.resolve(jobsAtLeastOne.map((id) => ({ customer_id: id })));
      return Promise.resolve([]);
    });

    await request(app)
      .get('/api/customers?leads_min=1&jobs_min=1')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    // customerFacets registers leads BEFORE jobs, so leads' id-filter lands
    // first via mergeIdFilter's `where.id` branch, then jobs' AND-appends via
    // the `where.AND` branch — both survive, neither overwrites the other.
    expect(findManyArgs.where.AND).toEqual([
      { id: { in: leadsAtLeastOne } },
      { id: { in: jobsAtLeastOne } },
    ]);
  });

  it('returns 401 without auth header', async () => {
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(401);
  });

  it('returns 403 for TECHNICIAN role', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get('/api/customers')
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });

  it('includes customer_number in list select', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findManyArgs.select.customer_number).toBe(true);
  });

  it('accepts sortBy=customer_number', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/customers?sortBy=customer_number&sortDir=asc')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    // SRVW-89 - parseSortParams now always returns an orderBy array.
    expect(findManyArgs.orderBy).toEqual([{ customer_number: 'asc' }]);
  });

  // SRVW-89 - deliberate inversion of the old "accepts sortBy=phone" case. `phone` was
  // allowlisted but the Customers Phone column is enableSorting:false and no shipped column
  // ever emits it, so it is a dead entry the map drops rather than wires up. Rejecting it with
  // a 400 is the intended behaviour, not a regression.
  it('rejects sortBy=phone (dead allowlist entry, dropped from the map)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/customers?sortBy=phone&sortDir=desc')
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SORT_FIELD');
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('list select includes city/state/zip in primary service_location (address guarantee)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app)
      .get('/api/customers')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    const locationSelect = findManyArgs.select.service_locations?.select;
    expect(locationSelect).toBeDefined();
    expect(locationSelect.city).toBe(true);
    expect(locationSelect.state).toBe(true);
    expect(locationSelect.zip).toBe(true);
  });

  it('open_leads=true filters customers having an open lead', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);
    await request(app).get('/api/customers?open_leads=true').set(authHeader('admin'));
    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(where.leads).toEqual({ some: { status: { in: ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'] } } });
  });

  it('active_jobs=true filters customers having an active job', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);
    await request(app).get('/api/customers?active_jobs=true').set(authHeader('admin'));
    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    // S4 (D17): EN_ROUTE/ON_SITE retired from JobStatus. A customer whose tech is on the way or
    // on site still reads as having an active job - that job now derives SCHEDULED or IN_PROGRESS.
    expect(where.jobs).toEqual({ some: { status: { in: ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'] } } });
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/customers
// ═══════════════════════════════════════════════════════

describe('POST /api/customers', () => {
  const validBody = {
    first_name: 'Jane',
    last_name: 'Smith',
    email: 'jane@smith.com',
    phone: '5559876543',
  };

  it('creates a customer without locations', async () => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = { customer: { create: vi.fn().mockResolvedValue({ id: 'new-id', ...validBody, service_locations: [] }) } };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.customer.first_name).toBe('Jane');
  });

  it('creates a customer with locations', async () => {
    mockAuthAs('admin');
    const body = {
      ...validBody,
      locations: [{
        address_line1: '456 Oak Ave',
        city: 'Dallas',
        state: 'TX',
        zip: '75201',
      }],
    };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = { customer: { create: vi.fn().mockResolvedValue({ id: 'new-id', ...body, service_locations: [] }) } };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send(body);

    expect(res.status).toBe(201);
  });

  it('creates a customer with an empty email (email now optional)', async () => {
    mockAuthAs('admin');
    let txCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCreate = vi.fn().mockResolvedValue({ id: 'new-id', ...validBody, email: null, service_locations: [] });
      const txMock = { customer: { create: txCreate } };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...validBody, email: '' });

    expect(res.status).toBe(201);
    // Empty email normalizes away — it must not be persisted as an empty string.
    const createArgs = txCreate!.mock.calls[0][0];
    expect(createArgs.data.email ?? null).toBeNull();
  });

  it('creates a person customer with only first name + phone (last name + email optional)', async () => {
    mockAuthAs('admin');
    let txCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCreate = vi.fn().mockResolvedValue({ id: 'new-id', first_name: 'Jane', service_locations: [] });
      const txMock = { customer: { create: txCreate } };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', phone: '5559876543' });

    expect(res.status).toBe(201);
    const createArgs = txCreate!.mock.calls[0][0];
    expect(createArgs.data.last_name ?? null).toBeNull();
    expect(createArgs.data.email ?? null).toBeNull();
  });

  it('creates a customer with extra_emails', async () => {
    mockAuthAs('admin');
    const body = {
      ...validBody,
      extra_emails: [
        { email: 'billing@smith.com', label: 'Billing' },
        { email: 'office@smith.com' },
      ],
    };
    let txCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCreate = vi.fn().mockResolvedValue({ id: 'new-id', ...body, service_locations: [] });
      const txMock = { customer: { create: txCreate } };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send(body);

    expect(res.status).toBe(201);
    const createArgs = txCreate!.mock.calls[0][0];
    expect(createArgs.data.extra_emails.create).toHaveLength(2);
    expect(createArgs.data.extra_emails.create[0].email).toBe('billing@smith.com');
    expect(createArgs.data.extra_emails.create[0].label).toBe('Billing');
  });

  it('rejects invalid extra_email format', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...validBody, extra_emails: [{ email: 'not-an-email' }] });

    expect(res.status).toBe(400);
  });

  it('returns 400 when a customer has neither phone nor email', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane' }); // no phone, no email

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('creates a customer with email only, no phone (SERV10X-35)', async () => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = { customer: { create: vi.fn().mockResolvedValue({ id: 'new-id', first_name: 'Jane', service_locations: [] }) } };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', email: 'jane@example.com' });

    expect(res.status).toBe(201);
  });

  it('creates a customer with phone only, no email (SERV10X-35)', async () => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = { customer: { create: vi.fn().mockResolvedValue({ id: 'new-id', first_name: 'Jane', service_locations: [] }) } };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', phone: '5551234567' });

    expect(res.status).toBe(201);
  });

  it('creates a company-only customer (no first/last name)', async () => {
    mockAuthAs('admin');
    const body = {
      company_name: 'Ivory & Bone Design',
      email: 'orders@ivoryandbone.com',
      phone: '5551234567',
    };
    let txCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCreate = vi.fn().mockResolvedValue({ id: 'new-id', ...body, service_locations: [] });
      const txMock = { customer: { create: txCreate } };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send(body);

    expect(res.status).toBe(201);
    const createArgs = txCreate!.mock.calls[0][0];
    expect(createArgs.data.company_name).toBe('Ivory & Bone Design');
  });

  it('rejects customer with neither person name nor company', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ email: 'foo@bar.com', phone: '5551234567' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('accepts a customer with only first_name (last_name no longer required)', async () => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = { customer: { create: vi.fn().mockResolvedValue({ id: 'new-id', first_name: 'Jane', service_locations: [] }) } };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', email: 'jane@example.com', phone: '5551234567' });

    expect(res.status).toBe(201);
  });

  it('returns 400 for phone too short', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Smith', email: 'jane@smith.com', phone: '123' });

    expect(res.status).toBe(400);
  });

  it('creates a customer with payment_type', async () => {
    mockAuthAs('admin');
    const body = { ...validBody, payment_type: 'NET 30' };
    let txCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCreate = vi.fn().mockResolvedValue({ id: 'new-id', ...body, service_locations: [] });
      const txMock = { customer: { create: txCreate } };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send(body);

    expect(res.status).toBe(201);
    const createArgs = txCreate!.mock.calls[0][0];
    expect(createArgs.data.payment_type).toBe('NET 30');
  });

  it('rejects payment_type longer than 100 characters', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...validBody, payment_type: 'A'.repeat(101) });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid state in location', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({
        ...validBody,
        locations: [{ address_line1: '123 Main', city: 'Austin', state: 'TEX', zip: '78701' }],
      });

    expect(res.status).toBe(400);
  });

  it('returns 201 for SALES role (#1472 - SALES gained create Customer)', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('sales'))
      .send(validBody);

    expect(res.status).toBe(201);
  });

  it('returns 403 for TECHNICIAN role', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('technician'))
      .send(validBody);

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/customers — customer_number generation
// ═══════════════════════════════════════════════════════

describe('POST /api/customers (customer_number generation)', () => {
  it('allocates customer_number C00001 on create', async () => {
    mockAuthAs('admin');
    const createdCustomer = {
      id: 'new-id',
      first_name: 'Jane',
      last_name: 'Smith',
      email: 'jane@smith.com',
      phone: '5559876543',
      customer_number: 'C00001',
      extra_emails: [],
      service_locations: [],
    };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        customer: {
          create: vi.fn().mockResolvedValue(createdCustomer),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Smith', email: 'jane@smith.com', phone: '5559876543' });

    expect(res.status).toBe(201);
    expect(res.body.customer.customer_number).toBe('C00001');
    expect(allocateNumber).toHaveBeenCalledWith(expect.anything(), 'customer', ALPHA_ORG_ID);
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/customers/:id
// ═══════════════════════════════════════════════════════

describe('GET /api/customers/:id', () => {
  // Zero-value summary mocks for getById (which now bundles summary)
  const zeroFinancials = [{ lifetime_revenue: '0', total_invoiced: '0', past_due_balance: '0', due_balance: '0', unpaid_invoice_count: '0', paid_invoice_count: '0' }];
  const zeroEstimates = [{ total: '0', pending: '0', approved: '0', total_value: '0' }];
  const zeroDeposits = [{ deposits_collected: '0', deposits_pending: '0' }];

  function mockSummaryQueries() {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(zeroFinancials)
      .mockResolvedValueOnce(zeroEstimates)
      .mockResolvedValueOnce(zeroDeposits);
  }

  it('returns customer details with notes and summary', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === CUSTOMER_FIXTURE.id) return Promise.resolve(CUSTOMER_FIXTURE);
      // For user lookup
      const user = Object.values(TEST_USERS).find(u => u.id === args.where.id);
      return Promise.resolve(user || null);
    });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.customer.id).toBe(CUSTOMER_FIXTURE.id);
    // Polymorphic Note rows are returned under `activity_notes` (not `notes`) so they
    // don't clobber the scalar free-text `notes` column the edit form binds.
    expect(res.body.customer.activity_notes).toEqual([]);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.financials).toMatchObject({ lifetime_revenue: 0 });
  });

  it('returns lead and task counts in summary', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === CUSTOMER_FIXTURE.id) return Promise.resolve(CUSTOMER_FIXTURE);
      const user = Object.values(TEST_USERS).find(u => u.id === args.where.id);
      return Promise.resolve(user || null);
    });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();
    // open (2: e.g. one NEW + one CONTACTED) then active (1: the CONTACTED) — distinct values prove active ⊆ open
    mockPrisma.lead.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    // one TODO task linked to the customer; FINISHED tasks excluded by the where
    mockPrisma.task.count.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.summary.leads).toEqual({ open: 2, active: 1 });
    expect(res.body.summary.tasks).toEqual({ open: 1 });
    // Issue 03: the count must exclude BOTH terminal statuses, and must read them from the
    // one constant rather than naming DONE on its own.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskWhere = (mockPrisma.task.count.mock.calls[0][0] as any).where;
    expect(taskWhere.status).toEqual({ notIn: ['DONE', 'CANCELLED'] });
  });

  it('counts a lead in a walkthrough status as open, and as active (not NEW)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === CUSTOMER_FIXTURE.id) return Promise.resolve(CUSTOMER_FIXTURE);
      const user = Object.values(TEST_USERS).find(u => u.id === args.where.id);
      return Promise.resolve(user || null);
    });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.task.count.mockResolvedValue(0);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statusSets = mockPrisma.lead.count.mock.calls.map((c: any[]) =>
      (c[0].where.AND as any[]).find((clause) => clause.status)?.status.in as string[],
    );
    expect(statusSets).toEqual([
      ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'],
      ['CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'],
    ]);
  });

  it('keeps the scalar notes string separate from the Note[] rows (no [object Object])', async () => {
    mockAuthAs('admin');
    const withNote = { ...CUSTOMER_FIXTURE, notes: 'Gate code 1234' };
    mockPrisma.customer.findUnique.mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === CUSTOMER_FIXTURE.id) return Promise.resolve(withNote);
      return Promise.resolve(Object.values(TEST_USERS).find((u) => u.id === args.where.id) || null);
    });
    mockPrisma.note.findMany.mockResolvedValue([
      { id: 'n1', content: 'Called re: pump', created_at: new Date('2026-02-01'), creator: { id: 'u1', first_name: 'Sue', last_name: 'Ross' } },
    ]);
    mockSummaryQueries();

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // The scalar free-text note stays a string (what the edit form reads) — never the array.
    expect(res.body.customer.notes).toBe('Gate code 1234');
    // The Note rows surface under their own key for the detail page's notes list.
    expect(res.body.customer.activity_notes).toHaveLength(1);
    expect(res.body.customer.activity_notes[0].content).toBe('Called re: pump');
  });

  it('reaches orphan/estimate-anchored invoices via Invoice.customer_id and drops job.is_urgent', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.note.findMany.mockResolvedValue([]);
    (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'orphan-1', invoice_number: 'I00010', status: 'SENT', kind: 'STANDARD', total_amount: 500, amount_due: 500, payments: [] },
    ]);
    mockSummaryQueries();

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // orphan invoices surfaced separately
    expect(res.body.customer.orphan_invoices).toHaveLength(1);
    expect(res.body.customer.orphan_invoices[0].invoice_number).toBe('I00010');
    // orphan query reaches invoices via customer_id (job-less)
    const invArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(invArgs.where.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(invArgs.where.job_id).toBeNull();
    // job select no longer reads is_urgent
    const custArgs = (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(custArgs.select.jobs.select.is_urgent).toBeUndefined();
  });

  // Multi-visit S8 (D6): the nested job select reaches crew through the TRIPS, because
  // `Job.assignees` went with `job_assignees`. The customer detail page's Jobs tab still reads
  // `job.assignees` and falls back to "Unassigned" when the key is missing, so the payload has to
  // carry the derived union - the same one the jobs list and the job detail serve.
  it('serves each job\'s crew under `assignees`, derived from the trips', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...CUSTOMER_FIXTURE,
      jobs: [
        {
          id: 'job-1',
          job_number: 'J00042',
          status: 'SCHEDULED',
          visits: [
            { assignees: [{ user: { id: 'user-pat', first_name: 'Pat', last_name: 'Plumber' } }] },
            // Same person on a second trip, plus a different one - the union is deduped.
            { assignees: [
              { user: { id: 'user-pat', first_name: 'Pat', last_name: 'Plumber' } },
              { user: { id: 'user-hal', first_name: 'Hal', last_name: 'Hvac' } },
            ] },
          ],
          invoices: [],
        },
      ],
    });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const job = res.body.customer.jobs[0];
    expect(job.assignees.map((a: { user: { id: string } }) => a.user.id)).toEqual(['user-pat', 'user-hal']);
  });

  it('returns 404 for non-existent customer', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    const res = await request(app)
      .get('/api/customers/00000000-0000-0000-0000-999999999999')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('allows SALES to view customer', async () => {
    mockAuthAs('sales');
    // #2041 — SALES's read/update Customer grant is now row-scoped (OWN_CUSTOMER); this fixture
    // must be associated with the SALES test user or the new scope check 404s it.
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: TEST_USERS.sales.id });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('includes standalone invoices in customer.invoices with flattened job_number', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.note.findMany.mockResolvedValue([]);
    // First findMany call: orphan query (job_id: null) — empty
    // Second findMany call: customer-anchored all-invoices — both job-linked and standalone
    (prisma.invoice.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'inv-1', invoice_number: 'I00001', status: 'PAID', kind: 'STANDARD',
          total_amount: 300, amount_due: 0, due_date: null, created_at: new Date(),
          job: { id: 'job-1', job_number: 'J00001' }, payments: [],
        },
        {
          id: 'inv-2', invoice_number: 'I00002', status: 'SENT', kind: 'STANDARD',
          total_amount: 500, amount_due: 500, due_date: null, created_at: new Date(),
          job: null, payments: [],
        },
      ]);
    mockSummaryQueries();

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.customer.invoices).toHaveLength(2);
    const jobLinked = res.body.customer.invoices.find((i: { id: string }) => i.id === 'inv-1');
    expect(jobLinked.job_number).toBe('J00001');
    const standalone = res.body.customer.invoices.find((i: { id: string }) => i.id === 'inv-2');
    expect(standalone.job_number).toBeNull();
  });

  it('customer.invoices query excludes DEPOSIT-kind invoices', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.note.findMany.mockResolvedValue([]);
    (prisma.invoice.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])  // orphan query (job_id: null)
      .mockResolvedValueOnce([]); // all-invoices query
    mockSummaryQueries();

    await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: { not: 'DEPOSIT' } }),
      })
    );
  });

  it('maps financials from customer-anchored SQL result', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.note.findMany.mockResolvedValue([]);
    (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{
        lifetime_revenue: 100, total_invoiced: 200, past_due_balance: 0,
        due_balance: 50, paid_invoice_count: 1, unpaid_invoice_count: 1,
      }])
      .mockResolvedValueOnce(zeroEstimates)
      .mockResolvedValueOnce(zeroDeposits);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.summary.financials).toEqual({
      lifetime_revenue: 100,
      total_invoiced: 200,
      past_due_balance: 0,
      due_balance: 50,
      paid_invoice_count: 1,
      unpaid_invoice_count: 1,
    });
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/customers/:id
// ═══════════════════════════════════════════════════════

describe('PATCH /api/customers/:id', () => {
  it('updates customer fields', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, first_name: 'Updated' });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ first_name: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.customer.first_name).toBe('Updated');
  });

  it('returns 400 when a PATCH would clear the customer\'s only contact method (SERV10X-35)', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...CUSTOMER_FIXTURE,
      phone: '5551234567',
      email: null,
    });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ phone: null });

    expect(res.status).toBe(400);
    expect(mockPrisma.customer.update).not.toHaveBeenCalled();
  });

  it('allows a PATCH that leaves the other contact method intact (SERV10X-35)', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...CUSTOMER_FIXTURE,
      phone: '5551234567',
      email: 'jane@example.com',
    });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, phone: null });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ phone: null });

    expect(res.status).toBe(200);
  });

  it('allows an unrelated PATCH on a phone-only customer to pass through untouched (SERV10X-35)', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...CUSTOMER_FIXTURE,
      phone: '5551234567',
      email: null,
    });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, first_name: 'Updated' });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ first_name: 'Updated' });

    expect(res.status).toBe(200);
  });

  it('updates extra_emails with delete-all + re-create', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, extra_emails: [{ id: 'e1', email: 'new@test.com', label: 'Office' }] });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ extra_emails: [{ email: 'new@test.com', label: 'Office' }] });

    expect(res.status).toBe(200);
    const updateArgs = mockPrisma.customer.update.mock.calls[0][0];
    expect(updateArgs.data.extra_emails.deleteMany).toEqual({});
    expect(updateArgs.data.extra_emails.create).toHaveLength(1);
    expect(updateArgs.data.extra_emails.create[0].email).toBe('new@test.com');
  });

  it('updates payment_type', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, payment_type: 'COD' });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ payment_type: 'COD' });

    expect(res.status).toBe(200);
    const updateArgs = mockPrisma.customer.update.mock.calls[0][0];
    expect(updateArgs.data.payment_type).toBe('COD');
  });

  it('clears payment_type with null', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...CUSTOMER_FIXTURE, payment_type: 'NET 30' });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, payment_type: null });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ payment_type: null });

    expect(res.status).toBe(200);
    const updateArgs = mockPrisma.customer.update.mock.calls[0][0];
    expect(updateArgs.data.payment_type).toBeNull();
  });

  it('returns 404 for non-existent customer', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/customers/00000000-0000-0000-0000-999999999999')
      .set(authHeader('admin'))
      .send({ first_name: 'Updated' });

    expect(res.status).toBe(404);
  });

  it('allows SALES to update customer', async () => {
    mockAuthAs('sales');
    // #2041 — SALES's read/update Customer grant is now row-scoped (OWN_CUSTOMER); this fixture
    // must be associated with the SALES test user or the new scope check 404s it.
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: TEST_USERS.sales.id });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, first_name: 'Updated' });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ first_name: 'Updated' });

    expect(res.status).toBe(200);
  });

  it('admin can set created_at', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_at: new Date('2020-05-01') });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ created_at: '2020-05-01' });

    expect(res.status).toBe(200);
    const updateArgs = mockPrisma.customer.update.mock.calls[0][0];
    expect(updateArgs.data.created_at).toEqual(new Date('2020-05-01'));
  });

  it('non-admin created_at is silently ignored', async () => {
    mockAuthAs('sales');
    // #2041 — SALES's read/update Customer grant is now row-scoped (OWN_CUSTOMER); this fixture
    // must be associated with the SALES test user or the new scope check 404s it.
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: TEST_USERS.sales.id });
    mockPrisma.customer.update.mockResolvedValue(CUSTOMER_FIXTURE);

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ created_at: '2020-05-01' });

    expect(res.status).toBe(200);
    const updateArgs = mockPrisma.customer.update.mock.calls[0][0];
    expect(updateArgs.data).not.toHaveProperty('created_at');
  });

  it('rejects created_at in the future with 400', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ created_at: '2999-01-01' });

    expect(res.status).toBe(400);
  });

  it('created_at is NOT re-applied when the sent date matches the existing calendar date', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue(CUSTOMER_FIXTURE);

    // Same calendar date as CUSTOMER_FIXTURE.created_at (2026-01-01) — no dirty change.
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ created_at: '2026-01-01' });

    expect(res.status).toBe(200);
    const updateArgs = mockPrisma.customer.update.mock.calls[0][0];
    expect(updateArgs.data).not.toHaveProperty('created_at');
  });

  it('created_at IS applied when the sent date differs from the existing calendar date', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_at: new Date('2020-03-15') });

    // Different from CUSTOMER_FIXTURE.created_at (2026-01-01) — dirty, should apply.
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ created_at: '2020-03-15' });

    expect(res.status).toBe(200);
    const updateArgs = mockPrisma.customer.update.mock.calls[0][0];
    expect(updateArgs.data).toHaveProperty('created_at');
  });

  it('re-derives kind to COMPANY when company_name is added on update (no client kind field exists anymore)', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...CUSTOMER_FIXTURE,
      first_name: 'Jane',
      company_name: null,
      kind: 'PERSON',
    });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, company_name: 'Chestnut', kind: 'COMPANY' });

    await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ company_name: 'Chestnut' });

    expect(mockPrisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'COMPANY' }) }),
    );
  });

  it('re-derives kind to PERSON when company_name is cleared on update', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...CUSTOMER_FIXTURE,
      first_name: 'Jane',
      company_name: 'Chestnut',
      kind: 'COMPANY',
    });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, company_name: null, kind: 'PERSON' });

    await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ company_name: null });

    expect(mockPrisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'PERSON' }) }),
    );
  });

  it('a PATCH that does not touch first_name/company_name never writes kind', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...CUSTOMER_FIXTURE, kind: 'PERSON' });
    mockPrisma.customer.update.mockResolvedValue(CUSTOMER_FIXTURE);

    await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ notes: 'called back' });

    const callData = mockPrisma.customer.update.mock.calls[0][0].data;
    expect(callData.kind).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/customers/:id
// ═══════════════════════════════════════════════════════

describe('DELETE /api/customers/:id', () => {
  it('deletes customer when no leads or jobs', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.customer.delete.mockResolvedValue(CUSTOMER_FIXTURE);

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Customer deleted');
  });

  it('returns 400 when customer has leads', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.lead.count.mockResolvedValue(3);
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('leads or jobs');
  });

  it('returns 400 when customer has jobs', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.job.count.mockResolvedValue(2);

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent customer', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/customers/00000000-0000-0000-0000-999999999999')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('returns 403 for SALES role', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/customers/:id/locations
// ═══════════════════════════════════════════════════════

describe('POST /api/customers/:id/locations', () => {
  const validLocation = {
    address_line1: '789 Elm St',
    city: 'Houston',
    state: 'TX',
    zip: '77001',
  };

  it('adds a location to customer', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.create.mockResolvedValue({ id: 'loc-new', ...validLocation });

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/locations`)
      .set(authHeader('admin'))
      .send(validLocation);

    expect(res.status).toBe(201);
    expect(res.body.location.address_line1).toBe('789 Elm St');
  });

  it('clears other primaries when is_primary is true', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.serviceLocation.create.mockResolvedValue({ id: 'loc-new', ...validLocation, is_primary: true });

    await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/locations`)
      .set(authHeader('admin'))
      .send({ ...validLocation, is_primary: true });

    expect(mockPrisma.serviceLocation.updateMany).toHaveBeenCalled();
  });

  it('returns 404 if customer not found', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/customers/00000000-0000-0000-0000-999999999999/locations')
      .set(authHeader('admin'))
      .send(validLocation);

    expect(res.status).toBe(404);
  });

  it('allows SALES to add location', async () => {
    mockAuthAs('sales');
    // #2041 — SALES's read/update Customer grant is now row-scoped (OWN_CUSTOMER); this fixture
    // must be associated with the SALES test user or the new scope check 404s it.
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: TEST_USERS.sales.id });
    mockPrisma.serviceLocation.create.mockResolvedValue({ id: 'loc-new', ...validLocation });

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/locations`)
      .set(authHeader('sales'))
      .send(validLocation);

    expect(res.status).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/customers/:id/locations/:locId
// ═══════════════════════════════════════════════════════

describe('PATCH /api/customers/:id/locations/:locId', () => {
  it('updates a location', async () => {
    mockAuthAs('admin');
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    mockPrisma.serviceLocation.update.mockResolvedValue({ ...LOCATION_FIXTURE, city: 'Dallas' });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ city: 'Dallas' });

    expect(res.status).toBe(200);
    expect(res.body.location.city).toBe('Dallas');
  });

  it('returns 404 if location not found', async () => {
    mockAuthAs('admin');
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/nonexistent`)
      .set(authHeader('admin'))
      .send({ city: 'Dallas' });

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/customers/:id/locations/:locId
// ═══════════════════════════════════════════════════════

describe('DELETE /api/customers/:id/locations/:locId', () => {
  it('deletes location when no jobs or leads reference it', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    // non-primary so the primary invariant does not trip; >1 active so last-active passes
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ ...LOCATION_FIXTURE, is_primary: false });
    mockPrisma.serviceLocation.count.mockResolvedValue(2);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.serviceLocation.delete.mockResolvedValue(LOCATION_FIXTURE);

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Location deleted');
  });

  it('archives (not 400) when location has jobs (§10)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ ...LOCATION_FIXTURE, is_primary: false });
    mockPrisma.serviceLocation.count.mockResolvedValue(2);
    mockPrisma.job.count.mockResolvedValue(1);
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.serviceLocation.update.mockResolvedValue({ ...LOCATION_FIXTURE, is_active: false });

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);
    expect(mockPrisma.serviceLocation.delete).not.toHaveBeenCalled();
  });

  it('returns 404 if location not found', async () => {
    mockAuthAs('admin');
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/nonexistent`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('returns 403 for SALES role', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/customers/stats
// ═══════════════════════════════════════════════════════

describe('GET /api/customers/stats', () => {
  it('returns all four stat counts (activeLeads/activeJobs count customers)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.count
      .mockResolvedValueOnce(42)   // total
      .mockResolvedValueOnce(5)    // newThisMonth
      .mockResolvedValueOnce(12)   // activeLeads (customers with an open lead)
      .mockResolvedValueOnce(3);   // activeJobs (customers with an active job)

    const res = await request(app)
      .get('/api/customers/stats')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 42,
      newThisMonth: 5,
      activeLeads: 12,
      activeJobs: 3,
    });

    const wheres = mockPrisma.customer.count.mock.calls.map((c) => c[0].where);
    expect(wheres).toContainEqual(
      expect.objectContaining({ leads: { some: { status: { in: ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'] } } } }),
    );
    expect(wheres).toContainEqual(
      expect.objectContaining({ jobs: { some: { status: { in: ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'] } } } }),
    );
  });

  it('is accessible by SALES role', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.count.mockResolvedValue(0);
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.job.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/customers/stats')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('returns 403 for TECHNICIAN role', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get('/api/customers/stats')
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/customers/export
// ═══════════════════════════════════════════════════════

describe('GET /api/customers/export', () => {
  it('returns all customers without pagination', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_FIXTURE]);

    const res = await request(app)
      .get('/api/customers/export')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    expect(res.body.pagination).toBeUndefined();
  });

  it('is accessible by DISPATCHER role', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/customers/export')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
  });

  it('returns 403 for TECHNICIAN role', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get('/api/customers/export')
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });

  // 018 — SALES lost `export Customer`; read/update on Customer are untouched. Full
  // both-directions coverage (and the DISPATCHER blast-radius pins) lives in
  // customer-export-rbac.test.ts; this keeps the role enumeration in this block honest.
  it('returns 403 for SALES role', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .get('/api/customers/export')
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/customers/:id/summary
// ═══════════════════════════════════════════════════════

describe('GET /api/customers/:id/summary', () => {
  const mockFinancials = [{
    lifetime_revenue: '12450.00',
    total_invoiced: '13650.00',
    past_due_balance: '800.00',
    due_balance: '400.00',
    unpaid_invoice_count: '1',
    paid_invoice_count: '3',
  }];
  const mockEstimates = [{
    total: '5',
    pending: '1',
    approved: '3',
    total_value: '18000.00',
  }];
  const mockDeposits = [{
    deposits_collected: '2000.00',
    deposits_pending: '500.00',
  }];

  it('returns financial summary for a customer', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(mockFinancials)
      .mockResolvedValueOnce(mockEstimates)
      .mockResolvedValueOnce(mockDeposits);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}/summary`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.financials).toMatchObject({
      lifetime_revenue: 12450,
      total_invoiced: 13650,
      past_due_balance: 800,
      due_balance: 400,
    });
    expect(res.body.estimates).toMatchObject({
      total: 5,
      pending: 1,
      approved: 3,
      total_value: 18000,
    });
    expect(res.body.deposits).toMatchObject({
      collected: 2000,
      pending: 500,
    });
  });

  it('returns zeroes for customer with no financial data', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ lifetime_revenue: '0', total_invoiced: '0', past_due_balance: '0', due_balance: '0', unpaid_invoice_count: '0', paid_invoice_count: '0' }])
      .mockResolvedValueOnce([{ total: '0', pending: '0', approved: '0', total_value: '0' }])
      .mockResolvedValueOnce([{ deposits_collected: '0', deposits_pending: '0' }]);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}/summary`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.financials.lifetime_revenue).toBe(0);
    expect(res.body.financials.past_due_balance).toBe(0);
    expect(res.body.financials.due_balance).toBe(0);
  });

  it('returns 404 for non-existent customer', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await request(app)
      .get('/api/customers/00000000-0000-0000-0000-999999999999/summary')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('allows SALES role to access summary', async () => {
    mockAuthAs('sales');
    // #2041 — SALES's read/update Customer grant is now row-scoped (OWN_CUSTOMER); this fixture
    // must be associated with the SALES test user or the new scope check 404s it.
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: TEST_USERS.sales.id });
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(mockFinancials)
      .mockResolvedValueOnce(mockEstimates)
      .mockResolvedValueOnce(mockDeposits);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}/summary`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('returns 403 for TECHNICIAN role', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}/summary`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });

  it('uses customer-anchored financials (shared helper) — numbers match the mocked $queryRaw row', async () => {
    // This test proves getSummary is wired to the shared loadCustomerFinancials helper:
    // the $queryRaw mock resolves a specific known row and we assert getSummary's response
    // financials equal it exactly. The SQL anchors on customer_id (not jobs), so standalone
    // invoices are included — the same query getById uses.
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{
        lifetime_revenue: '5500.00',
        total_invoiced: '6000.00',
        past_due_balance: '250.00',
        due_balance: '750.00',
        unpaid_invoice_count: '2',
        paid_invoice_count: '4',
      }])
      .mockResolvedValueOnce([{ total: '3', pending: '1', approved: '2', total_value: '9000.00' }])
      .mockResolvedValueOnce([{ deposits_collected: '1000.00', deposits_pending: '200.00' }]);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}/summary`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.financials).toEqual({
      lifetime_revenue: 5500,
      total_invoiced: 6000,
      past_due_balance: 250,
      due_balance: 750,
      unpaid_invoice_count: 2,
      paid_invoice_count: 4,
    });
  });

  // R6 (2026-07-22) — Estimate.customer_id is a direct column again; the estimate-stats and
  // deposit-stats raw SQL no longer need to JOIN leads to reach it.
  it('estimate + deposit stats query estimates.customer_id directly (no JOIN leads)', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(mockFinancials)
      .mockResolvedValueOnce(mockEstimates)
      .mockResolvedValueOnce(mockDeposits);

    await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}/summary`)
      .set(authHeader('admin'));

    // calls[0] = financials helper (unrelated), calls[1] = estimate stats, calls[2] = deposit stats.
    const estimateSql = (mockPrisma.$queryRaw.mock.calls[1][0] as string[]).join('');
    const depositSql = (mockPrisma.$queryRaw.mock.calls[2][0] as string[]).join('');
    expect(estimateSql).not.toContain('JOIN leads');
    expect(estimateSql).toContain('e.customer_id');
    expect(depositSql).not.toContain('JOIN leads');
    expect(depositSql).toContain('e.customer_id');
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/customers/:id/notes
// ═══════════════════════════════════════════════════════

describe('POST /api/customers/:id/notes', () => {
  const noteFixture = {
    id: 'n0000000-0000-0000-0000-000000000001',
    content: 'Customer prefers morning appointments.',
    created_at: new Date('2026-02-20'),
    creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
  };

  it('creates a note for a customer', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.note.create.mockResolvedValue(noteFixture);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/notes`)
      .set(authHeader('admin'))
      .send({ content: 'Customer prefers morning appointments.' });

    expect(res.status).toBe(201);
    expect(res.body.note.content).toBe('Customer prefers morning appointments.');
    expect(res.body.note.creator.first_name).toBe('Test');
  });

  it('returns 400 for empty content', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/notes`)
      .set(authHeader('admin'))
      .send({ content: '' });

    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent customer', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/customers/00000000-0000-0000-0000-999999999999/notes')
      .set(authHeader('admin'))
      .send({ content: 'Some note' });

    expect(res.status).toBe(404);
  });

  it('allows SALES to add notes', async () => {
    mockAuthAs('sales');
    // #2041 — SALES's read/update Customer grant is now row-scoped (OWN_CUSTOMER); this fixture
    // must be associated with the SALES test user or the new scope check 404s it.
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: TEST_USERS.sales.id });
    mockPrisma.note.create.mockResolvedValue(noteFixture);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/notes`)
      .set(authHeader('sales'))
      .send({ content: 'Some note' });

    expect(res.status).toBe(201);
  });

  it('returns 403 for TECHNICIAN role', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/notes`)
      .set(authHeader('technician'))
      .send({ content: 'Some note' });

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// Customer timeline writers
// ═══════════════════════════════════════════════════════

describe('Customer timeline writers', () => {
  it('writes a CUSTOMER timeline event on create', async () => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = { customer: { create: vi.fn().mockResolvedValue({ id: 'new-id', first_name: 'Jane', last_name: 'Smith', service_locations: [] }) } };
      return fn(txMock);
    });

    await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Smith', email: 'jane@smith.com', phone: '5559876543' });

    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledTimes(1);
    const args = mockPrisma.timelineEvent.create.mock.calls[0][0];
    expect(args.data.entity_type).toBe('CUSTOMER');
    expect(args.data.entity_id).toBe('new-id');
    expect(args.data.event_type).toBe('CUSTOMER_CREATED');
    expect(args.data.organization_id).toBe(ALPHA_ORG_ID);
    expect(args.data.created_by).toBe(TEST_USERS.admin.id);
  });

  it('writes a CUSTOMER timeline event on update', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.customer.update.mockResolvedValue({ id: CUSTOMER_FIXTURE.id, first_name: 'Jane' });

    await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ first_name: 'Jane' });

    const calls = mockPrisma.timelineEvent.create.mock.calls;
    expect(calls.some((c) => c[0].data.event_type === 'CUSTOMER_UPDATED' && c[0].data.entity_type === 'CUSTOMER')).toBe(true);
  });

  it('writes a CUSTOMER timeline event on adding a location', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.serviceLocation.create.mockResolvedValue({ ...LOCATION_FIXTURE });

    await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/locations`)
      .set(authHeader('admin'))
      .send({ address_line1: '456 Oak Ave', city: 'Dallas', state: 'TX', zip: '75201' });

    const calls = mockPrisma.timelineEvent.create.mock.calls;
    expect(calls.some((c) => c[0].data.event_type === 'LOCATION_ADDED' && c[0].data.entity_id === CUSTOMER_FIXTURE.id)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// Entity-redesign Phase 3 — new customer fields
// ═══════════════════════════════════════════════════════

describe('POST /api/customers (entity-redesign fields)', () => {
  const base = { first_name: 'Jane', last_name: 'Smith', email: 'jane@smith.com', phone: '5559876543' };

  function captureCreate() {
    let txCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCreate = vi.fn().mockResolvedValue({ id: 'new-id', ...base, service_locations: [] });
      return fn({ customer: { create: txCreate } });
    });
    return () => txCreate!;
  }

  it('accepts kind + segment and persists them', async () => {
    mockAuthAs('admin');
    const get = captureCreate();
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base, kind: 'COMPANY', segment: 'COMMERCIAL', company_name: 'Acme' });
    expect(res.status).toBe(201);
    const args = get().mock.calls[0][0];
    expect(args.data.kind).toBe('COMPANY');
    expect(args.data.segment).toBe('COMMERCIAL');
  });

  it('backward-compat: legacy validBody with no kind still 201', async () => {
    mockAuthAs('admin');
    captureCreate();
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send(base);
    expect(res.status).toBe(201);
  });

  it('persists phones[] as CustomerPhone create rows and mirrors legacy phone', async () => {
    mockAuthAs('admin');
    const get = captureCreate();
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({
        ...base,
        phones: [
          { phone: '5551112222', label: 'Mobile', extension: '12', is_primary: true },
          { phone: '5553334444' },
        ],
      });
    expect(res.status).toBe(201);
    const args = get().mock.calls[0][0];
    expect(args.data.phones.create).toHaveLength(2);
    expect(args.data.phones.create[0].phone).toBe('5551112222');
    expect(args.data.phones.create[0].label).toBe('Mobile');
    // legacy single-phone column still set
    expect(args.data.phone).toBe('5559876543');
  });

  it('normalizes two is_primary phones to exactly one primary (the first)', async () => {
    mockAuthAs('admin');
    const get = captureCreate();
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({
        ...base,
        phones: [
          { phone: '5551112222', is_primary: true },
          { phone: '5553334444', is_primary: true },
        ],
      });
    expect(res.status).toBe(201);
    const args = get().mock.calls[0][0];
    expect(args.data.phones.create[0].is_primary).toBe(true);
    expect(args.data.phones.create[1].is_primary).toBe(false);
    expect(args.data.phones.create.filter((p: { is_primary: boolean }) => p.is_primary)).toHaveLength(1);
  });

  it('defaults the first phone to primary when none is flagged', async () => {
    mockAuthAs('admin');
    const get = captureCreate();
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({
        ...base,
        phones: [{ phone: '5551112222' }, { phone: '5553334444' }],
      });
    expect(res.status).toBe(201);
    const args = get().mock.calls[0][0];
    expect(args.data.phones.create[0].is_primary).toBe(true);
    expect(args.data.phones.create[1].is_primary).toBe(false);
  });

  it('forces a single phone to primary', async () => {
    mockAuthAs('admin');
    const get = captureCreate();
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base, phones: [{ phone: '5551112222', is_primary: false }] });
    expect(res.status).toBe(201);
    const args = get().mock.calls[0][0];
    expect(args.data.phones.create[0].is_primary).toBe(true);
  });

  it('billing_same_as_service_location copies the primary location address', async () => {
    mockAuthAs('admin');
    const get = captureCreate();
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({
        ...base,
        billing_same_as_service_location: true,
        locations: [{ address_line1: '500 Billing Rd', city: 'Austin', state: 'TX', zip: '78701' }],
      });
    expect(res.status).toBe(201);
    const args = get().mock.calls[0][0];
    expect(args.data.billing_address_line1).toBe('500 Billing Rd');
    expect(args.data.billing_city).toBe('Austin');
    expect(args.data.billing_state).toBe('TX');
    expect(args.data.billing_zip).toBe('78701');
  });

  it('rejects a grandchild parent_id (parent must be top-level billing group)', async () => {
    mockAuthAs('admin');
    captureCreate();
    // parent customer is itself a member (parent_id !== null)
    mockPrisma.customer.findFirst.mockResolvedValue({ id: 'p1', parent_id: 'grandparent' });
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base, parent_id: '00000000-0000-0000-0000-0000000000p1'.replace(/p/g, '1') });
    expect(res.status).toBe(400);
    expect(mockPrisma.customer.findFirst).toHaveBeenCalled();
    const findArgs = mockPrisma.customer.findFirst.mock.calls[0][0];
    expect(findArgs.where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('accepts a top-level parent_id (parent_id null)', async () => {
    mockAuthAs('admin');
    const get = captureCreate();
    mockPrisma.customer.findFirst.mockResolvedValue({ id: 'p1', parent_id: null, is_parent: true });
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base, parent_id: '11111111-1111-1111-1111-111111111111' });
    expect(res.status).toBe(201);
    const args = get().mock.calls[0][0];
    expect(args.data.parent_id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('rejects a cross-tenant parent_id (findFirst null under tenantWhere)', async () => {
    mockAuthAs('admin');
    captureCreate();
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base, parent_id: '22222222-2222-2222-2222-222222222222' });
    expect(res.status).toBe(400);
  });

  it('bill_to_customer_id must be self or the parent billing group', async () => {
    mockAuthAs('admin');
    captureCreate();
    const parentId = '11111111-1111-1111-1111-111111111111';
    const otherId = '33333333-3333-3333-3333-333333333333';
    mockPrisma.customer.findFirst.mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === parentId) return Promise.resolve({ id: parentId, parent_id: null, is_parent: true });
      return Promise.resolve(null); // other id not a valid billing target for this customer
    });
    // bill_to = parent → ok
    const ok = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base, parent_id: parentId, bill_to_customer_id: parentId });
    expect(ok.status).toBe(201);

    vi.clearAllMocks();
    mockAuthAs('admin');
    captureCreate();
    mockPrisma.customer.findFirst.mockImplementation((args: { where: { id: string } }) => {
      if (args.where.id === parentId) return Promise.resolve({ id: parentId, parent_id: null, is_parent: true });
      return Promise.resolve(null);
    });
    // bill_to = unrelated other → 400
    const bad = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base, parent_id: parentId, bill_to_customer_id: otherId });
    expect(bad.status).toBe(400);
  });
});

describe('PATCH /api/customers (entity-redesign fields)', () => {
  it('replaces phones with deleteMany + create', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE });
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ phones: [{ phone: '5550009999', label: 'New' }] });
    expect(res.status).toBe(200);
    const args = mockPrisma.customer.update.mock.calls[0][0];
    expect(args.data.phones.deleteMany).toEqual({});
    expect(args.data.phones.create).toHaveLength(1);
    expect(args.data.phones.create[0].phone).toBe('5550009999');
  });

  it('normalizes two is_primary phones to exactly one primary (the first) on update', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE });
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        phones: [
          { phone: '5551112222', is_primary: true },
          { phone: '5553334444', is_primary: true },
        ],
      });
    expect(res.status).toBe(200);
    const args = mockPrisma.customer.update.mock.calls[0][0];
    expect(args.data.phones.create[0].is_primary).toBe(true);
    expect(args.data.phones.create[1].is_primary).toBe(false);
    expect(args.data.phones.create.filter((p: { is_primary: boolean }) => p.is_primary)).toHaveLength(1);
  });

  it('defaults the first phone to primary on update when none is flagged', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE });
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ phones: [{ phone: '5550009999' }, { phone: '5550008888' }] });
    expect(res.status).toBe(200);
    const args = mockPrisma.customer.update.mock.calls[0][0];
    expect(args.data.phones.create[0].is_primary).toBe(true);
    expect(args.data.phones.create[1].is_primary).toBe(false);
  });

  it('clearing parent_id resets bill_to_customer_id to null', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE });
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ parent_id: null });
    expect(res.status).toBe(200);
    const args = mockPrisma.customer.update.mock.calls[0][0];
    expect(args.data.bill_to_customer_id).toBeNull();
  });

  it('re-parenting is a plain edit and never rewrites issued invoices', async () => {
    mockAuthAs('admin');
    const newParent = '11111111-1111-1111-1111-111111111111';
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.findFirst.mockResolvedValue({ id: newParent, parent_id: null, is_parent: true });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE });
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ parent_id: newParent, bill_to_customer_id: newParent });
    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
    expect(mockPrisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  // defect 1 — a member persisted with parent_id=P that PATCHes only { bill_to=P } must be
  // accepted (consolidated billing). The guard must read the persisted parent, not require
  // parent_id to be restated in the same body.
  it('accepts PATCH { bill_to_customer_id: parent } alone for a member (uses persisted parent)', async () => {
    mockAuthAs('admin');
    const parentId = '11111111-1111-1111-1111-111111111111';
    mockPrisma.customer.findUnique.mockResolvedValue({
      ...CUSTOMER_FIXTURE,
      parent_id: parentId,
      bill_to_customer_id: CUSTOMER_FIXTURE.id,
    });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE });
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ bill_to_customer_id: parentId });
    expect(res.status).toBe(200);
    const args = mockPrisma.customer.update.mock.calls[0][0];
    expect(args.data.bill_to_customer_id).toBe(parentId);
  });

  // defect 2 — re-parenting to a DIFFERENT parent without restating bill_to must not leave a
  // stale bill_to pointing at the OLD parent. The persisted bill_to is reset to self (null).
  it('re-parent to a different parent resets a stale bill_to off the old parent', async () => {
    mockAuthAs('admin');
    const oldParent = '22222222-2222-2222-2222-222222222222';
    const newParent = '11111111-1111-1111-1111-111111111111';
    mockPrisma.customer.findUnique.mockResolvedValue({
      ...CUSTOMER_FIXTURE,
      parent_id: oldParent,
      bill_to_customer_id: oldParent,
    });
    mockPrisma.customer.findFirst.mockResolvedValue({ id: newParent, parent_id: null, is_parent: true });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE });
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ parent_id: newParent });
    expect(res.status).toBe(200);
    const args = mockPrisma.customer.update.mock.calls[0][0];
    // stale bill_to (old parent) is neither self nor the new parent → reset to null (bills self)
    expect(args.data.bill_to_customer_id).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// Customer-form-redesign — is_parent (franchise / billing group)
// ═══════════════════════════════════════════════════════

describe('Customer is_parent (franchise)', () => {
  const base = { first_name: 'Jane', last_name: 'Smith', email: 'jane@smith.com', phone: '5559876543' };

  function captureCreate() {
    let txCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCreate = vi.fn().mockResolvedValue({ id: 'new-id', ...base, service_locations: [] });
      return fn({ customer: { create: txCreate } });
    });
    return () => txCreate!;
  }

  // (a)
  it('POST create with is_parent:true passes is_parent:true into prisma create data', async () => {
    mockAuthAs('admin');
    const get = captureCreate();
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base, is_parent: true });
    expect(res.status).toBe(201);
    const args = get().mock.calls[0][0];
    expect(args.data.is_parent).toBe(true);
  });

  // (b) NOT-NULL safety
  it('POST create omitting segment still persists segment:RESIDENTIAL', async () => {
    mockAuthAs('admin');
    const get = captureCreate();
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base });
    expect(res.status).toBe(201);
    const args = get().mock.calls[0][0];
    expect(args.data.segment).toBe('RESIDENTIAL');
  });

  it('POST create omitting kind still persists kind:PERSON', async () => {
    mockAuthAs('admin');
    const get = captureCreate();
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base });
    expect(res.status).toBe(201);
    const args = get().mock.calls[0][0];
    expect(args.data.kind).toBe('PERSON');
  });

  // (c)
  it('PATCH update with is_parent passes it through into prisma.customer.update data', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, is_parent: true });
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ is_parent: true });
    expect(res.status).toBe(200);
    const args = mockPrisma.customer.update.mock.calls[0][0];
    expect(args.data.is_parent).toBe(true);
  });

  // (d) Guard: parent must itself be a franchise
  it('rejects parent_id whose looked-up parent is NOT a franchise (is_parent:false)', async () => {
    mockAuthAs('admin');
    captureCreate();
    mockPrisma.customer.findFirst.mockResolvedValue({ id: 'p1', parent_id: null, is_parent: false });
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base, parent_id: '11111111-1111-1111-1111-111111111111' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/franchise/i);
  });

  it('allows parent_id when the looked-up parent IS a franchise (is_parent:true)', async () => {
    mockAuthAs('admin');
    const get = captureCreate();
    mockPrisma.customer.findFirst.mockResolvedValue({ id: 'p1', parent_id: null, is_parent: true });
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base, parent_id: '11111111-1111-1111-1111-111111111111' });
    expect(res.status).toBe(201);
    const args = get().mock.calls[0][0];
    expect(args.data.parent_id).toBe('11111111-1111-1111-1111-111111111111');
  });

  // (e) Conflict: a member cannot itself be a franchise
  it('rejects create with parent_id set AND is_parent:true', async () => {
    mockAuthAs('admin');
    captureCreate();
    mockPrisma.customer.findFirst.mockResolvedValue({ id: 'p1', parent_id: null, is_parent: true });
    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...base, parent_id: '11111111-1111-1111-1111-111111111111', is_parent: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/under a franchise cannot itself be a franchise/i);
  });

  it('rejects update with parent_id set AND is_parent:true', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.findFirst.mockResolvedValue({ id: 'p1', parent_id: null, is_parent: true });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE });
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ parent_id: '11111111-1111-1111-1111-111111111111', is_parent: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/under a franchise cannot itself be a franchise/i);
  });

  it('rejects update with is_parent:true when the customer already has a persisted parent', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({
      ...CUSTOMER_FIXTURE,
      parent_id: '11111111-1111-1111-1111-111111111111',
    });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE });
    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ is_parent: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/under a franchise cannot itself be a franchise/i);
  });

  // (f) List filter
  it('GET list with is_parent=true builds where.is_parent === true', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);
    await request(app).get('/api/customers?is_parent=true').set(authHeader('admin'));
    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(where.is_parent).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// Customer lifecycle — archive / unarchive
// ═══════════════════════════════════════════════════════

describe('Customer lifecycle: archive / unarchive', () => {
  it('POST /:id/archive sets is_active=false + archived_at and writes CUSTOMER_ARCHIVED', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, is_active: false });
    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/archive`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    const args = mockPrisma.customer.update.mock.calls[0][0];
    expect(args.data.is_active).toBe(false);
    expect(args.data.archived_at).toBeInstanceOf(Date);
    const calls = mockPrisma.timelineEvent.create.mock.calls;
    expect(calls.some((c) => c[0].data.event_type === 'CUSTOMER_ARCHIVED')).toBe(true);
  });

  it('POST /:id/unarchive restores is_active=true, archived_at=null', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, is_active: false });
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, is_active: true });
    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/unarchive`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    const args = mockPrisma.customer.update.mock.calls[0][0];
    expect(args.data.is_active).toBe(true);
    expect(args.data.archived_at).toBeNull();
  });

  it('archive allowed for DISPATCHER, forbidden for TECHNICIAN', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, is_active: false });
    const ok = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/archive`)
      .set(authHeader('dispatcher'));
    expect(ok.status).toBe(200);

    mockAuthAs('technician');
    const forbidden = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/archive`)
      .set(authHeader('technician'));
    expect(forbidden.status).toBe(403);
  });

  it('archive allowed even when the customer has members', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.count.mockResolvedValue(2); // has members
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE, is_active: false });
    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/archive`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
  });

  it('GET /api/customers defaults is_active=true; includes archived when flagged or searched', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);

    await request(app).get('/api/customers').set(authHeader('admin'));
    expect(mockPrisma.customer.findMany.mock.calls[0][0].where.is_active).toBe(true);

    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);
    await request(app).get('/api/customers?include_archived=true').set(authHeader('admin'));
    expect(mockPrisma.customer.findMany.mock.calls[0][0].where.is_active).toBeUndefined();

    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);
    await request(app).get('/api/customers?search=John').set(authHeader('admin'));
    expect(mockPrisma.customer.findMany.mock.calls[0][0].where.is_active).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// Customer delete — money-gate split
// ═══════════════════════════════════════════════════════

describe('DELETE /api/customers/:id (money-gate)', () => {
  it('blocks casual delete when a Payment exists in the subtree (no history rows)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.customer.count.mockResolvedValue(0); // no members
    mockPrisma.payment.count.mockResolvedValue(1); // payment in subtree
    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(mockPrisma.customer.delete).not.toHaveBeenCalled();
    expect(res.body.error).toMatch(/archive|purge/i);
  });

  it('allows casual delete only with zero history and no payments', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.customer.count.mockResolvedValue(0);
    mockPrisma.payment.count.mockResolvedValue(0);
    mockPrisma.customer.delete.mockResolvedValue(CUSTOMER_FIXTURE);
    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.customer.delete).toHaveBeenCalled();
  });

  it('blocks casual delete when the customer has members (billing group)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.customer.count.mockResolvedValue(3); // has members
    mockPrisma.payment.count.mockResolvedValue(0);
    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member/i);
    expect(mockPrisma.customer.delete).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// Customer force-purge
// ═══════════════════════════════════════════════════════

describe('POST /api/customers/:id/purge', () => {
  function setupPurge(overrides: Record<string, unknown> = {}) {
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, customer_number: 'C00001', ...overrides });
    mockPrisma.customer.count.mockResolvedValue(0); // no members
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
    mockPrisma.timelineEvent.create.mockResolvedValue({});
  }

  it('requires admin (sales/dispatcher/technician → 403)', async () => {
    for (const role of ['sales', 'dispatcher', 'technician'] as const) {
      mockAuthAs(role);
      const res = await request(app)
        .post(`/api/customers/${CUSTOMER_FIXTURE.id}/purge`)
        .set(authHeader(role))
        .send({ confirm: 'C00001' });
      expect(res.status).toBe(403);
    }
  });

  it('requires the type-to-confirm token to match customer_number', async () => {
    mockAuthAs('admin');
    setupPurge();
    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/purge`)
      .set(authHeader('admin'))
      .send({ confirm: 'WRONG' });
    expect(res.status).toBe(400);
  });

  it('clean one-click purge when no Payment in subtree', async () => {
    mockAuthAs('admin');
    setupPurge();
    mockPrisma.payment.count.mockResolvedValue(0);
    mockPrisma.payment.findMany.mockResolvedValue([]);
    // resolve subtree ids → empty
    (prisma.lead.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.estimate.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.messageThread.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.whatsAppChat.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockPrisma.customer.delete.mockResolvedValue(CUSTOMER_FIXTURE);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/purge`)
      .set(authHeader('admin'))
      .send({ confirm: 'C00001' });
    expect(res.status).toBe(200);
    expect(res.body.purged).toBe(true);
    expect(res.body.warning).toBeUndefined();
    expect(mockPrisma.customer.delete).toHaveBeenCalled();
    const calls = mockPrisma.timelineEvent.create.mock.calls;
    expect(calls.some((c) => c[0].data.event_type === 'CUSTOMER_PURGED')).toBe(true);
  });

  it('warns-but-allows admin when Payment present, with Stripe-charge flag', async () => {
    mockAuthAs('admin');
    setupPurge();
    mockPrisma.payment.findMany.mockResolvedValue([
      { amount: 300, stripe_payment_intent_id: 'pi_xyz' },
    ]);
    (prisma.lead.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.estimate.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.messageThread.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.whatsAppChat.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockPrisma.customer.delete.mockResolvedValue(CUSTOMER_FIXTURE);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/purge`)
      .set(authHeader('admin'))
      .send({ confirm: 'C00001' });
    expect(res.status).toBe(200);
    expect(res.body.purged).toBe(true);
    expect(String(res.body.warning)).toMatch(/recorded/i);
    expect(res.body.has_stripe_charge).toBe(true);
  });

  it('blocks purge when the customer has members', async () => {
    mockAuthAs('admin');
    setupPurge();
    mockPrisma.customer.count.mockResolvedValue(2); // members exist
    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/purge`)
      .set(authHeader('admin'))
      .send({ confirm: 'C00001' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member/i);
  });
});

// ═══════════════════════════════════════════════════════
// Customer anonymize (deferred stub)
// ═══════════════════════════════════════════════════════

describe('POST /api/customers/:id/anonymize', () => {
  it('is admin-only and returns the deferred 501 design contract', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/anonymize`)
      .set(authHeader('admin'));
    expect(res.status).toBe(501);
    expect(res.body.deferred).toBe(true);

    for (const role of ['sales', 'dispatcher', 'technician'] as const) {
      mockAuthAs(role);
      const forbidden = await request(app)
        .post(`/api/customers/${CUSTOMER_FIXTURE.id}/anonymize`)
        .set(authHeader(role));
      expect(forbidden.status).toBe(403);
    }
  });
});

// ═══════════════════════════════════════════════════════
// ServiceLocation lifecycle — archive instead of delete + invariants
// ═══════════════════════════════════════════════════════

describe('DELETE /api/customers/:id/locations/:locId (lead/job-aware + invariants)', () => {
  it('archives instead of deleting when a LEAD references the location', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ ...LOCATION_FIXTURE, is_primary: false });
    mockPrisma.serviceLocation.count.mockResolvedValue(2); // other active locations exist
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.lead.count.mockResolvedValue(1); // referenced by a lead
    mockPrisma.serviceLocation.update.mockResolvedValue({ ...LOCATION_FIXTURE, is_active: false });
    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);
    expect(mockPrisma.serviceLocation.update).toHaveBeenCalled();
    expect(mockPrisma.serviceLocation.delete).not.toHaveBeenCalled();
  });

  it('still hard-deletes when neither leads nor jobs reference it', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ ...LOCATION_FIXTURE, is_primary: false });
    mockPrisma.serviceLocation.count.mockResolvedValue(2);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.serviceLocation.delete.mockResolvedValue(LOCATION_FIXTURE);
    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.serviceLocation.delete).toHaveBeenCalled();
  });

  it('blocks removing the last active location', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ ...LOCATION_FIXTURE, is_primary: false });
    mockPrisma.serviceLocation.count.mockResolvedValue(1); // it is the only active one
    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last active/i);
  });

  it('blocks removing the primary location without a promotion', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ ...LOCATION_FIXTURE, is_primary: true });
    mockPrisma.serviceLocation.count.mockResolvedValue(2);
    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/primary/i);
  });

  it('promotes another location then removes the primary when promote_location_id supplied', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ ...LOCATION_FIXTURE, is_primary: true });
    mockPrisma.serviceLocation.count.mockResolvedValue(2);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.serviceLocation.update.mockResolvedValue({});
    mockPrisma.serviceLocation.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.serviceLocation.delete.mockResolvedValue(LOCATION_FIXTURE);
    const promoteId = 'b0000000-0000-0000-0000-000000000002';
    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ promote_location_id: promoteId });
    expect(res.status).toBe(200);
    expect(mockPrisma.serviceLocation.update).toHaveBeenCalled();
    expect(mockPrisma.serviceLocation.delete).toHaveBeenCalled();
  });
});

describe('POST /api/customers/:id/locations/:locId/archive', () => {
  it('writes LOCATION_ARCHIVED and sets is_active=false', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ ...LOCATION_FIXTURE, is_primary: false });
    mockPrisma.serviceLocation.count.mockResolvedValue(2);
    mockPrisma.serviceLocation.update.mockResolvedValue({ ...LOCATION_FIXTURE, is_active: false });
    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/${LOCATION_FIXTURE.id}/archive`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    const args = mockPrisma.serviceLocation.update.mock.calls[0][0];
    expect(args.data.is_active).toBe(false);
    expect(args.data.archived_at).toBeInstanceOf(Date);
    const calls = mockPrisma.timelineEvent.create.mock.calls;
    expect(calls.some((c) => c[0].data.event_type === 'LOCATION_ARCHIVED')).toBe(true);
  });

  it('enforces the last-active invariant on archive', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ ...LOCATION_FIXTURE, is_primary: false });
    mockPrisma.serviceLocation.count.mockResolvedValue(1);
    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/${LOCATION_FIXTURE.id}/archive`)
      .set(authHeader('admin'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the location is not under this customer (tenant isolation)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/locations/nope/archive`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/customers — duplicate-customer guard (Fixes #42)
// Spec: md_files/plans/customers/2026-06-08-duplicate-customer-guard.md
// ═══════════════════════════════════════════════════════

describe('POST /api/customers (duplicate-customer guard)', () => {
  const newBody = {
    first_name: 'Jane',
    last_name: 'Smith',
    email: 'jane@smith.com',
    phone: '5559876543',
  };

  // An existing customer row as the guard's findMany would return it (raw,
  // un-normalized values + primary service location).
  const existingRow = {
    id: 'c0000000-0000-0000-0000-0000000000ee',
    customer_number: 'C00042',
    first_name: 'Existing',
    last_name: 'Person',
    company_name: null,
    email: 'jane@smith.com',
    phone: '5559876543',
    is_active: true,
    archived_at: null,
    service_locations: [
      { address_line1: '1 Old Rd', city: 'Austin', state: 'TX' },
    ],
    phones: [],
    extra_emails: [],
  };

  function captureCreate() {
    let txCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCreate = vi.fn().mockResolvedValue({ id: 'new-id', ...newBody, service_locations: [] });
      return fn({ customer: { create: txCreate } });
    });
    return () => txCreate!;
  }

  it('returns 409 { error:"duplicate", existing } when the email matches an existing customer', async () => {
    mockAuthAs('admin');
    captureCreate();
    mockPrisma.customer.findMany.mockResolvedValue([existingRow]);

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...newBody, phone: '5550000000' }); // only email collides

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate');
    expect(res.body.existing).toMatchObject({
      id: existingRow.id,
      customer_number: 'C00042',
      first_name: 'Existing',
      last_name: 'Person',
      company_name: null,
      email: 'jane@smith.com',
      phone: '5559876543',
      is_active: true,
      archived_at: null,
      primary_address: { line1: '1 Old Rd', city: 'Austin', state: 'TX' },
    });
  });

  it('scopes the duplicate lookup to the requesting org', async () => {
    mockAuthAs('admin');
    captureCreate();
    mockPrisma.customer.findMany.mockResolvedValue([existingRow]);

    await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send(newBody);

    const findArgs = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(findArgs.where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('returns 409 when the phone matches an existing customer (different email)', async () => {
    mockAuthAs('admin');
    captureCreate();
    mockPrisma.customer.findMany.mockResolvedValue([existingRow]);

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...newBody, email: 'someone.else@elsewhere.com' }); // only phone collides

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate');
    expect(res.body.existing.id).toBe(existingRow.id);
  });

  it('normalizes a formatted phone + upper-case email against stored variants → 409', async () => {
    mockAuthAs('admin');
    captureCreate();
    // stored row is digits-only / lower-case; the new input is formatted / upper-case
    mockPrisma.customer.findMany.mockResolvedValue([existingRow]);

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...newBody, email: 'JANE@SMITH.COM', phone: '(555) 987-6543' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate');
    expect(res.body.existing.id).toBe(existingRow.id);
  });

  it('creates (201) and does NOT 409 when the email/phone belong to a different org', async () => {
    mockAuthAs('admin');
    captureCreate();
    // The guard is org-scoped; a row from another org is never returned by findMany.
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send(newBody);

    expect(res.status).toBe(201);
  });

  it('?override=true creates (201) even on a duplicate, recording the bypass on the timeline event', async () => {
    mockAuthAs('admin');
    captureCreate();
    mockPrisma.customer.findMany.mockResolvedValue([existingRow]);

    const res = await request(app)
      .post('/api/customers?override=true')
      .set(authHeader('admin'))
      .send(newBody);

    expect(res.status).toBe(201);

    const tlArgs = mockPrisma.timelineEvent.create.mock.calls[0][0];
    expect(tlArgs.data.event_type).toBe('CUSTOMER_CREATED');
    // the existing customer_number must appear in the audit trail
    expect(tlArgs.data.description).toContain('C00042');
    expect(tlArgs.data.metadata).toMatchObject({
      duplicate_override: true,
      matched_customer_number: 'C00042',
      matched_customer_id: existingRow.id,
    });
  });

  it('writes the plain "Customer created" timeline note on a normal (non-duplicate) create', async () => {
    mockAuthAs('admin');
    captureCreate();
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send(newBody);

    expect(res.status).toBe(201);
    const tlArgs = mockPrisma.timelineEvent.create.mock.calls[0][0];
    expect(tlArgs.data.description).toBe('Customer created');
    expect(tlArgs.data.metadata).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/customers/export
// ═══════════════════════════════════════════════════════

describe('GET /api/customers/export', () => {
  it('returns all matching rows under the {customers} envelope', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_FIXTURE]);

    const res = await request(app)
      .get('/api/customers/export')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
  });

  it('exportAll applies the same status/search filters as list (respects filters)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/customers/export?state=CA&search=acme')
      .set(authHeader('admin'));

    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeDefined();                 // search applied
    expect(JSON.stringify(where)).toContain('CA');  // state filter applied
  });

  it('exportAll is unpaginated (no skip/take limit beyond the cap)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/customers/export')
      .set(authHeader('admin'));

    const args = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(args.skip).toBeUndefined();
  });

  // CUS-B1 — the only `take` is the defensive 50_000 cap (NOT a list page size), so a
  // multi-page result set is never truncated by pagination.
  it('exportAll uses the 50_000 row cap as the only take (CUS-B1)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/customers/export')
      .set(authHeader('admin'));

    const args = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(args.skip).toBeUndefined();
    expect(args.take).toBe(50_000);
  });

  // CUS-B3 — tenant isolation: the export `where` is scoped to the caller's org so
  // cross-org rows can never be returned.
  it('exportAll scopes the where to the caller organization (CUS-B3)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/customers/export')
      .set(authHeader('admin'));

    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
  });

  // CUS-B6 — select parity: the export select carries the same list columns (e.g.
  // customer_number) so every CSV column has data.
  it('exportAll select matches the list select columns (CUS-B6)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/customers/export')
      .set(authHeader('admin'));

    const select = mockPrisma.customer.findMany.mock.calls[0][0].select;
    expect(select.customer_number).toBe(true);
    expect(select.first_name).toBe(true);
    expect(select.last_name).toBe(true);
    expect(select.company_name).toBe(true);
    expect(select.email).toBe(true);
    expect(select.phone).toBe(true);
    // primary service-location address column (same as the list)
    expect(select.service_locations).toBeDefined();
  });
});

// ─── extra_emails[].receives_emails — automated-mail opt-in ──────────────────
//
// The flag decides whether an Automation Center email addressed to "the customer"
// also reaches this secondary address (services/automations/recipients.ts).
//
// The update path is deleteMany+recreate, so the flag only survives an edit if the
// client echoes it back. A payload that OMITS it must therefore recreate the row
// opted OUT — an old client re-saving a customer must never silently opt addresses
// in. Newly added addresses are opted in by the FORM sending true, not by the API
// guessing; the column default only covers rows inserted outside this path.

describe('extra_emails receives_emails flag', () => {
  const flagBody = {
    first_name: 'Jane',
    last_name: 'Smith',
    email: 'jane@smith.com',
    phone: '5551234567',
  };

  it('persists receives_emails on create', async () => {
    mockAuthAs('admin');
    let txCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCreate = vi.fn().mockResolvedValue({ id: 'new-id', service_locations: [] });
      return fn({ customer: { create: txCreate } });
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({
        ...flagBody,
        extra_emails: [
          { email: 'ops@smith.com', receives_emails: true },
          { email: 'archive@smith.com', receives_emails: false },
        ],
      });

    expect(res.status).toBe(201);
    const created = txCreate!.mock.calls[0][0].data.extra_emails.create;
    expect(created[0]).toMatchObject({ email: 'ops@smith.com', receives_emails: true });
    expect(created[1]).toMatchObject({ email: 'archive@smith.com', receives_emails: false });
  });

  it('defaults to opted-OUT when create omits the flag', async () => {
    mockAuthAs('admin');
    let txCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCreate = vi.fn().mockResolvedValue({ id: 'new-id', service_locations: [] });
      return fn({ customer: { create: txCreate } });
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ ...flagBody, extra_emails: [{ email: 'ops@smith.com' }] });

    expect(res.status).toBe(201);
    expect(txCreate!.mock.calls[0][0].data.extra_emails.create[0].receives_emails).toBe(false);
  });

  it('round-trips the flag through a PATCH (deleteMany + recreate)', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...CUSTOMER_FIXTURE,
      phone: '5551234567',
      email: 'jane@example.com',
    });
    mockPrisma.customer.update.mockResolvedValue(CUSTOMER_FIXTURE);

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        extra_emails: [
          { email: 'ops@smith.com', receives_emails: true },
          { email: 'archive@smith.com', receives_emails: false },
        ],
      });

    expect(res.status).toBe(200);
    const recreated = mockPrisma.customer.update.mock.calls[0][0].data.extra_emails.create;
    expect(recreated[0]).toMatchObject({ email: 'ops@smith.com', receives_emails: true });
    expect(recreated[1]).toMatchObject({ email: 'archive@smith.com', receives_emails: false });
  });

  it('does NOT opt an address in when a PATCH omits the flag', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...CUSTOMER_FIXTURE,
      phone: '5551234567',
      email: 'jane@example.com',
    });
    mockPrisma.customer.update.mockResolvedValue(CUSTOMER_FIXTURE);

    await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ extra_emails: [{ email: 'ops@smith.com', label: 'Ops' }] });

    expect(mockPrisma.customer.update.mock.calls[0][0].data.extra_emails.create[0].receives_emails).toBe(false);
  });
});
