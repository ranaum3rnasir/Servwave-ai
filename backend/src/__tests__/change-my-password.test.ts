/**
 * POST /api/users/me/password - change your own password (password reset spec §4.2, slice 02;
 * decision §9.2: every OTHER session is signed out, THIS device stays signed in).
 *
 * Seams: the HTTP endpoint (status + body the browser sees) and the auth provider boundary: the
 * auth client (mocked in setup.ts) and the provider's user endpoint over HTTP (fetch, stubbed here).
 * Every password and token here is generated per run, never a literal.
 *
 * The provider is modelled as it behaves (seen on staging 2026-10-25 and in its source):
 * - the ADMIN password update ends EVERY session of the user, the caller's included;
 * - the user's OWN update (PUT /auth/v1/user with that session's JWT) ends every OTHER session and
 *   keeps the one that made the call;
 * - a sign-out with the JWT of a session that no longer exists fails with AuthSessionMissingError.
 * The earlier version of this suite let the admin update end nothing, which is how the staging
 * defect (#2866 live check: "couldn't sign out your other devices", and this device signed out too)
 * passed every test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { AuthSessionMissingError } from '@supabase/supabase-js';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin, supabaseAuth, createIsolatedAuthClient } from '../lib/supabase';
import { logger } from '../lib/logger';
import { emit } from '../services/notifications/notificationService';
import { clearTokenCache } from '../middleware/authenticate';
import { TEST_USERS, TEST_ORG, mockAuthAs } from './helpers';
import { BREACHED_PASSWORD_MESSAGE, PASSWORD_UPDATE_FAILED_MESSAGE } from '../lib/auth-provider-errors';

const auth = supabaseAdmin.auth as unknown as {
  getUser: Mock;
  signInWithPassword: Mock;
  admin: {
    listUsers: Mock;
    updateUserById: Mock;
    signOut: Mock;
  };
};
const mockAuditCreate = prisma.auditLog.create as Mock;

const ME = TEST_USERS.admin;
// An invited user: the auth provider's id is NOT the app user id (lib/auth-user.ts).
const AUTH_ID = 'a0000000-0000-4000-8000-00000000a0a0';
const USER_ENDPOINT = 'https://test.supabase.co/auth/v1/user';
const SAME_PASSWORD = "Choose a password you haven't used here.";
const secret = () => randomBytes(12).toString('base64url');

/** The bearer token this "device" sends, another device's, and the re-check's. Generated per run. */
let THIS_DEVICE: string;
let OTHER_DEVICE: string;
let RECHECK: string;
/** Sessions the provider still has. */
let live: Set<string>;
/** What the provider's user endpoint answers next, when a test wants a refusal. */
let userEndpointReply: { status: number; body: Record<string, unknown> } | null;
/** Every call that reached the provider's user endpoint. */
let userEndpointCalls: Array<{ method: string; authorization: string | null; body: Record<string, unknown> }>;

const fetchBefore = globalThis.fetch;

/** The provider's PUT /auth/v1/user, as it behaves. */
async function fakeUserEndpoint(init: RequestInit | undefined): Promise<Response> {
  const authorization = new Headers(init?.headers).get('authorization');
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  userEndpointCalls.push({ method: init?.method ?? 'GET', authorization, body });
  const jwt = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!live.has(jwt)) {
    return Response.json({ code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' }, { status: 403 });
  }
  if (userEndpointReply) return Response.json(userEndpointReply.body, { status: userEndpointReply.status });
  // Every other session ends; the one that made the call stays.
  for (const t of [...live]) if (t !== jwt) live.delete(t);
  return Response.json({ id: AUTH_ID, email: ME.email }, { status: 200 });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  THIS_DEVICE = `tok-${secret()}`;
  OTHER_DEVICE = `tok-${secret()}`;
  RECHECK = `tok-${secret()}`;
  live = new Set([THIS_DEVICE, OTHER_DEVICE]);
  userEndpointReply = null;
  userEndpointCalls = [];
  mockAuthAs('admin');
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url === USER_ENDPOINT ? fakeUserEndpoint(init) : fetchBefore(input, init);
  }) as typeof fetch;
  // The provider verifies any session it still has, and reports the auth id (not the app id).
  auth.getUser.mockImplementation(async (token: string) =>
    live.has(token)
      ? { data: { user: { id: AUTH_ID, email: ME.email, email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null }
      : { data: { user: null }, error: new AuthSessionMissingError() },
  );
  // resolveAppUser falls back from the auth id to the confirmed email - the invited-user path.
  (prisma.user.findUnique as Mock).mockImplementation(
    (args: { where: { id: string } }) =>
      Promise.resolve(args.where.id === ME.id ? { ...ME, has_login: true, organization: TEST_ORG } : null),
  );
  (prisma.user.findFirst as Mock).mockResolvedValue({ ...ME, has_login: true, organization: TEST_ORG });
  // The current-password re-check signs in, which opens one more session.
  auth.signInWithPassword.mockImplementation(async () => {
    live.add(RECHECK);
    return { data: { user: { id: AUTH_ID }, session: { access_token: RECHECK } }, error: null };
  });
  // The admin update ends EVERY session of the user, the caller's included.
  auth.admin.updateUserById.mockImplementation(async () => {
    live.clear();
    return { data: { user: { id: AUTH_ID } }, error: null };
  });
  auth.admin.signOut.mockImplementation(async (jwt: string, scope: string) => {
    if (!live.has(jwt)) return { data: null, error: new AuthSessionMissingError() };
    if (scope === 'others') for (const t of [...live]) if (t !== jwt) live.delete(t);
    if (scope === 'global') live.clear();
    if (scope === 'local') live.delete(jwt);
    return { data: null, error: null };
  });
});

afterEach(() => {
  globalThis.fetch = fetchBefore;
});

function change(body: Record<string, unknown>, token = THIS_DEVICE) {
  return request(app).post('/api/users/me/password').set({ Authorization: `Bearer ${token}` }).send(body);
}

const me = (token: string) => request(app).get('/api/auth/me').set({ Authorization: `Bearer ${token}` });

const auditRow = () => mockAuditCreate.mock.calls.map((c) => c[0].data).find((d) => d.action === 'user.password_changed');

/** Every string a response could carry, for the copy checks. */
const VENDOR_WORDS = /supabase|gotrue|resend|render|vercel|pwned|known to be weak/i;

describe('POST /api/users/me/password', () => {
  it('a wrong current password is a 400 "Current password is incorrect." and nothing changes', async () => {
    auth.signInWithPassword.mockResolvedValue({ data: {}, error: { message: 'Invalid login credentials', status: 400 } });

    const res = await change({ current_password: secret(), password: secret() });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Current password is incorrect.', code: 'current_password_incorrect' });
    expect(userEndpointCalls).toHaveLength(0);
    expect(auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(auth.admin.signOut).not.toHaveBeenCalled();
  });

  it('a new password equal to the current one is a 400 and the provider is never asked', async () => {
    const same = secret();

    const res = await change({ current_password: same, password: same });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'password', message: SAME_PASSWORD }]);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(userEndpointCalls).toHaveLength(0);
  });

  it('a user without a login holds no session: refused before the handler, and the provider is never asked', async () => {
    (prisma.user.findUnique as Mock).mockResolvedValue({ ...ME, has_login: false, organization: TEST_ORG });

    const res = await change({ current_password: secret(), password: secret() });

    // H2 (ticket 22): the sign-in check refuses a person whose login is off on every request, before any route.
    expect(res.status).toBe(401);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(userEndpointCalls).toHaveLength(0);
  });

  it('a missing current password is a 400 and nothing changes (review #4)', async () => {
    const res = await change({ password: secret() });

    expect(res.status).toBe(400);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(userEndpointCalls).toHaveLength(0);
  });

  it('a new password under 8 characters is a 400', async () => {
    const res = await change({ current_password: secret(), password: secret().slice(0, 7) });

    expect(res.status).toBe(400);
    expect(userEndpointCalls).toHaveLength(0);
  });

  it("sets the password through this device's own session, never the admin update and never an email search", async () => {
    const current = secret();
    const next = secret();

    const res = await change({ current_password: current, password: next });

    expect(res.status).toBe(200);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: ME.email, password: current });
    expect(userEndpointCalls).toEqual([
      { method: 'PUT', authorization: `Bearer ${THIS_DEVICE}`, body: { password: next, current_password: current } },
    ]);
    expect(auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(auth.admin.listUsers).not.toHaveBeenCalled();
  });

  it('re-checks the current password on a fresh client for every request, never the shared one', async () => {
    const shared = supabaseAuth.auth.signInWithPassword as Mock;
    const factory = createIsolatedAuthClient as unknown as Mock;
    const seen: unknown[] = [];
    factory.mockImplementation(() => {
      const client = { auth: { signInWithPassword: vi.fn().mockResolvedValue({ data: {}, error: null }) } };
      seen.push(client);
      return client;
    });
    shared.mockClear();

    await change({ current_password: secret(), password: secret() });
    clearTokenCache();
    await change({ current_password: secret(), password: secret() });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(shared).not.toHaveBeenCalled();
  });

  // The #2866 staging defect: the admin update ended every session, so the sign-out of "the others"
  // found this device's session gone, the answer said the others were still signed in, and this
  // device was bounced to sign-in on its next page.
  it('signs out every other session, keeps this one, and says so truthfully (decision §9.2)', async () => {
    // The other device has a live, cached identity before the change.
    expect((await me(OTHER_DEVICE)).status).toBe(200);

    const res = await change({ current_password: secret(), password: secret() });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password updated', other_sessions_signed_out: true, this_device_signed_out: false });
    // The 60 s identity cache was cleared, so the revoked session is not served from it.
    expect((await me(OTHER_DEVICE)).status).toBe(401);
    expect((await me(THIS_DEVICE)).status).toBe(200);
    // The re-check's own session is gone too, and only this device's session is left.
    expect([...live]).toEqual([THIS_DEVICE]);
  });

  it('records user.password_changed and the security notification, with no password or token in either', async () => {
    const current = secret();
    const next = secret();

    await change({ current_password: current, password: next });

    const audits = mockAuditCreate.mock.calls.map((c) => c[0].data).filter((d) => d.action === 'user.password_changed');
    expect(audits).toHaveLength(1);
    expect(audits[0].resource_id).toBe(ME.id);
    expect(audits[0].metadata).toEqual({ other_sessions_signed_out: true, this_device_signed_out: false });
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    expect((emit as Mock).mock.calls[0][0].verb).toBe('security.password_changed');

    const recorded = JSON.stringify([
      audits,
      (emit as Mock).mock.calls,
      (logger.info as Mock).mock.calls,
      (logger.warn as Mock).mock.calls,
      (logger.error as Mock).mock.calls,
    ]);
    for (const s of [current, next, THIS_DEVICE, RECHECK]) expect(recorded).not.toContain(s);
  });

  it('if the other sessions cannot be confirmed signed out, the change still succeeds but says so, and the audit records it', async () => {
    auth.admin.signOut.mockResolvedValue({ data: null, error: Object.assign(new Error('upstream timeout'), { status: 504 }) });

    const res = await change({ current_password: secret(), password: secret() });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password updated', other_sessions_signed_out: false, this_device_signed_out: false });
    expect(auth.admin.signOut).toHaveBeenCalledTimes(2);
    expect(auditRow().metadata).toEqual({ other_sessions_signed_out: false, this_device_signed_out: false });
    // Only the error's name and status are logged, never the provider's message (security review).
    const errorLogs = (logger.error as Mock).mock.calls;
    expect(errorLogs).toHaveLength(2);
    for (const [, meta] of errorLogs) {
      expect(meta).toEqual({ userId: ME.id, attempt: expect.any(Number), name: 'Error', status: 504 });
    }
    expect(JSON.stringify(errorLogs)).not.toContain('upstream timeout');
  });

  it('if the sign-out call THROWS, the change still returns 200 with other_sessions_signed_out:false (review O1)', async () => {
    const thrown = Object.assign(new TypeError(`fetch failed for ${THIS_DEVICE}`), { status: 503 });
    auth.admin.signOut.mockRejectedValue(thrown);

    const res = await change({ current_password: secret(), password: secret() });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password updated', other_sessions_signed_out: false, this_device_signed_out: false });
    expect(auth.admin.signOut).toHaveBeenCalledTimes(2);
    expect(auditRow().metadata).toEqual({ other_sessions_signed_out: false, this_device_signed_out: false });
    // The raw error (which may quote the token back) is never logged; only its name and status.
    const errorLogs = (logger.error as Mock).mock.calls;
    expect(errorLogs).toHaveLength(2);
    for (const [, meta] of errorLogs) {
      expect(meta).toEqual({ userId: ME.id, attempt: expect.any(Number), name: 'TypeError', status: 503 });
    }
  });

  it('GET /api/auth/me never hands the auth id to the browser', async () => {
    const res = await me(THIS_DEVICE);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(ME.id);
    expect(res.body.user).not.toHaveProperty('auth_id');
    expect(JSON.stringify(res.body)).not.toContain(AUTH_ID);
  });

  it('a breached new password is a 422 weak_password in ServWave wording, and nobody is signed out', async () => {
    userEndpointReply = {
      status: 422,
      body: { code: 'weak_password', msg: 'Password is known to be weak and easy to guess, please choose a different one.', weak_password: { reasons: ['pwned'] } },
    };

    const res = await change({ current_password: secret(), password: secret() });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: BREACHED_PASSWORD_MESSAGE, code: 'weak_password' });
    expect(auth.admin.signOut).not.toHaveBeenCalled();
    expect(auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(live.has(OTHER_DEVICE)).toBe(true);
    expect(live.has(THIS_DEVICE)).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("the provider's same-password refusal is the ServWave same-password message", async () => {
    userEndpointReply = { status: 422, body: { code: 'same_password', msg: 'New password should be different from the old password.' } };

    const res = await change({ current_password: secret(), password: secret() });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: SAME_PASSWORD, code: 'same_password' });
    expect(auth.admin.signOut).not.toHaveBeenCalled();
  });

  it('any other provider error is a generic 400, with the detail logged server-side only', async () => {
    const providerMessage = `Database error updating user ${secret()}`;
    userEndpointReply = { status: 500, body: { code: 'unexpected_failure', msg: providerMessage } };

    const res = await change({ current_password: secret(), password: secret() });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PASSWORD_UPDATE_FAILED_MESSAGE });
    expect(JSON.stringify(res.body)).not.toContain(providerMessage);
    expect(auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(live.has(OTHER_DEVICE)).toBe(true);
  });

  it('a network failure reaching the provider is a generic 400 and nobody is signed out', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError(`fetch failed ${THIS_DEVICE}`);
    }) as typeof fetch;

    const res = await change({ current_password: secret(), password: secret() });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PASSWORD_UPDATE_FAILED_MESSAGE });
    expect(auth.admin.signOut).not.toHaveBeenCalled();
    expect(JSON.stringify((logger.warn as Mock).mock.calls)).not.toContain(THIS_DEVICE);
  });

  // When the provider wants a fresher sign-in before this session may change the password (its
  // "secure password change" setting, or a second factor it holds), the admin update is the only
  // way left. It ends EVERY session, this one included, so the answer must say so: the page then
  // sends the user to sign in with the new password instead of pretending they are still signed in.
  it.each(['reauthentication_needed', 'insufficient_aal'])(
    'if the provider refuses the own-session update with %s, the admin update sets it and the answer says this device was signed out too',
    async (code) => {
      userEndpointReply = { status: code === 'insufficient_aal' ? 401 : 400, body: { code, msg: 'Password update requires reauthentication' } };
      const next = secret();

      const res = await change({ current_password: secret(), password: next });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Password updated', other_sessions_signed_out: true, this_device_signed_out: true });
      expect(auth.admin.updateUserById).toHaveBeenCalledWith(AUTH_ID, { password: next });
      expect(auditRow().metadata).toEqual({ other_sessions_signed_out: true, this_device_signed_out: true });
      expect((await me(OTHER_DEVICE)).status).toBe(401);
      expect((await me(THIS_DEVICE)).status).toBe(401);
    },
  );

  it('the admin fallback still maps a breached password to the ServWave copy', async () => {
    userEndpointReply = { status: 400, body: { code: 'reauthentication_needed', msg: 'Password update requires reauthentication' } };
    auth.admin.updateUserById.mockResolvedValue({
      data: { user: null },
      error: Object.assign(new Error('Password is known to be weak and easy to guess, please choose a different one.'), {
        name: 'AuthWeakPasswordError', status: 422, code: 'weak_password', reasons: ['pwned'],
      }),
    });

    const res = await change({ current_password: secret(), password: secret() });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: BREACHED_PASSWORD_MESSAGE, code: 'weak_password' });
    expect(auth.admin.signOut).not.toHaveBeenCalled();
  });

  it('no provider message or vendor name ever reaches a response', async () => {
    const providerMessage = `GoTrue says no ${secret()}`;
    const bodies: string[] = [];
    const cases: Array<() => void> = [
      () => auth.signInWithPassword.mockResolvedValue({ data: {}, error: { message: providerMessage, status: 400 } }),
      () => { userEndpointReply = { status: 422, body: { code: 'weak_password', msg: providerMessage } }; },
      () => { userEndpointReply = { status: 422, body: { code: 'same_password', msg: providerMessage } }; },
      () => { userEndpointReply = { status: 500, body: { msg: providerMessage } }; },
      () => {
        userEndpointReply = { status: 400, body: { code: 'reauthentication_needed', msg: providerMessage } };
        auth.admin.updateUserById.mockRejectedValue(new Error(providerMessage));
      },
      () => auth.admin.signOut.mockResolvedValue({ data: null, error: Object.assign(new Error(providerMessage), { status: 500 }) }),
    ];
    for (const arrange of cases) {
      clearTokenCache();
      live = new Set([THIS_DEVICE, OTHER_DEVICE]);
      userEndpointReply = null;
      arrange();
      const res = await change({ current_password: secret(), password: secret() });
      bodies.push(JSON.stringify(res.body));
      auth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
    }

    for (const body of bodies) {
      expect(body).not.toContain(providerMessage);
      expect(body).not.toMatch(VENDOR_WORDS);
    }
  });
});
