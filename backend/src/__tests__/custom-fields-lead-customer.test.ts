// SRVW-114 slice 3 - custom-field VALUES on Lead and Customer.
//
// Slice 1 shipped the whole spine but wired only the Job PATCH, so a definition scoped to LEAD
// or CUSTOMER saved fine in Settings and then surfaced nowhere - no error, no empty state. These
// tests pin the two remaining value paths to the same contract the Job path already honours:
// validate against the org's own definitions, merge onto the stored bag, never let one entity's
// definition be written onto another's row.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS, LEAD_FIXTURE, CUSTOMER_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  lead: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  customer: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  customFieldDefinition: { findMany: ReturnType<typeof vi.fn> };
};

const DEF_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Lead ──────────────────────────────────────────────

describe('PATCH /api/leads/:id - custom_fields (SRVW-114 slice 3)', () => {
  it('merges the patch onto the existing bag and persists it', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, custom_fields: { 'other-def': 'kept' } });
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_ID, entity_types: ['LEAD'], type: 'TEXT', archived_at: null },
    ]);
    let captured: { data: Record<string, unknown> } | undefined;
    mockPrisma.lead.update.mockImplementation((args: { data: Record<string, unknown> }) => {
      captured = args;
      return Promise.resolve({ ...LEAD_FIXTURE, custom_fields: args.data.custom_fields });
    });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ custom_fields: { [DEF_ID]: 'Gate code 4417' } });

    expect(res.status).toBe(200);
    expect(captured?.data.custom_fields).toEqual({ 'other-def': 'kept', [DEF_ID]: 'Gate code 4417' });
    expect(res.body.lead.custom_fields).toEqual({ 'other-def': 'kept', [DEF_ID]: 'Gate code 4417' });
  });

  it('400s on an unknown definition id and never calls lead.update', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([]);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ custom_fields: { [DEF_ID]: 'x' } });

    expect(res.status).toBe(400);
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
  });

  // The cross-entity guard: a JOB-only definition must not become writable on a lead just
  // because both rows now carry a custom_fields column.
  it('400s when the definition is not scoped to LEAD', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_ID, entity_types: ['JOB'], type: 'TEXT', archived_at: null },
    ]);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ custom_fields: { [DEF_ID]: 'x' } });

    expect(res.status).toBe(400);
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
  });

  it('400s on a non-string value against a TEXT definition', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_ID, entity_types: ['LEAD'], type: 'TEXT', archived_at: null },
    ]);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ custom_fields: { [DEF_ID]: 42 } });

    expect(res.status).toBe(400);
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
  });

  // Org isolation. The mock cannot enforce scoping, so the assertion is on the query the
  // controller issues: the definition lookup must be bounded by the CALLER's org, which is
  // what makes borrowing another org's definition id resolve to "unknown" rather than valid.
  it("looks definitions up under the caller's organization, never globally", async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([]);

    await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('orgB_admin'))
      .send({ custom_fields: { [DEF_ID]: 'x' } });

    const where = mockPrisma.customFieldDefinition.findMany.mock.calls[0][0].where;
    expect(where.organization_id).toBe(TEST_USERS.orgB_admin.organization_id);
    expect(where.organization_id).not.toBe(TEST_USERS.admin.organization_id);
  });

  // Asserted on the SELECT, not on the response body: the Prisma mock hands back whatever the
  // fixture holds regardless of `select`, so a body assertion here would pass even with the
  // column missing from leadDetailSelect - which is exactly the bug this guards.
  it('asks for custom_fields in the lead detail select, so the panel has values to render', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, custom_fields: { [DEF_ID]: 'Gate code 4417' } });

    const res = await request(app).get(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    const select = mockPrisma.lead.findUnique.mock.calls[0][0].select;
    expect(select.custom_fields).toBe(true);
  });
});

// ─── Customer ──────────────────────────────────────────

describe('PATCH /api/customers/:id - custom_fields (SRVW-114 slice 3)', () => {
  it('merges the patch onto the existing bag and persists it', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, custom_fields: { 'other-def': 'kept' } });
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_ID, entity_types: ['CUSTOMER'], type: 'TEXT', archived_at: null },
    ]);
    let captured: { data: Record<string, unknown> } | undefined;
    mockPrisma.customer.update.mockImplementation((args: { data: Record<string, unknown> }) => {
      captured = args;
      return Promise.resolve({ ...CUSTOMER_FIXTURE, custom_fields: args.data.custom_fields });
    });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ custom_fields: { [DEF_ID]: 'Net 30' } });

    expect(res.status).toBe(200);
    expect(captured?.data.custom_fields).toEqual({ 'other-def': 'kept', [DEF_ID]: 'Net 30' });
    expect(res.body.customer.custom_fields).toEqual({ 'other-def': 'kept', [DEF_ID]: 'Net 30' });
  });

  it('400s on an unknown definition id and never calls customer.update', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([]);

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ custom_fields: { [DEF_ID]: 'x' } });

    expect(res.status).toBe(400);
    expect(mockPrisma.customer.update).not.toHaveBeenCalled();
  });

  it('400s when the definition is not scoped to CUSTOMER', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_ID, entity_types: ['LEAD'], type: 'TEXT', archived_at: null },
    ]);

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ custom_fields: { [DEF_ID]: 'x' } });

    expect(res.status).toBe(400);
    expect(mockPrisma.customer.update).not.toHaveBeenCalled();
  });

  it('400s on a non-string value against a TEXT definition', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_ID, entity_types: ['CUSTOMER'], type: 'TEXT', archived_at: null },
    ]);

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ custom_fields: { [DEF_ID]: true } });

    expect(res.status).toBe(400);
    expect(mockPrisma.customer.update).not.toHaveBeenCalled();
  });

  it("looks definitions up under the caller's organization, never globally", async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([]);

    await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('orgB_admin'))
      .send({ custom_fields: { [DEF_ID]: 'x' } });

    const where = mockPrisma.customFieldDefinition.findMany.mock.calls[0][0].where;
    expect(where.organization_id).toBe(TEST_USERS.orgB_admin.organization_id);
    expect(where.organization_id).not.toBe(TEST_USERS.admin.organization_id);
  });

  // custom_fields must not reach the audit trail as a raw bag - it rides the same `rest`
  // spread every other column does, so without an explicit carve-out it would land in
  // prisma.customer.update's data twice (once unvalidated) as well as in the timeline event.
  it('records the edit in the timeline as a field name, not as raw values', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_ID, entity_types: ['CUSTOMER'], type: 'TEXT', archived_at: null },
    ]);
    mockPrisma.customer.update.mockResolvedValue(CUSTOMER_FIXTURE);

    await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ custom_fields: { [DEF_ID]: 'Net 30' } });

    const timelineArgs = (prisma.timelineEvent.create as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(timelineArgs.data.metadata.fields).toContain('custom_fields');
    expect(JSON.stringify(timelineArgs.data.metadata)).not.toContain('Net 30');
  });

  // Same reasoning as the lead select test above.
  it('asks for custom_fields in the customer detail select', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, custom_fields: {} });

    await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('admin'));

    const select = mockPrisma.customer.findUnique.mock.calls[0][0].select;
    expect(select.custom_fields).toBe(true);
  });
});
