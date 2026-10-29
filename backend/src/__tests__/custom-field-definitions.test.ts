import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, TEST_USERS } from './helpers';
import { prisma } from '../lib/prisma';

const mockPrisma = prisma as unknown as {
  customFieldDefinition: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  lead: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  job: { update: ReturnType<typeof vi.fn> };
  customer: { update: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/custom-field-definitions', () => {
  it('lists org-scoped, non-archived definitions', async () => {
    mockAuthAs('admin');
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: 'def-1', organization_id: TEST_USERS.admin.organization_id, key: 'po_number', label: 'PO Number', type: 'TEXT', entity_types: ['JOB'], options: [], required: false, sort_order: 0, archived_at: null },
    ]);

    const res = await request(app).get('/api/custom-field-definitions').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.custom_field_definitions).toHaveLength(1);
    const callArgs = mockPrisma.customFieldDefinition.findMany.mock.calls[0][0];
    expect(callArgs.where.organization_id).toBe(TEST_USERS.admin.organization_id);
    expect(callArgs.where.archived_at).toBeNull();
  });

  it('filters by entity_type when provided', async () => {
    mockAuthAs('admin');
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([]);

    await request(app).get('/api/custom-field-definitions?entity_type=JOB').set(authHeader('admin'));

    const callArgs = mockPrisma.customFieldDefinition.findMany.mock.calls[0][0];
    expect(callArgs.where.entity_types).toEqual({ has: 'JOB' });
  });

  it('does not filter by entity type when omitted', async () => {
    mockAuthAs('admin');
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([]);

    await request(app).get('/api/custom-field-definitions').set(authHeader('admin'));

    const callArgs = mockPrisma.customFieldDefinition.findMany.mock.calls[0][0];
    expect(callArgs.where.entity_types).toBeUndefined();
  });

  it('blocks unauthenticated access', async () => {
    const res = await request(app).get('/api/custom-field-definitions');
    expect(res.status).toBe(401);
  });

  it('TECHNICIAN can read (default read Organization grant, same precedent as org-tax-rates)', async () => {
    mockAuthAs('technician');
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/custom-field-definitions').set(authHeader('technician'));
    expect(res.status).toBe(200);
  });

  it("never returns another org's definitions - the where clause is the only thing standing between orgs here", async () => {
    // The mock cannot itself enforce tenant scoping, so the real assertion is on the query the
    // controller issues: it must never ask Prisma for a bare `findMany({})` un-scoped by org.
    mockAuthAs('orgB_admin');
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([]);

    await request(app).get('/api/custom-field-definitions').set(authHeader('orgB_admin'));

    const callArgs = mockPrisma.customFieldDefinition.findMany.mock.calls[0][0];
    expect(callArgs.where.organization_id).toBe(TEST_USERS.orgB_admin.organization_id);
    expect(callArgs.where.organization_id).not.toBe(TEST_USERS.admin.organization_id);
  });
});

describe('POST /api/custom-field-definitions', () => {
  it('creates a TEXT definition scoped to the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue(null);
    mockPrisma.customFieldDefinition.create.mockResolvedValue({
      id: 'def-2', organization_id: TEST_USERS.admin.organization_id, key: 'po_number', label: 'PO Number', type: 'TEXT', entity_types: ['JOB'], options: [], required: false, sort_order: 0, archived_at: null,
    });

    const res = await request(app)
      .post('/api/custom-field-definitions')
      .set(authHeader('admin'))
      .send({ key: 'po_number', label: 'PO Number', type: 'TEXT', entity_types: ['JOB'] });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.customFieldDefinition.create.mock.calls[0][0];
    expect(createArgs.data.organization_id).toBe(TEST_USERS.admin.organization_id);
    expect(createArgs.data.key).toBe('po_number');
    expect(createArgs.data.entity_types).toEqual(['JOB']);
  });

  it('rejects a duplicate key within the same org', async () => {
    mockAuthAs('admin');
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue({ id: 'existing-def' });

    const res = await request(app)
      .post('/api/custom-field-definitions')
      .set(authHeader('admin'))
      .send({ key: 'po_number', label: 'PO Number', type: 'TEXT', entity_types: ['JOB'] });

    expect(res.status).toBe(409);
    expect(mockPrisma.customFieldDefinition.create).not.toHaveBeenCalled();
  });

  it('rejects a missing entity_types', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/custom-field-definitions')
      .set(authHeader('admin'))
      .send({ key: 'po_number', label: 'PO Number', type: 'TEXT', entity_types: [] });
    expect(res.status).toBe(400);
  });

  it('rejects a type other than TEXT (not exercised end to end this slice)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/custom-field-definitions')
      .set(authHeader('admin'))
      .send({ key: 'quantity', label: 'Quantity', type: 'NUMBER', entity_types: ['JOB'] });
    expect(res.status).toBe(400);
  });

  it('TECHNICIAN cannot create (no update-Organization grant)', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .post('/api/custom-field-definitions')
      .set(authHeader('technician'))
      .send({ key: 'po_number', label: 'PO Number', type: 'TEXT', entity_types: ['JOB'] });
    expect(res.status).toBe(403);
    expect(mockPrisma.customFieldDefinition.create).not.toHaveBeenCalled();
  });
});

// SRVW-114 slice 3 - a definition's entity scope has to be editable after creation, otherwise
// an admin who ticks the wrong entity has to abandon the key (there is no delete path) and
// invent a second one.
describe('PATCH /api/custom-field-definitions/:id', () => {
  const DEF_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

  it('updates the label and the entity scope', async () => {
    mockAuthAs('admin');
    mockPrisma.customFieldDefinition.findFirst.mockResolvedValue({
      id: DEF_ID, organization_id: TEST_USERS.admin.organization_id, key: 'po_number', type: 'TEXT', entity_types: ['JOB'],
    });
    mockPrisma.customFieldDefinition.update.mockResolvedValue({
      id: DEF_ID, key: 'po_number', label: 'Reference', type: 'TEXT', entity_types: ['JOB', 'LEAD'], options: [], required: false, sort_order: 0, archived_at: null,
    });

    const res = await request(app)
      .patch(`/api/custom-field-definitions/${DEF_ID}`)
      .set(authHeader('admin'))
      .send({ label: 'Reference', entity_types: ['JOB', 'LEAD'] });

    expect(res.status).toBe(200);
    const updateArgs = mockPrisma.customFieldDefinition.update.mock.calls[0][0];
    expect(updateArgs.data.label).toBe('Reference');
    expect(updateArgs.data.entity_types).toEqual(['JOB', 'LEAD']);
  });

  // The lookup is what enforces tenancy: `update` takes a bare unique id, so without an
  // org-scoped read first, any admin could rewrite another org's definition by guessing a uuid.
  it("404s on another org's definition and never writes", async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.customFieldDefinition.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/custom-field-definitions/${DEF_ID}`)
      .set(authHeader('orgB_admin'))
      .send({ label: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(mockPrisma.customFieldDefinition.update).not.toHaveBeenCalled();
    const where = mockPrisma.customFieldDefinition.findFirst.mock.calls[0][0].where;
    expect(where.organization_id).toBe(TEST_USERS.orgB_admin.organization_id);
  });

  // `key` is what stored values are NOT keyed by (they use the uuid), but it is the org-facing
  // identifier and the unique constraint; `type` decides how every stored value is interpreted.
  // Changing either after values exist reinterprets or orphans data, so neither is accepted.
  it('ignores attempts to change key or type', async () => {
    mockAuthAs('admin');
    mockPrisma.customFieldDefinition.findFirst.mockResolvedValue({
      id: DEF_ID, organization_id: TEST_USERS.admin.organization_id, key: 'po_number', type: 'TEXT', entity_types: ['JOB'],
    });
    mockPrisma.customFieldDefinition.update.mockResolvedValue({ id: DEF_ID });

    await request(app)
      .patch(`/api/custom-field-definitions/${DEF_ID}`)
      .set(authHeader('admin'))
      .send({ key: 'something_else', type: 'NUMBER', label: 'Reference' });

    const updateArgs = mockPrisma.customFieldDefinition.update.mock.calls[0][0];
    expect(updateArgs.data.key).toBeUndefined();
    expect(updateArgs.data.type).toBeUndefined();
  });

  it('rejects narrowing the entity scope to nothing', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .patch(`/api/custom-field-definitions/${DEF_ID}`)
      .set(authHeader('admin'))
      .send({ entity_types: [] });
    expect(res.status).toBe(400);
    expect(mockPrisma.customFieldDefinition.update).not.toHaveBeenCalled();
  });

  // Archive-not-delete's sibling rule: dropping an entity from the scope must not be a
  // data-loss event. Values live in each row's own custom_fields bag, so narrowing the
  // definition may touch the definition row and nothing else - reinstating the entity
  // brings the old values straight back.
  it('narrowing the scope writes only the definition row, never the entities that hold values', async () => {
    mockAuthAs('admin');
    mockPrisma.customFieldDefinition.findFirst.mockResolvedValue({
      id: DEF_ID, organization_id: TEST_USERS.admin.organization_id, key: 'po_number', type: 'TEXT', entity_types: ['JOB', 'LEAD'],
    });
    mockPrisma.customFieldDefinition.update.mockResolvedValue({ id: DEF_ID });

    await request(app)
      .patch(`/api/custom-field-definitions/${DEF_ID}`)
      .set(authHeader('admin'))
      .send({ entity_types: ['JOB'] });

    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
    expect(mockPrisma.lead.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
    expect(mockPrisma.customer.update).not.toHaveBeenCalled();
  });

  it('TECHNICIAN cannot update (no update-Organization grant)', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .patch(`/api/custom-field-definitions/${DEF_ID}`)
      .set(authHeader('technician'))
      .send({ label: 'Reference' });
    expect(res.status).toBe(403);
    expect(mockPrisma.customFieldDefinition.update).not.toHaveBeenCalled();
  });
});
