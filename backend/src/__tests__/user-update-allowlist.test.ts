import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { update } from '../controllers/user.controller';
import { prisma } from '../lib/prisma';
import { ALPHA_ORG_ID } from './helpers';

// authz-4: user.update must self-defend with an EXPLICIT field allowlist, not
// `data: req.body`. validate(updateUserSchema) strips unknown keys upstream today,
// so this defense only matters under schema drift (a future .passthrough(), a new
// privileged column, or a removed validate) — which a full-stack supertest cannot
// simulate. So we drive the controller directly with an un-stripped body.
const mockPrisma = prisma as unknown as {
  user: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  department: { findFirst: ReturnType<typeof vi.fn> };
};

function mockRes() {
  const res = {} as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => vi.clearAllMocks());

describe('user.controller update() — explicit field allowlist (authz-4)', () => {
  it('writes ONLY the allowlisted fields, dropping injected keys that bypass validate', async () => {
    const targetId = 'target-user-id';
    mockPrisma.user.findFirst.mockResolvedValue({ id: targetId, organization_id: ALPHA_ORG_ID, role: 'TECHNICIAN' });
    mockPrisma.user.update.mockResolvedValue({ id: targetId });

    const req = {
      params: { id: targetId },
      // Simulate schema drift: malicious extra keys present alongside legit ones.
      body: {
        first_name: 'New',
        role: 'ADMIN',
        organization_id: 'other-org-id', // cross-tenant move attempt
        has_login: true,                 // login/privilege flag
        email: 'attacker@evil.com',      // identity change
        id: 'some-other-id',             // PK overwrite attempt
      },
      user: { id: 'admin-id', organization_id: ALPHA_ORG_ID, role: 'ADMIN' },
    } as unknown as Request;

    await update(req, mockRes());

    expect(mockPrisma.user.update).toHaveBeenCalledOnce();
    const data = mockPrisma.user.update.mock.calls[0][0].data;
    // allowlisted, provided values pass through
    expect(data.first_name).toBe('New');
    expect(data.role).toBe('ADMIN');
    // injected keys are NOT forwarded to Prisma
    expect(data).not.toHaveProperty('organization_id');
    expect(data).not.toHaveProperty('has_login');
    expect(data).not.toHaveProperty('email');
    expect(data).not.toHaveProperty('id');
  });

  it('omits allowlisted fields that were not provided (no undefined overwrites)', async () => {
    const targetId = 'target-2';
    mockPrisma.user.findFirst.mockResolvedValue({ id: targetId, organization_id: ALPHA_ORG_ID, role: 'TECHNICIAN' });
    mockPrisma.user.update.mockResolvedValue({ id: targetId });

    const req = {
      params: { id: targetId },
      body: { is_active: false }, // only one field supplied
      user: { id: 'admin-id', organization_id: ALPHA_ORG_ID, role: 'ADMIN' },
    } as unknown as Request;

    await update(req, mockRes());

    const data = mockPrisma.user.update.mock.calls[0][0].data;
    expect(data).toEqual({ is_active: false });
  });
});
