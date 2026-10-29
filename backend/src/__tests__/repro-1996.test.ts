/**
 * #1996 — the duplicate-customer 409 leaks the full matched record to a requester who cannot
 * read that customer row.
 *
 * Agent Brief (issue #1996): after `findDuplicateCustomer` finds a match, evaluate whether the
 * requester may READ that specific customer row with the same row-scope machinery the
 * customer list/detail use — never a role name. May read → unchanged (full `existing`). May not
 * → `409 { error:'duplicate', existing:{ id, matched:{email,phone} }, redacted:true }` with NO
 * name/company/email/phone/address/customer_number/status keys. One code path for all five
 * call sites.
 *
 * Mechanism for "the requester cannot read this row" (Pass A found the Roles editor cannot
 * author a conditioned `read Customer` grant at all — `roleViewModel.ts`'s `SCOPE_ENTITIES`
 * excludes `Customer` by design — and `scopeWhereFor.ts`'s `ScopeResource` union also omits
 * `Customer`, so there is no LIST/detail row-scope machinery for Customer today either):
 *
 *   `defineAbilityFor` (backend/src/lib/permissions/defineAbility.ts:94-102) is fully generic —
 *   it turns ANY `{role,action,subject,conditions}` row into a CASL rule via
 *   `can(action, subject, conditions)`, regardless of whether that subject is in
 *   `ScopeResource`. And `enforce.ts`'s `can(req, action, subjectName, row)`
 *   (backend/src/lib/permissions/enforce.ts:44-49) already evaluates a CASL rule's conditions
 *   directly against a loaded JS row via `subject()` — no SQL `where`-fragment translation, so
 *   it does NOT depend on `ScopeResource` either. So a conditioned `read Customer` grant CAN be
 *   hand-injected into the mocked `rolePermission.findMany` (bypassing the Roles editor, which
 *   is a UI gap, not a permissions-engine gap) and evaluated per-row TODAY via
 *   `req.ability.can('read', subject('Customer', matchedRow))` — this is the CONTRACT the fix
 *   is expected to wire into all five call sites, reusing `enforce.ts`'s existing `can()`
 *   helper rather than inventing new machinery. `mockDeniedCustomerRead` below grants a
 *   `read Customer` conditioned on an `id` that is NOT the matched customer's id — the
 *   requester holds the grant (so route-level `canDo` guards elsewhere are unaffected) but is
 *   denied on THIS row, exactly the shape `can()` already understands for Lead/Job/Estimate.
 *
 * Five call sites (all through `findDuplicateCustomer`, backend/src/lib/customer-duplicate.ts:100):
 *   1. POST /api/customers                        — customer.controller.ts:502 (call), 409 at :507
 *   2. POST /api/leads (new_customer)              — lead.controller.ts:763 (call), 409 at :768
 *   3. POST /api/leads (cross-customer accretion)  — lead.controller.ts:919 (call), 409 at :921
 *   4. POST /api/jobs (new_customer)               — job.controller.ts:1457 (call), 409 at :1462
 *   5. POST /api/jobs (cross-customer accretion)   — job.controller.ts:1568 (call), 409 at :1570
 *
 * Every site gets the same four cases: a requester who CAN read the match (green control, full
 * body unchanged), a requester who CANNOT (red — today still leaks the full body; desired: a
 * redacted 409), a cross-org requester (green control — tenant scoping already yields no match
 * at all, so no 409 fires), and ADMIN (green control, full body — ADMIN is a superuser).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, CUSTOMER_FIXTURE, LOCATION_FIXTURE } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { allocateNumber } from '../lib/numbering';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  vi.mocked(allocateNumber).mockImplementation(((_tx: unknown, entity: string) =>
    Promise.resolve(`${entity[0].toUpperCase()}00001`)) as typeof allocateNumber);
});

// ─── Fixture: the existing customer the probes collide with ────────────────────────────────
const EXISTING_ID = 'c0000000-0000-0000-0000-0000000000ee';
const EXISTING_PHONE = '5551996000';
const EXISTING_EMAIL = 'qa-1996-existing@example.com';
const EXISTING_ROW = {
  id: EXISTING_ID,
  customer_number: 'C00042',
  first_name: 'Existing',
  last_name: 'Person',
  company_name: null,
  email: EXISTING_EMAIL,
  phone: EXISTING_PHONE,
  is_active: true,
  archived_at: null,
  service_locations: [{ address_line1: '1996 Fixture Ave', city: 'Fixtureville', state: 'CA' }],
  phones: [],
  extra_emails: [],
};

// Every key `ExistingMatch` (customer-duplicate.ts:19-37) carries besides `id`/`matched` — the
// issue brief's "NO name/company/email/phone/address/customer_number/status keys".
const LEAKED_KEYS = [
  'customer_number', 'first_name', 'last_name', 'company_name',
  'email', 'phone', 'is_active', 'archived_at', 'primary_address',
];

function expectRedacted(existing: Record<string, unknown>) {
  expect(existing.redacted).toBe(true);
  expect(existing.id).toBe(EXISTING_ID);
  expect(existing.matched).toBeDefined();
  expect('email' in existing).toBe(false);
  for (const key of LEAKED_KEYS) {
    expect(key in existing, `existing.${key} must not be present when redacted`).toBe(false);
  }
}

function expectFullMatch(existing: Record<string, unknown>) {
  expect(existing.id).toBe(EXISTING_ID);
  expect(existing.customer_number).toBe('C00042');
  expect(existing.email).toBe(EXISTING_EMAIL);
  expect(existing.phone).toBe(EXISTING_PHONE);
}

/**
 * Grant `role` a `read Customer` conditioned on an `id` that is NOT `EXISTING_ID` — the
 * requester holds the grant (unrelated route-level `canDo('read','Customer')` guards, if any,
 * still pass) but is denied per-row on the matched customer. See file header for why this is
 * achievable today independent of the Roles editor / `ScopeResource`.
 */
function mockDeniedCustomerRead(role: string) {
  const rows = [
    ...DEFAULT_GRANTS.filter((g) => !(g.role === role && g.action === 'read' && g.subject === 'Customer')),
    { role, action: 'read', subject: 'Customer', conditions: { id: 'zz-not-' + EXISTING_ID } },
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows.filter((g) => g.role === role));
  clearPermissionCache();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Site 1 — POST /api/customers (customer.controller.ts:502)
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1996 (1) POST /api/customers — duplicate 409 body', () => {
  const body = { first_name: 'Probe', last_name: 'Cust1996', phone: EXISTING_PHONE };

  it('green control: a requester who CAN read the match (SALES, unconditional default) gets the full body', async () => {
    mockAuthAs('sales'); // default grants: unconditional read Customer (defaultGrants.ts:96)
    mockPrisma.customer.findMany.mockResolvedValue([{ ...EXISTING_ROW, created_by_id: TEST_USERS.sales.id }]);

    const res = await request(app).post('/api/customers').set(authHeader('sales')).send(body);

    expect(res.status).toBe(409);
    expectFullMatch(res.body.existing);
  });

  it('RED — a requester who CANNOT read the match (SALES, denied on this row) still gets the full leaked body today; desired: redacted', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/customers').set(authHeader('sales')).send(body);

    expect(res.status).toBe(409);
    expectRedacted(res.body.existing);
  });

  it('green control: a cross-org requester finds no match (tenant-scoped lookup), no 409 at all', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.customer.findMany.mockResolvedValue([]); // org-scoped lookup never returns another org's row
    let txCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCreate = vi.fn().mockResolvedValue({ id: 'new-id', ...body, service_locations: [] });
      return fn({ customer: { create: txCreate } });
    });

    const res = await request(app).post('/api/customers').set(authHeader('orgB_admin')).send(body);

    expect(res.status).not.toBe(409);
    expect(res.status).toBe(201);
  });

  it('green control: ADMIN (superuser) gets the full body', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/customers').set(authHeader('admin')).send(body);

    expect(res.status).toBe(409);
    expectFullMatch(res.body.existing);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Site 2 — POST /api/leads, new_customer duplicate (lead.controller.ts:763)
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1996 (2) POST /api/leads (new_customer) — duplicate 409 body', () => {
  const body = {
    new_customer: {
      first_name: 'Probe', last_name: 'Lead1996', phone: EXISTING_PHONE,
      location: { address_line1: '1 Probe St', city: 'Probeville', state: 'CA', zip: '94001' },
    },
    service_request: 'qa-1996 probe',
  };

  it('green control: a requester who CAN read the match (SALES) gets the full body', async () => {
    mockAuthAs('sales'); // SALES holds create Lead (defaultGrants.ts:97)
    mockPrisma.customer.findMany.mockResolvedValue([{ ...EXISTING_ROW, created_by_id: TEST_USERS.sales.id }]);

    const res = await request(app).post('/api/leads').set(authHeader('sales')).send(body);

    expect(res.status).toBe(409);
    expectFullMatch(res.body.existing);
  });

  it('RED — a requester who CANNOT read the match still gets the full leaked body today; desired: redacted', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/leads').set(authHeader('sales')).send(body);

    expect(res.status).toBe(409);
    expectRedacted(res.body.existing);
  });

  it('green control: a cross-org requester finds no match, no 409 at all', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
      customer: { create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [] }) },
      lead: { create: vi.fn().mockResolvedValue({ id: 'new-lead-id', lead_number: 'L00001' }) },
      timelineEvent: { create: vi.fn() },
    }));

    const res = await request(app).post('/api/leads').set(authHeader('orgB_admin')).send(body);

    expect(res.status).not.toBe(409);
    expect(res.status).toBe(201);
  });

  it('green control: ADMIN (superuser) gets the full body', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/leads').set(authHeader('admin')).send(body);

    expect(res.status).toBe(409);
    expectFullMatch(res.body.existing);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Site 3 — POST /api/leads, cross-customer accretion guard (lead.controller.ts:919)
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1996 (3) POST /api/leads (cross-customer accretion guard) — duplicate 409 body', () => {
  const body = { customer_id: CUSTOMER_FIXTURE.id, service_request: 'qa-1996 probe', phone: EXISTING_PHONE };

  beforeEach(() => {
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE); // the linked customer exists in-org
  });

  it('green control: a requester who CAN read the match gets the full body', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([{ ...EXISTING_ROW, created_by_id: TEST_USERS.sales.id }]); // a DIFFERENT customer owns the phone

    const res = await request(app).post('/api/leads').set(authHeader('sales')).send(body);

    expect(res.status).toBe(409);
    expectFullMatch(res.body.existing);
  });

  it('RED — a requester who CANNOT read the match still gets the full leaked body today; desired: redacted', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/leads').set(authHeader('sales')).send(body);

    expect(res.status).toBe(409);
    expectRedacted(res.body.existing);
  });

  it('green control: a cross-org requester — the linked customer_id is not in their org, 400 not 409, no leak', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.customer.findUnique.mockResolvedValue(null); // tenantWhere excludes another org's customer_id
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app).post('/api/leads').set(authHeader('orgB_admin')).send(body);

    expect(res.status).not.toBe(409);
    expect(res.status).toBe(400);
  });

  it('green control: ADMIN (superuser) gets the full body', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/leads').set(authHeader('admin')).send(body);

    expect(res.status).toBe(409);
    expectFullMatch(res.body.existing);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Site 4 — POST /api/jobs, new_customer duplicate (job.controller.ts:1457)
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1996 (4) POST /api/jobs (new_customer) — duplicate 409 body', () => {
  const body = {
    new_customer: {
      first_name: 'Probe', last_name: 'Job1996', phone: EXISTING_PHONE,
      location: { address_line1: '1 Probe St', city: 'Probeville', state: 'CA', zip: '94001' },
    },
    scope_notes: 'qa-1996 probe',
  };

  it('green control: a requester who CAN read the match (DISPATCHER) gets the full body', async () => {
    mockAuthAs('dispatcher'); // DISPATCHER holds create Job + unconditional read Customer (defaultGrants.ts:189,217)
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/jobs').set(authHeader('dispatcher')).send(body);

    expect(res.status).toBe(409);
    expectFullMatch(res.body.existing);
  });

  it('RED — a requester who CANNOT read the match still gets the full leaked body today; desired: redacted', async () => {
    mockAuthAs('dispatcher');
    mockDeniedCustomerRead('DISPATCHER');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/jobs').set(authHeader('dispatcher')).send(body);

    expect(res.status).toBe(409);
    expectRedacted(res.body.existing);
  });

  it('green control: a cross-org requester finds no match, no 409 at all', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      customer: { create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] }) },
      job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'new-job-id', job_number: 'J00001' }) },
      orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
      stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }));

    const res = await request(app).post('/api/jobs').set(authHeader('orgB_admin')).send(body);

    expect(res.status).not.toBe(409);
    expect(res.status).toBe(201);
  });

  it('green control: ADMIN (superuser) gets the full body', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/jobs').set(authHeader('admin')).send(body);

    expect(res.status).toBe(409);
    expectFullMatch(res.body.existing);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Site 5 — POST /api/jobs, cross-customer accretion guard (job.controller.ts:1568)
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1996 (5) POST /api/jobs (cross-customer accretion guard) — duplicate 409 body', () => {
  const body = {
    customer_id: CUSTOMER_FIXTURE.id,
    service_location_id: LOCATION_FIXTURE.id,
    scope_notes: 'qa-1996 probe',
    phone: EXISTING_PHONE,
  };

  beforeEach(() => {
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
  });

  it('green control: a requester who CAN read the match gets the full body', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/jobs').set(authHeader('dispatcher')).send(body);

    expect(res.status).toBe(409);
    expectFullMatch(res.body.existing);
  });

  it('RED — a requester who CANNOT read the match still gets the full leaked body today; desired: redacted', async () => {
    mockAuthAs('dispatcher');
    mockDeniedCustomerRead('DISPATCHER');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/jobs').set(authHeader('dispatcher')).send(body);

    expect(res.status).toBe(409);
    expectRedacted(res.body.existing);
  });

  it('green control: a cross-org requester — the linked customer_id is not in their org, 404 not 409, no leak', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.customer.findUnique.mockResolvedValue(null);
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app).post('/api/jobs').set(authHeader('orgB_admin')).send(body);

    expect(res.status).not.toBe(409);
    expect(res.status).toBe(404);
  });

  it('green control: ADMIN (superuser) gets the full body', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/jobs').set(authHeader('admin')).send(body);

    expect(res.status).toBe(409);
    expectFullMatch(res.body.existing);
  });
});
