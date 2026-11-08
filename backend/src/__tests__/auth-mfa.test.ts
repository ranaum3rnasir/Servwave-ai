import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { sendMfaCodeEmail } from '../lib/email';
import { clearTokenCache } from '../middleware/authenticate';
import { hashCode, encryptRefreshToken } from '../lib/mfa-otp';

// mfa-otp reads process.env directly (MFA_TOKEN_ENC_KEY || SUPABASE_SERVICE_ROLE_KEY).
// Pin a deterministic key so the controller's hash/encrypt matches the test's.
beforeAll(() => {
  process.env.MFA_TOKEN_ENC_KEY = 'test-mfa-enc-key-deterministic';
});

const mockPrisma = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  mfaEmailChallenge: {
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
};
const mockSupabase = supabaseAdmin as unknown as {
  auth: {
    getUser: ReturnType<typeof vi.fn>;
    signInWithPassword: ReturnType<typeof vi.fn>;
    refreshSession: ReturnType<typeof vi.fn>;
  };
};
const mockSendMfa = sendMfaCodeEmail as ReturnType<typeof vi.fn>;

const ORG_ID = '00000000-0000-0000-0000-000000000001';

// An app user row as resolveAppUser's SELECT returns it (no mfa flag in that select).
const APP_USER = {
  id: 'user-1',
  email: 'mfa@acme.com',
  first_name: 'Mona',
  last_name: 'Fae',
  role: 'ADMIN',
  is_active: true,
  organization_id: ORG_ID,
  department_id: null,
  location_id: null,
};

const SESSION = {
  access_token: 'access-abc',
  refresh_token: 'refresh-xyz',
  expires_at: 1893456000,
};

/**
 * Wire prisma.user.findUnique for the login path: resolveAppUser looks the user
 * up (by supabase id, then by email); a separate enrollment read selects
 * mfa_email_enrolled + first_name. We disambiguate on the presence of that select.
 */
function wireLoginUser(opts: { enrolled: boolean }) {
  mockPrisma.user.findUnique.mockImplementation(
    (args: { where: { id?: string; email?: string }; select?: Record<string, boolean> }) => {
      if (args.select && 'mfa_email_enrolled' in args.select) {
        return Promise.resolve({ mfa_email_enrolled: opts.enrolled, first_name: APP_USER.first_name });
      }
      // resolveAppUser lookup
      if (args.where.id === APP_USER.id || args.where.email === APP_USER.email) {
        return Promise.resolve(APP_USER);
      }
      return Promise.resolve(null);
    },
  );
}

function mockSignInOk() {
  mockSupabase.auth.signInWithPassword.mockResolvedValue({
    data: { user: { id: APP_USER.id, email: APP_USER.email }, session: { ...SESSION } },
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
});

// ═══════════════════════════════════════════════════════
// POST /api/auth/login — MFA gate
// ═══════════════════════════════════════════════════════

describe('POST /api/auth/login (email-OTP 2FA gate)', () => {
  it('enrolled user → 200 { mfaRequired:true, challengeId } and the body LEAKS NO session/token/user', async () => {
    mockSignInOk();
    wireLoginUser({ enrolled: true });
    mockPrisma.mfaEmailChallenge.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.mfaEmailChallenge.count.mockResolvedValue(0);
    mockPrisma.mfaEmailChallenge.create.mockResolvedValue({ id: 'chal-1' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: APP_USER.email, password: 'pw' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaRequired: true, challengeId: 'chal-1' });

    // CRITICAL INVARIANT — no credential material may appear anywhere in the body.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('access');
    expect(serialized).not.toContain('refresh');
    expect(res.body.session).toBeUndefined();
    expect(res.body.user).toBeUndefined();
    expect(res.body.access_token).toBeUndefined();
    expect(res.body.refresh_token).toBeUndefined();

    // The parked token is encrypted, never the plaintext.
    const createArg = mockPrisma.mfaEmailChallenge.create.mock.calls[0][0];
    expect(createArg.data.purpose).toBe('LOGIN');
    expect(createArg.data.user_id).toBe(APP_USER.id);
    expect(createArg.data.enc_refresh_token).toBeTruthy();
    expect(createArg.data.enc_refresh_token).not.toContain(SESSION.refresh_token);
    expect(createArg.data.code_hmac).toBeTruthy();
    expect(createArg.data.code_hmac).not.toMatch(/^\d{6}$/); // hashed, not the raw code
    expect(mockSendMfa).toHaveBeenCalledOnce();
  });

  it('supersedes (consumes, not deletes) the prior unconsumed LOGIN challenge before creating a new one', async () => {
    mockSignInOk();
    wireLoginUser({ enrolled: true });
    mockPrisma.mfaEmailChallenge.deleteMany.mockResolvedValue({ count: 0 }); // lazy reap of old rows
    mockPrisma.mfaEmailChallenge.updateMany.mockResolvedValue({ count: 1 }); // supersede prior live
    mockPrisma.mfaEmailChallenge.count.mockResolvedValue(0);
    mockPrisma.mfaEmailChallenge.create.mockResolvedValue({ id: 'chal-2' });

    await request(app).post('/api/auth/login').send({ email: APP_USER.email, password: 'pw' });

    // The prior live challenge is SUPERSEDED (kept as a creation record so it still
    // counts toward the per-user cap) — NOT deleted, which was the brute-force hole.
    expect(mockPrisma.mfaEmailChallenge.updateMany).toHaveBeenCalled();
    const supArg = mockPrisma.mfaEmailChallenge.updateMany.mock.calls[0][0];
    expect(supArg.where.user_id).toBe(APP_USER.id);
    expect(supArg.where.purpose).toBe('LOGIN');
    expect(supArg.where.consumed_at).toBeNull();
    expect(supArg.data.consumed_at).toBeInstanceOf(Date);
    // supersede must run before create (only one live LOGIN challenge per user)
    expect(mockPrisma.mfaEmailChallenge.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(mockPrisma.mfaEmailChallenge.create.mock.invocationCallOrder[0]);
  });

  it('counts in-window challenges BEFORE superseding/creating, so rotating challenges cannot reset the budget', async () => {
    mockSignInOk();
    wireLoginUser({ enrolled: true });
    mockPrisma.mfaEmailChallenge.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.mfaEmailChallenge.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.mfaEmailChallenge.count.mockResolvedValue(0);
    mockPrisma.mfaEmailChallenge.create.mockResolvedValue({ id: 'chal-9' });

    await request(app).post('/api/auth/login').send({ email: APP_USER.email, password: 'pw' });

    // The cap count is read BEFORE the supersede + create that would otherwise erase
    // the history (the bug was deleteMany-before-count → the count always read ~0).
    const countOrder = mockPrisma.mfaEmailChallenge.count.mock.invocationCallOrder[0];
    expect(countOrder).toBeLessThan(mockPrisma.mfaEmailChallenge.updateMany.mock.invocationCallOrder[0]);
    expect(countOrder).toBeLessThan(mockPrisma.mfaEmailChallenge.create.mock.invocationCallOrder[0]);
  });

  it('caps challenge creation at 5 per 15 min per user → 429 when exceeded (no challenge created)', async () => {
    mockSignInOk();
    wireLoginUser({ enrolled: true });
    mockPrisma.mfaEmailChallenge.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.mfaEmailChallenge.count.mockResolvedValue(5); // already at the cap in-window

    const res = await request(app).post('/api/auth/login').send({ email: APP_USER.email, password: 'pw' });

    expect(res.status).toBe(429);
    expect(mockPrisma.mfaEmailChallenge.create).not.toHaveBeenCalled();
    // capped path bails BEFORE mutating — no supersede either
    expect(mockPrisma.mfaEmailChallenge.updateMany).not.toHaveBeenCalled();
    // still no token leak on the throttled path
    expect(JSON.stringify(res.body)).not.toContain('refresh');
  });

  it('non-enrolled user → unchanged { user, session } shape', async () => {
    mockSignInOk();
    wireLoginUser({ enrolled: false });

    const res = await request(app).post('/api/auth/login').send({ email: APP_USER.email, password: 'pw' });

    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBeUndefined();
    expect(res.body.user).toMatchObject({ id: APP_USER.id, email: APP_USER.email, role: 'ADMIN' });
    expect(res.body.session).toMatchObject({ access_token: 'access-abc', refresh_token: 'refresh-xyz' });
    expect(mockPrisma.mfaEmailChallenge.create).not.toHaveBeenCalled();
    expect(mockSendMfa).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/auth/mfa/verify
// ═══════════════════════════════════════════════════════

describe('POST /api/auth/mfa/verify', () => {
  const CODE = '123456';
  const future = () => new Date(Date.now() + 5 * 60 * 1000);
  const liveChallenge = (over: Record<string, unknown> = {}) => ({
    id: 'chal-1',
    user_id: APP_USER.id,
    code_hmac: hashCode(CODE),
    enc_refresh_token: encryptRefreshToken(SESSION.refresh_token),
    purpose: 'LOGIN',
    attempts: 0,
    expires_at: future(),
    consumed_at: null,
    ...over,
  });

  it('happy path → exchanges the parked refresh token and returns { user, session }', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue(liveChallenge());
    mockPrisma.mfaEmailChallenge.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.mfaEmailChallenge.delete.mockResolvedValue({});
    mockSupabase.auth.refreshSession.mockResolvedValue({
      data: { session: { access_token: 'new-access', refresh_token: 'new-refresh', expires_at: 1893456999 } },
      error: null,
    });
    // resolveAppUser after the exchange
    mockPrisma.user.findUnique.mockResolvedValue(APP_USER);
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: APP_USER.id, email: APP_USER.email, email_confirmed_at: '2026-01-01' } },
      error: null,
    });

    const res = await request(app).post('/api/auth/mfa/verify').send({ challengeId: 'chal-1', code: CODE });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: APP_USER.id, email: APP_USER.email });
    expect(res.body.session).toMatchObject({ access_token: 'new-access', refresh_token: 'new-refresh' });
    // refreshSession is the ONLY consumer of the parked token
    expect(mockSupabase.auth.refreshSession).toHaveBeenCalledWith({ refresh_token: SESSION.refresh_token });
    // single-use: atomic compare-and-set consume, then the row removed
    expect(mockPrisma.mfaEmailChallenge.updateMany).toHaveBeenCalled();
    const consumeArg = mockPrisma.mfaEmailChallenge.updateMany.mock.calls[0][0];
    expect(consumeArg.where).toEqual({ id: 'chal-1', consumed_at: null });
    expect(consumeArg.data.consumed_at).toBeInstanceOf(Date);
    expect(mockPrisma.mfaEmailChallenge.delete).toHaveBeenCalledWith({ where: { id: 'chal-1' } });
  });

  it('concurrent double-use → 401 and the parked token is NEVER exchanged (atomic consume lost the race)', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue(liveChallenge());
    // Read as live, but the atomic consume finds it already consumed (count 0) — lost the race.
    mockPrisma.mfaEmailChallenge.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).post('/api/auth/mfa/verify').send({ challengeId: 'chal-1', code: CODE });

    expect(res.status).toBe(401);
    expect(res.body.session).toBeUndefined();
    expect(mockSupabase.auth.refreshSession).not.toHaveBeenCalled();
    expect(mockPrisma.mfaEmailChallenge.delete).not.toHaveBeenCalled();
  });

  it('wrong code → generic 401 and increments attempts (no token exchange)', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue(liveChallenge());
    mockPrisma.mfaEmailChallenge.update.mockResolvedValue({});

    const res = await request(app).post('/api/auth/mfa/verify').send({ challengeId: 'chal-1', code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.session).toBeUndefined();
    expect(mockSupabase.auth.refreshSession).not.toHaveBeenCalled();
    // attempts++ persisted
    const updArg = mockPrisma.mfaEmailChallenge.update.mock.calls[0][0];
    expect(updArg.where).toEqual({ id: 'chal-1' });
    expect(updArg.data.attempts).toEqual({ increment: 1 });
  });

  it('5th wrong attempt is locked → generic 401, never reaching code comparison', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue(liveChallenge({ attempts: 5 }));

    const res = await request(app).post('/api/auth/mfa/verify').send({ challengeId: 'chal-1', code: CODE });

    expect(res.status).toBe(401);
    expect(mockSupabase.auth.refreshSession).not.toHaveBeenCalled();
    // locked path does not bump attempts further
    expect(mockPrisma.mfaEmailChallenge.update).not.toHaveBeenCalled();
  });

  it('expired challenge → generic 401', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue(
      liveChallenge({ expires_at: new Date(Date.now() - 60 * 1000) }),
    );

    const res = await request(app).post('/api/auth/mfa/verify').send({ challengeId: 'chal-1', code: CODE });

    expect(res.status).toBe(401);
    expect(mockSupabase.auth.refreshSession).not.toHaveBeenCalled();
  });

  it('already-consumed challenge → generic 401', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue(liveChallenge({ consumed_at: new Date() }));

    const res = await request(app).post('/api/auth/mfa/verify').send({ challengeId: 'chal-1', code: CODE });

    expect(res.status).toBe(401);
    expect(mockSupabase.auth.refreshSession).not.toHaveBeenCalled();
  });

  it('unknown challenge id → generic 401 (no enumeration)', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/api/auth/mfa/verify').send({ challengeId: 'nope', code: CODE });

    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/auth/mfa/resend
// ═══════════════════════════════════════════════════════

describe('POST /api/auth/mfa/resend', () => {
  it('re-mints the code on a live challenge and re-emails → 200 { ok:true }', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue({
      id: 'chal-1', user_id: APP_USER.id, purpose: 'LOGIN', attempts: 0,
      expires_at: new Date(Date.now() + 5 * 60 * 1000), consumed_at: null,
    });
    mockPrisma.mfaEmailChallenge.count.mockResolvedValue(1);
    mockPrisma.mfaEmailChallenge.update.mockResolvedValue({});
    mockPrisma.user.findUnique.mockResolvedValue({ email: APP_USER.email, first_name: APP_USER.first_name });

    const res = await request(app).post('/api/auth/mfa/resend').send({ challengeId: 'chal-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // the stored hash was rotated
    const updArg = mockPrisma.mfaEmailChallenge.update.mock.calls[0][0];
    expect(updArg.data.code_hmac).toBeTruthy();
    expect(mockSendMfa).toHaveBeenCalledOnce();
  });

  it('throttles when the per-user cap is exceeded → 429 (no email)', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue({
      id: 'chal-1', user_id: APP_USER.id, purpose: 'LOGIN', attempts: 0,
      expires_at: new Date(Date.now() + 5 * 60 * 1000), consumed_at: null,
    });
    mockPrisma.mfaEmailChallenge.count.mockResolvedValue(5);

    const res = await request(app).post('/api/auth/mfa/resend').send({ challengeId: 'chal-1' });

    expect(res.status).toBe(429);
    expect(mockSendMfa).not.toHaveBeenCalled();
  });

  it('unknown/expired challenge → generic 401', async () => {
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/auth/mfa/resend').send({ challengeId: 'gone' });
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// Enrollment (authenticated)
// ═══════════════════════════════════════════════════════

import { mockAuthAs, authHeader, TEST_ORG } from './helpers';

describe('POST /api/auth/mfa/setup (authenticated enrollment start)', () => {
  it('creates an ENROLL challenge (no parked token) and emails the code', async () => {
    mockAuthAs('admin');
    mockPrisma.mfaEmailChallenge.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.mfaEmailChallenge.count.mockResolvedValue(0);
    mockPrisma.mfaEmailChallenge.create.mockResolvedValue({ id: 'enroll-1' });

    const res = await request(app).post('/api/auth/mfa/setup').set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challengeId: 'enroll-1' });
    const createArg = mockPrisma.mfaEmailChallenge.create.mock.calls[0][0];
    expect(createArg.data.purpose).toBe('ENROLL');
    expect(createArg.data.enc_refresh_token ?? null).toBeNull();
    expect(mockSendMfa).toHaveBeenCalledOnce();
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/auth/mfa/setup').send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/mfa/enable', () => {
  const CODE = '424242';

  it('verifies the ENROLL challenge and flips mfa_email_enrolled = true', async () => {
    mockAuthAs('admin');
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue({
      id: 'enroll-1',
      user_id: '00000000-0000-0000-0000-000000000001', // TEST_USERS.admin.id
      code_hmac: hashCode(CODE),
      enc_refresh_token: null,
      purpose: 'ENROLL',
      attempts: 0,
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
      consumed_at: null,
    });
    mockPrisma.mfaEmailChallenge.update.mockResolvedValue({});
    mockPrisma.mfaEmailChallenge.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.mfaEmailChallenge.delete.mockResolvedValue({});
    mockPrisma.user.update.mockResolvedValue({ id: 'u', mfa_email_enrolled: true });

    const res = await request(app).post('/api/auth/mfa/enable').set(authHeader('admin')).send({ challengeId: 'enroll-1', code: CODE });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enrolled: true });
    const updArg = mockPrisma.user.update.mock.calls[0][0];
    expect(updArg.data.mfa_email_enrolled).toBe(true);
    expect(updArg.where.id).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('rejects a wrong code with 401 and does not flip the flag', async () => {
    mockAuthAs('admin');
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue({
      id: 'enroll-1',
      user_id: '00000000-0000-0000-0000-000000000001',
      code_hmac: hashCode(CODE),
      enc_refresh_token: null,
      purpose: 'ENROLL',
      attempts: 0,
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
      consumed_at: null,
    });
    mockPrisma.mfaEmailChallenge.update.mockResolvedValue({});

    const res = await request(app).post('/api/auth/mfa/enable').set(authHeader('admin')).send({ challengeId: 'enroll-1', code: '999999' });

    expect(res.status).toBe(401);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses an ENROLL challenge that belongs to a different user → 401", async () => {
    mockAuthAs('admin');
    mockPrisma.mfaEmailChallenge.findUnique.mockResolvedValue({
      id: 'enroll-1',
      user_id: 'someone-else',
      code_hmac: hashCode(CODE),
      enc_refresh_token: null,
      purpose: 'ENROLL',
      attempts: 0,
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
      consumed_at: null,
    });

    const res = await request(app).post('/api/auth/mfa/enable').set(authHeader('admin')).send({ challengeId: 'enroll-1', code: CODE });

    expect(res.status).toBe(401);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/mfa/disable', () => {
  it('clears mfa_email_enrolled and purges the user challenges', async () => {
    mockAuthAs('admin');
    mockPrisma.user.update.mockResolvedValue({ id: 'u', mfa_email_enrolled: false });
    mockPrisma.mfaEmailChallenge.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app).post('/api/auth/mfa/disable').set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enrolled: false });
    expect(mockPrisma.user.update.mock.calls[0][0].data.mfa_email_enrolled).toBe(false);
    expect(mockPrisma.mfaEmailChallenge.deleteMany).toHaveBeenCalled();
    expect(mockPrisma.mfaEmailChallenge.deleteMany.mock.calls[0][0].where.user_id)
      .toBe('00000000-0000-0000-0000-000000000001');
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/auth/mfa/disable').send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/mfa/status', () => {
  it('reflects the enrolled state for the current user', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findUnique.mockImplementation(
      (args: { where: { id: string }; select?: Record<string, boolean> }) => {
        if (args.select && 'mfa_email_enrolled' in args.select) {
          return Promise.resolve({ mfa_email_enrolled: true });
        }
        // authenticate middleware lookup
        return Promise.resolve({
          id: '00000000-0000-0000-0000-000000000001', email: 'admin@test.com',
          first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_active: true,
          organization_id: ORG_ID, department_id: null, location_id: null,
          organization: TEST_ORG,
        });
      },
    );

    const res = await request(app).get('/api/auth/mfa/status').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enrolled: true });
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/auth/mfa/status');
    expect(res.status).toBe(401);
  });
});
