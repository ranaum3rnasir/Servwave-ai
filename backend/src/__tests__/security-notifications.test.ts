/**
 * security-notifications.test.ts — Task 3.7
 *
 * TDD for emitting SECURITY self-notifications on:
 *   1. security.new_signin       — login (non-enrolled) + mfaVerify (enrolled)
 *   2. security.password_changed — changeMyPassword
 *   3. security.mfa_enabled      — mfaEnable
 *   4. security.mfa_disabled     — mfaDisable
 *
 * Strategy: vi.mock captures emit calls. Each test hits the real Express route
 * via supertest. Prisma + Supabase are fully mocked (vi.mock in setup.ts).
 * All four verbs must have actorId: null and entity.user_id set.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { clearTokenCache } from '../middleware/authenticate';
import { hashCode, encryptRefreshToken } from '../lib/mfa-otp';
import { TEST_USERS, TEST_ORG, ALPHA_ORG_ID, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Spy on emit ─────────────────────────────────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ─────────────────────────────────────────────────────

const mockPrisma = prisma as any;
const mockSupabase = supabaseAdmin as any;

// ─── Pin MFA enc key (same as auth-mfa.test.ts) ──────────────────────────────

beforeAll(() => {
  process.env.MFA_TOKEN_ENC_KEY = 'test-mfa-enc-key-deterministic';
});

// ─── Shared user fixture ──────────────────────────────────────────────────────

const USER_ID = TEST_USERS.admin.id;       // '00000000-0000-0000-0000-000000000001'
const USER_EMAIL = TEST_USERS.admin.email; // 'admin@test.com'
const USER_NAME = `${TEST_USERS.admin.first_name} ${TEST_USERS.admin.last_name}`;

const APP_USER = {
  id: USER_ID,
  email: USER_EMAIL,
  first_name: TEST_USERS.admin.first_name,
  last_name: TEST_USERS.admin.last_name,
  role: 'ADMIN',
  is_active: true,
  organization_id: ALPHA_ORG_ID,
  has_login: true,
  department_id: null,
  location_id: null,
  phone: null,
  phone_ext: null,
};

const SESSION = {
  access_token: 'access-abc',
  refresh_token: 'refresh-xyz',
  expires_at: 1893456000,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Wire prisma.user.findUnique for login path. Disambiguates the mfa_email_enrolled
 * lookup (separate select) from resolveAppUser's main lookup.
 */
function wireLoginUser(opts: { enrolled: boolean }) {
  mockPrisma.user.findUnique.mockImplementation(
    (args: { where: { id?: string; email?: string }; select?: Record<string, boolean> }) => {
      if (args.select && 'mfa_email_enrolled' in args.select) {
        return Promise.resolve({
          mfa_email_enrolled: opts.enrolled,
          first_name: APP_USER.first_name,
        });
      }
      // resolveAppUser lookup
      if (args.where.id === USER_ID || args.where.email === USER_EMAIL) {
        return Promise.resolve(APP_USER);
      }
      return Promise.resolve(null);
    },
  );
}

function mockSignInOk() {
  mockSupabase.auth.signInWithPassword.mockResolvedValue({
    data: {
      user: { id: USER_ID, email: USER_EMAIL },
      session: { ...SESSION },
    },
    error: null,
  });
}

// ─── beforeEach ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

// ═══════════════════════════════════════════════════════════════════════════════
// security.new_signin — login (non-enrolled)
// ═══════════════════════════════════════════════════════════════════════════════

describe('security.new_signin via login (non-enrolled user)', () => {
  it('emits security.new_signin with actorId:null and entity.user_id on successful non-enrolled login', async () => {
    mockSignInOk();
    wireLoginUser({ enrolled: false });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: USER_EMAIL, password: 'correctpassword' });

    expect(res.status).toBe(200);
    expect(res.body.session).toBeDefined();

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.verb).toBe('security.new_signin');
    expect(call.organizationId).toBe(ALPHA_ORG_ID);
    expect(call.actorId).toBeNull();
    expect(call.object.type).toBe('USER');
    expect(call.object.id).toBe(USER_ID);
    expect(call.entity.user_id).toBe(USER_ID);
  });

  it('does NOT emit new_signin when MFA-enrolled user logs in (returns CHALLENGE)', async () => {
    mockSignInOk();
    wireLoginUser({ enrolled: true });
    // MFA challenge creation mocks
    mockPrisma.mfaEmailChallenge.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.mfaEmailChallenge.count.mockResolvedValue(0);
    mockPrisma.mfaEmailChallenge.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.mfaEmailChallenge.create.mockResolvedValue({
      id: 'challenge-id-1',
      user_id: USER_ID,
      code_hmac: 'hashed-code',
      enc_refresh_token: 'encrypted-token',
      purpose: 'LOGIN',
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
      consumed_at: null,
      created_at: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: USER_EMAIL, password: 'correctpassword' });

    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.challengeId).toBeDefined();

    // Must NOT emit — MFA challenge was issued, not a real session
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('does NOT emit when login credentials are invalid', async () => {
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: USER_EMAIL, password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// security.new_signin — mfaVerify (enrolled user completing 2FA)
// ═══════════════════════════════════════════════════════════════════════════════

describe('security.new_signin via mfaVerify (MFA-enrolled user)', () => {
  const CHALLENGE_ID = 'challenge-verify-id-1';
  const PLAIN_CODE = '123456';

  function buildChallengeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: CHALLENGE_ID,
      user_id: USER_ID,
      code_hmac: hashCode(PLAIN_CODE),
      enc_refresh_token: encryptRefreshToken(SESSION.refresh_token),
      purpose: 'LOGIN',
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
      consumed_at: null,
      created_at: new Date(),
      ...overrides,
    };
  }

  it('emits security.new_signin with actorId:null and entity.user_id after successful MFA verify', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue(buildChallengeRow());
    mockPrisma.mfaEmailChallenge.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.mfaEmailChallenge.delete.mockResolvedValue({});
    mockSupabase.auth.refreshSession.mockResolvedValue({
      data: { session: { ...SESSION } },
      error: null,
    });
    // resolveAppUser lookup in mfaVerify
    mockPrisma.user.findUnique.mockResolvedValue(APP_USER);

    const res = await request(app)
      .post('/api/auth/mfa/verify')
      .send({ challengeId: CHALLENGE_ID, code: PLAIN_CODE });

    expect(res.status).toBe(200);
    expect(res.body.session).toBeDefined();

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.verb).toBe('security.new_signin');
    expect(call.organizationId).toBe(ALPHA_ORG_ID);
    expect(call.actorId).toBeNull();
    expect(call.object.type).toBe('USER');
    expect(call.object.id).toBe(USER_ID);
    expect(call.entity.user_id).toBe(USER_ID);
  });

  it('does NOT emit when MFA code is wrong', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue(buildChallengeRow());
    mockPrisma.mfaEmailChallenge.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/mfa/verify')
      .send({ challengeId: CHALLENGE_ID, code: '000000' });

    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('does NOT emit when challenge is missing', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/mfa/verify')
      .send({ challengeId: 'nonexistent', code: PLAIN_CODE });

    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// security.password_changed — changeMyPassword
// ═══════════════════════════════════════════════════════════════════════════════

describe('security.password_changed via changeMyPassword', () => {
  it('emits security.password_changed with actorId:null and entity.user_id after password update', async () => {
    mockAuthAs('admin');

    // changeMyPassword calls findUnique with select: { has_login, email } (no is_active).
    // resolveAppUser (authenticate path) calls findUnique with SELECT that includes is_active.
    // Distinguish by the presence of is_active in the select.
    mockPrisma.user.findUnique.mockImplementation((args: any) => {
      if (args.select && 'has_login' in args.select && !('is_active' in args.select)) {
        return Promise.resolve({ has_login: true, email: USER_EMAIL });
      }
      // authenticate middleware lookup (resolveAppUser SELECT)
      return Promise.resolve({ ...APP_USER, organization: TEST_ORG });
    });

    // findSupabaseAuthIdByEmail paginates listUsers
    mockSupabase.auth.admin.listUsers.mockResolvedValue({
      data: { users: [{ id: 'supa-id-1', email: USER_EMAIL }], nextPage: null },
      error: null,
    });

    mockSupabase.auth.admin.updateUserById.mockResolvedValue({ error: null });
    mockSignInOk(); // #4: changeMyPassword re-verifies current_password before updating

    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ current_password: 'currentPass123', password: 'newSecurePassword123' });

    expect(res.status).toBe(200);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.verb).toBe('security.password_changed');
    expect(call.organizationId).toBe(ALPHA_ORG_ID);
    expect(call.actorId).toBeNull();
    expect(call.object.type).toBe('USER');
    expect(call.object.id).toBe(USER_ID);
    expect(call.entity.user_id).toBe(USER_ID);
  });

  it('does NOT emit when Supabase password update fails', async () => {
    mockAuthAs('admin');

    // Re-establish findUnique mock to serve both authenticate (resolveAppUser SELECT includes
    // is_active) AND the controller's has_login lookup (select: { has_login, email } — no
    // is_active). Distinguish by checking if is_active is absent from the select.
    mockPrisma.user.findUnique.mockImplementation((args: any) => {
      if (args.select && 'has_login' in args.select && !('is_active' in args.select)) {
        return Promise.resolve({ has_login: true, email: USER_EMAIL });
      }
      // authenticate middleware lookup (resolveAppUser SELECT includes is_active)
      return Promise.resolve({ ...APP_USER, organization: TEST_ORG });
    });

    mockSupabase.auth.admin.listUsers.mockResolvedValue({
      data: { users: [{ id: 'supa-id-1', email: USER_EMAIL }], nextPage: null },
      error: null,
    });

    // Supabase update fails
    mockSupabase.auth.admin.updateUserById.mockResolvedValue({
      error: { message: 'Password too weak' },
    });
    mockSignInOk(); // #4: pass re-auth so the test exercises the update-failure path, not the re-auth gate

    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ current_password: 'currentPass123', password: 'validbutbad' });

    expect(res.status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// security.mfa_enabled — mfaEnable
// ═══════════════════════════════════════════════════════════════════════════════

describe('security.mfa_enabled via mfaEnable', () => {
  const CHALLENGE_ID = 'enroll-challenge-id-1';
  const PLAIN_CODE = '654321';

  it('emits security.mfa_enabled with actorId:null and entity.user_id after enrollment', async () => {
    mockAuthAs('admin');

    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue({
      id: CHALLENGE_ID,
      user_id: USER_ID,
      code_hmac: hashCode(PLAIN_CODE),
      enc_refresh_token: null,
      purpose: 'ENROLL',
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
      consumed_at: null,
      created_at: new Date(),
    });
    mockPrisma.mfaEmailChallenge.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.mfaEmailChallenge.update.mockResolvedValue({});
    mockPrisma.mfaEmailChallenge.delete.mockResolvedValue({});
    mockPrisma.user.update.mockResolvedValue({ ...APP_USER, mfa_email_enrolled: true });

    const res = await request(app)
      .post('/api/auth/mfa/enable')
      .set(authHeader('admin'))
      .send({ challengeId: CHALLENGE_ID, code: PLAIN_CODE });

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(true);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.verb).toBe('security.mfa_enabled');
    expect(call.organizationId).toBe(ALPHA_ORG_ID);
    expect(call.actorId).toBeNull();
    expect(call.object.type).toBe('USER');
    expect(call.object.id).toBe(USER_ID);
    expect(call.entity.user_id).toBe(USER_ID);
  });

  it('does NOT emit when challenge code is wrong', async () => {
    mockAuthAs('admin');

    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue({
      id: CHALLENGE_ID,
      user_id: USER_ID,
      code_hmac: hashCode(PLAIN_CODE),
      enc_refresh_token: null,
      purpose: 'ENROLL',
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
      consumed_at: null,
      created_at: new Date(),
    });
    mockPrisma.mfaEmailChallenge.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/mfa/enable')
      .set(authHeader('admin'))
      .send({ challengeId: CHALLENGE_ID, code: '000000' });

    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// security.mfa_disabled — mfaDisable
// ═══════════════════════════════════════════════════════════════════════════════

describe('security.mfa_disabled via mfaDisable', () => {
  it('emits security.mfa_disabled with actorId:null and entity.user_id after disabling', async () => {
    mockAuthAs('admin');

    mockPrisma.user.update.mockResolvedValue({ ...APP_USER, mfa_email_enrolled: false });
    mockPrisma.mfaEmailChallenge.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .post('/api/auth/mfa/disable')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(false);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.verb).toBe('security.mfa_disabled');
    expect(call.organizationId).toBe(ALPHA_ORG_ID);
    expect(call.actorId).toBeNull();
    expect(call.object.type).toBe('USER');
    expect(call.object.id).toBe(USER_ID);
    expect(call.entity.user_id).toBe(USER_ID);
  });
});
