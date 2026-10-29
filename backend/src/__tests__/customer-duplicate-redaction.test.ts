/**
 * #1996 — unit + audit-branch coverage for the redacting body builder.
 *
 * `repro-1996.test.ts` (frozen) pins the response CONTRACT at all five call sites. This file
 * pins the pieces that frozen suite does not exercise directly: `duplicateConflictBody`'s exact
 * key set and `matched` boolean derivation (N1-N4), the R8 fail-closed guarantee on a missing
 * condition field (N5), the R10 structural tenant assertion on the finder's own query (N6), and
 * the AC7 override-audit metadata for all three writers (customer/lead/job — R12).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS, CUSTOMER_FIXTURE, LOCATION_FIXTURE } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { allocateNumber } from '../lib/numbering';
import {
  findDuplicateCustomer,
  duplicateConflictBody,
  type DuplicateFinding,
  type ExistingMatch,
} from '../lib/customer-duplicate';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { scopeWhereFor } from '../lib/permissions/scopeWhereFor';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  vi.mocked(allocateNumber).mockImplementation(((_tx: unknown, entity: string) =>
    Promise.resolve(`${entity[0].toUpperCase()}00001`)) as typeof allocateNumber);
});

const FULL_MATCH: ExistingMatch = {
  id: 'c-existing-1',
  customer_number: 'C00042',
  first_name: 'Existing',
  last_name: 'Person',
  company_name: null,
  email: 'existing@example.com',
  phone: '5551996000',
  is_active: true,
  archived_at: null,
  primary_address: { line1: '1996 Fixture Ave', city: 'Fixtureville', state: 'CA' },
  matched: { email: null, phone: '5551996000' },
};

// The nine keys `expectRedacted` (repro-1996.test.ts:86-89) asserts absent — kept as a local
// literal so this file's contract does not depend on importing from the frozen suite.
const LEAKED_KEYS = [
  'customer_number', 'first_name', 'last_name', 'company_name',
  'email', 'phone', 'is_active', 'archived_at', 'primary_address',
];

describe('duplicateConflictBody — exact shapes (R7)', () => {
  it('N1: a readable finding returns the full match unchanged', () => {
    const finding: DuplicateFinding = { match: FULL_MATCH, readable: true };
    const body = duplicateConflictBody(finding);

    expect(body).toEqual({ error: 'duplicate', existing: FULL_MATCH });
    const existing = body.existing as ExistingMatch;
    expect(existing.customer_number).toBe('C00042');
    expect(existing.email).toBe('existing@example.com');
    expect(existing.phone).toBe('5551996000');
    expect('redacted' in existing).toBe(false);
  });

  it('N2: an unreadable finding exposes exactly id/matched/redacted, none of the LEAKED_KEYS', () => {
    const finding: DuplicateFinding = { match: FULL_MATCH, readable: false };
    const body = duplicateConflictBody(finding);

    expect(Object.keys(body.existing).sort()).toEqual(['id', 'matched', 'redacted']);
    expect((body as { redacted?: unknown }).redacted).toBeUndefined(); // never top-level
    for (const key of LEAKED_KEYS) {
      expect(key in body.existing, `existing.${key} must not be present when redacted`).toBe(false);
    }
    expect(body.existing.id).toBe('c-existing-1');
    expect((body.existing as { redacted: true }).redacted).toBe(true);
  });

  it('N3: matched booleans — phone-only, email-only, both — both keys always present', () => {
    const phoneOnly = duplicateConflictBody({
      match: { ...FULL_MATCH, matched: { email: null, phone: '5551996000' } },
      readable: false,
    });
    expect((phoneOnly.existing as { matched: unknown }).matched).toEqual({ email: false, phone: true });

    const emailOnly = duplicateConflictBody({
      match: { ...FULL_MATCH, matched: { email: 'existing@example.com', phone: null } },
      readable: false,
    });
    expect((emailOnly.existing as { matched: unknown }).matched).toEqual({ email: true, phone: false });

    const both = duplicateConflictBody({
      match: { ...FULL_MATCH, matched: { email: 'existing@example.com', phone: '5551996000' } },
      readable: false,
    });
    expect((both.existing as { matched: unknown }).matched).toEqual({ email: true, phone: true });
  });

  it('N4: finding.match still carries customer_number when readable === false (the audit branch needs it)', () => {
    const finding: DuplicateFinding = { match: FULL_MATCH, readable: false };
    expect(finding.match.customer_number).toBe('C00042');
    // ...while the body the client receives never does:
    expect('customer_number' in duplicateConflictBody(finding).existing).toBe(false);
  });
});

describe('findDuplicateCustomer — readable is fail-closed (R8) and tenant-structural (R10/N6)', () => {
  function makeClient(customers: unknown[]) {
    return { customer: { findMany: vi.fn().mockResolvedValue(customers) } } as never;
  }

  const ROW = {
    id: 'c1', organization_id: 'org-1', customer_number: 'C00001', first_name: 'Bob',
    last_name: null, company_name: null, email: null, phone: '5559998888',
    is_active: true, archived_at: null, service_locations: [], phones: [], extra_emails: [],
  };

  it('N5: a grant conditioned on a field absent from MATCH_SELECT redacts, and does not throw', async () => {
    const client = makeClient([ROW]);
    // `assignees` is never selected by MATCH_SELECT — the row the finder passes to the readable
    // check has no such key, so the condition compares against `undefined` and fails closed
    // (R12's absent-key-is-a-non-match rule, exercised via the same `scopeWhereFor` the real
    // `attachCustomerScope` middleware computes).
    const grants = [{ action: 'read', subject: 'Customer', conditions: { assignees: { some: { id: 'nope' } } } }];
    const req = {
      ability: defineAbilityFor({ id: 'u1', role: 'SALES' }, grants),
      customerScope: scopeWhereFor({ id: 'u1', role: 'SALES' }, 'Customer', grants),
    } as unknown as Request;

    let finding: DuplicateFinding | null = null;
    let threw = false;
    try {
      finding = await findDuplicateCustomer(client, 'org-1', { phone: '(555) 999-8888' }, { requester: req });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(finding).not.toBeNull();
    expect((finding as unknown as DuplicateFinding).readable).toBe(false);
  });

  it('N6: customer.findMany runs with where.organization_id === the requester org (structural, not a mocked-return proof)', async () => {
    const client = makeClient([]);
    const req = { ability: defineAbilityFor({ id: 'admin-1', role: 'ADMIN' }, []) } as unknown as Request;

    await findDuplicateCustomer(client, 'the-requesters-org', { phone: '5559998888' }, { requester: req });

    const call = (client as any).customer.findMany.mock.calls[0][0];
    expect(call.where.organization_id).toBe('the-requesters-org');
  });

  it('N6: with excludeCustomerId set, the where ALSO excludes the linked customer by id.not', async () => {
    const client = makeClient([]);
    const req = { ability: defineAbilityFor({ id: 'admin-1', role: 'ADMIN' }, []) } as unknown as Request;

    await findDuplicateCustomer(client, 'the-requesters-org', { phone: '5559998888' }, {
      requester: req,
      excludeCustomerId: 'linked-customer-id',
    });

    const call = (client as any).customer.findMany.mock.calls[0][0];
    expect(call.where.organization_id).toBe('the-requesters-org');
    expect(call.where.id).toEqual({ not: 'linked-customer-id' });
  });

  it('N6: MATCH_SELECT carries organization_id — a grant conditioned on it can match the row (not just the where-clause tenant filter)', async () => {
    const client = makeClient([ROW]); // ROW.organization_id === 'org-1'
    const grants = [{ action: 'read', subject: 'Customer', conditions: { organization_id: 'org-1' } }];
    const req = {
      ability: defineAbilityFor({ id: 'u1', role: 'SALES' }, grants),
      customerScope: scopeWhereFor({ id: 'u1', role: 'SALES' }, 'Customer', grants),
    } as unknown as Request;

    const finding = await findDuplicateCustomer(client, 'org-1', { phone: '(555) 999-8888' }, { requester: req });

    expect(finding?.readable).toBe(true); // only possible if the row the readable check evaluated carried organization_id
  });
});

// ─── AC7 — the override audit event does not leak the hidden customer number ──────────────────
// One case per writer (customer/lead/job — R12), each run twice: a readable match keeps today's
// wording + number, an unreadable one gets the neutral description and metadata WITHOUT
// matched_customer_number.
const EXISTING_ID = 'c0000000-0000-0000-0000-0000000000ee';
const EXISTING_PHONE = '5551996000';
const EXISTING_ROW = {
  id: EXISTING_ID,
  customer_number: 'C00042',
  first_name: 'Existing',
  last_name: 'Person',
  company_name: null,
  email: 'qa-1996-existing@example.com',
  phone: EXISTING_PHONE,
  is_active: true,
  archived_at: null,
  service_locations: [{ address_line1: '1996 Fixture Ave', city: 'Fixtureville', state: 'CA' }],
  phones: [],
  extra_emails: [],
  // #2041 — SALES's read Customer is now row-scoped (OWN_CUSTOMER); the "readable match" tests
  // below associate this row via created_by_id. `mockDeniedCustomerRead` below overrides the
  // WHOLE grant to a shape that ignores created_by_id entirely, so it still denies correctly.
  created_by_id: TEST_USERS.sales.id,
};

function mockDeniedCustomerRead(role: string) {
  const rows = [
    ...DEFAULT_GRANTS.filter((g) => !(g.role === role && g.action === 'read' && g.subject === 'Customer')),
    { role, action: 'read', subject: 'Customer', conditions: { id: 'zz-not-' + EXISTING_ID } },
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows.filter((g) => g.role === role));
  clearPermissionCache();
}

describe('#1996 AC7 — override audit metadata, one writer per controller', () => {
  it('customer.controller.ts: readable match keeps today\'s wording + matched_customer_number', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ customer: { create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [] }) } }));
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app).post('/api/customers?override=true').set(authHeader('sales'))
      .send({ first_name: 'Probe', last_name: 'Cust1996', phone: EXISTING_PHONE });

    expect(res.status).toBe(201);
    const call = mockPrisma.timelineEvent.create.mock.calls[0][0];
    expect(call.data.description).toBe('Customer created (duplicate of C00042 bypassed)');
    expect(call.data.metadata.matched_customer_id).toBe(EXISTING_ID);
    expect(call.data.metadata.matched_customer_number).toBe('C00042');
  });

  it('customer.controller.ts: unreadable match gets neutral wording, matched_customer_id only', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ customer: { create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [] }) } }));
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app).post('/api/customers?override=true').set(authHeader('sales'))
      .send({ first_name: 'Probe', last_name: 'Cust1996', phone: EXISTING_PHONE });

    expect(res.status).toBe(201);
    const call = mockPrisma.timelineEvent.create.mock.calls[0][0];
    expect(call.data.description).toBe('Customer created (duplicate of an existing customer bypassed)');
    expect(call.data.description).not.toContain('C00042');
    expect(call.data.metadata.matched_customer_id).toBe(EXISTING_ID);
    expect('matched_customer_number' in call.data.metadata).toBe(false);
  });

  it('lead.controller.ts: readable match keeps today\'s wording + matched_customer_number', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);
    const timelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({
      customer: { create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [] }) },
      lead: { create: vi.fn().mockResolvedValue({ id: 'new-lead-id', lead_number: 'L00001' }) },
      timelineEvent: { create: timelineCreate },
    }));

    const res = await request(app).post('/api/leads?override=true').set(authHeader('sales')).send({
      new_customer: { first_name: 'Probe', last_name: 'Lead1996', phone: EXISTING_PHONE },
      service_request: 'qa-1996 probe',
    });

    expect(res.status).toBe(201);
    const call = timelineCreate.mock.calls[0][0];
    expect(call.data.description).toBe('Customer created (duplicate of C00042 bypassed)');
    expect(call.data.metadata.matched_customer_id).toBe(EXISTING_ID);
    expect(call.data.metadata.matched_customer_number).toBe('C00042');
  });

  it('lead.controller.ts: unreadable match gets neutral wording, matched_customer_id only', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);
    const timelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({
      customer: { create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [] }) },
      lead: { create: vi.fn().mockResolvedValue({ id: 'new-lead-id', lead_number: 'L00001' }) },
      timelineEvent: { create: timelineCreate },
    }));

    const res = await request(app).post('/api/leads?override=true').set(authHeader('sales')).send({
      new_customer: { first_name: 'Probe', last_name: 'Lead1996', phone: EXISTING_PHONE },
      service_request: 'qa-1996 probe',
    });

    expect(res.status).toBe(201);
    const call = timelineCreate.mock.calls[0][0];
    expect(call.data.description).toBe('Customer created (duplicate of an existing customer bypassed)');
    expect(call.data.description).not.toContain('C00042');
    expect(call.data.metadata.matched_customer_id).toBe(EXISTING_ID);
    expect('matched_customer_number' in call.data.metadata).toBe(false);
  });

  it('job.controller.ts: readable match keeps today\'s wording + matched_customer_number', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);
    const timelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({
      customer: { create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] }) },
      job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'new-job-id', job_number: 'J00001' }) },
      orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
      stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
      timelineEvent: { create: timelineCreate },
    }));

    const res = await request(app).post('/api/jobs?override=true').set(authHeader('dispatcher')).send({
      new_customer: {
        first_name: 'Probe', last_name: 'Job1996', phone: EXISTING_PHONE,
        location: { address_line1: '1 Probe St', city: 'Probeville', state: 'CA', zip: '94001' },
      },
      scope_notes: 'qa-1996 probe',
    });

    expect(res.status).toBe(201);
    const call = timelineCreate.mock.calls[0][0];
    expect(call.data.description).toBe('Customer created (duplicate of C00042 bypassed)');
    expect(call.data.metadata.matched_customer_id).toBe(EXISTING_ID);
    expect(call.data.metadata.matched_customer_number).toBe('C00042');
  });

  it('job.controller.ts: unreadable match gets neutral wording, matched_customer_id only', async () => {
    mockAuthAs('dispatcher');
    mockDeniedCustomerRead('DISPATCHER');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);
    const timelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({
      customer: { create: vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] }) },
      job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'new-job-id', job_number: 'J00001' }) },
      orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
      stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
      timelineEvent: { create: timelineCreate },
    }));

    const res = await request(app).post('/api/jobs?override=true').set(authHeader('dispatcher')).send({
      new_customer: {
        first_name: 'Probe', last_name: 'Job1996', phone: EXISTING_PHONE,
        location: { address_line1: '1 Probe St', city: 'Probeville', state: 'CA', zip: '94001' },
      },
      scope_notes: 'qa-1996 probe',
    });

    expect(res.status).toBe(201);
    const call = timelineCreate.mock.calls[0][0];
    expect(call.data.description).toBe('Customer created (duplicate of an existing customer bypassed)');
    expect(call.data.description).not.toContain('C00042');
    expect(call.data.metadata.matched_customer_id).toBe(EXISTING_ID);
    expect('matched_customer_number' in call.data.metadata).toBe(false);
  });
});

// ─── validate-1.md finding 2 — coverage gaps the shipped suite left open ───────────────────────

/**
 * Grant `role` a `read Customer` conditioned on an `id` that IS the matched customer's id — the
 * inverse of `mockDeniedCustomerRead` above: the requester holds the grant AND is in scope on
 * this specific row.
 */
function mockInScopeCustomerRead(role: string) {
  const rows = [
    ...DEFAULT_GRANTS.filter((g) => !(g.role === role && g.action === 'read' && g.subject === 'Customer')),
    { role, action: 'read', subject: 'Customer', conditions: { id: EXISTING_ID } },
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows.filter((g) => g.role === role));
  clearPermissionCache();
}

describe('H1 — an in-scope conditioned read Customer grant gets the full body, at all five call sites', () => {
  it('site 1: POST /api/customers', async () => {
    mockAuthAs('sales');
    mockInScopeCustomerRead('SALES');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/customers').set(authHeader('sales'))
      .send({ first_name: 'Probe', last_name: 'Cust1996', phone: EXISTING_PHONE });

    expect(res.status).toBe(409);
    expect(res.body.existing.customer_number).toBe('C00042');
    expect(res.body.existing.redacted).toBeUndefined();
  });

  it('site 2: POST /api/leads (new_customer)', async () => {
    mockAuthAs('sales');
    mockInScopeCustomerRead('SALES');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/leads').set(authHeader('sales')).send({
      new_customer: {
        first_name: 'Probe', last_name: 'Lead1996', phone: EXISTING_PHONE,
        location: { address_line1: '1 Probe St', city: 'Probeville', state: 'CA', zip: '94001' },
      },
      service_request: 'qa-1996 probe',
    });

    expect(res.status).toBe(409);
    expect(res.body.existing.customer_number).toBe('C00042');
    expect(res.body.existing.redacted).toBeUndefined();
  });

  it('site 3: POST /api/leads (cross-customer accretion guard)', async () => {
    mockAuthAs('sales');
    mockInScopeCustomerRead('SALES');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/leads').set(authHeader('sales'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'qa-1996 probe', phone: EXISTING_PHONE });

    expect(res.status).toBe(409);
    expect(res.body.existing.customer_number).toBe('C00042');
    expect(res.body.existing.redacted).toBeUndefined();
  });

  it('site 4: POST /api/jobs (new_customer)', async () => {
    mockAuthAs('dispatcher');
    mockInScopeCustomerRead('DISPATCHER');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/jobs').set(authHeader('dispatcher')).send({
      new_customer: {
        first_name: 'Probe', last_name: 'Job1996', phone: EXISTING_PHONE,
        location: { address_line1: '1 Probe St', city: 'Probeville', state: 'CA', zip: '94001' },
      },
      scope_notes: 'qa-1996 probe',
    });

    expect(res.status).toBe(409);
    expect(res.body.existing.customer_number).toBe('C00042');
    expect(res.body.existing.redacted).toBeUndefined();
  });

  it('site 5: POST /api/jobs (cross-customer accretion guard)', async () => {
    mockAuthAs('dispatcher');
    mockInScopeCustomerRead('DISPATCHER');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/jobs').set(authHeader('dispatcher')).send({
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: LOCATION_FIXTURE.id,
      scope_notes: 'qa-1996 probe',
      phone: EXISTING_PHONE,
    });

    expect(res.status).toBe(409);
    expect(res.body.existing.customer_number).toBe('C00042');
    expect(res.body.existing.redacted).toBeUndefined();
  });
});

describe('H2 — an ADMIN-derived custom role (base role ADMIN, custom_role_id set) gets the full body', () => {
  // Mirrors comm-manual-log-edit.test.ts's `mockAuthAsAdminDerivedCustomRole`: `users.role` stays
  // ADMIN (unchanged) but `custom_role_id` points at a row whose OWN grants govern access, so
  // `isSuperUser` (role === 'ADMIN' && !custom_role_id) is false and this resolves through the
  // normal grant path instead of the manage-all short-circuit.
  const CUSTOM_ROLE_KEY = 'ops-lead-1996';

  it('POST /api/customers: an unconditional read Customer grant on the custom role gets the full body', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findUnique.mockResolvedValue({
      ...TEST_USERS.admin,
      custom_role_id: 'cc000000-0000-0000-0000-0000000000c2',
      custom_role: { key: CUSTOM_ROLE_KEY },
      organization: { is_demo: false, plan: 'SCALE', trial_ends_at: null, feature_overrides: {} },
    });
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      ...DEFAULT_GRANTS.filter((g) => g.role === 'SALES').map((g) => ({ ...g, role: CUSTOM_ROLE_KEY })),
      { role: CUSTOM_ROLE_KEY, action: 'read', subject: 'Customer', conditions: null },
    ]);
    clearTokenCache();
    clearPermissionCache();
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/customers').set(authHeader('admin'))
      .send({ first_name: 'Probe', last_name: 'Cust1996', phone: EXISTING_PHONE });

    expect(res.status).toBe(409);
    expect(res.body.existing.customer_number).toBe('C00042');
    expect(res.body.existing.redacted).toBeUndefined();
  });
});

describe('H5/H6 — the `matched` booleans reflect exactly which field(s) collided', () => {
  it('H5: an email-only collision redacts to matched: { email: true, phone: false }', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES');
    mockPrisma.customer.findMany.mockResolvedValue([EXISTING_ROW]);

    const res = await request(app).post('/api/customers').set(authHeader('sales'))
      .send({ first_name: 'Probe', last_name: 'Cust1996', email: EXISTING_ROW.email });

    expect(res.status).toBe(409);
    expect(res.body.existing.redacted).toBe(true);
    expect(res.body.existing.matched).toEqual({ email: true, phone: false });
  });

  it('H6: a match on a SECONDARY phone (phones[]) still redacts, matched: { email: false, phone: true }', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES');
    const rowWithSecondaryPhone = { ...EXISTING_ROW, phone: null, phones: [{ phone: '5551996998' }] };
    mockPrisma.customer.findMany.mockResolvedValue([rowWithSecondaryPhone]);

    const res = await request(app).post('/api/customers').set(authHeader('sales'))
      .send({ first_name: 'Probe', last_name: 'Cust1996', phone: '5551996998' });

    expect(res.status).toBe(409);
    expect(res.body.existing.redacted).toBe(true);
    expect(res.body.existing.matched).toEqual({ email: false, phone: true });
  });
});

describe('H11 — a rejected customer.findMany propagates, never a silent full/redacted 409', () => {
  it('POST /api/customers: the finder\'s own query rejecting surfaces as a 500, not a 409', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockRejectedValue(new Error('qa-1996 db unavailable'));

    const res = await request(app).post('/api/customers').set(authHeader('sales'))
      .send({ first_name: 'Probe', last_name: 'Cust1996', phone: EXISTING_PHONE });

    expect(res.status).toBe(500);
    expect(res.body.existing).toBeUndefined();
  });
});
