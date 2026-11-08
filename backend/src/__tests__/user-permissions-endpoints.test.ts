import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// RBAC Phase 2 — per-user permission override endpoints + end-to-end gate.
// v1 curated capability = `create Invoice`.
const findFirst = prisma.user.findFirst as ReturnType<typeof vi.fn>;
const rolePermFind = prisma.rolePermission.findMany as ReturnType<typeof vi.fn>;
const ovFind = prisma.userPermissionOverride.findMany as ReturnType<typeof vi.fn>;
const ovCreate = prisma.userPermissionOverride.create as ReturnType<typeof vi.fn>;
const ovDeleteMany = prisma.userPermissionOverride.deleteMany as ReturnType<typeof vi.fn>;
const tx = prisma.$transaction as ReturnType<typeof vi.fn>;

const SALES_ID = TEST_USERS.sales.id;
const DISPATCHER_ID = TEST_USERS.dispatcher.id;
const ADMIN_ID = TEST_USERS.admin.id;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  // Default: the per-user override read returns none (overridden per test).
  ovFind.mockResolvedValue([]);
  // $transaction runs its callback against the mocked prisma as the tx client.
  tx.mockImplementation(async (cb: (client: typeof prisma) => unknown) => cb(prisma));
});

describe('GET /api/users/:id/permissions', () => {
  it('admin → dispatcher target: role grants invoice-create, no override → effective true / inherit', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: DISPATCHER_ID, role: 'DISPATCHER', first_name: 'D', last_name: 'X' });
    rolePermFind.mockResolvedValue([{ action: 'create', subject: 'Invoice' }]);

    const res = await request(app).get(`/api/users/${DISPATCHER_ID}/permissions`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.editable).toBe(true);
    const cap = res.body.capabilities.find((c: any) => c.action === 'create' && c.subject === 'Invoice');
    expect(cap).toMatchObject({ roleDefault: 'allowed', override: 'inherit', effective: true });
  });

  it('admin → sales target: role lacks invoice-create, no override → effective false', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: SALES_ID, role: 'SALES', first_name: 'S', last_name: 'X' });
    rolePermFind.mockResolvedValue([]); // SALES has no create Invoice

    const res = await request(app).get(`/api/users/${SALES_ID}/permissions`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    const cap = res.body.capabilities.find((c: any) => c.action === 'create' && c.subject === 'Invoice');
    expect(cap).toMatchObject({ roleDefault: 'not-in-role', override: 'inherit', effective: false });
  });

  it('admin → sales target WITH allow override → effective true', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: SALES_ID, role: 'SALES', first_name: 'S', last_name: 'X' });
    rolePermFind.mockResolvedValue([]);
    ovFind.mockResolvedValue([{ action: 'create', subject: 'Invoice', effect: 'allow' }]);

    const res = await request(app).get(`/api/users/${SALES_ID}/permissions`).set(authHeader('admin'));
    const cap = res.body.capabilities.find((c: any) => c.action === 'create' && c.subject === 'Invoice');
    expect(cap).toMatchObject({ override: 'allow', effective: true });
  });

  it('cross-org / unknown user → 404 (tenant-scoped findFirst returns null)', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue(null);
    const res = await request(app).get(`/api/users/${SALES_ID}/permissions`).set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('non-admin (dispatcher) is forbidden — needs update User', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).get(`/api/users/${SALES_ID}/permissions`).set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/users/:id/permissions', () => {
  it('admin sets allow for a sales user → 200, persists an allow row', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: SALES_ID, role: 'SALES' });

    const res = await request(app)
      .put(`/api/users/${SALES_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ action: 'create', subject: 'Invoice', effect: 'allow' }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(ovDeleteMany).toHaveBeenCalled();
    expect(ovCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ user_id: SALES_ID, action: 'create', subject: 'Invoice', effect: 'allow' }),
      }),
    );
  });

  it('admin clears overrides (empty list) → 200, deletes managed rows, creates none', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: SALES_ID, role: 'SALES' });

    const res = await request(app)
      .put(`/api/users/${SALES_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [] });

    expect(res.status).toBe(200);
    expect(ovDeleteMany).toHaveBeenCalled();
    expect(ovCreate).not.toHaveBeenCalled();
  });

  it('targeting an ADMIN user → 400 (admins are not overridable)', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: ADMIN_ID, role: 'ADMIN' });

    const res = await request(app)
      .put(`/api/users/${ADMIN_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ action: 'create', subject: 'Invoice', effect: 'deny' }] });

    expect(res.status).toBe(400);
    expect(ovCreate).not.toHaveBeenCalled();
  });

  it('unsupported capability → 400 (only curated capabilities allowed)', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: SALES_ID, role: 'SALES' });

    // `delete Invoice` is a real catalog action but deliberately NOT a per-user managed toggle.
    // (Phase B expanded the curated set to create/update Job etc., so those are now accepted —
    // this asserts a capability OUTSIDE the curated set is still rejected.)
    const res = await request(app)
      .put(`/api/users/${SALES_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ action: 'delete', subject: 'Invoice', effect: 'allow' }] });

    expect(res.status).toBe(400);
    expect(ovCreate).not.toHaveBeenCalled();
  });

  it('non-admin (dispatcher) is forbidden', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .put(`/api/users/${SALES_ID}/permissions`)
      .set(authHeader('dispatcher'))
      .send({ overrides: [] });
    expect(res.status).toBe(403);
  });
});

describe('end-to-end gate: POST /api/invoices reflects the override', () => {
  it('SALES with an allow override passes the create-Invoice gate (not 403)', async () => {
    mockAuthAs('sales');
    ovFind.mockResolvedValue([{ action: 'create', subject: 'Invoice', effect: 'allow' }]);
    const res = await request(app).post('/api/invoices').set(authHeader('sales')).send({});
    expect(res.status).not.toBe(403); // gate passed (then 400 on the empty body)
  });

  it('SALES with no override is blocked by the gate (403)', async () => {
    mockAuthAs('sales');
    ovFind.mockResolvedValue([]);
    const res = await request(app).post('/api/invoices').set(authHeader('sales')).send({});
    expect(res.status).toBe(403);
  });

  it('DISPATCHER with a deny override is blocked by the gate (403)', async () => {
    mockAuthAs('dispatcher');
    ovFind.mockResolvedValue([{ action: 'create', subject: 'Invoice', effect: 'deny' }]);
    const res = await request(app).post('/api/invoices').set(authHeader('dispatcher')).send({});
    expect(res.status).toBe(403);
  });
});
