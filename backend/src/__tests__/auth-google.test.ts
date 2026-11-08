import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { clearTokenCache } from '../middleware/authenticate';

const mockPrisma = prisma as unknown as {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  termsAcceptance: {
    findFirst: ReturnType<typeof vi.fn>;
  };
};
const mockSupabase = supabaseAdmin as unknown as {
  auth: {
    getUser: ReturnType<typeof vi.fn>;
    admin: { deleteUser: ReturnType<typeof vi.fn> };
  };
};

const ADMIN_ROW = {
  id: 'supa-admin-id',
  email: 'admin@acme.com',
  first_name: 'Ada',
  last_name: 'Admin',
  role: 'ADMIN',
  is_active: true,
  organization_id: 'org-1',
  department_id: null,
  location_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
});

describe('POST /api/auth/google/finalize', () => {
  it('returns user + abilityRules for an authorized active user (no orphan delete)', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supa-admin-id', email: 'admin@acme.com', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    mockPrisma.user.findUnique.mockImplementation((args: { where: { id?: string; email?: string } }) =>
      Promise.resolve(args.where.id === 'supa-admin-id' ? ADMIN_ROW : null),
    );

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 'supa-admin-id', email: 'admin@acme.com', role: 'ADMIN' });
    expect(Array.isArray(res.body.abilityRules)).toBe(true);
    expect(mockSupabase.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('refuses an MFA-enrolled user (403 MFA_REQUIRED) instead of blessing the live Google session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supa-admin-id', email: 'admin@acme.com', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    // resolveAppUser lookup returns the row; the controller's new mfa_email_enrolled
    // select reports the user is enrolled.
    mockPrisma.user.findUnique.mockImplementation(
      (args: { where: { id?: string; email?: string }; select?: Record<string, unknown> }) => {
        if (args.select && 'mfa_email_enrolled' in args.select) {
          return Promise.resolve({ mfa_email_enrolled: true });
        }
        return Promise.resolve(args.where.id === 'supa-admin-id' ? ADMIN_ROW : null);
      },
    );

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MFA_REQUIRED');
    // CRITICAL: no session, no ability rules leak to an enrolled user here.
    expect(res.body.user).toBeUndefined();
    expect(res.body.abilityRules).toBeUndefined();
    expect(mockSupabase.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('still finalizes a NON-enrolled user normally (200 user + abilityRules)', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supa-admin-id', email: 'admin@acme.com', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    mockPrisma.user.findUnique.mockImplementation(
      (args: { where: { id?: string; email?: string }; select?: Record<string, unknown> }) => {
        if (args.select && 'mfa_email_enrolled' in args.select) {
          return Promise.resolve({ mfa_email_enrolled: false });
        }
        return Promise.resolve(args.where.id === 'supa-admin-id' ? ADMIN_ROW : null);
      },
    );

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 'supa-admin-id', role: 'ADMIN' });
    expect(Array.isArray(res.body.abilityRules)).toBe(true);
  });

  it('rejects an unknown Google account with 403 and deletes the orphan Supabase user', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'orphan-id', email: 'stranger@gmail.com', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_AUTHORIZED');
    expect(mockSupabase.auth.admin.deleteUser).toHaveBeenCalledWith('orphan-id');
  });

  it('authorizes via confirmed-email fallback when the Supabase id does not match', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'new-supa-id', email: 'admin@acme.com', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockImplementation((args: { where: { email?: { equals?: string } } }) =>
      Promise.resolve(args.where.email?.equals === 'admin@acme.com' ? ADMIN_ROW : null),
    );

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('admin@acme.com');
    expect(mockSupabase.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('returns 403 ACCOUNT_DISABLED for a deactivated user (no orphan delete)', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supa-admin-id', email: 'admin@acme.com', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    mockPrisma.user.findUnique.mockResolvedValue({ ...ADMIN_ROW, is_active: false });

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_DISABLED');
    expect(mockSupabase.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer token is missing', async () => {
    const res = await request(app).post('/api/auth/google/finalize');
    expect(res.status).toBe(401);
  });

  it('returns 401 when Supabase rejects the token', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad' } });
    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/google/finalize — ToS acceptance gate', () => {
  it('grandfathers a user created before the enforcement cutover with no terms_acceptances row (200)', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supa-admin-id', email: 'admin@acme.com', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    mockPrisma.user.findUnique.mockImplementation(
      (args: { where: { id?: string; email?: string }; select?: Record<string, unknown> }) => {
        if (args.select && 'mfa_email_enrolled' in args.select) {
          return Promise.resolve({
            mfa_email_enrolled: false,
            created_at: new Date('2026-07-08T23:59:59.000Z'),
          });
        }
        return Promise.resolve(args.where.id === 'supa-admin-id' ? ADMIN_ROW : null);
      },
    );
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 'supa-admin-id', role: 'ADMIN' });
    expect(Array.isArray(res.body.abilityRules)).toBe(true);
    // Grandfathered users never even trigger the terms_acceptances lookup.
    expect(mockPrisma.termsAcceptance.findFirst).not.toHaveBeenCalled();
  });

  it('blocks a user created on/after the cutover who has not accepted terms (403 TERMS_ACCEPTANCE_REQUIRED)', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supa-admin-id', email: 'admin@acme.com', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    mockPrisma.user.findUnique.mockImplementation(
      (args: { where: { id?: string; email?: string }; select?: Record<string, unknown> }) => {
        if (args.select && 'mfa_email_enrolled' in args.select) {
          return Promise.resolve({
            mfa_email_enrolled: false,
            created_at: new Date('2026-07-09T00:00:00.000Z'),
          });
        }
        return Promise.resolve(args.where.id === 'supa-admin-id' ? ADMIN_ROW : null);
      },
    );
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TERMS_ACCEPTANCE_REQUIRED');
    // CRITICAL: no session, no ability rules leak to a not-yet-accepted user here.
    expect(res.body.user).toBeUndefined();
    expect(res.body.abilityRules).toBeUndefined();
    expect(mockPrisma.termsAcceptance.findFirst).toHaveBeenCalledWith({
      where: { user_id: 'supa-admin-id' },
      select: { id: true },
    });
  });

  it('allows a user created on/after the cutover who already has a terms_acceptances row (200)', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supa-admin-id', email: 'admin@acme.com', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    mockPrisma.user.findUnique.mockImplementation(
      (args: { where: { id?: string; email?: string }; select?: Record<string, unknown> }) => {
        if (args.select && 'mfa_email_enrolled' in args.select) {
          return Promise.resolve({
            mfa_email_enrolled: false,
            created_at: new Date('2026-07-10T00:00:00.000Z'),
          });
        }
        return Promise.resolve(args.where.id === 'supa-admin-id' ? ADMIN_ROW : null);
      },
    );
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 'terms-row-1' });

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 'supa-admin-id', role: 'ADMIN' });
    expect(Array.isArray(res.body.abilityRules)).toBe(true);
  });
});

// Middleware fallback (proves authenticate resolves a Google-linked user by confirmed email)
describe('authenticate middleware confirmed-email fallback', () => {
  it('authenticates GET /api/auth/me when the Supabase id has no row but the confirmed email matches', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'unlinked-supa-id', email: 'admin@acme.com', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockImplementation((args: { where: { email?: { equals?: string } } }) =>
      Promise.resolve(args.where.email?.equals === 'admin@acme.com' ? ADMIN_ROW : null),
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer unique-token-1');

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('ADMIN');
  });
});
