/**
 * #1996 security follow-up (Lead FIX, handoffs/security-1.md H1), REVISED BY #2041 decision 8.
 *
 * #1996's original fix refused an existing-customer id the requester could not read
 * (`can(req,'read','Customer',row)` -> 400/404 "Customer not found") on POST /api/leads,
 * POST /api/jobs and POST /api/estimates. #2041 (Ran's carve-out, 2026-09-10) DELIBERATELY
 * REVERSES that refusal for exactly this shape: the create-form pickers stay org-wide (a rep
 * must be able to start a lead/job/estimate on a customer they have never worked with), so the
 * `create <Subject>` grant the route already enforced is now the authority — a picker-visible,
 * in-org customer id is ALWAYS accepted. What #2041 keeps from #1996's contract is the SPLIT
 * between existence (tenancy — still 400/404 "Customer not found" for an id outside the org, or
 * one that plain does not exist) and the WRITE/READ consequence: the two writes that could
 * confirm a guessed id (the `ad_source` update, `accreteContactMethods`) are skipped, and the
 * created record's `customer` block is redacted through the same contact strip #1997 uses,
 * exactly as it is for any customer the requester cannot otherwise read.
 *
 * "Accepted, and decided: a rep can therefore attach themselves to any customer in the org by
 * booking a lead on it. That is the carve-out, not a hole; it is audited (created_by, the lead
 * row, the assignee row)." — spec decision 8.
 *
 * Three call sites are covered:
 *   - POST /api/jobs (existing-customer)   — job.controller.ts (~1564)
 *   - POST /api/leads (existing-customer)  — lead.controller.ts (~915)
 *   - POST /api/estimates (customer anchor) — estimate.controller.ts (~1116) — the gate here was
 *     removed outright (decision 8): nothing on this branch writes to the customer row, and the
 *     response is redacted automatically by `presentEstimateDetail` (its `customer`/`lead.customer`
 *     anchors carry the #2041 proof relations), so there is no separate readability check to pin.
 *
 * POST /api/invoices (createStandaloneInvoice) and POST /api/service-plans (createPlan) were
 * enumerated too (handoffs/security-fix-1.md) and judged UNREACHABLE by a seeded role default —
 * unaffected by #2041, since neither is a lead/job/estimate create form.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS, mockAuthAs, authHeader, CUSTOMER_FIXTURE, LOCATION_FIXTURE,
  STANDALONE_JOB_FIXTURE, LEAD_FIXTURE,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
});

/**
 * Hand-inject a `read Customer` grant for `role` conditioned on an id that never matches
 * `rowId` — the requester HOLDS the grant (route-level `canDo` guards elsewhere still pass) but
 * is denied per-row on THIS customer. Same mechanism repro-1996.test.ts's mockDeniedCustomerRead
 * uses (see that file's header for why this is achievable today independent of the Roles editor).
 */
function mockConditionedCustomerRead(role: string, rowId: string) {
  const rows = [
    ...DEFAULT_GRANTS.filter((g) => !(g.role === role && g.action === 'read' && g.subject === 'Customer')),
    { role, action: 'read', subject: 'Customer', conditions: { id: 'zz-not-' + rowId } },
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows.filter((g) => g.role === role));
  clearPermissionCache();
}

/**
 * Build a synthetic "creates X, cannot read Customer" persona for an action neither seeded
 * creator role (SALES/DISPATCHER, both default Customer readers) already lacks read Customer
 * for — e.g. Lead create. Fixture plumbing only; the code under test never checks a role name.
 */
function mockGrantsPlusExtra(role: string, extra: { action: string; subject: string }) {
  const rows = [...DEFAULT_GRANTS.filter((g) => g.role === role), { role, ...extra }];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows);
  clearPermissionCache();
}

function mockJobCreateTx() {
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE) },
      customer: { update: vi.fn() },
      orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
      stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
      timelineEvent: { create: vi.fn() },
      visit: {
        create: vi.fn().mockResolvedValue({ id: 'v-new', visit_seq: 1 }),
        update: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
      },
      visitAssignee: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn(), deleteMany: vi.fn() },
      organization: { findUnique: vi.fn().mockResolvedValue({ default_job_duration_min: 120 }) },
    }),
  );
}

function mockLeadCreateTx() {
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
      lead: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(LEAD_FIXTURE) },
      serviceLocation: { findFirst: vi.fn().mockResolvedValue(null) },
      customer: { update: vi.fn() },
    }),
  );
}

function mockEstimateCreateTx(result: unknown) {
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      estimate: { create: vi.fn().mockResolvedValue(result) },
      timelineEvent: { create: vi.fn() },
    }),
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// POST /api/jobs — existing-customer branch (job.controller.ts)
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 decision 8 — POST /api/jobs existing-customer, picker-visible-but-unreadable', () => {
  it('TECHNICIAN (create Job, no read Customer at all) → 201, ACCEPTED, customer redacted', async () => {
    mockAuthAs('technician');
    mockPrisma.customer.findUnique.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, organization_id: TEST_USERS.technician.organization_id,
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    mockJobCreateTx();

    const res = await request(app).post('/api/jobs').set(authHeader('technician'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    // Decision 8's contact strip — no email/phone, since this requester has no association.
    if (res.body.job.customer) {
      expect(res.body.job.customer).not.toHaveProperty('email');
      expect(res.body.job.customer).not.toHaveProperty('phone');
    }
  });

  it('a conditioned reader (DISPATCHER) whose grant does not cover THIS row → 201, ACCEPTED, customer redacted', async () => {
    mockAuthAs('dispatcher'); // create Job + normally-unconditional read Customer (defaultGrants.ts:217,189)
    mockConditionedCustomerRead('DISPATCHER', CUSTOMER_FIXTURE.id);
    mockPrisma.customer.findUnique.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, organization_id: TEST_USERS.dispatcher.organization_id,
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    mockJobCreateTx();

    const res = await request(app).post('/api/jobs').set(authHeader('dispatcher'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    if (res.body.job.customer) {
      expect(res.body.job.customer).not.toHaveProperty('email');
    }
  });

  it('a reader (DISPATCHER, default unconditional read Customer) → 201 with the customer block, unredacted', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findUnique.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, organization_id: TEST_USERS.dispatcher.organization_id,
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    mockJobCreateTx();

    const res = await request(app).post('/api/jobs').set(authHeader('dispatcher'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(res.body.job.customer).toMatchObject({ email: CUSTOMER_FIXTURE.email, phone: CUSTOMER_FIXTURE.phone });
  });

  it('ADMIN (superuser) → 201', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, organization_id: TEST_USERS.admin.organization_id,
    });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue(LOCATION_FIXTURE);
    mockJobCreateTx();

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
  });

  it('cross-org id → 404 (unchanged — the tenant-scoped lookup already returns nothing)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/api/jobs').set(authHeader('admin'))
      .send({ customer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Customer not found');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// POST /api/leads — existing-customer branch (lead.controller.ts) — mirrors POST /api/jobs
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 decision 8 — POST /api/leads existing-customer, picker-visible-but-unreadable', () => {
  it('a create-Lead grant with no read-Customer grant at all → 201, ACCEPTED, customer redacted', async () => {
    mockAuthAs('technician');
    mockGrantsPlusExtra('TECHNICIAN', { action: 'create', subject: 'Lead' });
    mockPrisma.customer.findUnique.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, organization_id: TEST_USERS.technician.organization_id,
    });
    mockLeadCreateTx();

    const res = await request(app).post('/api/leads').set(authHeader('technician'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'AC not cooling' });

    expect(res.status).toBe(201);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    if (res.body.lead.customer) {
      expect(res.body.lead.customer).not.toHaveProperty('email');
      expect(res.body.lead.customer).not.toHaveProperty('phone');
    }
  });

  it('a conditioned reader (SALES) whose grant does not cover THIS row → 201, ACCEPTED, customer redacted', async () => {
    mockAuthAs('sales'); // create Lead + normally-unconditional read Customer (defaultGrants.ts:107,96)
    mockConditionedCustomerRead('SALES', CUSTOMER_FIXTURE.id);
    mockPrisma.customer.findUnique.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, organization_id: TEST_USERS.sales.organization_id,
    });
    mockLeadCreateTx();

    const res = await request(app).post('/api/leads').set(authHeader('sales'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'AC not cooling' });

    expect(res.status).toBe(201);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    if (res.body.lead.customer) {
      expect(res.body.lead.customer).not.toHaveProperty('email');
    }
  });

  it('a reader (SALES, associated via OWN_CUSTOMER) → 201 with the customer block, unredacted', async () => {
    mockAuthAs('sales');
    // #2041 — SALES's read Customer is now row-scoped; associate the fixture (created_by_id) so
    // the readability check the response redaction keys on passes.
    mockPrisma.customer.findUnique.mockResolvedValue({
      ...CUSTOMER_FIXTURE, organization_id: TEST_USERS.sales.organization_id, created_by_id: TEST_USERS.sales.id,
    });
    mockLeadCreateTx();

    const res = await request(app).post('/api/leads').set(authHeader('sales'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'AC not cooling' });

    expect(res.status).toBe(201);
    expect(res.body.lead.customer).toMatchObject({ email: LEAD_FIXTURE.customer.email, phone: LEAD_FIXTURE.customer.phone });
  });

  it('ADMIN (superuser) → 201', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({
      ...CUSTOMER_FIXTURE, organization_id: TEST_USERS.admin.organization_id,
    });
    mockLeadCreateTx();

    const res = await request(app).post('/api/leads').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'AC not cooling' });

    expect(res.status).toBe(201);
  });

  it('cross-org id → 400 (unchanged — the tenant-scoped lookup already returns nothing)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/api/leads').set(authHeader('admin'))
      .send({ customer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', service_request: 'AC not cooling' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Customer not found');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// POST /api/estimates — customer-anchor branch (estimate.controller.ts) — TECHNICIAN reachable
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 decision 8 — POST /api/estimates customer-anchor, gate removed outright', () => {
  const body = { customer_id: CUSTOMER_FIXTURE.id, line_items: [{ description: 'Rekey', quantity: 1, unit_price: 100, is_taxable: true }] };
  const customerRow = (orgId: string) => ({
    id: CUSTOMER_FIXTURE.id,
    organization_id: orgId,
    tax_exempt: false,
    service_locations: [{ id: LOCATION_FIXTURE.id, state: 'TX' }],
  });

  it('TECHNICIAN (unconditional create Estimate, no read Customer) → 201, ACCEPTED (no per-row gate on this branch)', async () => {
    mockAuthAs('technician');
    mockPrisma.customer.findUnique.mockResolvedValue(customerRow(TEST_USERS.technician.organization_id));
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    mockEstimateCreateTx({ id: 'est-1996-3', estimate_number: 'C00001-1' });

    const res = await request(app).post('/api/estimates').set(authHeader('technician')).send(body);

    expect(res.status).toBe(201);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('a reader (SALES, default read Customer) → 201', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue(customerRow(TEST_USERS.sales.organization_id));
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    mockEstimateCreateTx({ id: 'est-1996-1', estimate_number: 'C00001-1' });

    const res = await request(app).post('/api/estimates').set(authHeader('sales')).send(body);

    expect(res.status).toBe(201);
  });

  it('ADMIN (superuser) → 201', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(customerRow(TEST_USERS.admin.organization_id));
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    mockEstimateCreateTx({ id: 'est-1996-2', estimate_number: 'C00001-1' });

    const res = await request(app).post('/api/estimates').set(authHeader('admin')).send(body);

    expect(res.status).toBe(201);
  });

  it('cross-org id → 404 (unchanged — the tenant-scoped lookup already returns nothing)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ ...body, customer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Customer not found');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// #2041 decision 8 explicitly RE-LEGITIMIZES the #1996 two-step shape: a redacted duplicate 409's
// `id` replayed as `customer_id` on a create endpoint now succeeds (the carve-out), with the
// response redacted rather than refused. "Accepted, and decided" — spec decision 8.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 decision 8 — redacted 409 id -> customer_id replay is now ACCEPTED, redacted', () => {
  const EXISTING_ID = 'd0000000-0000-0000-0000-0000000000ee';
  const EXISTING_EMAIL = 'qa-1996-sec-existing@example.com';
  const EXISTING_ROW = {
    id: EXISTING_ID,
    customer_number: 'C00099',
    first_name: 'Existing', last_name: 'Person', company_name: null,
    email: EXISTING_EMAIL, phone: '5551996111',
    is_active: true, archived_at: null,
    service_locations: [], phones: [], extra_emails: [],
  };

  it('TECHNICIAN: 409 redacted id from new_customer, then customer_id replay → 201 (redacted, not refused)', async () => {
    mockAuthAs('technician');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const step1 = await request(app).post('/api/jobs').set(authHeader('technician')).send({
      new_customer: {
        first_name: 'Probe', last_name: 'Job1996Sec', email: EXISTING_EMAIL,
        location: { address_line1: '1 Probe St', city: 'Probeville', state: 'CA', zip: '94001' },
      },
      scope_notes: 'qa-1996-sec probe',
    });

    expect(step1.status).toBe(409);
    expect(step1.body.existing.redacted).toBe(true);
    const leakedId = step1.body.existing.id;
    expect(leakedId).toBe(EXISTING_ID);

    // TECHNICIAN has no `read Customer` grant at all — not associated with this row.
    mockPrisma.customer.findUnique.mockResolvedValue({
      id: leakedId, organization_id: TEST_USERS.technician.organization_id,
    });
    mockJobCreateTx();

    const step2 = await request(app).post('/api/jobs').set(authHeader('technician'))
      .send({ customer_id: leakedId, service_location_id: LOCATION_FIXTURE.id });

    expect(step2.status).toBe(201);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    if (step2.body.job.customer) {
      expect(step2.body.job.customer).not.toHaveProperty('email');
    }
  });
});
