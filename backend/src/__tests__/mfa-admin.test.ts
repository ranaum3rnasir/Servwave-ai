import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, ALPHA_ORG_ID, mockAuthAs, authHeader } from './helpers';

// Admin "Reset 2FA" endpoint: POST /api/users/:id/mfa/reset
// Clears mfa_email_enrolled and purges any pending email-OTP challenges for the
// target user. Admin-only + tenant-scoped, mirroring the permanent-delete sibling
// (authorize via canDo('delete','User'); resolve the row with findFirst + tenantWhere).

const mockPrisma = prisma as unknown as {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  mfaEmailChallenge: {
    deleteMany: ReturnType<typeof vi.fn>;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/users/:id/mfa/reset', () => {
  // A different user in the SAME org (not the caller) — the normal reset target.
  const TARGET_ID = '00000000-0000-0000-0000-0000000000e1';
  const target = {
    id: TARGET_ID,
    email: 'enrolled@test.com',
    mfa_email_enrolled: true,
    organization_id: ALPHA_ORG_ID,
  };

  it('requires ADMIN role (dispatcher → 403)', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post(`/api/users/${TARGET_ID}/mfa/reset`)
      .set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.mfaEmailChallenge.deleteMany).not.toHaveBeenCalled();
  });

  it('admin reset clears mfa_email_enrolled and deletes pending challenges', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(target);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.mfaEmailChallenge.deleteMany.mockResolvedValue({ count: 2 });

    const res = await request(app)
      .post(`/api/users/${TARGET_ID}/mfa/reset`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Tenant-scoped lookup via findFirst (NOT findUnique — dodges the auth-middleware mock collision).
    const findArgs = mockPrisma.user.findFirst.mock.calls[0][0];
    expect(findArgs.where).toMatchObject({ id: TARGET_ID, organization_id: ALPHA_ORG_ID });

    // Flag cleared with a TENANT-SCOPED write (not just the prior findFirst gate).
    const updArgs = mockPrisma.user.updateMany.mock.calls[0][0];
    expect(updArgs.where).toMatchObject({ id: TARGET_ID, organization_id: ALPHA_ORG_ID });
    expect(updArgs.data).toEqual({ mfa_email_enrolled: false });

    // Pending challenges purged for that user.
    expect(mockPrisma.mfaEmailChallenge.deleteMany).toHaveBeenCalledWith({ where: { user_id: TARGET_ID } });
  });

  it('404s when the target is outside the caller org (cross-tenant)', async () => {
    mockAuthAs('admin');
    // findFirst + tenantWhere makes an out-of-org row invisible.
    mockPrisma.user.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/users/${TARGET_ID}/mfa/reset`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.mfaEmailChallenge.deleteMany).not.toHaveBeenCalled();
  });
});

// Keep the import marked as used by ESLint.
void TEST_USERS;
