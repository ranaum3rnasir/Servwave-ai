/* =============================================================================
   Security finding H2, build item 10 (ticket 22): Revoke really locks out.

   When an Admin revokes someone's sign-in, or deactivates them, that person gets in through no door: not their open session
   (refused on its next request), not a password, not Google, not the two-step code, not a session refresh, not an invite link
   or a password reset. The check lives once, in the sign-in layer. Revoke reports an error when the login can't be removed at
   the identity provider, finds the login however many accounts the provider holds, and a login made while the person was being
   revoked does not survive.

   Every way in is one row of ONE table below, run against every state: able to sign in, revoked, deactivated, and both reversed.
   Everything goes through the HTTP API on a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. The
   identity provider is stubbed at its edge (the suite-wide mock), and the stub says yes at every door, as a login that was not
   removed would: the refusal must come from ServWave's own check, never from the provider. The mailer is mocked at its edge so
   an invite link is read out of the email the person would get.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';

// The two-step code's parked sign-in is sealed with this key (lib/mfa-otp.ts reads it from the environment).
vi.hoisted(() => {
  process.env.MFA_TOKEN_ENC_KEY = 'test-mfa-enc-key-ticket-22';
});

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The mail edge: an invitation is captured, and the link in it is what the person would click.
const { sendUserInviteEmail } = vi.hoisted(() => ({ sendUserInviteEmail: vi.fn() }));
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserInviteEmail,
}));

import { supabaseAdmin } from '../lib/supabase';
import { switchFixture, type Person } from './permission-switches-fixture';
import { DELETE_LOGIN_FAILED_MESSAGE } from '../controllers/user.controller';
import { hashCode, encryptRefreshToken } from '../lib/mfa-otp';
import { INVITE_EXPIRED_BODY, retireInvite } from '../lib/invite-link';
import { SESSION_DOOR, SIGN_IN_DOORS } from './revoke-doors';

const suite = realClient ? describe : describe.skip;

type Mock = ReturnType<typeof vi.fn>;
const auth = supabaseAdmin.auth as unknown as {
  getUser: Mock; signInWithPassword: Mock; refreshSession: Mock; verifyOtp: Mock;
  admin: { createUser: Mock; deleteUser: Mock; listUsers: Mock; signOut: Mock; updateUserById: Mock };
};

/** No vendor name, and no session, in anything a refused person is answered. */
function expectRefused(res: request.Response, door: string) {
  expect([400, 401, 403], `${door}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
  const body = JSON.stringify(res.body);
  expect(body, `${door} answered a session`).not.toMatch(/access_token|refresh_token/);
  expect(body, `${door} names a vendor`).not.toMatch(/supabase|gotrue/i);
}

suite('H2 (ticket 22): a revoked or deactivated person gets in through no door (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const app = () => fx.listener();
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  beforeEach(() => {
    sendUserInviteEmail.mockReset().mockResolvedValue(true);
    auth.admin.createUser.mockReset().mockImplementation(async () => ({ data: { user: { id: randomUUID() } }, error: null }));
    auth.admin.deleteUser.mockReset().mockResolvedValue({ data: null, error: null });
    auth.admin.listUsers.mockReset().mockResolvedValue({ data: { users: [], nextPage: null }, error: null });
    auth.admin.signOut.mockReset().mockResolvedValue({ error: null });
    auth.admin.updateUserById.mockReset().mockResolvedValue({ data: {}, error: null });
    auth.signInWithPassword.mockReset();
    auth.refreshSession.mockReset();
    auth.verifyOtp.mockReset();
  });

  let sequence = 0;
  /** A company, an Admin on a custom role, and the custom role the people being revoked hold (no switch is about this). */
  async function world() {
    const { org } = await fx.newOrg();
    const adminRole = await fx.addCustomRole(org, `h2-admin-${++sequence}`, 'DISPATCHER');
    // Revoke, resend and deactivate are user management: the Admin flag's alone (AL-18).
    const admin = await fx.addUser(org, `h2admin${sequence}`, 'DISPATCHER', { customRoleId: adminRole.id, isAdmin: true });
    const staffRole = await fx.addCustomRole(org, `h2-staff-${sequence}`, 'SALES');
    const person = async () => {
      const p = await fx.addUser(org, `h2p${++sequence}`, 'SALES', { customRoleId: staffRole.id });
      // Signed up after the terms cutover, so the Google door asks for consent: this person gave it.
      await db.termsAcceptance.create({
        data: {
          user_id: p.id, user_email: p.email, organization_id: org, terms_version: 'test', terms_url: 'https://example.test/t',
          privacy_url: 'https://example.test/p', context: 'invite_acceptance',
        },
      });
      return p;
    };
    return { org, admin, person, asAdmin: () => fx.signedInAs(admin) };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** An id the provider gives an account: its own, never the person's (an invited person's two ids differ). */
  const ids = new Map<string, string>();
  const providerId = (kind: 'password' | 'google', p: Person) => {
    const k = `${kind}:${p.id}`;
    if (!ids.has(k)) ids.set(k, randomUUID());
    return ids.get(k)!;
  };
  /** The provider's account for a person: the same email, its own id. */
  const providerUser = (p: Person, id = providerId('password', p)) => ({ id, email: p.email, email_confirmed_at: new Date().toISOString() });
  const session = (tag: string) => ({ access_token: `at-${tag}`, refresh_token: `rt-${tag}`, expires_at: 9_999_999_999 });

  /** The link in the last invitation mailed to this address. */
  const mailedLink = (email: string) => {
    const sent = sendUserInviteEmail.mock.calls.map((c) => c[0] as { to: string; inviteUrl: string }).filter((m) => m.to === email);
    expect(sent.length, 'an invitation was mailed').toBeGreaterThan(0);
    return new URL(sent[sent.length - 1]!.inviteUrl).searchParams.get('token')!;
  };
  async function resendInvite(w: World, p: Person) {
    const res = await (await w.asAdmin()).post(`/api/users/${p.id}/invite`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return mailedLink(p.email);
  }

  // ─── The doors ────────────────────────────────────────────────────────────
  // Each prepares what it needs before the person's state is set (an invite link, a parked two-step code), then knocks.
  type Door = {
    name: string;
    /** The route, as revoke-doors.ts lists it: the source guard keeps that list complete. */
    route: string;
    prepare?: (w: World, p: Person) => Promise<string>;
    knock: (w: World, p: Person, prepared: string) => Promise<request.Response>;
    /** What a person who may sign in gets. */
    allowed: number;
  };
  const DOORS: Door[] = [
    {
      name: 'an already-open session (its next request)',
      route: SESSION_DOOR,
      knock: async (_w, p) => (await fx.signedInAs(p)).get('/api/auth/me'),
      allowed: 200,
    },
    {
      name: 'password sign-in',
      route: 'POST /login',
      knock: async (_w, p) => {
        auth.signInWithPassword.mockResolvedValue({ data: { user: providerUser(p), session: session(p.id) }, error: null });
        return request(await app()).post('/api/auth/login').send({ email: p.email, password: 'correct-horse-9' });
      },
      allowed: 200,
    },
    {
      name: 'the two-step code (a parked sign-in)',
      route: 'POST /mfa/verify',
      prepare: async (_w, p) => {
        const challenge = await db.mfaEmailChallenge.create({
          data: {
            user_id: p.id, code_hmac: hashCode('424242'), enc_refresh_token: encryptRefreshToken(`rt-${p.id}`),
            purpose: 'LOGIN', expires_at: new Date(Date.now() + 5 * 60_000),
          },
        });
        return challenge.id;
      },
      knock: async (_w, p, challengeId) => {
        auth.refreshSession.mockResolvedValue({ data: { user: providerUser(p), session: session(p.id) }, error: null });
        return request(await app()).post('/api/auth/mfa/verify').send({ challengeId, code: '424242' });
      },
      allowed: 200,
    },
    {
      name: 'a session refresh',
      route: 'POST /refresh',
      knock: async (_w, p) => {
        auth.refreshSession.mockResolvedValue({ data: { user: providerUser(p), session: session(p.id) }, error: null });
        return request(await app()).post('/api/auth/refresh').send({ refresh_token: `rt-${p.id}` });
      },
      allowed: 200,
    },
    {
      name: 'Google sign-in (finalize)',
      route: 'POST /google/finalize',
      knock: async (_w, p) => {
        // The provider vouches for the address under an account id of its own (a fresh Google sign-in makes one).
        auth.getUser.mockResolvedValue({ data: { user: providerUser(p, providerId('google', p)) }, error: null });
        return request(await app()).post('/api/auth/google/finalize').set('Authorization', `Bearer google-${p.id}`);
      },
      allowed: 200,
    },
    {
      name: 'opening an invite link',
      route: 'POST /invite',
      prepare: (w, p) => resendInvite(w, p),
      knock: async (_w, _p, token) => request(await app()).post('/api/auth/invite').send({ token }),
      allowed: 200,
    },
    {
      name: 'accepting an invite link (setting a password)',
      route: 'POST /accept-invite',
      prepare: (w, p) => resendInvite(w, p),
      knock: async (_w, _p, token) =>
        request(await app()).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret99', accepted_terms: true }),
      allowed: 200,
    },
    {
      name: 'consent on an invite link (before Google)',
      route: 'POST /accept-invite/terms',
      prepare: (w, p) => resendInvite(w, p),
      knock: async (_w, _p, token) => request(await app()).post('/api/auth/accept-invite/terms').send({ token, accepted_terms: true }),
      allowed: 200,
    },
    {
      name: 'completing a password reset',
      route: 'POST /password/reset',
      knock: async (_w, p) => {
        auth.verifyOtp.mockResolvedValue({ data: { user: providerUser(p), session: session(p.id) }, error: null });
        return request(await app()).post('/api/auth/password/reset').send({ token: `reset-${p.id}`, password: 'a-new-passw0rd' });
      },
      allowed: 200,
    },
  ];

  // ─── The states ───────────────────────────────────────────────────────────
  // Set on the row directly, so each row tests the flag alone; the journeys below go through the real Revoke and Deactivate.
  type State = { name: string; apply: (p: Person) => Promise<void>; mayEnter: boolean };
  const set = (p: Person, data: { has_login?: boolean; is_active?: boolean }) => db.user.update({ where: { id: p.id }, data });
  const STATES: State[] = [
    { name: 'may sign in', apply: async () => {}, mayEnter: true },
    { name: 'revoked', apply: async (p) => { await set(p, { has_login: false }); }, mayEnter: false },
    { name: 'deactivated', apply: async (p) => { await set(p, { is_active: false }); }, mayEnter: false },
    { name: 'revoked, then given sign-in back', apply: async (p) => { await set(p, { has_login: false }); await set(p, { has_login: true }); }, mayEnter: true },
    { name: 'deactivated, then reactivated', apply: async (p) => { await set(p, { is_active: false }); await set(p, { is_active: true }); }, mayEnter: true },
  ];

  it('every way in that revoke-doors.ts lists has a row in this table, and no row is unlisted', () => {
    expect(DOORS.map((d) => d.route).sort()).toEqual([SESSION_DOOR, ...SIGN_IN_DOORS].sort());
  });

  for (const door of DOORS) {
    for (const state of STATES) {
      it(`${door.name} | ${state.name} -> ${state.mayEnter ? 'let in' : 'refused'}`, async () => {
        const w = await world();
        const p = await w.person();
        const prepared = door.prepare ? await door.prepare(w, p) : '';
        await state.apply(p);
        const res = await door.knock(w, p, prepared);
        if (state.mayEnter) expect(res.status, JSON.stringify(res.body)).toBe(door.allowed);
        else expectRefused(res, door.name);
      });
    }
  }

  // ─── A sign-in finishes every live invite link ────────────────────────────
  // A link that answered "already set up" (the login exists) stays live for consent and Google. Once the person signs in, by any
  // door that signs them in, it is finished: a copy of the email shows nothing, accepts nothing and records nothing.
  const openLink = async (token: string) => request(await app()).post('/api/auth/invite').send({ token });
  const acceptLink = async (token: string) =>
    request(await app()).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret99', accepted_terms: true });
  const consentLink = async (token: string) =>
    request(await app()).post('/api/auth/accept-invite/terms').send({ token, accepted_terms: true, phone: '(555) 222-3333' });
  const SIGN_INS = ['password sign-in', 'the two-step code (a parked sign-in)', 'a session refresh', 'Google sign-in (finalize)'];
  for (const door of DOORS.filter((d) => SIGN_INS.includes(d.name))) {
    it(`${door.name} finishes a live invite link: after "already set up", the link answers expired everywhere`, async () => {
      const w = await world();
      const p = await w.person();
      const token = await resendInvite(w, p);
      auth.admin.createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', message: 'A user with this email already exists' } });
      expect((await acceptLink(token)).status, 'the account is already set up').toBe(409);
      expect((await openLink(token)).status, 'the link is still live for consent and Google').toBe(200);

      const prepared = door.prepare ? await door.prepare(w, p) : '';
      const signedIn = await door.knock(w, p, prepared);
      expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);

      for (const [what, res] of [['open', await openLink(token)], ['accept', await acceptLink(token)], ['consent', await consentLink(token)]] as const) {
        expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(400);
        expect(res.body, `${what} answers what any expired link answers`).toEqual(INVITE_EXPIRED_BODY);
      }
      // Nothing the link offered was written: the phone a copy of the email tried to set is not on the row.
      expect((await db.user.findUniqueOrThrow({ where: { id: p.id } })).phone).not.toBe('+15552223333');
    });
  }

  it('Google: a revoked person is refused and the account the sign-in made at the provider is removed', async () => {
    const w = await world();
    const p = await w.person();
    await set(p, { has_login: false });
    auth.getUser.mockResolvedValue({ data: { user: providerUser(p, providerId('google', p)) }, error: null });
    const res = await request(await app()).post('/api/auth/google/finalize').set('Authorization', `Bearer google-${p.id}`);
    expectRefused(res, 'Google');
    expect(auth.admin.deleteUser).toHaveBeenCalledWith(providerId('google', p));
  });

  // ─── The journey ──────────────────────────────────────────────────────────
  it('journey: an Admin revokes a signed-in person; every door refuses them; a resent invite gives them sign-in back', async () => {
    const w = await world();
    const p = await w.person();

    // The person is signed in and working.
    expect((await (await fx.signedInAs(p)).get('/api/auth/me')).status).toBe(200);

    // The Admin revokes. The provider holds the person's login under its own id, and removes it.
    auth.admin.listUsers.mockResolvedValue({ data: { users: [providerUser(p)], nextPage: null }, error: null });
    const revoked = await (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.user.has_login).toBe(false);
    expect(auth.admin.deleteUser).toHaveBeenCalledWith(providerId('password', p));

    // The open session is refused on its very next request.
    expectRefused(await (await fx.signedInAs(p)).get('/api/auth/me'), 'open session');
    expectRefused(await (await fx.signedInAs(p)).get('/api/users/me/password-status'), 'open session, another route');
    // A password that the provider still accepted is refused.
    auth.signInWithPassword.mockResolvedValue({ data: { user: providerUser(p), session: session('after') }, error: null });
    expectRefused(await request(await app()).post('/api/auth/login').send({ email: p.email, password: 'correct-horse-9' }), 'password');
    // So is Google.
    auth.getUser.mockResolvedValue({ data: { user: providerUser(p, providerId('google', p)) }, error: null });
    expectRefused(await request(await app()).post('/api/auth/google/finalize').set('Authorization', 'Bearer g'), 'Google');

    // The Admin gives sign-in back by resending the invite (story 8: the newest link works). The person sets a password.
    const token = await resendInvite(w, p);
    const accepted = await request(await app()).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret99', accepted_terms: true });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    auth.signInWithPassword.mockResolvedValue({ data: { user: providerUser(p), session: session('back') }, error: null });
    const back = await request(await app()).post('/api/auth/login').send({ email: p.email, password: 'sup3rsecret99' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await (await fx.signedInAs(p)).get('/api/auth/me')).status).toBe(200);
  });

  it('journey: an Admin deactivates a signed-in person; the open session and a password are refused', async () => {
    const w = await world();
    const p = await w.person();
    expect((await (await fx.signedInAs(p)).get('/api/auth/me')).status).toBe(200);

    auth.admin.listUsers.mockResolvedValue({ data: { users: [providerUser(p)], nextPage: null }, error: null });
    const off = await (await w.asAdmin()).delete(`/api/users/${p.id}`);
    expect(off.status, JSON.stringify(off.body)).toBe(200);

    expectRefused(await (await fx.signedInAs(p)).get('/api/auth/me'), 'open session');
    auth.signInWithPassword.mockResolvedValue({ data: { user: providerUser(p), session: session('after') }, error: null });
    expectRefused(await request(await app()).post('/api/auth/login').send({ email: p.email, password: 'correct-horse-9' }), 'password');
  });

  // ─── A failed removal is an error ─────────────────────────────────────────
  const FAILURES: { name: string; arrange: (p: Person) => void }[] = [
    {
      name: 'the provider refuses the account list',
      arrange: () => auth.admin.listUsers.mockResolvedValue({ data: { users: [] }, error: { message: 'boom', status: 500 } }),
    },
    { name: 'the account list call throws', arrange: () => auth.admin.listUsers.mockRejectedValue(new Error('network down')) },
    {
      name: 'the provider refuses the removal',
      arrange: (p) => {
        auth.admin.listUsers.mockResolvedValue({ data: { users: [providerUser(p)], nextPage: null }, error: null });
        auth.admin.deleteUser.mockResolvedValue({ data: null, error: { message: 'cannot delete', status: 500 } });
      },
    },
    {
      name: 'the removal call throws',
      arrange: (p) => {
        auth.admin.listUsers.mockResolvedValue({ data: { users: [providerUser(p)], nextPage: null }, error: null });
        auth.admin.deleteUser.mockRejectedValue(new Error('timeout'));
      },
    },
  ];
  for (const failure of FAILURES) {
    it(`Revoke answers an error, not success, when ${failure.name}; nothing changed, so the screen can say so`, async () => {
      const w = await world();
      const p = await w.person();
      failure.arrange(p);
      const res = await (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`);
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(500);
      expect(res.body.user, 'no user row in an error').toBeUndefined();
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error).toMatch(/could not/i);
      expect(JSON.stringify(res.body)).not.toMatch(/supabase|gotrue|boom|cannot delete|network|timeout/i);
      // The login could not be removed, so the person still has it and the Admin can try again.
      const row = await db.user.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.has_login).toBe(true);
    });
  }

  // ─── Two revokes at once ──────────────────────────────────────────────────
  // Two Admins (or one double-click) revoke the same person while the first provider call is still running. Whatever the provider
  // answers each of them, no Revoke may say "done" while the person can still sign in, and a "done" is said only once the
  // provider holds no login for them.
  const TWICE: { name: string; first: 'fails' | 'removes'; second: 'fails' | 'removes' }[] = [
    { name: 'the provider fails the first and removes on the second', first: 'fails', second: 'removes' },
    { name: 'the provider fails both', first: 'fails', second: 'fails' },
    { name: 'the provider removes on the first and fails the second', first: 'removes', second: 'fails' },
  ];
  for (const twice of TWICE) {
    it(`two revokes at once, ${twice.name}: no "done" while the person can still sign in`, async () => {
      const w = await world();
      const p = await w.person();
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let calls = 0;
      let removed = false;
      const answer = async (outcome: 'fails' | 'removes') => {
        if (outcome === 'fails') return { data: { users: [] }, error: { message: 'provider down', status: 503 } };
        return { data: { users: removed ? [] : [providerUser(p)], nextPage: null }, error: null };
      };
      auth.admin.listUsers.mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          await firstHeld; // the first revoke's provider call is slow
          return answer(twice.first);
        }
        return answer(twice.second);
      });
      auth.admin.deleteUser.mockImplementation(async () => { removed = true; return { data: null, error: null }; });

      const first = (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`).then((r) => r);
      // The second revoke starts once the first is inside its provider call.
      while (calls < 1) await new Promise((r) => setTimeout(r, 10));
      const second = await (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`);
      releaseFirst();
      const firstRes = await first;

      const end = await db.user.findUniqueOrThrow({ where: { id: p.id } });
      const answers = [firstRes, second];
      // The person can still sign in exactly when the row says so (every door checks it, and Google re-makes a login).
      const canSignIn = end.has_login && end.is_active;
      for (const res of answers) {
        if (res.status === 200) {
          expect(canSignIn, `a "done" while the person can still sign in: ${JSON.stringify(answers.map((a) => a.status))}`).toBe(false);
          expect(removed, 'a "done" with a login still at the provider').toBe(true);
        } else {
          expect(res.status, JSON.stringify(res.body)).toBe(502);
          expect(JSON.stringify(res.body)).not.toMatch(/supabase|gotrue|provider down/i);
        }
      }
      // Every error says something true: "they can still sign in" only while they can.
      for (const res of answers.filter((a) => a.status === 502)) {
        if (/still sign in/i.test(res.body.error)) expect(canSignIn, res.body.error).toBe(true);
      }
      // Whoever was told "try again" can: the row either holds the sign-in again (Revoke on screen) or says the revoke is
      // unfinished, unless another revoke finished it and said so.
      const listed = (await (await (await w.asAdmin()).get('/api/users')).body.users as Array<Record<string, unknown>>).find((u) => u.id === p.id)!;
      if (answers.some((a) => a.status === 502 && /try again/i.test(a.body.error)) && !answers.some((a) => a.status === 200)) {
        expect(listed.has_login === true || listed.revoke_pending === true, JSON.stringify(listed)).toBe(true);
      }
      if (canSignIn) {
        expect(answers.every((a) => a.status !== 200)).toBe(true);
      } else {
        // Locked out: an open session is refused.
        expectRefused(await (await fx.signedInAs(p)).get('/api/auth/me'), 'open session');
      }
    });
  }

  it('a revoke that could not finish can be tried again, and says "done" once the provider is clear', async () => {
    const w = await world();
    const p = await w.person();
    // The row was turned off, but the provider still holds the login (a revoke that did not finish).
    await set(p, { has_login: false });
    auth.admin.listUsers.mockResolvedValue({ data: { users: [], nextPage: null }, error: { message: 'down', status: 503 } });
    const failed = await (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`);
    expect(failed.status, 'an already-off row is no excuse to say done without asking the provider').toBe(502);
    expect(failed.body.error).toMatch(/try again/i);
    expect(auth.admin.deleteUser).not.toHaveBeenCalled();

    // "Try again" must be possible: the list says the revoke is unfinished (so the screen still offers Revoke), and never shows
    // the row's own mark.
    const listed = await (await w.asAdmin()).get('/api/users');
    expect(listed.status).toBe(200);
    const row = (listed.body.users as Array<Record<string, unknown>>).find((u) => u.id === p.id)!;
    expect(row).toMatchObject({ has_login: false, revoke_pending: true });
    expect(row).not.toHaveProperty('password_hash');
    expect(JSON.stringify(listed.body)).not.toMatch(/revoking:|invite:v1:|invite:used:/);

    auth.admin.listUsers.mockResolvedValue({ data: { users: [providerUser(p)], nextPage: null }, error: null });
    const done = await (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.user.has_login).toBe(false);
    expect(auth.admin.deleteUser).toHaveBeenCalledWith(providerId('password', p));
    // Finished: nothing left to retry.
    const after = (await (await (await w.asAdmin()).get('/api/users')).body.users as Array<Record<string, unknown>>).find((u) => u.id === p.id)!;
    expect(after).toMatchObject({ has_login: false, revoke_pending: false });
  });

  // ─── Reactivated people come back through a new invite (Ran, 2026-10-28) ──
  it('journey: a reactivated person is refused until they accept a fresh invite, then signs in', async () => {
    const w = await world();
    const p = await w.person();
    auth.admin.listUsers.mockResolvedValue({ data: { users: [providerUser(p)], nextPage: null }, error: null });
    expect((await (await w.asAdmin()).delete(`/api/users/${p.id}`)).status).toBe(200);
    const back = await (await w.asAdmin()).patch(`/api/users/${p.id}`, { is_active: true });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.user.has_login, 'reactivating does not give the login back').toBe(false);

    // Active again, but no login: every door still refuses them.
    expectRefused(await (await fx.signedInAs(p)).get('/api/auth/me'), 'open session');
    auth.signInWithPassword.mockResolvedValue({ data: { user: providerUser(p), session: session('react') }, error: null });
    expectRefused(await request(await app()).post('/api/auth/login').send({ email: p.email, password: 'correct-horse-9' }), 'password');
    auth.getUser.mockResolvedValue({ data: { user: providerUser(p, providerId('google', p)) }, error: null });
    expectRefused(await request(await app()).post('/api/auth/google/finalize').set('Authorization', 'Bearer g'), 'Google');

    // A fresh invite, accepted, gives them sign-in back.
    const token = await resendInvite(w, p);
    const accepted = await request(await app()).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret99', accepted_terms: true });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    auth.signInWithPassword.mockResolvedValue({ data: { user: providerUser(p), session: session('react2') }, error: null });
    const signedIn = await request(await app()).post('/api/auth/login').send({ email: p.email, password: 'sup3rsecret99' });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    expect((await (await fx.signedInAs(p)).get('/api/auth/me')).status).toBe(200);
  });

  // ─── Anything that can happen while a revoke waits on the provider ────────
  // ONE table. Revoke A holds its provider call open; in that gap something else happens; then A's provider call removes the
  // login or fails. The provider is modelled as it is: one login per person, found by email; a removal applies when it is made,
  // and its answer may arrive late (a stale "removed" after a newer login exists). In the gap the provider is down for everyone
  // else unless a row says otherwise, so a "done" can come only from a Revoke's own provider call.
  // For every row: no "done" while the provider holds a login for the person or they can sign in, every message is true, the
  // list's revoke_pending offers a retry whenever one is asked for or nothing said "done", and the person can sign in only when
  // Revoke's answer says they still can (put back, or an Admin gave sign-in back).
  type Provider = {
    login: string | null; // the provider's account for the person's email, if any
    /** A second revoke's provider call, held open until A has answered; its outcome is set by the row. */
    holdB?: { outcome: 'removes' | 'fails'; waiting: boolean; release: () => void; gate: Promise<void> };
  };
  type Gap = {
    name: string; gapProvider?: 'removes' | 'fails';
    prepare?: (w: World, p: Person) => Promise<string>;
    act: (w: World, p: Person, prepared: string, provider: Provider) => Promise<void | (() => Promise<void>)>;
  };
  const ok = (res: request.Response, what: string) => expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(200);
  /** An Admin re-invites the person and they sign in with Google: the provider now holds a NEW login for them. */
  const reinviteAndGoogle = async (w: World, p: Person, provider: Provider) => {
    ok(await (await w.asAdmin()).post(`/api/users/${p.id}/invite`), 're-invite');
    provider.login = providerId('google', p);
    auth.getUser.mockResolvedValue({ data: { user: providerUser(p, providerId('google', p)) }, error: null });
    ok(await request(await app()).post('/api/auth/google/finalize').set('Authorization', `Bearer google-${p.id}`), 'Google sign-in');
  };
  /** A second revoke that turns the row off and waits on the provider, answering only after A has. */
  const heldSecondRevoke = (outcome: 'removes' | 'fails') => async (w: World, p: Person, _prepared: string, provider: Provider) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    provider.holdB = { outcome, waiting: false, release, gate };
    const pendingB = (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`).then((r) => r);
    while (!provider.holdB.waiting) await new Promise((r) => setTimeout(r, 10));
    return async () => { release(); gapAnswers.push(await pendingB); };
  };
  const GAPS: Gap[] = [
    { name: 'a second revoke (its provider call removes the login)', gapProvider: 'removes', act: async (w, p) => { gapAnswers.push(await (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`)); } },
    ...DOORS.filter((d) => d.route !== SESSION_DOOR).map((d): Gap => ({
      name: `${d.name}, refused`,
      prepare: d.prepare,
      act: async (w, p, prepared) => expectRefused(await d.knock(w, p, prepared), d.name),
    })),
    { name: 'the open session, refused', act: async (_w, p) => expectRefused(await (await fx.signedInAs(p)).get('/api/auth/me'), 'session') },
    // A sign-in that passed its check just before the revoke began finishes in the gap: its invite clean-up lands now.
    { name: "a sign-in that began before the revoke finishes its clean-up", act: async (_w, p) => { await retireInvite(p.id); } },
    { name: 'deactivate', act: async (w, p) => ok(await (await w.asAdmin()).delete(`/api/users/${p.id}`), 'deactivate') },
    {
      name: 'deactivate, then reactivate',
      act: async (w, p) => {
        ok(await (await w.asAdmin()).delete(`/api/users/${p.id}`), 'deactivate');
        ok(await (await w.asAdmin()).patch(`/api/users/${p.id}`, { is_active: true }), 'reactivate');
      },
    },
    { name: 'a re-invite (the Admin gives sign-in back)', act: async (w, p) => ok(await (await w.asAdmin()).post(`/api/users/${p.id}/invite`), 're-invite') },
    // Pre-PR review CR-10: an erase that cannot remove the sign-in says so (502) and erases nothing, so the real address stays
    // for a retry. With the provider down in the gap that is its answer; with the provider up it erases.
    {
      name: 'deactivate, then erase (the provider is down, so the erase says it could not and erases nothing)',
      act: async (w, p) => {
        ok(await (await w.asAdmin()).delete(`/api/users/${p.id}`), 'deactivate');
        const erase = await (await w.asAdmin()).post(`/api/users/${p.id}/erase-personal-data`);
        expect(erase.status, `erase: ${JSON.stringify(erase.body)}`).toBe(502);
        expect(erase.body.error).toMatch(/nothing was erased/i);
        expect((await db.user.findUniqueOrThrow({ where: { id: p.id } })).erased_at).toBeNull();
      },
    },
    {
      name: 'deactivate, then erase (the provider answers)', gapProvider: 'removes',
      act: async (w, p) => {
        ok(await (await w.asAdmin()).delete(`/api/users/${p.id}`), 'deactivate');
        ok(await (await w.asAdmin()).post(`/api/users/${p.id}/erase-personal-data`), 'erase');
      },
    },
    {
      // The provider is down in the gap, so the delete can't remove the sign-in: it deletes nothing and says so (security review
      // SR-5), leaving the row and its address for the retry.
      name: 'deactivate, then permanent delete (its sign-in removal fails, so nothing is deleted)',
      act: async (w, p) => {
        ok(await (await w.asAdmin()).delete(`/api/users/${p.id}`), 'deactivate');
        const del = await (await w.asAdmin()).delete(`/api/users/${p.id}/permanent`);
        expect(del.status, JSON.stringify(del.body)).toBe(502);
        expect(del.body).toEqual({ error: DELETE_LOGIN_FAILED_MESSAGE });
        expect(await db.user.findUnique({ where: { id: p.id }, select: { email: true } })).toEqual({ email: p.email });
      },
    },
    // V1: a newer login, then a newer revoke, which answers only after A's (stale) answer has landed.
    ...(['removes', 'fails'] as const).map((b): Gap => ({
      name: `a re-invite, a Google sign-in (a new login), then a second revoke whose provider call ${b === 'removes' ? 'removes it' : 'fails'}, answering after A`,
      act: async (w, p, prepared, provider) => {
        await reinviteAndGoogle(w, p, provider);
        return heldSecondRevoke(b)(w, p, prepared, provider);
      },
    })),
  ];
  let gapAnswers: request.Response[] = [];

  for (const gap of GAPS) {
    for (const outcome of ['removes', 'fails'] as const) {
      it(`while a revoke waits: ${gap.name}; then A's provider call ${outcome === 'removes' ? 'removes the login' : 'fails'}`, async () => {
        const w = await world();
        const p = await w.person();
        gapAnswers = [];
        const prepared = gap.prepare ? await gap.prepare(w, p) : '';
        const provider: Provider = { login: providerId('password', p) };
        const down = { data: { users: [] }, error: { message: 'provider down', status: 503 } };
        const snapshot = () => ({ data: { users: provider.login ? [providerUser(p, provider.login)] : [], nextPage: null }, error: null });
        let releaseA!: () => void;
        const heldA = new Promise<void>((resolve) => { releaseA = resolve; });
        let aWaiting = false;
        let aDone = false;
        let listCalls = 0;
        auth.admin.listUsers.mockImplementation(async () => {
          listCalls += 1;
          if (listCalls === 1) {
            if (outcome === 'fails') { aWaiting = true; await heldA; return down; }
            return snapshot(); // A finds the login; its removal is held below
          }
          if (provider.holdB && !provider.holdB.waiting) {
            const b = provider.holdB;
            const seen = snapshot(); // the provider's answer as of B's call
            b.waiting = true;
            await b.gate;
            return b.outcome === 'fails' ? down : seen;
          }
          return (gap.gapProvider ?? 'fails') === 'fails' ? down : snapshot();
        });
        auth.admin.deleteUser.mockImplementation(async (id: string) => {
          if (id === provider.login) provider.login = null; // applies when made
          if (!aDone && outcome === 'removes' && id === providerId('password', p)) {
            aDone = true; aWaiting = true; await heldA; // A's answer arrives late
          }
          return { data: null, error: null };
        });

        const pendingA = (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`).then((r) => r);
        while (!aWaiting) await new Promise((r) => setTimeout(r, 10));
        const afterA = await gap.act(w, p, prepared, provider);
        releaseA();
        const a = await pendingA;
        if (typeof afterA === 'function') await afterA();

        const row = await db.user.findUnique({ where: { id: p.id } });
        const canSignIn = Boolean(row?.has_login && row.is_active);
        const listed = row
          ? ((await (await w.asAdmin()).get('/api/users')).body.users as Array<Record<string, unknown>>).find((u) => u.id === p.id)
          : undefined;
        const answers = [a, ...gapAnswers];
        const tell = () => JSON.stringify({ answers: answers.map((g) => [g.status, g.body.error]), row: row && { has_login: row.has_login, is_active: row.is_active, mark: row.password_hash }, listed: listed && { revoke_pending: listed.revoke_pending }, providerLogin: provider.login });

        // Every Revoke answer here is true.
        for (const res of answers) {
          const said = String(res.body.error ?? '');
          if (res.status === 200) {
            expect(provider.login, `"done" while the provider holds a login: ${tell()}`).toBeNull();
            expect(canSignIn, `"done" while the person can sign in: ${tell()}`).toBe(false);
            expect(row, `"done" for a person who is gone: ${tell()}`).not.toBeNull();
          } else if (res.status === 404) {
            expect(row, `"not found" for a person who is there: ${tell()}`).toBeNull();
          } else {
            expect(res.status, tell()).toBe(502);
            expect(said).not.toMatch(/supabase|gotrue|provider down/i);
            if (/still sign in/i.test(said)) expect(canSignIn, `"they can still sign in" when they can't: ${tell()}`).toBe(true);
            else if (/try again/i.test(said)) {
              // The retry it asks for is on screen (Revoke is offered for a login or an unfinished revoke), unless a later
              // Revoke finished the job and said so.
              const offered = Boolean(row && row.is_active && (row.has_login || listed?.revoke_pending === true));
              expect(offered || answers.some((r) => r.status === 200), `"try again" with nothing to retry on screen: ${tell()}`).toBe(true);
            } else {
              expect(said, tell()).toMatch(/could not finish/i);
              expect(row && !row.is_active, `"could not finish" (no retry) for an active person: ${tell()}`).toBe(true);
            }
          }
        }
        // Nothing unfinished is hidden: an active person with sign-in off and no "done" is offered a retry.
        if (row && row.is_active && !row.has_login && !answers.some((r) => r.status === 200)) {
          expect(listed?.revoke_pending, `unfinished but not offered again: ${tell()}`).toBe(true);
        }
        // The person can sign in only when Revoke said they still can.
        if (canSignIn) {
          expect(answers.some((r) => r.status === 502 && /still sign in/i.test(String(r.body.error))), `able to sign in, but Revoke did not say so: ${tell()}`).toBe(true);
          expect(answers.some((r) => r.status === 200), `"done" while they can sign in: ${tell()}`).toBe(false);
        } else {
          expectRefused(await (await fx.signedInAs(p)).get('/api/auth/me'), 'the session afterwards');
          auth.signInWithPassword.mockResolvedValue({ data: { user: providerUser(p), session: session('after') }, error: null });
          expectRefused(await request(await app()).post('/api/auth/login').send({ email: p.email, password: 'correct-horse-9' }), 'a password afterwards');
        }
      });
    }
  }

  it('the interleaving table has a row for every event, both ways', () => {
    expect(GAPS.length).toBe(19);
  });

  // ─── V3: a resend lands between Revoke's read of the row and its turn-off ──
  it('a resend landing just before the turn-off, then a failed provider call: the old link stays dead and the new one works', async () => {
    const w = await world();
    const p = await w.person();
    const oldToken = await resendInvite(w, p);
    auth.admin.listUsers.mockResolvedValue({ data: { users: [], nextPage: null }, error: { message: 'down', status: 503 } });
    // The moment Revoke writes the row off is the only place this race can land, so the resend is run right before that write.
    // Ticket 26: the turn-off runs inside a transaction (under the company lock), so the write is caught on that
    // transaction's client; the resend runs on its own connection, as a second Admin's click would.
    let newToken = '';
    const realTransaction = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: unknown, ...rest: unknown[]) => {
      if (typeof fn !== 'function') return realTransaction(fn, ...rest);
      return realTransaction(async (tx: PrismaClient) => {
        const user = new Proxy(tx.user, {
          get(target, key, receiver) {
            if (key !== 'updateMany') return Reflect.get(target, key, receiver);
            return async (args: { data?: { has_login?: boolean } }) => {
              if (!newToken && args?.data?.has_login === false) newToken = await resendInvite(w, p);
              return target.updateMany(args as never);
            };
          },
        });
        return (fn as (t: unknown) => unknown)(new Proxy(tx, { get: (t, k, r) => (k === 'user' ? user : Reflect.get(t, k, r)) }));
      }, ...rest);
    }) as never);
    try {
      const res = await (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`);
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.error).toMatch(/still sign in/i);
    } finally {
      spy.mockRestore();
    }
    expect(newToken, 'the resend ran inside the window').not.toBe('');
    const openOld = await request(await app()).post('/api/auth/invite').send({ token: oldToken });
    expect(openOld.status, 'the replaced link stays dead').toBe(400);
    expect(openOld.body).toEqual(INVITE_EXPIRED_BODY);
    expect((await request(await app()).post('/api/auth/invite').send({ token: newToken })).status, 'the newest link works').toBe(200);
  });

  // ─── V2: a session check that read the row before the revoke finishes after it ─
  for (const action of [
    { name: 'a revoke', run: async (w: World, p: Person) => (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`) },
    { name: 'a deactivation', run: async (w: World, p: Person) => (await w.asAdmin()).delete(`/api/users/${p.id}`) },
  ]) {
    it(`a session check in flight across ${action.name} does not keep the session: the next request is refused`, async () => {
      const w = await world();
      const p = await w.person();
      auth.admin.listUsers.mockResolvedValue({ data: { users: [providerUser(p)], nextPage: null }, error: null });
      // Hold the session check right after it read the person (still able to sign in), until the action has finished.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let readDone = false;
      const realFindUnique = db.user.findUnique.bind(db.user);
      const spy = vi.spyOn(db.user, 'findUnique').mockImplementation((async (args: { where?: { id?: string } }) => {
        const result = await realFindUnique(args as never);
        if (!readDone && args?.where?.id === p.id) {
          readDone = true;
          spy.mockImplementation(realFindUnique as never);
          await gate;
        }
        return result;
      }) as never);
      try {
        const inFlight = (await fx.signedInAs(p)).get('/api/auth/me').then((r) => r);
        while (!readDone) await new Promise((r) => setTimeout(r, 10));
        const done = await action.run(w, p);
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        release();
        await inFlight; // it began before the action: whatever it answers, it may not outlive it
      } finally {
        spy.mockRestore();
      }
      expectRefused(await (await fx.signedInAs(p)).get('/api/auth/me'), 'the next request');
      expectRefused(await (await fx.signedInAs(p)).get('/api/auth/me'), 'the one after');
    });
  }

  // ─── The lookup has no cap ────────────────────────────────────────────────
  it('Revoke finds and removes the right login past 10,000 accounts at the provider', async () => {
    const w = await world();
    const p = await w.person();
    const PER_PAGE = 200;
    const TOTAL = 12_000; // 60 pages
    const TARGET_INDEX = 10_950; // page 55: past the first 10,000 accounts
    auth.admin.listUsers.mockImplementation(async ({ page, perPage }: { page: number; perPage: number }) => {
      const size = perPage ?? PER_PAGE;
      const start = (page - 1) * size;
      const users = Array.from({ length: Math.max(0, Math.min(size, TOTAL - start)) }, (_, i) => {
        const n = start + i;
        return n === TARGET_INDEX ? providerUser(p, '7e57a11d-0000-4000-8000-000000010950') : { id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, email: `other-${n}@elsewhere.test` };
      });
      return { data: { users, nextPage: start + size < TOTAL ? page + 1 : null, lastPage: Math.ceil(TOTAL / size), total: TOTAL }, error: null };
    });
    const res = await (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(auth.admin.deleteUser).toHaveBeenCalledTimes(1);
    expect(auth.admin.deleteUser).toHaveBeenCalledWith('7e57a11d-0000-4000-8000-000000010950');
  });

  // ─── A login made while the person was being revoked does not survive ────
  const MEANWHILE: { name: string; act: (w: World, p: Person) => Promise<{ status: number }> }[] = [
    { name: 'revoked', act: async (w, p) => (await w.asAdmin()).post(`/api/users/${p.id}/revoke-login`) },
    { name: 'deactivated', act: async (w, p) => (await w.asAdmin()).delete(`/api/users/${p.id}`) },
  ];
  const MADE_MEANWHILE = 'a11ce000-0000-4000-8000-00000000beef';
  for (const meanwhile of MEANWHILE) {
    it(`accepting an invite while the person is ${meanwhile.name} during the provider call leaves no login and is refused`, async () => {
      const w = await world();
      const p = await w.person();
      const token = await resendInvite(w, p);
      let during = 0;
      auth.admin.createUser.mockImplementation(async () => {
        // The Admin acts while the provider is making the login, and the provider then says it made it.
        during = (await meanwhile.act(w, p)).status;
        return { data: { user: { id: MADE_MEANWHILE } }, error: null };
      });
      const res = await request(await app()).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret99', accepted_terms: true });
      expect(during, 'the Admin action itself succeeded').toBe(200);
      expectRefused(res, 'accept invite');
      // The login the provider made is removed again, and the person holds none.
      expect(auth.admin.deleteUser).toHaveBeenCalledWith(MADE_MEANWHILE);
      const row = await db.user.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.has_login).toBe(false);
    });
  }
});
