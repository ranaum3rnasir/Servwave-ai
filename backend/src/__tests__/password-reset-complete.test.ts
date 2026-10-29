/**
 * POST /api/auth/password/reset - set a new password from a reset link (password reset spec §5.2,
 * slice 04; conductor brief §3.3 token, §3.4 sessions, §3.6 input, §3.7 error copy, §3.8 audit).
 *
 * Seams: the HTTP response, and the auth provider boundary (mocked in setup.ts). The fresh client
 * the token is checked on gets its own mock, so the test can tell it apart from the shared ones.
 * Every token and password is generated per run.
 *
 * The provider is modelled as it behaves: a recovery token works once (verifyOtp spends it), and
 * generateLink mints a new one for an email without sending anything (slice 05's retry).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { AuthSessionMissingError } from '@supabase/supabase-js';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin, createIsolatedAuthClient } from '../lib/supabase';
import { logger } from '../lib/logger';
import { sendPasswordResetEmail } from '../lib/email';
import { emit } from '../services/notifications/notificationService';
import { clearTokenCache } from '../middleware/authenticate';
import { BREACHED_PASSWORD_MESSAGE, PASSWORD_UPDATE_FAILED_MESSAGE } from '../lib/auth-provider-errors';
import { TEST_USERS, mockAuthAs } from './helpers';

const shared = supabaseAdmin.auth as unknown as {
  getUser: Mock;
  verifyOtp: Mock;
  admin: { updateUserById: Mock; signOut: Mock; generateLink: Mock };
};
const ME = TEST_USERS.admin;
const INVALID_LINK = 'This reset link is invalid or has expired.';
const secret = () => randomBytes(16).toString('base64url');

/** The fresh client the token must be checked on. */
let fresh: { verifyOtp: Mock };
let token: string;
let password: string;
/** The session verifyOtp opens, and one the user already had on another device. */
let recoverySession: string;
let otherDevice: string;
let revoked: Set<string>;
/** Recovery tokens the provider would still accept. verifyOtp removes the one it checks. */
let live: Set<string>;

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  mockAuthAs('admin');
  token = secret();
  password = secret();
  recoverySession = `tok-${secret()}`;
  otherDevice = `tok-${secret()}`;
  revoked = new Set();
  live = new Set([token]);

  fresh = {
    verifyOtp: vi.fn(async (args: { type: string; token_hash: string }) =>
      args.type === 'recovery' && live.delete(args.token_hash)
        ? {
            data: {
              user: { id: ME.id, email: ME.email, email_confirmed_at: '2026-01-01T00:00:00Z' },
              session: { access_token: recoverySession, refresh_token: secret() },
            },
            error: null,
          }
        : { data: { user: null, session: null }, error: { status: 403, code: 'otp_expired', message: 'Email link is invalid or has expired' } },
    ),
  };
  // Mints a recovery token without sending an email. Unknown emails get the provider's error.
  shared.admin.generateLink.mockImplementation(async (args: { type: string; email: string }) => {
    if (args.type !== 'recovery' || args.email !== ME.email) {
      return { data: { user: null, properties: null }, error: { status: 404, code: 'user_not_found', message: 'User not found' } };
    }
    const minted = secret();
    live.add(minted);
    return { data: { user: { id: ME.id, email: ME.email }, properties: { hashed_token: minted, action_link: `https://auth.example/verify?token=${minted}` } }, error: null };
  });
  (createIsolatedAuthClient as Mock).mockImplementation(() => ({ auth: fresh }));

  shared.getUser.mockImplementation(async (jwt: string) =>
    revoked.has(jwt)
      ? { data: { user: null }, error: { status: 403, message: 'session_not_found' } }
      : { data: { user: { id: ME.id, email: ME.email } }, error: null },
  );
  // The provider's admin password update ends EVERY session of the user, the token check's
  // included (seen on staging 2026-10-25; it runs the provider's "log out of all sessions" step).
  shared.admin.updateUserById.mockImplementation(async () => {
    for (const t of [recoverySession, otherDevice]) revoked.add(t);
    return { data: { user: { id: ME.id } }, error: null };
  });
  // 'global' revokes every session the user has; 'local' only the one whose JWT is passed. A JWT
  // whose session is already gone is refused the way the auth client reports it.
  shared.admin.signOut.mockImplementation(async (jwt: string, scope: string) => {
    if (revoked.has(jwt)) return { data: null, error: new AuthSessionMissingError() };
    if (scope === 'global') for (const t of [recoverySession, otherDevice]) revoked.add(t);
    if (scope === 'local') revoked.add(jwt);
    return { data: null, error: null };
  });
  (prisma.user.findUnique as Mock).mockImplementation((args: { where: { id: string } }) =>
    Promise.resolve(args.where.id === ME.id ? { ...ME, is_active: true, has_login: true, organization: { is_demo: false, plan: 'SCALE', trial_ends_at: null, feature_overrides: {} } } : null),
  );
});

const reset = (body: Record<string, unknown>) => request(app).post('/api/auth/password/reset').send(body);

const logged = () =>
  JSON.stringify([
    (logger.info as Mock).mock.calls,
    (logger.warn as Mock).mock.calls,
    (logger.error as Mock).mock.calls,
    (logger.debug as Mock).mock.calls,
  ]);

const VENDOR_WORDS = /supabase|gotrue|resend|render|vercel|pwned|known to be weak|otp/i;

describe('POST /api/auth/password/reset', () => {
  it('checks the token on a fresh client and sets the new password', async () => {
    const res = await reset({ token, password });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sessions_signed_out: true });
    expect(fresh.verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: token });
    expect(shared.verifyOtp).not.toHaveBeenCalled();
    expect(shared.admin.updateUserById).toHaveBeenCalledWith(ME.id, { password });
  });

  // The #2866 staging defect: the password update itself had already ended every session, so the
  // sign-out that followed found the token's session gone (AuthSessionMissingError, twice) and the
  // answer said sessions_signed_out:false although every device was in fact signed out.
  it('counts the sessions the password update itself ended as signed out, without a retry', async () => {
    const res = await reset({ token, password });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sessions_signed_out: true });
    expect(shared.admin.signOut).toHaveBeenCalledTimes(1);
    expect(shared.admin.signOut).toHaveBeenCalledWith(recoverySession, 'global');
    expect(revoked.has(otherDevice)).toBe(true);
    const row = (prisma.auditLog.create as Mock).mock.calls.map((c) => c[0].data).find((d) => d.action === 'user.password_reset');
    expect(row.metadata).toEqual({ sessions_signed_out: true });
  });

  it('still signs everything out when the password update leaves sessions open', async () => {
    shared.admin.updateUserById.mockResolvedValue({ data: { user: { id: ME.id } }, error: null });

    const res = await reset({ token, password });

    expect(res.body).toEqual({ ok: true, sessions_signed_out: true });
    expect(revoked.has(otherDevice)).toBe(true);
    expect(revoked.has(recoverySession)).toBe(true);
  });

  it('a refusal that is not "session gone" is not counted as signed out', async () => {
    shared.admin.signOut.mockResolvedValue({ data: null, error: { name: 'AuthApiError', status: 403, code: 'bad_jwt', message: 'nope' } });

    const res = await reset({ token, password });

    expect(res.body).toEqual({ ok: true, sessions_signed_out: false });
    expect(shared.admin.signOut).toHaveBeenCalledTimes(2);
  });

  it('signs out every session, including the one the token check opened', async () => {
    await reset({ token, password });

    expect(shared.admin.signOut).toHaveBeenCalledWith(recoverySession, 'global');
    expect(revoked.has(otherDevice)).toBe(true);
    expect(revoked.has(recoverySession)).toBe(true);
  });

  it('a device signed in before the reset is signed out at once, not after the identity cache expires', async () => {
    const before = await request(app).get('/api/auth/mfa/status').set({ Authorization: `Bearer ${otherDevice}` });
    expect(before.status).toBe(200);

    await reset({ token, password });

    const after = await request(app).get('/api/auth/mfa/status').set({ Authorization: `Bearer ${otherDevice}` });
    expect(after.status).toBe(401);
  });

  it('never signs anyone in: the answer carries no session', async () => {
    const res = await reset({ token, password });
    expect(JSON.stringify(res.body)).not.toContain(recoverySession);
    expect(res.body).not.toHaveProperty('access_token');
    expect(res.body).not.toHaveProperty('refresh_token');
  });

  it('records the reset in the audit log and sends the password-changed notice, with no token or password', async () => {
    await reset({ token, password });

    const audit = (prisma.auditLog.create as Mock).mock.calls.map((c) => c[0].data);
    const row = audit.find((d) => d.action === 'user.password_reset');
    expect(row).toMatchObject({ org_id: ME.organization_id, actor_id: ME.id, resource_type: 'User', resource_id: ME.id });
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(password);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ verb: 'security.password_changed', organizationId: ME.organization_id, object: { type: 'USER', id: ME.id } }),
    );
  });

  it.each([
    ['a used, expired or made-up token', () => ({ token: secret(), password })],
    ['no token', () => ({ password })],
    ['an empty token', () => ({ token: '', password })],
  ])('answers %s with the invalid-link message and changes nothing', async (_label, body) => {
    const res = await reset(body());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INVALID_LINK, code: 'invalid_reset_link' });
    expect(shared.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('treats a token check that throws as an invalid link', async () => {
    fresh.verifyOtp.mockRejectedValue(new Error('network down'));

    const res = await reset({ token, password });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INVALID_LINK, code: 'invalid_reset_link' });
  });

  it('refuses a password under 8 characters before it touches the token, so the link still works', async () => {
    const res = await reset({ token, password: secret().slice(0, 7) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be at least 8 characters.');
    expect(fresh.verifyOtp).not.toHaveBeenCalled();
  });

  it('refuses a missing or absurdly long password before it touches the token', async () => {
    for (const bad of [undefined, 12345678, 'x'.repeat(1001)]) {
      const res = await reset({ token, password: bad });
      expect(res.status).toBe(400);
    }
    expect(fresh.verifyOtp).not.toHaveBeenCalled();
  });

  it('a link for a user who has since been deactivated sets nothing and signs the token session out', async () => {
    (prisma.user.findUnique as Mock).mockResolvedValue({ ...ME, is_active: false, has_login: true, organization: null });

    const res = await reset({ token, password });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INVALID_LINK, code: 'invalid_reset_link' });
    expect(shared.admin.updateUserById).not.toHaveBeenCalled();
    expect(revoked.has(recoverySession)).toBe(true);
  });

  it('when nothing changed, the token session is signed out but the user stays signed in elsewhere', async () => {
    shared.admin.updateUserById.mockResolvedValue({ data: null, error: { status: 422, code: 'weak_password', message: 'weak' } });

    await reset({ token, password });

    expect(revoked.has(recoverySession)).toBe(true);
    expect(revoked.has(otherDevice)).toBe(false);
  });

  it('a breached password gets the ServWave wording, never the provider text, and the token session is signed out', async () => {
    shared.admin.updateUserById.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthWeakPasswordError', status: 422, code: 'weak_password', message: 'Password is known to be weak and easy to guess, please choose a different one.' },
    });

    const res = await reset({ token, password });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: BREACHED_PASSWORD_MESSAGE, code: 'weak_password' });
    expect(JSON.stringify(res.body)).not.toMatch(VENDOR_WORDS);
    expect(revoked.has(recoverySession)).toBe(true);
    expect(prisma.auditLog.create).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'user.password_reset' }) }));
  });

  it('any other provider failure gets the generic ServWave message', async () => {
    shared.admin.updateUserById.mockResolvedValue({ data: { user: null }, error: { status: 500, message: 'GoTrue exploded' } });

    const res = await reset({ token, password });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PASSWORD_UPDATE_FAILED_MESSAGE });
    expect(revoked.has(recoverySession)).toBe(true);
  });

  it('still reports success when signing the sessions out fails, and says the other devices were not signed out', async () => {
    shared.admin.signOut.mockRejectedValue(new Error('provider timeout'));

    const res = await reset({ token, password });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sessions_signed_out: false });
    expect(shared.admin.updateUserById).toHaveBeenCalled();
    const row = (prisma.auditLog.create as Mock).mock.calls.map((c) => c[0].data).find((d) => d.action === 'user.password_reset');
    expect(row.metadata).toEqual({ sessions_signed_out: false });
  });

  it('a sign-out the provider refuses counts as not signed out', async () => {
    shared.admin.signOut.mockResolvedValue({ data: null, error: { status: 500, message: 'nope' } });

    const res = await reset({ token, password });

    expect(res.body).toEqual({ ok: true, sessions_signed_out: false });
  });

  it('a token check that opens no session cannot sign anything out, and says so', async () => {
    fresh.verifyOtp.mockResolvedValue({
      data: { user: { id: ME.id, email: ME.email, email_confirmed_at: '2026-01-01T00:00:00Z' }, session: null },
      error: null,
    });

    const res = await reset({ token, password });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sessions_signed_out: false });
  });

  it('never writes the token or the password to a log line', async () => {
    await reset({ token, password });
    await reset({ token: secret(), password });
    shared.admin.updateUserById.mockResolvedValue({ data: null, error: { status: 422, code: 'weak_password', message: 'weak' } });
    await reset({ token, password });

    expect(logged()).not.toContain(token);
    expect(logged()).not.toContain(password);
  });
});

/**
 * Slice 05 (spec §5.2 "A rejected password must not burn the link"; conductor brief §3.3): verifyOtp
 * spends the token before the provider checks the new password, so a breached password gets a
 * replacement token in the same answer. Only a caller who just presented a valid token gets one.
 */
describe('POST /api/auth/password/reset - a breached password does not burn the link', () => {
  const breached = { name: 'AuthWeakPasswordError', status: 422, code: 'weak_password', message: 'Password is known to be weak and easy to guess, please choose a different one.' };
  /** The provider refuses the first password as breached and accepts the next one. */
  const refuseFirstPassword = (bad: string) =>
    shared.admin.updateUserById.mockImplementation(async (_id: string, attrs: { password: string }) =>
      attrs.password === bad ? { data: { user: null }, error: breached } : { data: { user: { id: ME.id } }, error: null },
    );

  it('answers 422 with the ServWave copy and a fresh token, which then sets the next password', async () => {
    refuseFirstPassword(password);
    const next = secret();

    const res = await reset({ token, password });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: 'weak_password', error: BREACHED_PASSWORD_MESSAGE, token: expect.any(String) });
    expect(res.body.token).not.toBe(token);
    expect(JSON.stringify(res.body)).not.toMatch(VENDOR_WORDS);

    const retry = await reset({ token: res.body.token, password: next });

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ok: true, sessions_signed_out: true });
    expect(shared.admin.updateUserById).toHaveBeenLastCalledWith(ME.id, { password: next });
  });

  it('mints the replacement for the same user with a sendless recovery link, and emails nothing', async () => {
    refuseFirstPassword(password);

    await reset({ token, password });

    expect(shared.admin.generateLink).toHaveBeenCalledTimes(1);
    expect(shared.admin.generateLink).toHaveBeenCalledWith({ type: 'recovery', email: ME.email });
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('the original token no longer works, and the replacement works only once', async () => {
    refuseFirstPassword(password);
    const res = await reset({ token, password });

    const again = await reset({ token, password: secret() });
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: INVALID_LINK, code: 'invalid_reset_link' });

    expect((await reset({ token: res.body.token, password: secret() })).status).toBe(200);
    const twice = await reset({ token: res.body.token, password: secret() });
    expect(twice.status).toBe(400);
    expect(twice.body).toEqual({ error: INVALID_LINK, code: 'invalid_reset_link' });
  });

  it('a breached retry can be refused again and still gets a working replacement', async () => {
    shared.admin.updateUserById.mockResolvedValue({ data: { user: null }, error: breached });
    const first = await reset({ token, password });
    const second = await reset({ token: first.body.token, password: secret() });

    expect(second.status).toBe(422);
    expect(second.body.token).toEqual(expect.any(String));
    expect(second.body.token).not.toBe(first.body.token);
  });

  it('signs the token session out and leaves the user signed in elsewhere', async () => {
    refuseFirstPassword(password);

    await reset({ token, password });

    expect(shared.admin.signOut).toHaveBeenCalledWith(recoverySession, 'local');
    expect(shared.admin.signOut).not.toHaveBeenCalledWith(expect.anything(), 'global');
    expect(revoked.has(recoverySession)).toBe(true);
    expect(revoked.has(otherDevice)).toBe(false);
  });

  it('any other provider failure gets no replacement token', async () => {
    shared.admin.updateUserById.mockResolvedValue({ data: { user: null }, error: { status: 500, code: 'unexpected_failure', message: 'boom' } });

    const res = await reset({ token, password });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PASSWORD_UPDATE_FAILED_MESSAGE });
    expect(shared.admin.generateLink).not.toHaveBeenCalled();
  });

  it('a password update that throws gets no replacement token', async () => {
    shared.admin.updateUserById.mockRejectedValue(new Error('socket hang up'));

    const res = await reset({ token, password });

    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty('token');
    expect(shared.admin.generateLink).not.toHaveBeenCalled();
  });

  it('a link that is not valid never gets a replacement', async () => {
    shared.admin.updateUserById.mockResolvedValue({ data: { user: null }, error: breached });

    const res = await reset({ token: secret(), password });

    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty('token');
    expect(shared.admin.generateLink).not.toHaveBeenCalled();
    expect(shared.admin.updateUserById).not.toHaveBeenCalled();
  });

  it.each([
    ['the provider refuses to mint one', () => shared.admin.generateLink.mockResolvedValue({ data: { user: null, properties: null }, error: { status: 500, message: 'boom' } })],
    ['minting throws', () => shared.admin.generateLink.mockRejectedValue(new Error('network down'))],
    ['the minted link has no token', () => shared.admin.generateLink.mockResolvedValue({ data: { user: { id: ME.id }, properties: {} }, error: null })],
    [
      'the minted token belongs to a different account',
      () => shared.admin.generateLink.mockResolvedValue({ data: { user: { id: `other-${secret()}` }, properties: { hashed_token: secret() } }, error: null }),
    ],
  ])('when %s, answers with the breached copy and no token', async (_label, arrange) => {
    arrange();
    refuseFirstPassword(password);

    const res = await reset({ token, password });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: 'weak_password', error: BREACHED_PASSWORD_MESSAGE });
    expect(revoked.has(recoverySession)).toBe(true);
  });

  it('the answer that carries a token is never cached', async () => {
    refuseFirstPassword(password);

    const res = await reset({ token, password });

    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('never writes the replacement token to a log line or an audit row', async () => {
    refuseFirstPassword(password);

    const res = await reset({ token, password });
    const retryPassword = secret();
    await reset({ token: res.body.token, password: retryPassword });

    for (const value of [token, password, res.body.token as string, retryPassword]) {
      expect(logged()).not.toContain(value);
      expect(JSON.stringify((prisma.auditLog.create as Mock).mock.calls)).not.toContain(value);
    }
  });
});

describe('POST /api/auth/password/reset - the token session never outlives the request', () => {
  it('is signed out even when something fails after the token check (review note O-a)', async () => {
    (prisma.user.findUnique as Mock).mockRejectedValue(new Error('database unavailable'));

    const res = await reset({ token, password });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: PASSWORD_UPDATE_FAILED_MESSAGE });
    expect(shared.admin.updateUserById).not.toHaveBeenCalled();
    expect(shared.admin.signOut).toHaveBeenCalledWith(recoverySession, 'local');
    expect(revoked.has(recoverySession)).toBe(true);
  });

  it('is signed out when the password update itself throws', async () => {
    shared.admin.updateUserById.mockRejectedValue(new Error('socket hang up'));

    await reset({ token, password });

    expect(revoked.has(recoverySession)).toBe(true);
    expect(revoked.has(otherDevice)).toBe(false);
  });

  it('is signed out once, not twice, after a successful reset', async () => {
    await reset({ token, password });

    expect(shared.admin.signOut).toHaveBeenCalledTimes(1);
    expect(shared.admin.signOut).toHaveBeenCalledWith(recoverySession, 'global');
  });
});
