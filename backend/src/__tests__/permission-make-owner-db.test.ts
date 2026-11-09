/* =============================================================================
   Roles & Permissions, ticket 27 (spec stories 18-23, finding H5, decision D1): Make Owner with email approval.

   The Owner hands the company to another active Admin of the same company who has really signed in. Pressing Make Owner
   changes nothing: it emails the CURRENT Owner a one-time approval link. Ownership moves only when that link is opened, once
   and before it expires, in one locked step that re-checks both people and writes one audit row. The old Owner stays an Admin;
   the new Owner and the outgoing Owner are each emailed. A newer request cancels an older one. Two racing hand-overs leave
   exactly one Owner.

   Everything goes through the real routes on a real migrated database (TEST_DATABASE_URL; the suite skips when it is unset).
   The people sign in through the real password door (the identity provider replaced), so "has really signed in" is what the
   app itself recorded. The mail edge is replaced: the test reads the link out of the captured email and opens it through the
   API, as the Owner would. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The sign-in records and the refusal rows are part of what is under test.
vi.unmock('../lib/audit');
// The mail edge.
const { sendOwnerApprovalEmail, sendOwnerChangedEmail, sendAdminChangeAlertEmail } = vi.hoisted(() => ({
  sendOwnerApprovalEmail: vi.fn(), sendOwnerChangedEmail: vi.fn(), sendAdminChangeAlertEmail: vi.fn(),
}));
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendOwnerApprovalEmail,
  sendOwnerChangedEmail,
  sendAdminChangeAlertEmail,
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { supabaseAdmin } from '../lib/supabase';
import { signInviteToken } from '../lib/invite-token';

const suite = realClient ? describe : describe.skip;
const ONLY_THE_OWNER = 'Only the Owner can change Admins.';
const NOT_A_CANDIDATE = 'Only an active Admin who has signed in can become the Owner.';
const EXPIRED = { error: 'This approval link has expired or has already been used. Nothing was changed.', code: 'owner_link_expired' };
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type Mock = ReturnType<typeof vi.fn>;
const auth = supabaseAdmin.auth as unknown as { signInWithPassword: Mock };

suite('Make Owner with email approval (ticket 27, real database, real routes)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const app = () => fx.listener();
  beforeAll(async () => {
    await import('../app.js');
  }, 600_000);
  afterAll(() => fx.cleanup());

  beforeEach(() => {
    sendOwnerApprovalEmail.mockReset().mockResolvedValue(true);
    sendOwnerChangedEmail.mockReset().mockResolvedValue(true);
    sendAdminChangeAlertEmail.mockReset().mockResolvedValue(true);
    auth.signInWithPassword.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  let n = 0;
  /** Sign this person in through the real password door, and wait for the app's own record of it. */
  async function signIn(p: Person) {
    auth.signInWithPassword.mockResolvedValue({
      data: {
        user: { id: randomUUID(), email: p.email, email_confirmed_at: new Date().toISOString() },
        session: { access_token: `at-${++n}`, refresh_token: `rt-${n}`, expires_at: 9_999_999_999 },
      },
      error: null,
    });
    const res = await request(await app()).post('/api/auth/login').send({ email: p.email, password: 'correct-horse-9' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (let i = 0; i < 60; i++) {
      if (await db.auditLog.count({ where: { actor_id: p.id, action: 'login.succeeded' } })) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no sign-in record');
  }

  /** A company: its Owner, and two Admins who are not the Owner and have signed in. */
  async function company() {
    const w = await fx.newOrg();
    const bea = await fx.addUser(w.org, 'bea', 'ADMIN');
    const cal = await fx.addUser(w.org, 'cal', 'ADMIN');
    await signIn(bea);
    await signIn(cal);
    return { org: w.org, owner: w.admin, bea, cal };
  }

  const ownerOf = async (org: string) => (await db.organization.findUniqueOrThrow({ where: { id: org }, select: { owner_user_id: true } })).owner_user_id;
  const ownerRows = (org: string) => db.auditLog.findMany({ where: { org_id: org, action: 'owner.assigned' }, orderBy: { created_at: 'asc' } });
  const markOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { password_hash: true } })).password_hash;
  const makeOwner = async (by: Person, targetId: string, path = `/api/users/${targetId}/make-owner`) => (await fx.signedInAs(by)).post(path);
  const preview = async (token: unknown) => request(await app()).post('/api/auth/owner-approval').send({ token });
  const approve = async (token: unknown) => request(await app()).post('/api/auth/owner-approval/approve').send({ token });

  /** The approval link in the last email sent to this address. */
  function mailedToken(email: string): string {
    const sent = sendOwnerApprovalEmail.mock.calls.map((c) => c[0] as { to: string; approveUrl: string }).filter((m) => m.to === email);
    expect(sent.length, 'an approval email was sent').toBeGreaterThan(0);
    const url = new URL(sent.at(-1)!.approveUrl);
    expect(url.pathname).toBe('/approve-owner');
    return url.searchParams.get('token')!;
  }

  /** The access.denied rows this person has, once the response's own write has landed. */
  async function deniedRows(actor: Person, atLeast: number) {
    const read = () => db.auditLog.findMany({ where: { actor_id: actor.id, action: 'access.denied' } });
    for (let i = 0; i < 40; i++) {
      if ((await read()).length >= atLeast) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 150));
    return read();
  }

  it('journey: the Owner asks, only the Owner is emailed, nothing changes until the link is opened; then ownership moves once', async () => {
    const { org, owner, bea, cal } = await company();
    const ownerRow = await db.user.findUniqueOrThrow({ where: { id: owner.id } });

    // 1. The Owner presses Make Owner on Bea. Nothing about who owns the company changes.
    const asked = await makeOwner(owner, bea.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toEqual({ email_sent: true });
    expect(JSON.stringify(asked.body)).not.toContain('token');
    expect(await ownerOf(org)).toBe(owner.id);
    expect(await ownerRows(org)).toHaveLength(1); // only the first Owner's, from the company's setup

    // 2. The CURRENT Owner is the one emailed (D1), with a one-time link to the approval page; no one else is mailed.
    expect(sendOwnerApprovalEmail).toHaveBeenCalledTimes(1);
    expect(sendOwnerApprovalEmail.mock.calls[0]![0]).toMatchObject({ to: owner.email, ownerFirstName: ownerRow.first_name, newOwnerName: 'bea Tester', organizationId: org });
    const token = mailedToken(owner.email);
    // Only a hash of the link's id is kept: neither the link nor its id is stored.
    const jti = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')).jti as string;
    const mark = await markOf(owner.id);
    expect(mark).toMatch(/^handover:v1:[0-9a-f]{64}$/);
    expect(mark).not.toContain(jti);
    expect(mark).not.toContain(token);

    // 3. The page the link opens says who becomes the Owner of which company.
    const shown = await preview(token);
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({ company_name: expect.stringMatching(/^switches-/), new_owner_name: 'bea Tester' });
    expect(await ownerOf(org)).toBe(owner.id);

    // 4. Opened: ownership moves, the old Owner stays an Admin, one audit row with the before and after.
    const done = await approve(token);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ new_owner_name: 'bea Tester' });
    expect(await ownerOf(org)).toBe(bea.id);
    expect(await db.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({ is_admin: true, is_active: true, has_login: true, role: ownerRow.role });
    const rows = await ownerRows(org);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ actor_id: owner.id, resource_type: 'User', resource_id: bea.id });
    expect(rows[1]!.metadata).toEqual({ before: { owner_user_id: owner.id }, after: { owner_user_id: bea.id }, by: 'make owner' });
    expect(await markOf(owner.id)).toBe('');

    // 5. The new Owner is told, and so is the outgoing Owner.
    expect(sendOwnerChangedEmail).toHaveBeenCalledTimes(2);
    const mails = sendOwnerChangedEmail.mock.calls.map((c) => c[0] as { to: string; for: string });
    expect(mails).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: bea.email, for: 'new', newOwnerName: 'bea Tester', organizationId: org }),
      expect.objectContaining({ to: owner.email, for: 'previous', newOwnerName: 'bea Tester', organizationId: org }),
    ]));
    // Nobody became or stopped being an Admin, so no Admin-change alert.
    expect(sendAdminChangeAlertEmail).not.toHaveBeenCalled();

    // 6. The sign-in payload now names the new Owner.
    expect((await (await fx.signedInAs(owner)).get('/api/auth/me')).body.user.org_owner_user_id).toBe(bea.id);

    // 7. Another Admin, signed in, opens the old link: nothing happens.
    const again = await request(await app()).post('/api/auth/owner-approval/approve').set('Authorization', `Bearer switches-${cal.id}`).send({ token });
    expect(again.status).toBe(400);
    expect(again.body).toEqual(EXPIRED);
    expect((await preview(token)).status).toBe(400);
    expect(await ownerOf(org)).toBe(bea.id);
    expect(await ownerRows(org)).toHaveLength(2);
    expect(sendOwnerChangedEmail).toHaveBeenCalledTimes(2);

    // 8. The new Owner can hand it on; the old Owner can no longer ask.
    const oldOwner = await makeOwner(owner, cal.id);
    expect(oldOwner.status).toBe(403);
    expect(oldOwner.body).toEqual({ error: ONLY_THE_OWNER });
  });

  it('only the Owner can ask: another Admin and a person who is not an Admin are refused 403 with one access.denied row, nothing sent', async () => {
    const { org, owner, bea, cal } = await company();
    const tech = await fx.addUser(org, 'tom', 'TECHNICIAN');
    await signIn(tech);
    const before = await markOf(owner.id);

    for (const [who, target] of [[cal, bea], [tech, bea], [cal, cal], [bea, owner]] as const) {
      const res = await makeOwner(who, target.id);
      expect(res.status, `${who.email} -> ${target.email}`).toBe(403);
      expect(res.body).toEqual({ error: ONLY_THE_OWNER });
    }
    const calRows = await deniedRows(cal, 2);
    expect(calRows).toHaveLength(2);
    expect(calRows.map((r) => r.metadata)).toEqual([
      expect.objectContaining({ refused: 'only_the_owner_changes_admins' }),
      expect.objectContaining({ refused: 'only_the_owner_changes_admins' }),
    ]);
    expect(await deniedRows(tech, 1)).toHaveLength(1);
    expect(sendOwnerApprovalEmail).not.toHaveBeenCalled();
    expect(await markOf(owner.id)).toBe(before);
    expect(await ownerOf(org)).toBe(owner.id);
  });

  it('refuses every target who is not an active Admin of the company who has signed in; another company and no one answer 404', async () => {
    const { org, owner, bea, cal } = await company();
    const other = await fx.newOrg();
    const foreignAdmin = await fx.addUser(other.org, 'fay', 'ADMIN');
    await signIn(foreignAdmin);

    const signedInTech = await fx.addUser(org, 'tom', 'TECHNICIAN');
    await signIn(signedInTech);
    const neverSignedIn = await fx.addUser(org, 'ned', 'ADMIN');
    const inactive = await fx.addUser(org, 'ina', 'ADMIN');
    await signIn(inactive);
    await db.user.update({ where: { id: inactive.id }, data: { is_active: false } });
    const revoked = await fx.addUser(org, 'rev', 'ADMIN');
    await signIn(revoked);
    await db.user.update({ where: { id: revoked.id }, data: { has_login: false } });
    const erased = await fx.addUser(org, 'era', 'ADMIN');
    await signIn(erased);
    await db.user.update({ where: { id: erased.id }, data: { is_active: false, has_login: false, erased_at: new Date() } });

    const cases: Array<[string, string, number, object]> = [
      ['a person who is not an Admin', signedInTech.id, 409, { error: NOT_A_CANDIDATE }],
      ['an Admin who never signed in (has_login alone is no proof)', neverSignedIn.id, 409, { error: NOT_A_CANDIDATE }],
      ['a deactivated Admin', inactive.id, 409, { error: NOT_A_CANDIDATE }],
      ['an Admin whose sign-in was revoked', revoked.id, 409, { error: NOT_A_CANDIDATE }],
      ['an erased Admin', erased.id, 409, { error: NOT_A_CANDIDATE }],
      ['the Owner themselves', owner.id, 409, { error: NOT_A_CANDIDATE }],
      ['an Admin of another company (no existence leak)', foreignAdmin.id, 404, { error: 'User not found' }],
      ['no one', randomUUID(), 404, { error: 'User not found' }],
      ['a malformed id', 'not-a-uuid', 404, { error: 'User not found' }],
    ];
    for (const [what, id, status, body] of cases) {
      const res = await makeOwner(owner, id);
      expect(res.status, what).toBe(status);
      expect(res.body, what).toEqual(body);
    }
    // The other company's 404 is the same as no one's: same status, same body.
    expect(sendOwnerApprovalEmail).not.toHaveBeenCalled();
    expect(await markOf(owner.id)).toBe('');
    expect(await ownerOf(org)).toBe(owner.id);
    expect(await ownerOf(other.org)).toBe(other.admin.id);

    // Address variants reach the same check: a trailing "/", an upper-case path. An id in upper case is another spelling of a
    // uuid, which names nobody (pre-PR review fixes, SR-2): 404, like a missing person.
    expect((await makeOwner(owner, bea.id, `/api/users/${bea.id.toUpperCase()}/make-owner`)).status).toBe(404);
    expect((await makeOwner(owner, bea.id, `/api/users/${bea.id}/make-owner/`)).status).toBe(200);
    expect((await makeOwner(owner, bea.id, `/api/users/${bea.id}/MAKE-OWNER`)).status).toBe(200);
    expect((await makeOwner(owner, foreignAdmin.id, `/api/users/${foreignAdmin.id.toUpperCase()}/make-owner/`)).status).toBe(404);
    for (const path of [`/api/users/${bea.id}/make-owner/`, `/api/users/${bea.id}/MAKE-OWNER`, `/api/users//${bea.id}/make-owner`]) {
      const res = await makeOwner(cal, bea.id, path);
      expect([403, 404], path).toContain(res.status);
    }
    expect(await ownerOf(org)).toBe(owner.id);
  });

  it('an expired link changes nothing', async () => {
    const { org, owner, bea } = await company();
    expect((await makeOwner(owner, bea.id)).status).toBe(200);
    const token = mailedToken(owner.email);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + SEVEN_DAYS_MS + 60_000 });
    expect((await preview(token)).status).toBe(400);
    const res = await approve(token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(EXPIRED);
    vi.useRealTimers();

    expect(await ownerOf(org)).toBe(owner.id);
    expect(await ownerRows(org)).toHaveLength(1);
    expect(sendOwnerChangedEmail).not.toHaveBeenCalled();
  });

  it('a newer request cancels the older pending one', async () => {
    const { org, owner, bea, cal } = await company();
    expect((await makeOwner(owner, bea.id)).status).toBe(200);
    const first = mailedToken(owner.email);
    expect((await makeOwner(owner, cal.id)).status).toBe(200);
    const second = mailedToken(owner.email);
    expect(second).not.toBe(first);

    expect((await preview(first)).status).toBe(400);
    const old = await approve(first);
    expect(old.status).toBe(400);
    expect(old.body).toEqual(EXPIRED);
    expect(await ownerOf(org)).toBe(owner.id);

    expect((await approve(second)).status).toBe(200);
    expect(await ownerOf(org)).toBe(cal.id);
    expect(await ownerRows(org)).toHaveLength(2);
  });

  it('re-checks both people when the link is opened: a target who stopped being eligible, or an Owner who changed, moves nothing', async () => {
    const { org, owner, bea, cal } = await company();
    expect((await makeOwner(owner, bea.id)).status).toBe(200);
    const token = mailedToken(owner.email);
    // Bea is no longer an Admin by the time the link is opened.
    expect((await (await fx.signedInAs(owner)).patch(`/api/users/${bea.id}`, { role: 'TECHNICIAN' })).status).toBe(200);
    const gone = await approve(token);
    expect(gone.status).toBe(409);
    expect(gone.body.error).toBe('This person can no longer become the Owner: they must be an active Admin who has signed in. Nothing was changed.');
    expect(await ownerOf(org)).toBe(owner.id);
    expect(sendOwnerChangedEmail).not.toHaveBeenCalled();

    // The company's Owner changes another way (a support fix) while a link is out: the link is dead.
    expect((await makeOwner(owner, cal.id)).status).toBe(200);
    const second = mailedToken(owner.email);
    await db.organization.update({ where: { id: org }, data: { owner_user_id: cal.id } });
    expect((await approve(second)).status).toBe(400);
    expect(await ownerOf(org)).toBe(cal.id);
  });

  it('a link opened many times at once moves ownership exactly once', async () => {
    const { org, owner, bea } = await company();
    expect((await makeOwner(owner, bea.id)).status).toBe(200);
    const token = mailedToken(owner.email);
    const results = await Promise.all(Array.from({ length: 6 }, () => approve(token)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400, 400, 400, 400]);
    expect(await ownerOf(org)).toBe(bea.id);
    expect(await ownerRows(org)).toHaveLength(2);
    expect(sendOwnerChangedEmail).toHaveBeenCalledTimes(2);
  });

  it('two racing hand-overs leave exactly one Owner', async () => {
    const { org, owner, bea, cal } = await company();
    // Two requests at once, then both links opened at once.
    const asked = await Promise.all([makeOwner(owner, bea.id), makeOwner(owner, cal.id)]);
    expect(asked.map((r) => r.status)).toEqual([200, 200]);
    const tokens = sendOwnerApprovalEmail.mock.calls.map((c) => new URL((c[0] as { approveUrl: string }).approveUrl).searchParams.get('token')!);
    expect(tokens).toHaveLength(2);
    const opened = await Promise.all(tokens.map((t) => approve(t)));
    expect(opened.map((r) => r.status).sort()).toEqual([200, 400]);
    const now = await ownerOf(org);
    expect([bea.id, cal.id]).toContain(now);
    expect(await ownerRows(org)).toHaveLength(2);
    expect(await db.organization.count({ where: { owner_user_id: { in: [owner.id, bea.id, cal.id] } } })).toBe(1);
    expect(await db.user.count({ where: { organization_id: org, is_admin: true, is_active: true } })).toBe(3);
  });

  it('a hand-over racing the Owner taking Admin away from the new Owner leaves an Owner who is an active Admin', async () => {
    for (let round = 0; round < 3; round++) {
      const { org, owner, bea } = await company();
      expect((await makeOwner(owner, bea.id)).status).toBe(200);
      const token = mailedToken(owner.email);
      const asOwner = await fx.signedInAs(owner);
      const [opened, demoted] = await Promise.all([approve(token), asOwner.patch(`/api/users/${bea.id}`, { role: 'TECHNICIAN' })]);
      const now = (await ownerOf(org))!;
      const holder = await db.user.findUniqueOrThrow({ where: { id: now } });
      expect(holder, `round ${round}: ${opened.status}/${demoted.status}`).toMatchObject({ is_admin: true, is_active: true });
      // Exactly one of the two went through.
      expect([opened.status, demoted.status].filter((s) => s === 200)).toHaveLength(1);
    }
  });

  it('refuses a tampered link, an invite link and junk; nothing changes', async () => {
    const { org, owner, bea, cal } = await company();
    expect((await makeOwner(owner, bea.id)).status).toBe(200);
    const token = mailedToken(owner.email);
    const [body, sig] = token.split('.') as [string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const toCal = `${Buffer.from(JSON.stringify({ ...payload, to: cal.id })).toString('base64url')}.${sig}`;
    const later = `${Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 1 })).toString('base64url')}.${sig}`;
    const invite = signInviteToken(bea.id, bea.email, 3600, payload.jti);
    for (const bad of [toCal, later, invite, `${token}x`, token.toUpperCase(), '', 'a.b', 42, null, undefined]) {
      const res = await approve(bad);
      expect(res.status, String(bad)).toBe(400);
      expect(res.body).toEqual(EXPIRED);
    }
    expect(await ownerOf(org)).toBe(owner.id);
    // The real link still works afterwards.
    expect((await approve(token)).status).toBe(200);
    expect(await ownerOf(org)).toBe(bea.id);
  });

  it('an approval link opens no invite, and the Owner signing in while it is out does not cancel it', async () => {
    const { org, owner, bea } = await company();
    expect((await makeOwner(owner, bea.id)).status).toBe(200);
    const token = mailedToken(owner.email);
    // Not an invite link: the invite door says expired.
    const asInvite = await request(await app()).post('/api/auth/invite').send({ token });
    expect(asInvite.status).toBe(400);
    expect(asInvite.body.code).toBe('invite_expired');
    // A sign-in finishes invite links only (ticket 22); the pending approval stays live.
    await signIn(owner);
    expect(await markOf(owner.id)).toMatch(/^handover:v1:/);
    expect((await approve(token)).status).toBe(200);
    expect(await ownerOf(org)).toBe(bea.id);
  });

  it('a request whose email could not be sent says so and leaves no live link', async () => {
    const { org, owner, bea } = await company();
    sendOwnerApprovalEmail.mockResolvedValueOnce(false);
    const res = await makeOwner(owner, bea.id);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("We couldn't send the approval email. Try again.");
    expect(await markOf(owner.id)).toBe('');
    expect((await approve(mailedToken(owner.email))).status).toBe(400);
    expect(await ownerOf(org)).toBe(owner.id);
  });

  it('the people list marks who could become the Owner, for the Owner only', async () => {
    const { org, owner, bea, cal } = await company();
    const neverSignedIn = await fx.addUser(org, 'ned', 'ADMIN');
    const tech = await fx.addUser(org, 'tom', 'TECHNICIAN');
    await signIn(tech);
    const eligible = async (viewer: Person) => {
      const res = await (await fx.signedInAs(viewer)).get('/api/users');
      expect(res.status).toBe(200);
      return Object.fromEntries((res.body.users as Array<{ id: string; owner_eligible: boolean }>).map((u) => [u.id, u.owner_eligible]));
    };
    expect(await eligible(owner)).toEqual({ [owner.id]: false, [bea.id]: true, [cal.id]: true, [neverSignedIn.id]: false, [tech.id]: false });
    expect(Object.values(await eligible(cal)).every((v) => v === false)).toBe(true);
  });

  it('no other way in moves the Owner: the company settings save refuses the field', async () => {
    const { org, owner, bea } = await company();
    const res = await (await fx.signedInAs(owner)).patch('/api/organization', { owner_user_id: bea.id });
    expect(res.status).toBe(400);
    expect(await ownerOf(org)).toBe(owner.id);
  });
});
