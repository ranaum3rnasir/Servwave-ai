/* =============================================================================
   Security finding H2 (ticket 23): an invite link opens the account exactly once. Each person has at most one live invite:
   a resend or a revoke cancels the earlier link, and an old, used or forwarded link answers "expired".

   Everything goes through the HTTP API on a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   The person who invites is on a custom role holding exactly the switches that invite, resend and revoke need. The identity
   provider is stubbed at its edge (the suite-wide mock): what it is asked to create is what acceptance sends it.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The mail edge: the invitation is captured, and the link in it is what the person would click. (The API's own answer is not
// read for the link: whether it carries one is another ticket's rule.)
const { sendUserInviteEmail } = vi.hoisted(() => ({ sendUserInviteEmail: vi.fn() }));
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserInviteEmail,
}));

import { supabaseAdmin } from '../lib/supabase';
import { switchFixture } from './permission-switches-fixture';
import { signInviteToken } from '../lib/invite-token';

const suite = realClient ? describe : describe.skip;

suite('H2: invite links are single-use (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const app = async () => (await import('../app.js')).default as never;
  beforeAll(async () => {
    // Inviting creates the person's mailbox, which needs the company's mailbox domain.
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: 'staging.mail.test.com' });
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  const createUser = supabaseAdmin.auth.admin.createUser as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sendUserInviteEmail.mockReset();
    sendUserInviteEmail.mockResolvedValue(true);
    createUser.mockReset();
    createUser.mockResolvedValue({ data: { user: { id: randomUUID() } }, error: null });
    // Revoking removes the login at the provider: it is asked to find the account and finds none.
    (supabaseAdmin.auth.admin.listUsers as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { users: [] }, error: null });
  });

  /** An org whose inviter is an Admin (inviting, resending and revoking are the Admin flag's alone, AL-18), on a custom role. */
  async function world() {
    const { org, admin } = await fx.newOrg();
    const key = `h2-inviter-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    const inviter = await fx.addUser(org, `h2i${sequence}`, 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: key, isAdmin: true });
    return { org, admin, inviter, api: () => fx.signedInAs(inviter) };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const tokenIn = (inviteUrl: string) => new URL(inviteUrl).searchParams.get('token')!;
  /** The link in the last invitation mailed to this address. */
  const mailedLink = (email: string) => {
    const sent = sendUserInviteEmail.mock.calls.map((c) => c[0] as { to: string; inviteUrl: string }).filter((m) => m.to === email);
    expect(sent.length, 'an invitation was mailed').toBeGreaterThan(0);
    return new URL(sent[sent.length - 1]!.inviteUrl).searchParams.get('token')!;
  };

  async function invite(w: World) {
    const email = `hire-${randomUUID().slice(0, 8)}@example.test`;
    const res = await (await w.api()).post('/api/users/invite', { email, first_name: 'Hire', last_name: 'Person', role: 'TECHNICIAN' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.user.id as string, email, token: mailedLink(email) };
  }
  async function resend(w: World, id: string) {
    const res = await (await w.api()).post(`/api/users/${id}/invite`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return mailedLink(res.body.user.email);
  }
  async function revoke(w: World, id: string) {
    const res = await (await w.api()).post(`/api/users/${id}/revoke-login`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  const accept = async (token: string) =>
    request(await app()).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret99', accepted_terms: true });
  const look = async (token: string) => request(await app()).post('/api/auth/invite').send({ token });
  const consent = async (token: string) =>
    request(await app()).post('/api/auth/accept-invite/terms').send({ token, accepted_terms: true });

  /** Sign in with Google as this email: the provider vouches for the address, and ServWave finalizes the sign-in. */
  const googleSignIn = async (email: string) => {
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: randomUUID(), email, email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'google' } } },
      error: null,
    });
    return request(await app()).post('/api/auth/google/finalize').set('Authorization', 'Bearer google-token');
  };

  /** The one answer every dead link gets: a refusal that says "expired". */
  function expectExpired(res: request.Response) {
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
    expect(res.body.code).toBe('invite_expired');
    // Nothing about the person or the company in a refusal.
    expect(JSON.stringify(res.body)).not.toMatch(/@example\.test/);
  }

  it('a fresh link shows who it is for and opens the account', async () => {
    const w = await world();
    const hire = await invite(w);
    const seen = await look(hire.token);
    expect(seen.status).toBe(200);
    expect(seen.body.email).toBe(hire.email);
    // Looking at the page does not use the link up.
    expect((await look(hire.token)).status).toBe(200);
    const res = await accept(hire.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it('a link used once answers "expired" the second time, and creates no second login', async () => {
    const w = await world();
    const hire = await invite(w);
    expect((await accept(hire.token)).status).toBe(200);
    expectExpired(await accept(hire.token));
    expectExpired(await look(hire.token));
    expectExpired(await consent(hire.token));
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it('two people opening the same link at the same moment: exactly one gets in', async () => {
    const w = await world();
    const hire = await invite(w);
    const answers = await Promise.all([accept(hire.token), accept(hire.token), accept(hire.token)]);
    const opened = answers.filter((a) => a.status === 200);
    expect(opened).toHaveLength(1);
    answers.filter((a) => a.status !== 200).forEach(expectExpired);
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it('a link the provider could not finish stays usable so the person can try again', async () => {
    const w = await world();
    const hire = await invite(w);
    createUser.mockResolvedValueOnce({ data: { user: null }, error: { code: 'unexpected_failure', message: 'try later' } });
    expect((await accept(hire.token)).status).toBe(400);
    expect((await accept(hire.token)).status).toBe(200);
  });

  it('after Resend, the earlier link answers "expired" and the new one works', async () => {
    const w = await world();
    const hire = await invite(w);
    const second = await resend(w, hire.id);
    expect(second).not.toBe(hire.token);
    expectExpired(await look(hire.token));
    expectExpired(await consent(hire.token));
    expectExpired(await accept(hire.token));
    expect(createUser).not.toHaveBeenCalled();
    expect((await look(second)).status).toBe(200);
    expect((await accept(second)).status).toBe(200);
  });

  it('each Resend cancels the one before: only the last link is live', async () => {
    const w = await world();
    const hire = await invite(w);
    const second = await resend(w, hire.id);
    const third = await resend(w, hire.id);
    expectExpired(await accept(hire.token));
    expectExpired(await accept(second));
    expect((await accept(third)).status).toBe(200);
  });

  it('after Revoke, every invite link for that person answers "expired"', async () => {
    const w = await world();
    const hire = await invite(w);
    const second = await resend(w, hire.id);
    await revoke(w, hire.id);
    for (const token of [hire.token, second]) {
      expectExpired(await look(token));
      expectExpired(await consent(token));
      expectExpired(await accept(token));
    }
    expect(createUser).not.toHaveBeenCalled();
  });

  it('a person revoked and invited again gets a working new link; the links from before stay expired', async () => {
    const w = await world();
    const hire = await invite(w);
    await revoke(w, hire.id);
    const fresh = await resend(w, hire.id);
    expectExpired(await accept(hire.token));
    expect((await accept(fresh)).status).toBe(200);
  });

  it('a deactivated person\'s link answers "expired" too', async () => {
    const w = await world();
    const hire = await invite(w);
    await db.user.update({ where: { id: hire.id }, data: { is_active: false } });
    expectExpired(await accept(hire.token));
  });

  it('a correctly signed link that no invite ever issued answers "expired"', async () => {
    const w = await world();
    const hire = await invite(w);
    expectExpired(await accept(signInviteToken(hire.id, hire.email)));
    expectExpired(await look(signInviteToken(hire.id, hire.email)));
    // The real link was not disturbed.
    expect((await accept(hire.token)).status).toBe(200);
  });

  it('a person who signs in with Google has opened the account: the link answers "expired" afterwards', async () => {
    const w = await world();
    const hire = await invite(w);
    expect((await consent(hire.token)).status).toBe(200);
    // Consent alone does not use the link up; the sign-in does.
    expect((await look(hire.token)).status).toBe(200);
    const done = await googleSignIn(hire.email);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expectExpired(await look(hire.token));
    expectExpired(await accept(hire.token));
  });

  it('a validly signed link for one person carrying the id issued to another answers "expired"', async () => {
    const w = await world();
    const a = await invite(w);
    const b = await invite(w);
    // B's invite id, read from B's real link; A's identity, signed with the real signer.
    const jtiOfB = JSON.parse(Buffer.from(b.token.split('.')[0]!, 'base64url').toString('utf8')).jti as string;
    expect(jtiOfB).toBeTruthy();
    const forged = signInviteToken(a.id, a.email, undefined, jtiOfB);
    expectExpired(await look(forged));
    expectExpired(await accept(forged));
    expect(createUser).not.toHaveBeenCalled();
    // Neither person's real link was disturbed.
    expect((await accept(a.token)).status).toBe(200);
    expect((await accept(b.token)).status).toBe(200);
  });

  /** A provider call the test settles by hand, so a link can be mid-use while other things happen. */
  function pending() {
    let fail!: () => void;
    const promise = new Promise((resolve) => {
      fail = () => resolve({ data: { user: null }, error: { code: 'unexpected_failure', message: 'try later' } });
    });
    return { promise, fail };
  }
  const providerCalls = (n: number) => vi.waitFor(() => expect(createUser.mock.calls.length).toBe(n), { timeout: 30_000 });

  it('a failed use restores only that link: a replaced link stays expired when its provider call fails late', async () => {
    const w = await world();
    const hire = await invite(w);
    const first = pending();
    const second = pending();
    createUser.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const use1 = accept(hire.token);
    await providerCalls(1);
    const link2 = await resend(w, hire.id);
    const use2 = accept(link2);
    await providerCalls(2);

    // The first link's provider call fails while the second link is mid-use: the first link must not come back.
    first.fail();
    expect((await use1).status).toBe(400);
    expectExpired(await look(hire.token));

    // The second fails too: it, and only it, is restored.
    second.fail();
    expect((await use2).status).toBe(400);
    expectExpired(await look(hire.token));
    expect((await look(link2)).status).toBe(200);
    expect((await accept(link2)).status).toBe(200);
    expectExpired(await accept(hire.token));
  });

  it('an invite that was revoked while its provider call was running is not brought back by the failure', async () => {
    const w = await world();
    const hire = await invite(w);
    const call = pending();
    createUser.mockImplementationOnce(() => call.promise);
    const use = accept(hire.token);
    await providerCalls(1);
    await revoke(w, hire.id);
    call.fail();
    await use;
    expectExpired(await look(hire.token));
  });

  it('a company\'s first admin, whose login the onboarding script already made, can finish: link opens, password says "already set up", consent works, Google completes, the link then expires', async () => {
    const { sendInviteLink } = await import('../lib/invite-link.js');
    const { org } = await world();
    // Onboarding makes the account at the identity provider FIRST (so a later password step finds it), then mails the link.
    const person = await fx.addUser(org, `onboard${++sequence}`, 'ADMIN');
    const sent = await sendInviteLink({ id: person.id, email: person.email, first_name: 'First', organization_id: org });
    expect(sent.emailSent).toBe(true);
    const token = mailedLink(person.email);
    expect(tokenIn(sent.inviteUrl)).toBe(token);
    createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', message: 'A user with this email already exists' } });

    // 1. The link opens the page.
    expect((await look(token)).status).toBe(200);
    // 2. A password cannot be set: the login exists. This must not kill the link.
    const password = await accept(token);
    expect(password.status).toBe(409);
    expect(password.body.error).toMatch(/already set up/i);
    // 3. Consent, the only way they can accept the terms, still works with the same link.
    expect((await look(token)).status).toBe(200);
    expect((await consent(token)).status).toBe(200);
    // 4. Google sign-in completes (it refuses anyone who has not accepted the terms).
    const done = await googleSignIn(person.email);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // 5. The account is open: the link is finished.
    expectExpired(await look(token));
    expectExpired(await accept(token));
    expectExpired(await consent(token));
  });

  it('a provider call that throws leaves the link usable: the person is told to retry and the same link still works', async () => {
    const w = await world();
    const hire = await invite(w);
    createUser.mockRejectedValueOnce(new Error('the provider is unreachable'));
    expect((await accept(hire.token)).status).toBe(500);
    expect((await look(hire.token)).status).toBe(200);
    expect((await accept(hire.token)).status).toBe(200);
  });

  it('only the invite module mints invite links (source guard): no other file signs a token or builds an accept-invite address', () => {
    const roots = ['src', 'scripts'].map((d) => path.resolve(__dirname, '../..', d));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
        if (!/\.ts$/.test(entry.name) || /\.test\.ts$/.test(entry.name) || full.includes(`${path.sep}__tests__${path.sep}`)) continue;
        if (/lib\/(invite-token|invite-link)\.ts$/.test(full.split(path.sep).join('/'))) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (/signInviteToken\s*\(/.test(text) || /accept-invite\?token=/.test(text)) offenders.push(path.relative(path.resolve(__dirname, '../..'), full));
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });

});
