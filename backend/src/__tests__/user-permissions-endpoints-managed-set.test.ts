import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { USER_CAPABILITIES, capabilityAllowsRole } from '../lib/permissions/userCapabilities';

// Phase B (technician redesign) — assert GET/PUT /api/users/:id/permissions are driven
// ENTIRELY by USER_CAPABILITIES (the foundation expanded the curated set from 1 → 13).
// Companion to user-permissions-endpoints.test.ts (which covers the create-Invoice path +
// the e2e gate); this file proves the WHOLE managed set is served and that a non-Invoice
// capability persists allow/deny/clear, plus the non-managed reject path.

const findFirst = prisma.user.findFirst as ReturnType<typeof vi.fn>;
const rolePermFind = prisma.rolePermission.findMany as ReturnType<typeof vi.fn>;
const ovFind = prisma.userPermissionOverride.findMany as ReturnType<typeof vi.fn>;
const ovCreate = prisma.userPermissionOverride.create as ReturnType<typeof vi.fn>;
const ovDeleteMany = prisma.userPermissionOverride.deleteMany as ReturnType<typeof vi.fn>;
const tx = prisma.$transaction as ReturnType<typeof vi.fn>;

const SALES_ID = TEST_USERS.sales.id;
const TECH_ID = TEST_USERS.technician.id;
const ADMIN_ID = TEST_USERS.admin.id;

const key = (c: { action: string; subject: string }) => `${c.action}:${c.subject}`;
// The endpoint serves only the capabilities a target's ROLE may hold (userCapabilities' `roles`
// allow-list — e.g. `approve LogisticOrder` is SALES/DISPATCHER-only, never TECHNICIAN). Derive
// expectations from the same source of truth so these stay "no hardcoded subset" assertions.
const capsForRole = (role: string) => USER_CAPABILITIES.filter((c) => capabilityAllowsRole(c, role));

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  ovFind.mockResolvedValue([]);
  tx.mockImplementation(async (cb: (client: typeof prisma) => unknown) => cb(prisma));
});

describe('GET /api/users/:id/permissions — full managed catalog', () => {
  it('returns every managed capability the target role may hold, with action/subject/label/description', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN', first_name: 'T', last_name: 'X' });
    rolePermFind.mockResolvedValue([]);

    const res = await request(app).get(`/api/users/${TECH_ID}/permissions`).set(authHeader('admin'));
    expect(res.status).toBe(200);

    // Same cardinality as the source of truth, role-filtered (proves no hardcoded subset).
    const expected = capsForRole('TECHNICIAN');
    expect(res.body.capabilities).toHaveLength(expected.length);
    expect(expected.length).toBeGreaterThanOrEqual(13);

    const returnedKeys = new Set(res.body.capabilities.map(key));
    for (const c of expected) {
      expect(returnedKeys.has(key(c))).toBe(true);
    }
    // Each entry carries the descriptor fields the FE renders.
    for (const cap of res.body.capabilities) {
      expect(cap).toHaveProperty('action');
      expect(cap).toHaveProperty('subject');
      expect(typeof cap.label).toBe('string');
      expect(cap.label.length).toBeGreaterThan(0);
      expect(typeof cap.description).toBe('string');
      expect(['inherit', 'allow', 'deny']).toContain(cap.override);
    }
  });

  it('reflects per-capability current state: role-default vs allow-override vs deny-override', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN', first_name: 'T', last_name: 'X' });
    // Role grants `update Job` for this user's role; everything else not-in-role.
    rolePermFind.mockResolvedValue([{ action: 'update', subject: 'Job' }]);
    // Overrides: allow `create Estimate`, deny `update Job`.
    ovFind.mockResolvedValue([
      { action: 'create', subject: 'Estimate', effect: 'allow' },
      { action: 'update', subject: 'Job', effect: 'deny' },
    ]);

    const res = await request(app).get(`/api/users/${TECH_ID}/permissions`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    const byKey = new Map(res.body.capabilities.map((c: any) => [key(c), c]));

    // allow override on a not-in-role capability → effective true.
    expect(byKey.get('create:Estimate')).toMatchObject({
      roleDefault: 'not-in-role',
      override: 'allow',
      effective: true,
    });
    // deny override beats the role grant → effective false.
    expect(byKey.get('update:Job')).toMatchObject({
      roleDefault: 'allowed',
      override: 'deny',
      effective: false,
    });
    // untouched managed capability → inherit / not-in-role / false.
    expect(byKey.get('record_payment:Invoice')).toMatchObject({
      override: 'inherit',
      effective: false,
    });
  });

  it('ADMIN target → editable:false and every capability inherits (manage all, never overridable)', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: ADMIN_ID, role: 'ADMIN', first_name: 'A', last_name: 'X' });

    const res = await request(app).get(`/api/users/${ADMIN_ID}/permissions`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.editable).toBe(false);
    expect(res.body.capabilities).toHaveLength(capsForRole('ADMIN').length);
    for (const cap of res.body.capabilities) {
      expect(cap.override).toBe('inherit');
      expect(cap.effective).toBe(true); // admin = manage all
    }
    // No role/override lookups for an admin target.
    expect(rolePermFind).not.toHaveBeenCalled();
    expect(ovFind).not.toHaveBeenCalled();
  });

  it('non-admin caller (dispatcher) is forbidden (403)', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).get(`/api/users/${SALES_ID}/permissions`).set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/users/:id/permissions — newly-managed capability persists', () => {
  it('accepts `create Estimate` allow → 200, persists the allow row', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN' });

    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ action: 'create', subject: 'Estimate', effect: 'allow' }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(ovDeleteMany).toHaveBeenCalled();
    expect(ovCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user_id: TECH_ID,
          action: 'create',
          subject: 'Estimate',
          effect: 'allow',
        }),
      }),
    );
  });

  it('accepts `create Estimate` deny → 200, persists the deny row', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN' });

    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ action: 'create', subject: 'Estimate', effect: 'deny' }] });

    expect(res.status).toBe(200);
    expect(ovCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'create', subject: 'Estimate', effect: 'deny' }),
      }),
    );
  });

  it('clears `create Estimate` (empty list) → 200, deletes managed rows, creates none', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN' });

    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [] });

    expect(res.status).toBe(200);
    expect(ovDeleteMany).toHaveBeenCalled();
    expect(ovCreate).not.toHaveBeenCalled();
  });

  it('persists several distinct managed capabilities in one call', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN' });

    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('admin'))
      .send({
        overrides: [
          { action: 'start', subject: 'Job', effect: 'allow' },
          { action: 'record_payment', subject: 'Invoice', effect: 'allow' },
          { action: 'update', subject: 'Lead', effect: 'deny' },
        ],
      });

    expect(res.status).toBe(200);
    expect(ovCreate).toHaveBeenCalledTimes(3);
  });
});

describe('PUT /api/users/:id/permissions — guards', () => {
  it('rejects a non-managed (action,subject) with 400 and persists nothing', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN' });

    // `delete Estimate` is a real catalog action but deliberately NOT a per-user managed toggle.
    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ action: 'delete', subject: 'Estimate', effect: 'allow' }] });

    expect(res.status).toBe(400);
    expect(ovCreate).not.toHaveBeenCalled();
    expect(ovDeleteMany).not.toHaveBeenCalled();
  });

  it('rejects a managed capability mixed with a non-managed one (atomic 400)', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN' });

    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('admin'))
      .send({
        overrides: [
          { action: 'create', subject: 'Estimate', effect: 'allow' }, // managed
          { action: 'manage', subject: 'all', effect: 'allow' }, // NOT managed
        ],
      });

    expect(res.status).toBe(400);
    expect(ovCreate).not.toHaveBeenCalled();
  });

  it('targeting an ADMIN user → 400 (admins are immune) and persists nothing', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: ADMIN_ID, role: 'ADMIN' });

    const res = await request(app)
      .put(`/api/users/${ADMIN_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ action: 'create', subject: 'Estimate', effect: 'deny' }] });

    expect(res.status).toBe(400);
    expect(ovCreate).not.toHaveBeenCalled();
    expect(ovDeleteMany).not.toHaveBeenCalled();
  });

  it('non-admin caller (dispatcher) is forbidden (403)', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('dispatcher'))
      .send({ overrides: [{ action: 'create', subject: 'Estimate', effect: 'allow' }] });
    expect(res.status).toBe(403);
  });
});

describe('location_restricted Inventory — P3 restriction toggle round-trips (D10/D13)', () => {
  it('GET serves the capability with its descriptor (rendered under the Inventory group)', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN', first_name: 'T', last_name: 'X' });
    rolePermFind.mockResolvedValue([]);

    const res = await request(app).get(`/api/users/${TECH_ID}/permissions`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    const cap = res.body.capabilities.find(
      (c: any) => c.action === 'location_restricted' && c.subject === 'Inventory',
    );
    expect(cap).toBeDefined();
    expect(cap.label.length).toBeGreaterThan(0);
    // Never a role grant (excluded from PERMISSION_CATALOG) — always "not-in-role".
    expect(cap.roleDefault).toBe('not-in-role');
    expect(cap).toMatchObject({ override: 'inherit', effective: false });
  });

  it('PUT accepts the allow override → 200, persists the row', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN' });

    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ action: 'location_restricted', subject: 'Inventory', effect: 'allow' }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(ovCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user_id: TECH_ID,
          action: 'location_restricted',
          subject: 'Inventory',
          effect: 'allow',
        }),
      }),
    );
  });

  it('GET reflects the persisted allow (override: allow, effective: true)', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN', first_name: 'T', last_name: 'X' });
    rolePermFind.mockResolvedValue([]);
    ovFind.mockResolvedValue([{ action: 'location_restricted', subject: 'Inventory', effect: 'allow' }]);

    const res = await request(app).get(`/api/users/${TECH_ID}/permissions`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    const cap = res.body.capabilities.find(
      (c: any) => c.action === 'location_restricted' && c.subject === 'Inventory',
    );
    expect(cap).toMatchObject({ override: 'allow', effective: true });
  });
});

describe('PUT /api/users/:id/permissions — PriceBook org-wide capability (#590)', () => {
  it('accepts a `create PriceBook` allow override → 200 and persists the row', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: SALES_ID, role: 'SALES' });

    const res = await request(app)
      .put(`/api/users/${SALES_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ action: 'create', subject: 'PriceBook', effect: 'allow' }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(ovCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user_id: SALES_ID,
          action: 'create',
          subject: 'PriceBook',
          effect: 'allow',
        }),
      }),
    );
  });
});
