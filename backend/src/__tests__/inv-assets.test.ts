/**
 * Inventory P4 (plan §4 Phase 4 / D12) — Asset CRUD.
 *
 * Company tools assigned to technicians. Rides the existing Inventory subject
 * (Admin + Dispatcher full, Sales read-only, Technician none). Serials are NOT
 * unique server-side (duplicate-serial is a UI warn only, QA-38). photo_url in
 * the DB is the canonical Storage path; responses carry a short-lived signed URL.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import {
  mockAuthAs,
  authHeader,
  ALPHA_ORG_ID,
  ASSET_FIXTURE,
  ASSET_ASSIGNED_FIXTURE,
  ASSET_RETIRED_FIXTURE,
  PRICE_BOOK_ITEM_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  asset: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  priceBookItem: { findFirst: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

// setup.ts mocks storage.from with mockReturnValue → the SAME object every call.
const storageApi = (supabaseAdmin.storage.from as any)();

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.asset.findMany.mockResolvedValue([ASSET_FIXTURE]);
  mockPrisma.asset.count.mockResolvedValue(1);
});

describe('GET /api/inventory/assets', () => {
  it('returns the {data, meta} envelope with org-scoped where + relation includes', async () => {
    const res = await request(app).get('/api/inventory/assets').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: ASSET_FIXTURE.id, name: ASSET_FIXTURE.name, serial: ASSET_FIXTURE.serial, status: 'ACTIVE' });
    expect(res.body.meta).toMatchObject({ total: 1, page: 1 });

    const args = mockPrisma.asset.findMany.mock.calls[0][0];
    expect(args.where.organization_id).toBe(ALPHA_ORG_ID);
    expect(args.include.assigned_user).toBeDefined();
    expect(args.include.price_book_item).toBeDefined();
  });

  it('?status=RETIRED filters; ?status=BOGUS is ignored (enum-guarded)', async () => {
    await request(app).get('/api/inventory/assets?status=RETIRED').set(authHeader('admin'));
    expect(mockPrisma.asset.findMany.mock.calls[0][0].where.status).toBe('RETIRED');

    await request(app).get('/api/inventory/assets?status=BOGUS').set(authHeader('admin'));
    expect(mockPrisma.asset.findMany.mock.calls[1][0].where.status).toBeUndefined();
  });

  it('?assigned_user_id passes through into the where', async () => {
    const uid = '00000000-0000-0000-0000-000000000004';
    await request(app).get(`/api/inventory/assets?assigned_user_id=${uid}`).set(authHeader('admin'));
    expect(mockPrisma.asset.findMany.mock.calls[0][0].where.assigned_user_id).toBe(uid);
  });

  it('?search matches name OR serial, case-insensitive', async () => {
    await request(app).get('/api/inventory/assets?search=drill').set(authHeader('admin'));
    const where = mockPrisma.asset.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { name: { contains: 'drill', mode: 'insensitive' } },
      { serial: { contains: 'drill', mode: 'insensitive' } },
    ]);
  });

  it('a stored photo path is replaced by a signed URL in the response; null stays null', async () => {
    mockPrisma.asset.findMany.mockResolvedValue([
      { ...ASSET_FIXTURE, photo_url: `${ALPHA_ORG_ID}/asset/${ASSET_FIXTURE.id}/1-drill.png` },
      { ...ASSET_ASSIGNED_FIXTURE, photo_url: null },
    ]);
    mockPrisma.asset.count.mockResolvedValue(2);

    const res = await request(app).get('/api/inventory/assets').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].photo_url).toBe('https://test.supabase.co/storage/v1/object/sign/test/file.jpg?token=mock');
    expect(res.body.data[1].photo_url).toBeNull();
    expect(supabaseAdmin.storage.from).toHaveBeenCalledWith('attachments');
  });
});

describe('GET /api/inventory/assets/:id', () => {
  it('returns the asset; cross-org id → 404', async () => {
    mockPrisma.asset.findFirst.mockResolvedValueOnce(ASSET_FIXTURE);
    const ok = await request(app).get(`/api/inventory/assets/${ASSET_FIXTURE.id}`).set(authHeader('admin'));
    expect(ok.status).toBe(200);
    expect(ok.body.asset.id).toBe(ASSET_FIXTURE.id);
    expect(mockPrisma.asset.findFirst.mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);

    mockPrisma.asset.findFirst.mockResolvedValueOnce(null);
    const miss = await request(app).get(`/api/inventory/assets/${ASSET_FIXTURE.id}`).set(authHeader('admin'));
    expect(miss.status).toBe(404);
  });
});

describe('POST /api/inventory/assets', () => {
  it('creates with organization_id + audits inventory.asset_created', async () => {
    mockPrisma.asset.create.mockResolvedValue(ASSET_FIXTURE);

    const res = await request(app).post('/api/inventory/assets').set(authHeader('admin'))
      .send({ name: 'DeWalt Hammer Drill', serial: 'DW-4451' });

    expect(res.status).toBe(201);
    expect(res.body.asset.id).toBe(ASSET_FIXTURE.id);
    const data = mockPrisma.asset.create.mock.calls[0][0].data;
    expect(data.organization_id).toBe(ALPHA_ORG_ID);
    expect(data.name).toBe('DeWalt Hammer Drill');
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.auditLog.create.mock.calls[0][0].data.action).toBe('inventory.asset_created');
  });

  it('org-scopes a price_book_item_id link — cross-org item → 404, no create', async () => {
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/inventory/assets').set(authHeader('admin'))
      .send({ name: 'Drill', price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id });

    expect(res.status).toBe(404);
    expect(mockPrisma.priceBookItem.findFirst.mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
    expect(mockPrisma.asset.create).not.toHaveBeenCalled();
  });

  it('in-org price_book_item_id link → 201', async () => {
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(PRICE_BOOK_ITEM_FIXTURE);
    mockPrisma.asset.create.mockResolvedValue({ ...ASSET_FIXTURE, price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id });

    const res = await request(app).post('/api/inventory/assets').set(authHeader('admin'))
      .send({ name: 'Drill', price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id });

    expect(res.status).toBe(201);
  });

  it('validation 400s: empty name; non-uuid price_book_item_id', async () => {
    const noName = await request(app).post('/api/inventory/assets').set(authHeader('admin')).send({ name: '' });
    expect(noName.status).toBe(400);

    const badLink = await request(app).post('/api/inventory/assets').set(authHeader('admin'))
      .send({ name: 'Drill', price_book_item_id: 'not-a-uuid' });
    expect(badLink.status).toBe(400);
    expect(mockPrisma.asset.create).not.toHaveBeenCalled();
  });

  it('NO duplicate-serial rejection: two creates with the same serial both 201 (QA-38)', async () => {
    mockPrisma.asset.create.mockResolvedValue(ASSET_FIXTURE);

    const first = await request(app).post('/api/inventory/assets').set(authHeader('admin'))
      .send({ name: 'Drill A', serial: 'DUP-1' });
    const second = await request(app).post('/api/inventory/assets').set(authHeader('admin'))
      .send({ name: 'Drill B', serial: 'DUP-1' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(mockPrisma.asset.create).toHaveBeenCalledTimes(2);
  });
});

describe('PATCH /api/inventory/assets/:id', () => {
  beforeEach(() => {
    mockPrisma.asset.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.asset.findFirst.mockResolvedValue(ASSET_FIXTURE);
  });

  it('sparse update: only provided keys reach data; audits inventory.asset_updated', async () => {
    const res = await request(app).patch(`/api/inventory/assets/${ASSET_FIXTURE.id}`).set(authHeader('admin'))
      .send({ serial: 'NEW-1' });

    expect(res.status).toBe(200);
    const call = mockPrisma.asset.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: ASSET_FIXTURE.id, organization_id: ALPHA_ORG_ID });
    expect(call.data).toEqual({ serial: 'NEW-1' });
    expect(mockPrisma.auditLog.create.mock.calls[0][0].data.action).toBe('inventory.asset_updated');
  });

  it('body status/assigned_user_id are ignored — they move only through the action verbs', async () => {
    const res = await request(app).patch(`/api/inventory/assets/${ASSET_FIXTURE.id}`).set(authHeader('admin'))
      .send({ name: 'Renamed', status: 'RETIRED', assigned_user_id: '00000000-0000-0000-0000-000000000004' });

    expect(res.status).toBe(200);
    const data = mockPrisma.asset.updateMany.mock.calls[0][0].data;
    expect(data).toEqual({ name: 'Renamed' });
    expect(data.status).toBeUndefined();
    expect(data.assigned_user_id).toBeUndefined();
  });

  it('cross-org id → updateMany count 0 → 404 (QA-805)', async () => {
    mockPrisma.asset.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).patch(`/api/inventory/assets/${ASSET_FIXTURE.id}`).set(authHeader('admin'))
      .send({ name: 'Nope' });

    expect(res.status).toBe(404);
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/inventory/assets/:id', () => {
  it('deletes id+org atomically and best-effort removes the stored photo', async () => {
    const path = `${ALPHA_ORG_ID}/asset/${ASSET_FIXTURE.id}/1-drill.png`;
    mockPrisma.asset.findFirst.mockResolvedValue({ ...ASSET_FIXTURE, photo_url: path });
    mockPrisma.asset.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app).delete(`/api/inventory/assets/${ASSET_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.asset.deleteMany.mock.calls[0][0].where).toMatchObject({ id: ASSET_FIXTURE.id, organization_id: ALPHA_ORG_ID });
    expect(storageApi.remove).toHaveBeenCalledWith([path]);
    expect(mockPrisma.auditLog.create.mock.calls[0][0].data.action).toBe('inventory.asset_deleted');
  });

  it('storage remove failure is warn-only — still 200', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue({ ...ASSET_FIXTURE, photo_url: 'p/x.png' });
    mockPrisma.asset.deleteMany.mockResolvedValue({ count: 1 });
    storageApi.remove.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

    const res = await request(app).delete(`/api/inventory/assets/${ASSET_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('cross-org id → 404, no delete, no storage call', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(null);

    const res = await request(app).delete(`/api/inventory/assets/${ASSET_RETIRED_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.asset.deleteMany).not.toHaveBeenCalled();
    expect(storageApi.remove).not.toHaveBeenCalled();
  });
});

describe('role gates (subject matrix: Admin+Dispatcher full, Sales read-only, Technician none)', () => {
  it('sales → GET 200; POST/PATCH/DELETE 403', async () => {
    mockAuthAs('sales');

    const list = await request(app).get('/api/inventory/assets').set(authHeader('sales'));
    expect(list.status).toBe(200);

    const create = await request(app).post('/api/inventory/assets').set(authHeader('sales')).send({ name: 'X' });
    expect(create.status).toBe(403);

    const patch = await request(app).patch(`/api/inventory/assets/${ASSET_FIXTURE.id}`).set(authHeader('sales')).send({ name: 'X' });
    expect(patch.status).toBe(403);

    const del = await request(app).delete(`/api/inventory/assets/${ASSET_FIXTURE.id}`).set(authHeader('sales'));
    expect(del.status).toBe(403);
    expect(mockPrisma.asset.create).not.toHaveBeenCalled();
    expect(mockPrisma.asset.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.asset.deleteMany).not.toHaveBeenCalled();
  });

  it('technician → GET 403 (no read Inventory)', async () => {
    mockAuthAs('technician');

    const res = await request(app).get('/api/inventory/assets').set(authHeader('technician'));
    expect(res.status).toBe(403);
  });

  it('dispatcher → full: GET 200 + POST 201', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.asset.create.mockResolvedValue(ASSET_FIXTURE);

    const list = await request(app).get('/api/inventory/assets').set(authHeader('dispatcher'));
    expect(list.status).toBe(200);

    const create = await request(app).post('/api/inventory/assets').set(authHeader('dispatcher')).send({ name: 'Drill' });
    expect(create.status).toBe(201);
  });
});
