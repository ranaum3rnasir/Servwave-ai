import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { update } from '../controllers/user.controller';

vi.mock('../lib/email', () => ({ sendUserInviteEmail: vi.fn().mockResolvedValue(true) }));

const mockPrisma = prisma as unknown as {
  user: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  customRole: { findFirst: ReturnType<typeof vi.fn> };
};
const mockSupabaseAdmin = supabaseAdmin as unknown as {
  auth: { admin: { createUser: ReturnType<typeof vi.fn> } };
};

function mockRes() {
  const res = {} as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => vi.clearAllMocks());

const OFFICE_MANAGER = { id: '00000000-0000-0000-0000-0000000000c1', organization_id: ALPHA_ORG_ID, key: 'office-manager', base_role: 'ADMIN', archived_at: null };

describe('POST /api/users (create) - custom_role_id', () => {
  it('accepts a custom_role_id whose base_role matches the given role', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.customRole.findFirst.mockResolvedValue(OFFICE_MANAGER);
    mockSupabaseAdmin.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'supa-1' } }, error: null });
    mockPrisma.user.create.mockResolvedValue({
      id: 'supa-1', email: 'om@test.com', first_name: 'O', last_name: 'M', role: 'ADMIN',
      is_active: true, has_login: true, department_id: null, department: null,
      created_at: new Date(), updated_at: new Date(),
    });

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'om@test.com', password: 'StrongPass!1', first_name: 'O', last_name: 'M', role: 'ADMIN', custom_role_id: '00000000-0000-0000-0000-0000000000c1' });

    expect(res.status).toBe(201);
    expect(mockPrisma.user.create.mock.calls[0][0].data).toMatchObject({ role: 'ADMIN', custom_role_id: '00000000-0000-0000-0000-0000000000c1' });
  });

  it("400s when the custom role's base_role does not match the given role", async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.customRole.findFirst.mockResolvedValue(OFFICE_MANAGER);

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'mismatch@test.com', password: 'StrongPass!1', first_name: 'A', last_name: 'B', role: 'SALES', custom_role_id: '00000000-0000-0000-0000-0000000000c1' });

    expect(res.status).toBe(400);
    expect(mockSupabaseAdmin.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('400s when custom_role_id does not resolve (wrong org, unknown, or archived)', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.customRole.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'ghost@test.com', password: 'StrongPass!1', first_name: 'A', last_name: 'B', role: 'ADMIN', custom_role_id: '00000000-0000-0000-0000-0000000000ff' });

    expect(res.status).toBe(400);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});

describe('user.controller update() - custom_role_id consistency', () => {
  it('accepts role + custom_role_id together when they agree', async () => {
    const targetId = 'target-1';
    mockPrisma.user.findFirst.mockResolvedValue({ id: targetId, organization_id: ALPHA_ORG_ID, role: 'SALES', custom_role_id: null });
    mockPrisma.customRole.findFirst.mockResolvedValue(OFFICE_MANAGER);
    mockPrisma.user.update.mockResolvedValue({ id: targetId });

    const req = {
      params: { id: targetId },
      body: { role: 'ADMIN', custom_role_id: '00000000-0000-0000-0000-0000000000c1' },
      user: { id: 'admin-id', organization_id: ALPHA_ORG_ID, role: 'ADMIN' },
    } as unknown as Request;

    await update(req, mockRes());

    expect(mockPrisma.user.update).toHaveBeenCalledOnce();
    const data = mockPrisma.user.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ role: 'ADMIN', custom_role_id: '00000000-0000-0000-0000-0000000000c1' });
  });

  it("400s when custom_role_id is set but the row's base_role disagrees with the (unchanged) existing role", async () => {
    const targetId = 'target-2';
    // existing.role stays SALES; only custom_role_id is being set, to an ADMIN-derived role.
    mockPrisma.user.findFirst.mockResolvedValue({ id: targetId, organization_id: ALPHA_ORG_ID, role: 'SALES', custom_role_id: null });
    mockPrisma.customRole.findFirst.mockResolvedValue(OFFICE_MANAGER);

    const req = {
      params: { id: targetId },
      body: { custom_role_id: '00000000-0000-0000-0000-0000000000c1' },
      user: { id: 'admin-id', organization_id: ALPHA_ORG_ID, role: 'ADMIN' },
    } as unknown as Request;

    const res = mockRes();
    await update(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('400s when role is changed but the EXISTING custom_role_id would become inconsistent', async () => {
    const targetId = 'target-3';
    // user already holds the office-manager (ADMIN-derived) custom role; body tries to move base role to SALES
    // without touching custom_role_id - would silently strand an ADMIN-derived role under a SALES base.
    mockPrisma.user.findFirst.mockResolvedValue({ id: targetId, organization_id: ALPHA_ORG_ID, role: 'ADMIN', custom_role_id: '00000000-0000-0000-0000-0000000000c1' });
    mockPrisma.customRole.findFirst.mockResolvedValue(OFFICE_MANAGER);

    const req = {
      params: { id: targetId },
      body: { role: 'SALES' },
      user: { id: 'admin-id', organization_id: ALPHA_ORG_ID, role: 'ADMIN' },
    } as unknown as Request;

    const res = mockRes();
    await update(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('clearing custom_role_id to null needs no base_role match and skips the lookup', async () => {
    const targetId = 'target-4';
    mockPrisma.user.findFirst.mockResolvedValue({ id: targetId, organization_id: ALPHA_ORG_ID, role: 'ADMIN', custom_role_id: '00000000-0000-0000-0000-0000000000c1' });
    mockPrisma.user.update.mockResolvedValue({ id: targetId });

    const req = {
      params: { id: targetId },
      body: { custom_role_id: null },
      user: { id: 'admin-id', organization_id: ALPHA_ORG_ID, role: 'ADMIN' },
    } as unknown as Request;

    await update(req, mockRes());

    expect(mockPrisma.customRole.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).toHaveBeenCalledOnce();
    expect(mockPrisma.user.update.mock.calls[0][0].data).toEqual({ custom_role_id: null });
  });

  it('a PATCH touching neither role nor custom_role_id does no consistency lookup at all', async () => {
    const targetId = 'target-5';
    mockPrisma.user.findFirst.mockResolvedValue({ id: targetId, organization_id: ALPHA_ORG_ID, role: 'ADMIN', custom_role_id: '00000000-0000-0000-0000-0000000000c1' });
    mockPrisma.user.update.mockResolvedValue({ id: targetId });

    const req = {
      params: { id: targetId },
      body: { is_active: false },
      user: { id: 'admin-id', organization_id: ALPHA_ORG_ID, role: 'ADMIN' },
    } as unknown as Request;

    await update(req, mockRes());

    expect(mockPrisma.customRole.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.user.update.mock.calls[0][0].data).toEqual({ is_active: false });
  });
});
