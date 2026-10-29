/**
 * A user who signs in only with Google has no password (password reset spec §4.1 last bullet,
 * §4.3 Google-only case; slice 06).
 *
 * Seams: the HTTP endpoints the Login & Security card calls (status + body), and what leaves the
 * system: the auth provider and the email sender are mocked at their boundaries (setup.ts). The
 * users table and the audit log are small in-memory fakes, because the per-email cap is a count
 * over the audit log and "has a password" falls back to it. Every password and token is generated
 * per run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'crypto';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { sendPasswordResetEmail } from '../lib/email';
import { clearTokenCache } from '../middleware/authenticate';
import { settlePasswordResetWork } from '../lib/password-reset';
import { TEST_USERS, TEST_ORG, mockAuthAs } from './helpers';

const auth = supabaseAdmin.auth as unknown as {
  getUser: Mock;
  signInWithPassword: Mock;
  verifyOtp: Mock;
  admin: { getUserById: Mock; updateUserById: Mock; generateLink: Mock; signOut: Mock };
};
const sendEmail = sendPasswordResetEmail as unknown as Mock;

const ME = { ...TEST_USERS.admin, has_login: true };
// A Google-only user was invited (has_login set then) and first signed in with Google. Their one
// auth account has a different id from the app user id (not a second account); lib/auth-user.ts
// resolves it by email.
const AUTH_ID = 'a0000000-0000-4000-8000-00000000600d';
const secret = () => randomBytes(12).toString('base64url');
const GOOGLE_ONLY = [{ provider: 'google' }];
const WITH_EMAIL = [{ provider: 'email' }, { provider: 'google' }];

/** Vendor and provider words that must never reach the page. Google is the sign-in the user chose. */
const VENDOR_WORDS = /supabase|gotrue|resend|render|vercel|identit|provider/i;

interface AuditRow {
  org_id: string;
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}
let audit: AuditRow[];
let token: string;
let hashedToken: string;
let identities: Array<{ provider: string }> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  token = `tok-${secret()}`;
  hashedToken = randomBytes(28).toString('hex');
  audit = [];
  identities = GOOGLE_ONLY;
  mockAuthAs('admin');
  auth.getUser.mockResolvedValue({
    data: { user: { id: AUTH_ID, email: ME.email, email_confirmed_at: '2026-01-01T00:00:00Z' } },
    error: null,
  });
  (prisma.user.findUnique as Mock).mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === ME.id ? { ...ME, organization: TEST_ORG } : null,
  );
  (prisma.user.findFirst as Mock).mockImplementation(async () => ({ ...ME, organization: TEST_ORG }));
  auth.admin.getUserById.mockImplementation(async (id: string) =>
    id === AUTH_ID
      ? { data: { user: { id: AUTH_ID, email: ME.email, identities } }, error: null }
      : { data: { user: null }, error: { status: 404, message: 'User not found' } },
  );

  (prisma.$transaction as Mock).mockImplementation(async (fn: unknown) =>
    typeof fn === 'function' ? (fn as (tx: typeof prisma) => unknown)(prisma) : Promise.all(fn as unknown[]),
  );
  (prisma.$executeRaw as unknown as Mock).mockResolvedValue(1);
  (prisma.auditLog.create as Mock).mockImplementation(async ({ data }: { data: Omit<AuditRow, 'created_at'> }) => {
    audit.push({ ...data, metadata: data.metadata ?? {}, created_at: new Date() });
    return data;
  });
  (prisma.auditLog.count as Mock).mockImplementation(
    async ({ where }: { where: { org_id?: string; resource_id: string; action: { in: string[] }; created_at?: { gte: Date } } }) =>
      audit.filter(
        (r) =>
          (where.org_id === undefined || r.org_id === where.org_id) &&
          r.resource_id === where.resource_id &&
          where.action.in.includes(r.action) &&
          (!where.created_at || r.created_at >= where.created_at.gte),
      ).length,
  );
  auth.admin.generateLink.mockImplementation(async () => ({
    data: { properties: { hashed_token: hashedToken }, user: { id: AUTH_ID } },
    error: null,
  }));
  sendEmail.mockResolvedValue(true);
});

const authed = () => ({ Authorization: `Bearer ${token}` });
const logged = () =>
  JSON.stringify([(logger.info as Mock).mock.calls, (logger.warn as Mock).mock.calls, (logger.error as Mock).mock.calls]);

// ─── Does the signed-in user have a password? ────────────────────────────────

describe('GET /api/users/me/password-status', () => {
  it('says a Google-only user has no password', async () => {
    const res = await request(app).get('/api/users/me/password-status').set(authed());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ has_password: false });
    // Asked about the account the verified token belongs to, never one named in the request.
    expect(auth.admin.getUserById).toHaveBeenCalledWith(AUTH_ID);
  });

  it('says a user who also has an email sign-in has a password', async () => {
    identities = WITH_EMAIL;
    const res = await request(app).get('/api/users/me/password-status').set(authed());

    expect(res.body).toEqual({ has_password: true });
  });

  it('counts a password ServWave set by email for a Google-only user', async () => {
    audit.push({
      org_id: ME.organization_id, actor_id: ME.id, action: 'user.password_reset', resource_type: 'User',
      resource_id: ME.id, metadata: {}, created_at: new Date('2026-02-01T00:00:00Z'),
    });
    const res = await request(app).get('/api/users/me/password-status').set(authed());

    expect(res.body).toEqual({ has_password: true });
  });

  it("never counts another organization's audit rows as this user's password (review item 5)", async () => {
    audit.push({
      org_id: '00000000-0000-4000-8000-0000000000ff', actor_id: ME.id, action: 'user.password_reset', resource_type: 'User',
      resource_id: ME.id, metadata: {}, created_at: new Date('2026-02-01T00:00:00Z'),
    });
    const res = await request(app).get('/api/users/me/password-status').set(authed());

    expect(res.body).toEqual({ has_password: false });
    expect(prisma.auditLog.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ org_id: ME.organization_id, resource_id: ME.id }),
    });
  });

  it('shows the password form when the sign-in methods cannot be read', async () => {
    auth.admin.getUserById.mockRejectedValue(new Error('network down'));
    const res = await request(app).get('/api/users/me/password-status').set(authed());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ has_password: true });
  });

  it('never hands the page the auth id or the sign-in internals', async () => {
    const res = await request(app).get('/api/users/me/password-status').set(authed());

    expect(JSON.stringify(res.body)).not.toContain(AUTH_ID);
    expect(JSON.stringify(res.body)).not.toMatch(VENDOR_WORDS);
    expect(JSON.stringify(res.body)).not.toMatch(/google/i);
  });
});

// ─── The change form refuses a user with no password ─────────────────────────

describe('POST /api/users/me/password for a Google-only user', () => {
  it.each([
    ['an empty current password', ''],
    ['a typed current password', 'typed'],
  ])('refuses %s with a clear message, and never re-checks or writes a password', async (_label, current) => {
    const res = await request(app)
      .post('/api/users/me/password')
      .set(authed())
      .send({ current_password: current === 'typed' ? secret() : current, password: secret() });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "You sign in with Google and don't have a password yet. Use Set a password by email on Login & Security.",
      code: 'no_password',
    });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toMatch(VENDOR_WORDS);
  });

  it('still lets a user with a password through to the current-password check', async () => {
    identities = WITH_EMAIL;
    auth.signInWithPassword.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'Invalid login credentials' } });

    const res = await request(app).post('/api/users/me/password').set(authed()).send({ current_password: secret(), password: secret() });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('current_password_incorrect');
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
  });
});

// ─── "Set a password by email" ───────────────────────────────────────────────

const emailLink = (body: Record<string, unknown> = {}) =>
  request(app).post('/api/users/me/password/email-link').set(authed()).send(body);

describe('POST /api/users/me/password/email-link', () => {
  it("emails the reset link to the user's own address and says where it went", async () => {
    const res = await emailLink();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, email: ME.email });
    expect(auth.admin.generateLink).toHaveBeenCalledWith({ type: 'recovery', email: ME.email });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith({
      to: ME.email,
      firstName: ME.first_name,
      resetUrl: `http://localhost:5173/reset-password?token=${hashedToken}`,
      organizationId: ME.organization_id,
    });
  });

  it('ignores any address in the request body', async () => {
    const res = await emailLink({ email: 'someone-else@example.test', to: 'someone-else@example.test' });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(ME.email);
    expect(auth.admin.generateLink).toHaveBeenCalledWith({ type: 'recovery', email: ME.email });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ME.email }));
    expect(JSON.stringify(sendEmail.mock.calls)).not.toContain('someone-else');
  });

  it('records the send in the audit log with the user as actor, and no token or link', async () => {
    await emailLink();

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'user.password_reset_requested',
      resource_type: 'User',
      resource_id: ME.id,
      actor_id: ME.id,
      org_id: ME.organization_id,
    });
    expect(JSON.stringify(audit)).not.toContain(hashedToken);
    expect(logged()).not.toContain(hashedToken);
  });

  it('shares the per-email limit: a fourth link in 15 minutes is refused and nothing is sent', async () => {
    for (let i = 0; i < 3; i++) expect((await emailLink()).status).toBe(200);
    sendEmail.mockClear();
    auth.admin.generateLink.mockClear();

    const res = await emailLink();

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: "We've already sent 3 reset links to this address in the last 15 minutes. Use the newest email, or try again later.",
      code: 'reset_link_limit',
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(auth.admin.generateLink).not.toHaveBeenCalled();
    expect(audit).toHaveLength(3);
  });

  it('counts links the user asked for from the sign-in page against the same limit', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/auth/password/forgot').send({ email: ME.email });
      await settlePasswordResetWork();
    }
    sendEmail.mockClear();

    const res = await emailLink();

    expect(res.status).toBe(429);
    // The user did not ask for these three from here: the copy must not say they did (review item 6).
    expect(res.body.error).toBe(
      "We've already sent 3 reset links to this address in the last 15 minutes. Use the newest email, or try again later.",
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['the link cannot be minted', () => auth.admin.generateLink.mockResolvedValue({ data: null, error: { status: 500, message: 'Database error' } })],
    ['the email cannot be sent', () => sendEmail.mockResolvedValue(false)],
  ])('says so plainly when %s', async (_label, arrange) => {
    arrange();
    const res = await emailLink();

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: "We couldn't send the email. Try again or contact ServWave support.",
      code: 'reset_link_not_sent',
    });
    expect(JSON.stringify(res.body)).not.toMatch(VENDOR_WORDS);
  });

  it('refuses a user whose login is not enabled, and sends nothing', async () => {
    (prisma.user.findUnique as Mock).mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === ME.id ? { ...ME, has_login: false, organization: TEST_ORG } : null,
    );
    const res = await emailLink();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Login is not enabled for your account');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit).toHaveLength(0);
  });

  it('needs a signed-in user', async () => {
    const res = await request(app).post('/api/users/me/password/email-link').send({});

    expect(res.status).toBe(401);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ─── The signed-out flows treat a Google-only user like anyone with a login ──

describe('forgot and reset for a Google-only user', () => {
  it('"Forgot password?" sends a Google-only user a link', async () => {
    const res = await request(app).post('/api/auth/password/forgot').send({ email: ME.email });
    await settlePasswordResetWork();

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ME.email }));
  });

  it('the link sets a password on the Google account (auth id resolved by confirmed email)', async () => {
    auth.verifyOtp.mockResolvedValue({
      data: {
        user: { id: AUTH_ID, email: ME.email, email_confirmed_at: '2026-01-01T00:00:00Z', identities: GOOGLE_ONLY },
        session: { access_token: `at-${secret()}` },
      },
      error: null,
    });
    // resolveAppUser: no app row under the auth id, so it falls back to the confirmed email.
    (prisma.user.findUnique as Mock).mockResolvedValue(null);
    auth.admin.updateUserById.mockResolvedValue({ data: { user: { id: AUTH_ID } }, error: null });
    auth.admin.signOut.mockResolvedValue({ data: null, error: null });
    const password = secret();

    const res = await request(app).post('/api/auth/password/reset').send({ token: hashedToken, password });

    expect(res.status).toBe(200);
    expect(auth.admin.updateUserById).toHaveBeenCalledWith(AUTH_ID, { password });
  });
});
