/**
 * Inventory P4 — asset lifecycle verbs (assign / return / transfer / retire / note)
 * + the append-only AssetEvent ledger.
 *
 * Every state-changing verb writes its AssetEvent inside the SAME $transaction as
 * the asset mutation, with the state guard re-asserted in the updateMany where so
 * a concurrent verb can't double-fire (raced count 0 → 409, no event committed).
 * Audits fire only after a 2xx; 4xx paths write zero events and zero audits.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  mockAuthAs,
  authHeader,
  TEST_USERS,
  ALPHA_ORG_ID,
  ASSET_FIXTURE,
  ASSET_ASSIGNED_FIXTURE,
  ASSET_RETIRED_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  asset: {
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  assetEvent: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  user: { findFirst: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const TECH = TEST_USERS.technician;
const DISPATCHER = TEST_USERS.dispatcher;
const ADMIN = TEST_USERS.admin;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  mockPrisma.asset.findFirst.mockResolvedValue(ASSET_FIXTURE);
  mockPrisma.asset.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.assetEvent.create.mockResolvedValue({});
  mockPrisma.user.findFirst.mockResolvedValue({ ...TECH });
});

describe('POST /api/inventory/assets/:id/assign', () => {
  it('happy: guard re-asserted in tx where; ASSIGNED event with actor; audited', async () => {
    const res = await request(app).post(`/api/inventory/assets/${ASSET_FIXTURE.id}/assign`).set(authHeader('admin'))
      .send({ user_id: TECH.id });

    expect(res.status).toBe(200);
    const upd = mockPrisma.asset.updateMany.mock.calls[0][0];
    expect(upd.where).toMatchObject({
      id: ASSET_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      status: 'ACTIVE',
      assigned_user_id: null,
    });
    expect(upd.data).toEqual({ assigned_user_id: TECH.id });

    const event = mockPrisma.assetEvent.create.mock.calls[0][0].data;
    expect(event).toMatchObject({
      asset_id: ASSET_FIXTURE.id,
      type: 'ASSIGNED',
      user_id: TECH.id,
      by_user_id: ADMIN.id,
      organization_id: ALPHA_ORG_ID,
    });

    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('inventory.asset_assigned');
    expect(audit.metadata).toMatchObject({ user_id: TECH.id });
  });

  it('retired asset → 409 ASSET_RETIRED, no event, no audit', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(ASSET_RETIRED_FIXTURE);

    const res = await request(app).post(`/api/inventory/assets/${ASSET_RETIRED_FIXTURE.id}/assign`).set(authHeader('admin'))
      .send({ user_id: TECH.id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSET_RETIRED');
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('already assigned → 409 ALREADY_ASSIGNED', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(ASSET_ASSIGNED_FIXTURE);

    const res = await request(app).post(`/api/inventory/assets/${ASSET_ASSIGNED_FIXTURE.id}/assign`).set(authHeader('admin'))
      .send({ user_id: DISPATCHER.id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ASSIGNED');
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
  });

  it('cross-org target user → 404, no event', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);

    const res = await request(app).post(`/api/inventory/assets/${ASSET_FIXTURE.id}/assign`).set(authHeader('admin'))
      .send({ user_id: '99999999-9999-9999-9999-999999999999' });

    expect(res.status).toBe(404);
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('inactive target user → 400', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ ...TECH, is_active: false });

    const res = await request(app).post(`/api/inventory/assets/${ASSET_FIXTURE.id}/assign`).set(authHeader('admin'))
      .send({ user_id: TECH.id });

    expect(res.status).toBe(400);
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
  });

  it('tx-raced state change (updateMany count 0) → 409, no event committed', async () => {
    mockPrisma.asset.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).post(`/api/inventory/assets/${ASSET_FIXTURE.id}/assign`).set(authHeader('admin'))
      .send({ user_id: TECH.id });

    expect(res.status).toBe(409);
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/inventory/assets/:id/return', () => {
  it('happy: clears the holder + RETURNED event records who gave it back', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(ASSET_ASSIGNED_FIXTURE);

    const res = await request(app).post(`/api/inventory/assets/${ASSET_ASSIGNED_FIXTURE.id}/return`).set(authHeader('admin'))
      .send({ note: 'back on the shelf' });

    expect(res.status).toBe(200);
    const upd = mockPrisma.asset.updateMany.mock.calls[0][0];
    expect(upd.where).toMatchObject({ assigned_user_id: TECH.id });
    expect(upd.data).toEqual({ assigned_user_id: null });

    const event = mockPrisma.assetEvent.create.mock.calls[0][0].data;
    expect(event).toMatchObject({ type: 'RETURNED', user_id: TECH.id, note: 'back on the shelf' });
    expect(mockPrisma.auditLog.create.mock.calls[0][0].data.action).toBe('inventory.asset_returned');
  });

  it('unassigned asset → 409 NOT_ASSIGNED, no event', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(ASSET_FIXTURE);

    const res = await request(app).post(`/api/inventory/assets/${ASSET_FIXTURE.id}/return`).set(authHeader('admin')).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_ASSIGNED');
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/inventory/assets/:id/transfer', () => {
  beforeEach(() => {
    mockPrisma.asset.findFirst.mockResolvedValue(ASSET_ASSIGNED_FIXTURE);
    mockPrisma.user.findFirst.mockResolvedValue({ ...DISPATCHER });
  });

  it('happy: TRANSFERRED event carries the new holder; audit has from/to', async () => {
    const res = await request(app).post(`/api/inventory/assets/${ASSET_ASSIGNED_FIXTURE.id}/transfer`).set(authHeader('admin'))
      .send({ user_id: DISPATCHER.id });

    expect(res.status).toBe(200);
    const upd = mockPrisma.asset.updateMany.mock.calls[0][0];
    expect(upd.where).toMatchObject({ assigned_user_id: TECH.id });
    expect(upd.data).toEqual({ assigned_user_id: DISPATCHER.id });

    const event = mockPrisma.assetEvent.create.mock.calls[0][0].data;
    expect(event).toMatchObject({ type: 'TRANSFERRED', user_id: DISPATCHER.id, by_user_id: ADMIN.id });

    const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('inventory.asset_transferred');
    expect(audit.metadata).toMatchObject({ from_user_id: TECH.id, to_user_id: DISPATCHER.id });
  });

  it('unassigned asset → 409 NOT_ASSIGNED (use assign)', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(ASSET_FIXTURE);

    const res = await request(app).post(`/api/inventory/assets/${ASSET_FIXTURE.id}/transfer`).set(authHeader('admin'))
      .send({ user_id: DISPATCHER.id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_ASSIGNED');
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
  });

  it('retired asset → 409, no event', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue({ ...ASSET_RETIRED_FIXTURE, assigned_user_id: TECH.id });

    const res = await request(app).post(`/api/inventory/assets/${ASSET_RETIRED_FIXTURE.id}/transfer`).set(authHeader('admin'))
      .send({ user_id: DISPATCHER.id });

    expect(res.status).toBe(409);
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
  });

  it('same-holder target → 400, no event, no audit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ ...TECH });

    const res = await request(app).post(`/api/inventory/assets/${ASSET_ASSIGNED_FIXTURE.id}/transfer`).set(authHeader('admin'))
      .send({ user_id: TECH.id });

    expect(res.status).toBe(400);
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/inventory/assets/:id/retire', () => {
  it('retire while assigned: one tx clears the holder; event user_id = holder-at-retire', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(ASSET_ASSIGNED_FIXTURE);

    const res = await request(app).post(`/api/inventory/assets/${ASSET_ASSIGNED_FIXTURE.id}/retire`).set(authHeader('admin'))
      .send({ note: 'motor burned out' });

    expect(res.status).toBe(200);
    const upd = mockPrisma.asset.updateMany.mock.calls[0][0];
    expect(upd.where).toMatchObject({ status: 'ACTIVE' });
    expect(upd.data).toEqual({ status: 'RETIRED', assigned_user_id: null });

    const event = mockPrisma.assetEvent.create.mock.calls[0][0].data;
    expect(event).toMatchObject({ type: 'RETIRED', user_id: TECH.id, note: 'motor burned out' });
    expect(mockPrisma.auditLog.create.mock.calls[0][0].data.action).toBe('inventory.asset_retired');
  });

  it('unassigned retire: event user_id is null', async () => {
    const res = await request(app).post(`/api/inventory/assets/${ASSET_FIXTURE.id}/retire`).set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.assetEvent.create.mock.calls[0][0].data.user_id).toBeNull();
  });

  it('already retired → 409 ALREADY_RETIRED, no event, no audit', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(ASSET_RETIRED_FIXTURE);

    const res = await request(app).post(`/api/inventory/assets/${ASSET_RETIRED_FIXTURE.id}/retire`).set(authHeader('admin')).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_RETIRED');
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/inventory/assets/:id/note', () => {
  it('appends a NOTE event only — no asset mutation; works on a RETIRED asset', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(ASSET_RETIRED_FIXTURE);

    const res = await request(app).post(`/api/inventory/assets/${ASSET_RETIRED_FIXTURE.id}/note`).set(authHeader('admin'))
      .send({ note: 'stored in the back room' });

    expect(res.status).toBe(200);
    expect(mockPrisma.asset.updateMany).not.toHaveBeenCalled();
    const event = mockPrisma.assetEvent.create.mock.calls[0][0].data;
    expect(event).toMatchObject({ type: 'NOTE', user_id: null, note: 'stored in the back room', by_user_id: ADMIN.id });
    expect(mockPrisma.auditLog.create.mock.calls[0][0].data.action).toBe('inventory.asset_note_added');
  });

  it('empty note → 400, no event', async () => {
    const res = await request(app).post(`/api/inventory/assets/${ASSET_FIXTURE.id}/note`).set(authHeader('admin'))
      .send({ note: '' });

    expect(res.status).toBe(400);
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/inventory/assets/:id/events', () => {
  it('ordered at desc with user/by_user includes', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(ASSET_FIXTURE);
    mockPrisma.assetEvent.findMany.mockResolvedValue([
      {
        id: 'e1', type: 'ASSIGNED', note: null, at: new Date('2026-03-02'),
        user: { id: TECH.id, first_name: TECH.first_name, last_name: TECH.last_name },
        by_user: { id: ADMIN.id, first_name: ADMIN.first_name, last_name: ADMIN.last_name },
      },
      { id: 'e0', type: 'NOTE', note: 'bought used', at: new Date('2026-03-01'), user: null, by_user: null },
    ]);

    const res = await request(app).get(`/api/inventory/assets/${ASSET_FIXTURE.id}/events`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0]).toMatchObject({ id: 'e1', type: 'ASSIGNED' });
    expect(res.body.events[1].by_user).toBeNull();

    const args = mockPrisma.assetEvent.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ asset_id: ASSET_FIXTURE.id, organization_id: ALPHA_ORG_ID });
    expect(args.orderBy).toEqual({ at: 'desc' });
    expect(args.include.user).toBeDefined();
    expect(args.include.by_user).toBeDefined();
  });

  it('cross-org asset → 404', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/inventory/assets/${ASSET_FIXTURE.id}/events`).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.assetEvent.findMany).not.toHaveBeenCalled();
  });
});

describe('verb role gates', () => {
  it.each(['sales', 'technician'] as const)('%s (no update Inventory) → 403 on assign', async (role) => {
    mockAuthAs(role);

    const res = await request(app).post(`/api/inventory/assets/${ASSET_FIXTURE.id}/assign`).set(authHeader(role))
      .send({ user_id: TECH.id });

    expect(res.status).toBe(403);
    expect(mockPrisma.assetEvent.create).not.toHaveBeenCalled();
  });

  it('dispatcher (update Inventory) → assign 200', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app).post(`/api/inventory/assets/${ASSET_FIXTURE.id}/assign`).set(authHeader('dispatcher'))
      .send({ user_id: TECH.id });

    expect(res.status).toBe(200);
  });
});
