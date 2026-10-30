import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('GET /api/roles', () => {
  it('returns the 4 system roles with user counts; admin labelled Owner', async () => {
    mockAuthAs('admin');
    const person = (role: string) => ({ id: `u-${role}`, role, custom_role_id: null, based_on_role_key: null, custom_role: null });
    (prisma.user.findMany as any).mockResolvedValue([person('ADMIN'), person('SALES'), person('SALES'), person('SALES')]);
    const res = await request(app).get('/api/roles').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.role)).toEqual(['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']);
    const admin = res.body.find((r: any) => r.role === 'ADMIN');
    expect(admin).toMatchObject({ label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1 });
    expect(res.body.find((r: any) => r.role === 'SALES').userCount).toBe(3);
  });
});

describe('roles isolation', () => {
  it('non-admin (no Role grant) gets 403', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/roles').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });
});
