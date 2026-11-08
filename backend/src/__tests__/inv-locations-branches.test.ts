/**
 * SRVW-93 - characterization test for POST /api/inventory/branches. This card gives the
 * endpoint its first production caller (the Stock page's "Add new branch" dialog now
 * persists for real instead of only mutating local state) and it had no test file at
 * all. No backend source changes here - both cases are green before and after.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  branch: { create: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('POST /api/inventory/branches (SRVW-93)', () => {
  it('an admin create stamps organization_id from req.user', async () => {
    mockAuthAs('admin');
    mockPrisma.branch.create.mockResolvedValue({
      id: 'b0000000-0000-0000-0000-000000000001',
      name: 'Long Island Branch',
      code: 'LI',
      address: null,
      phone: null,
      manager_name: null,
      timezone: null,
      notes: null,
      organization_id: '00000000-0000-0000-0000-000000000001',
      created_at: new Date(),
      updated_at: new Date(),
    });

    const res = await request(app)
      .post('/api/inventory/branches')
      .set(authHeader('admin'))
      .send({ name: 'Long Island Branch', code: 'LI' });

    expect(res.status).toBe(201);
    expect(res.body.branch).toMatchObject({ id: 'b0000000-0000-0000-0000-000000000001', name: 'Long Island Branch' });
    expect(mockPrisma.branch.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.branch.create.mock.calls[0][0].data).toMatchObject({
      name: 'Long Island Branch',
      organization_id: '00000000-0000-0000-0000-000000000001',
    });
  });

  it('a role without create Inventory gets 403 and no create call', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post('/api/inventory/branches')
      .set(authHeader('technician'))
      .send({ name: 'Shadow Branch' });

    expect(res.status).toBe(403);
    expect(mockPrisma.branch.create).not.toHaveBeenCalled();
  });
});
