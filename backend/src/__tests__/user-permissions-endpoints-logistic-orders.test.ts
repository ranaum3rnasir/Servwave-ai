import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// LO-1 — the per-user capability endpoints must respect userCapabilities' `roles` allow-list.
//
// `approve LogisticOrder` is an ORG-WIDE capability (no ownCondition) with impliesRead, so its
// synthesized read is condition-less and makes scopeWhereFor return {} = every LO in the org.
// That is the intended surface for SALES/DISPATCHER and a scope blow-out for TECHNICIAN, which
// by signed decision (spec §12 rec 5) has no LogisticOrder surface in v1. Before the allow-list,
// getPermissions rendered USER_CAPABILITIES wholesale and putPermissions validated only
// isManagedCapability — so an admin could toggle it onto a technician.

const findFirst = prisma.user.findFirst as ReturnType<typeof vi.fn>;
const rolePermFind = prisma.rolePermission.findMany as ReturnType<typeof vi.fn>;
const ovFind = prisma.userPermissionOverride.findMany as ReturnType<typeof vi.fn>;
const ovCreate = prisma.userPermissionOverride.create as ReturnType<typeof vi.fn>;
const tx = prisma.$transaction as ReturnType<typeof vi.fn>;

const SALES_ID = TEST_USERS.sales.id;
const DISPATCHER_ID = TEST_USERS.dispatcher.id;
const TECH_ID = TEST_USERS.technician.id;

const APPROVE = { action: 'approve', subject: 'LogisticOrder', effect: 'allow' as const };
const hasApprove = (caps: { action: string; subject: string }[]) =>
  caps.some((c) => c.action === 'approve' && c.subject === 'LogisticOrder');

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  ovFind.mockResolvedValue([]);
  rolePermFind.mockResolvedValue([]);
  tx.mockImplementation(async (cb: (client: typeof prisma) => unknown) => cb(prisma));
});

describe('GET /api/users/:id/permissions — approve LogisticOrder visibility by role', () => {
  it('does NOT offer approve LogisticOrder for a TECHNICIAN target', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN', first_name: 'T', last_name: 'X' });

    const res = await request(app).get(`/api/users/${TECH_ID}/permissions`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(hasApprove(res.body.capabilities)).toBe(false);
    // The technician-targeted capabilities are still served (the filter is not a blanket cut).
    expect(res.body.capabilities.length).toBeGreaterThan(10);
    expect(
      res.body.capabilities.some(
        (c: { action: string; subject: string }) =>
          c.action === 'location_restricted' && c.subject === 'Inventory',
      ),
    ).toBe(true);
  });

  for (const [role, id] of [
    ['SALES', SALES_ID],
    ['DISPATCHER', DISPATCHER_ID],
  ] as const) {
    it(`DOES offer approve LogisticOrder for a ${role} target`, async () => {
      mockAuthAs('admin');
      findFirst.mockResolvedValue({ id, role, first_name: role, last_name: 'X' });

      const res = await request(app).get(`/api/users/${id}/permissions`).set(authHeader('admin'));
      expect(res.status).toBe(200);
      expect(hasApprove(res.body.capabilities)).toBe(true);
    });
  }
});

describe('PUT /api/users/:id/permissions — approve LogisticOrder rejection by role', () => {
  it('rejects granting approve LogisticOrder to a TECHNICIAN (400, nothing persisted)', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN' });

    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [APPROVE] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/TECHNICIAN/);
    expect(res.body.error).toMatch(/approve LogisticOrder/);
    expect(ovCreate).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });

  it('rejects the whole payload when a technician-illegal capability rides along with legal ones', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN' });

    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('admin'))
      .send({
        overrides: [{ action: 'create', subject: 'Lead', effect: 'allow' }, APPROVE],
      });

    expect(res.status).toBe(400);
    expect(ovCreate).not.toHaveBeenCalled();
  });

  it('a deny override for the same capability is rejected for a TECHNICIAN too', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN' });

    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ ...APPROVE, effect: 'deny' }] });

    expect(res.status).toBe(400);
    expect(ovCreate).not.toHaveBeenCalled();
  });

  it('ACCEPTS granting approve LogisticOrder to a SALES user (the gate is role-specific)', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: SALES_ID, role: 'SALES' });

    const res = await request(app)
      .put(`/api/users/${SALES_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [APPROVE] });

    expect(res.status).toBe(200);
    expect(ovCreate).toHaveBeenCalledTimes(1);
    expect(ovCreate.mock.calls[0][0].data).toMatchObject({
      user_id: SALES_ID,
      action: 'approve',
      subject: 'LogisticOrder',
      effect: 'allow',
    });
  });

  it('still allows an unrestricted capability on a TECHNICIAN (no regression)', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: TECH_ID, role: 'TECHNICIAN' });

    const res = await request(app)
      .put(`/api/users/${TECH_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ action: 'create', subject: 'Lead', effect: 'allow' }] });

    expect(res.status).toBe(200);
    expect(ovCreate).toHaveBeenCalledTimes(1);
  });

  it('the removed process LogisticOrder capability is rejected as unsupported for every role', async () => {
    mockAuthAs('admin');
    findFirst.mockResolvedValue({ id: DISPATCHER_ID, role: 'DISPATCHER' });

    const res = await request(app)
      .put(`/api/users/${DISPATCHER_ID}/permissions`)
      .set(authHeader('admin'))
      .send({ overrides: [{ action: 'process', subject: 'LogisticOrder', effect: 'allow' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported capability/);
    expect(ovCreate).not.toHaveBeenCalled();
  });
});
