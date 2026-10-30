/* =============================================================================
   Roles & Permissions, ticket 26 (findings H4, H5): only the Owner changes Admins.

   Only the Owner makes someone an Admin (create, invite, the Admin switch, a move onto a role whose Admin flag is set), and
   only the Owner acts on an Admin's account. Anyone else is refused with 403 "Only the Owner can change Admins." and one
   access.denied row. The Owner check reads the database inside the change, under the same company lock as the last-Admin
   check, never the sign-in cache. Resend invite never hands the link back to anyone but the Owner.

   The table below is driven from the source: every route in routes/user.routes.ts that changes a person has a case here,
   or a reasoned entry in NOT_AN_ACTION_ON_AN_ADMIN. A route added later with neither fails the first test.

   Everything goes through the real routes, called as people of the company. The identity provider and the mail edge are
   replaced. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';
import type { Response } from 'supertest';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The suite-wide setup mocks the audit writer; the refusal rows are part of what is under test here.
vi.unmock('../lib/audit');
// The mail edge: what the invitation would carry is captured here, never read off the API's answer.
const { sendUserInviteEmail, sendPasswordResetEmail, sendAdminChangeAlertEmail } = vi.hoisted(() => ({
  sendUserInviteEmail: vi.fn(), sendPasswordResetEmail: vi.fn(), sendAdminChangeAlertEmail: vi.fn(),
}));
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserInviteEmail,
  sendPasswordResetEmail,
  sendAdminChangeAlertEmail,
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;
const ONLY_THE_OWNER = 'Only the Owner can change Admins.';
const DOMAIN = 'staging.mail.test.com';

/** A name part made of letters only, unique per call (a mailbox address takes no digits at the start). */
const letters = () => randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 10);

/** Every route in routes/user.routes.ts that writes (method and path, as written there). Read from the source. */
function writingUserRoutes(): string[] {
  const src = readFileSync(join(__dirname, '..', 'routes', 'user.routes.ts'), 'utf8');
  return [...src.matchAll(/router\.(post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
}

/**
 * Writing routes that are not an action on a person's account or access, each with why. Adding to this list is a decision
 * for review, not a way to make the table pass.
 */
const NOT_AN_ACTION_ON_AN_ADMIN: Record<string, string> = {
  'POST /:id/reassign': "moves a deactivated person's open records to someone else: it changes those records, not the person's account or access",
  'POST /:id/mfa/reset': 'the two-step reset part of H5 is deferred to SRVW-356 (spec, Out of Scope); it stays Admin-only as it is',
};
/** The caller's own account: no other person is acted on. */
const isOwnAccount = (route: string) => / \/me(\/|$)/.test(route);

suite('only the Owner changes Admins (ticket 26, real database, real routes)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: DOMAIN, MAILBOX_ADDRESS_HASH_KEY: 'test-mailbox-hash-key-0123456789abcdef' });
    await import('../app.js');
  }, 600_000);
  afterAll(async () => {
    await db.mailboxAddress.deleteMany({ where: { organization_id: { in: orgs } } }).catch(() => undefined);
    await fx.cleanup();
  });

  const authAdmin = supabaseAdmin.auth.admin as unknown as Record<'listUsers' | 'deleteUser' | 'createUser' | 'generateLink', ReturnType<typeof vi.fn>>;
  beforeEach(() => {
    authAdmin.listUsers.mockReset().mockResolvedValue({ data: { users: [], nextPage: null }, error: null });
    authAdmin.deleteUser.mockReset().mockResolvedValue({ data: null, error: null });
    authAdmin.createUser.mockReset().mockImplementation(async () => ({ data: { user: { id: randomUUID() } }, error: null }));
    authAdmin.generateLink.mockReset().mockResolvedValue({ data: { properties: { hashed_token: 'hashed-recovery-token' } }, error: null });
    sendUserInviteEmail.mockReset().mockResolvedValue(true);
    sendPasswordResetEmail.mockReset().mockResolvedValue(true);
    sendAdminChangeAlertEmail.mockReset().mockResolvedValue(true);
  });

  /**
   * Sign each person in once, one after another, so their sessions are in the sign-in cache. `signedInAs` stubs ONE identity
   * for the provider, so requests fired together must each find their person already cached under their own token.
   */
  async function warm(...people: Person[]) {
    for (const p of people) expect((await (await fx.signedInAs(p)).get('/api/auth/me')).status).toBe(200);
  }

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  /** A company that has been through the register (its company part set), with its Owner and a second Admin who is not. */
  async function company() {
    const w = await fx.newOrg();
    orgs.push(w.org);
    await db.organization.update({ where: { id: w.org }, data: { email_sender_local_part: `co${letters()}` } });
    const other = await fx.addUser(w.org, 'ada', 'ADMIN');
    return { org: w.org, owner: w.admin, other };
  }

  /** The access.denied rows this person has, once the response's own write has landed. A short wait so "exactly one" is real. */
  async function deniedRows(actor: Person, atLeast: number) {
    const read = () => db.auditLog.findMany({ where: { actor_id: actor.id, action: 'access.denied' } });
    for (let i = 0; i < 40; i++) {
      if ((await read()).length >= atLeast) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 150));
    return read();
  }

  /** Everything about the person an action could change. */
  const snapshot = (id: string) => db.user.findUnique({
    where: { id },
    select: {
      role: true, custom_role_id: true, is_admin: true, is_active: true, has_login: true, password_hash: true,
      first_name: true, last_name: true, phone: true, avatar_path: true, erased_at: true, email: true,
    },
  });
  const mailboxOf = (id: string) => db.mailbox.findMany({
    where: { user_id: id }, select: { holder_user_id: true, status: true, addresses: { select: { local_part: true, is_primary: true } } },
  });

  type Shape = 'active' | 'inactive' | 'invited' | 'none';
  interface Target { person: Person | null; mailbox: string | null }
  interface Case {
    what: string;
    /** The route as written in routes/user.routes.ts. */
    route: string;
    /** The person acted on: an Admin unless `admin` is false. `none` for a person not yet made. */
    shape: Shape;
    admin?: boolean;
    /** On a custom role (an Admin by the flag, not the Administrator role). */
    onCustomRole?: boolean;
    withMailbox?: boolean;
    call: (api: Api, target: Target, org: string) => Promise<Response>;
    /** What the Owner gets. Not 403. */
    ownerStatus: number;
  }

  const newPersonBody = (extra: object) => ({
    email: `new-${randomUUID().slice(0, 8)}@example.test`, first_name: 'New', last_name: 'Person', ...extra,
  });
  const idOf = (t: Target) => t.person!.id;

  /** Every action in the Owner-only table, and every way to make an Admin. */
  const CASES: Case[] = [
    // Making someone an Admin.
    { what: 'create an Admin (the Administrator role)', route: 'POST /', shape: 'none', ownerStatus: 201,
      call: (api) => api.post('/api/users', newPersonBody({ password: 'long-enough-1', role: 'ADMIN' })) },
    { what: 'create an Admin (the flag, on another role)', route: 'POST /', shape: 'none', ownerStatus: 201,
      call: (api) => api.post('/api/users', newPersonBody({ password: 'long-enough-1', role: 'DISPATCHER', is_admin: true })) },
    { what: 'invite an Admin (the Administrator role)', route: 'POST /invite', shape: 'none', ownerStatus: 201,
      call: (api) => api.post('/api/users/invite', newPersonBody({ role: 'ADMIN' })) },
    { what: 'invite an Admin (the flag, on another role)', route: 'POST /invite', shape: 'none', ownerStatus: 201,
      call: (api) => api.post('/api/users/invite', newPersonBody({ role: 'TECHNICIAN', is_admin: true })) },
    { what: 'make an Admin with the Admin switch', route: 'PATCH /:id', shape: 'active', admin: false, ownerStatus: 200,
      call: (api, t) => api.patch(`/api/users/${idOf(t)}`, { is_admin: true }) },
    { what: 'make an Admin by a move onto the Administrator role', route: 'PATCH /:id', shape: 'active', admin: false, ownerStatus: 200,
      call: (api, t) => api.patch(`/api/users/${idOf(t)}`, { role: 'ADMIN', custom_role_id: null }) },
    // Acting on an Admin's account.
    { what: 'edit an Admin', route: 'PATCH /:id', shape: 'active', ownerStatus: 200,
      call: (api, t) => api.patch(`/api/users/${idOf(t)}`, { first_name: 'Renamed' }) },
    { what: 'take Admin away (the switch)', route: 'PATCH /:id', shape: 'active', onCustomRole: true, ownerStatus: 200,
      call: (api, t) => api.patch(`/api/users/${idOf(t)}`, { is_admin: false }) },
    { what: 'role change that takes Admin away (off the Administrator role)', route: 'PATCH /:id', shape: 'active', ownerStatus: 200,
      call: (api, t) => api.patch(`/api/users/${idOf(t)}`, { role: 'TECHNICIAN' }) },
    { what: 'role change that keeps Admin', route: 'PATCH /:id', shape: 'active', onCustomRole: true, ownerStatus: 200,
      call: (api, t) => api.patch(`/api/users/${idOf(t)}`, { role: 'TECHNICIAN', custom_role_id: null }) },
    { what: 'set an Admin inactive', route: 'PATCH /:id', shape: 'active', ownerStatus: 200,
      call: (api, t) => api.patch(`/api/users/${idOf(t)}`, { is_active: false }) },
    { what: 'reactivate an Admin', route: 'PATCH /:id', shape: 'inactive', ownerStatus: 200,
      call: (api, t) => api.patch(`/api/users/${idOf(t)}`, { is_active: true }) },
    { what: 'deactivate an Admin', route: 'DELETE /:id', shape: 'active', ownerStatus: 200,
      call: (api, t) => api.delete(`/api/users/${idOf(t)}`, {}) },
    { what: "revoke an Admin's sign-in", route: 'POST /:id/revoke-login', shape: 'active', ownerStatus: 200,
      call: (api, t) => api.post(`/api/users/${idOf(t)}/revoke-login`) },
    { what: "resend an Admin's invite", route: 'POST /:id/invite', shape: 'invited', ownerStatus: 200,
      call: (api, t) => api.post(`/api/users/${idOf(t)}/invite`) },
    { what: 'send an Admin a password reset', route: 'POST /:id/password-reset', shape: 'active', ownerStatus: 200,
      call: (api, t) => api.post(`/api/users/${idOf(t)}/password-reset`) },
    { what: "change an Admin's mailbox address", route: 'PUT /:id/mailbox-address', shape: 'active', withMailbox: true, ownerStatus: 200,
      call: (api, t) => api.put(`/api/users/${idOf(t)}/mailbox-address`, { name_part: letters() }) },
    { what: "move a deactivated Admin's mailbox", route: 'PUT /:id/mailbox-handover', shape: 'inactive', withMailbox: true, ownerStatus: 200,
      call: (api, t) => api.put(`/api/users/${idOf(t)}/mailbox-handover`, { handover_to: 'main' }) },
    { what: 'delete an Admin', route: 'DELETE /:id/permanent', shape: 'inactive', ownerStatus: 200,
      call: (api, t) => api.delete(`/api/users/${idOf(t)}/permanent`) },
    { what: "erase an Admin's personal data", route: 'POST /:id/erase-personal-data', shape: 'inactive', ownerStatus: 200,
      call: (api, t) => api.post(`/api/users/${idOf(t)}/erase-personal-data`) },
    // Make Owner (ticket 27) is the Owner's alone. The Owner gets past the check to the handler's own answer: this Admin has
    // never signed in, so they can't become the Owner (409); permission-make-owner-db.test.ts covers the hand-over itself.
    { what: 'make an Admin the Owner', route: 'POST /:id/make-owner', shape: 'active', ownerStatus: 409,
      call: (api, t) => api.post(`/api/users/${idOf(t)}/make-owner`) },
    // The Owner gets past the check to the handler's own answer: a photo upload with no file.
    { what: "set an Admin's profile photo", route: 'POST /:id/avatar', shape: 'active', ownerStatus: 400,
      call: (api, t) => api.post(`/api/users/${idOf(t)}/avatar`) },
    { what: "remove an Admin's profile photo", route: 'DELETE /:id/avatar', shape: 'active', ownerStatus: 200,
      call: (api, t) => api.delete(`/api/users/${idOf(t)}/avatar`) },
    // An Admin has no switches to set, for anyone (400, the Admin box); the Owner check comes first for everyone else.
    { what: "set an Admin's switches", route: 'PUT /:id/permissions', shape: 'active', ownerStatus: 400,
      call: (api, t) => api.put(`/api/users/${idOf(t)}/permissions`, { values: { show_email: true } }) },
    { what: "reset an Admin's switches", route: 'POST /:id/permissions/reset', shape: 'active', ownerStatus: 400,
      call: (api, t) => api.post(`/api/users/${idOf(t)}/permissions/reset`, { all: true }) },
    { what: "save an Admin's switches as a role (moves them onto it)", route: 'POST /:id/permissions/save-as-role', shape: 'active', ownerStatus: 400,
      call: (api, t) => api.post(`/api/users/${idOf(t)}/permissions/save-as-role`, { label: `Saved ${letters()}` }) },
  ];

  /** The person a case acts on, made as the case describes. */
  async function targetFor(org: string, c: Case): Promise<Target> {
    if (c.shape === 'none') return { person: null, mailbox: null };
    const admin = c.admin ?? true;
    let person: Person;
    if (c.onCustomRole) {
      const role = await fx.addCustomRole(org, `night-${letters()}`, 'DISPATCHER');
      person = await fx.addUser(org, 'tara', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key, isAdmin: admin });
    } else {
      person = await fx.addUser(org, 'tara', admin ? 'ADMIN' : 'TECHNICIAN', { isAdmin: admin });
    }
    if (c.shape === 'inactive') await db.user.update({ where: { id: person.id }, data: { is_active: false, has_login: false } });
    if (c.shape === 'invited') await db.user.update({ where: { id: person.id }, data: { has_login: false } });
    if (c.shape === 'active') await db.user.update({ where: { id: person.id }, data: { avatar_path: `${org}/user_profile_photo/${person.id}/a.jpg` } });
    let mailbox: string | null = null;
    if (c.withMailbox) {
      const box = await db.mailbox.create({
        data: { organization_id: org, kind: 'user', user_id: person.id, holder_user_id: person.id, status: 'active' },
      });
      await db.mailboxAddress.create({ data: { local_part: `tara${letters()}`, organization_id: org, mailbox_id: box.id, is_primary: true } });
      mailbox = box.id;
    }
    return { person, mailbox };
  }

  it('has a case (or a reasoned exclusion) for every route in user.routes.ts that changes a person', () => {
    const routes = writingUserRoutes();
    expect(routes.length).toBeGreaterThan(10);
    const covered = new Set(CASES.map((c) => c.route));
    const missing = routes.filter((r) => !isOwnAccount(r) && !covered.has(r) && !NOT_AN_ACTION_ON_AN_ADMIN[r]);
    expect(missing).toEqual([]);
    // No case or exclusion names a route that is not there any more.
    for (const r of [...covered, ...Object.keys(NOT_AN_ACTION_ON_AN_ADMIN)]) expect(routes, r).toContain(r);
  });

  for (const c of CASES) {
    it(`${c.what}: refused to an Admin who is not the Owner (403, one access.denied row, nothing changed); the Owner may`, async () => {
      const { org, owner, other } = await company();
      const target = await targetFor(org, c);
      const before = target.person ? await snapshot(target.person.id) : null;
      const boxBefore = target.person ? await mailboxOf(target.person.id) : null;
      const peopleBefore = await db.user.count({ where: { organization_id: org } });

      const refused = await c.call(await fx.signedInAs(other), target, org);
      expect(refused.status, `${c.what} by another Admin`).toBe(403);
      expect(refused.body).toEqual({ error: ONLY_THE_OWNER });
      const rows = await deniedRows(other, 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.resource_id).toBe(target.person?.id ?? null);
      expect(rows[0]!.metadata).toMatchObject({ refused: 'only_the_owner_changes_admins' });

      // Nothing moved: the person, their mailbox, the people in the company; nothing was asked of the provider or sent.
      if (target.person) {
        expect(await snapshot(target.person.id)).toEqual(before);
        expect(await mailboxOf(target.person.id)).toEqual(boxBefore);
      }
      expect(await db.user.count({ where: { organization_id: org } })).toBe(peopleBefore);
      expect(authAdmin.createUser).not.toHaveBeenCalled();
      expect(authAdmin.deleteUser).not.toHaveBeenCalled();
      expect(authAdmin.generateLink).not.toHaveBeenCalled();
      expect(sendUserInviteEmail).not.toHaveBeenCalled();
      expect(sendPasswordResetEmail).not.toHaveBeenCalled();

      const done = await c.call(await fx.signedInAs(owner), target, org);
      expect(done.status, `${c.what} by the Owner: ${JSON.stringify(done.body)}`).toBe(c.ownerStatus);
      expect(await deniedRows(owner, 0)).toHaveLength(0);
    });
  }

  it('lets an Admin who is not the Owner keep acting on people who are not Admins', async () => {
    const { org, other } = await company();
    const tech = await fx.addUser(org, 'tom', 'TECHNICIAN');
    const api = () => fx.signedInAs(other);
    expect((await (await api()).patch(`/api/users/${tech.id}`, { first_name: 'Tommy', role: 'DISPATCHER' })).status).toBe(200);
    expect((await (await api()).post(`/api/users/${tech.id}/password-reset`)).status).toBe(200);
    expect((await (await api()).delete(`/api/users/${tech.id}`, {})).status).toBe(200);
    expect((await (await api()).post('/api/users/invite', newPersonBody({ role: 'SALES' }))).status).toBe(201);
    expect(await db.user.findUniqueOrThrow({ where: { id: tech.id } })).toMatchObject({ first_name: 'Tommy', role: 'DISPATCHER', is_active: false, is_admin: false });
    expect(await deniedRows(other, 0)).toHaveLength(0);
  });

  it('a person who is not an Admin is still refused a password reset by the Admin-only gate', async () => {
    const { org } = await company();
    const role = await fx.addCustomRole(org, `desk-${letters()}`, 'DISPATCHER');
    const desk = await fx.addUser(org, 'dee', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });
    const tech = await fx.addUser(org, 'tom', 'TECHNICIAN');
    const res = await (await fx.signedInAs(desk)).post(`/api/users/${tech.id}/password-reset`);
    expect(res.status).toBe(403);
    expect(res.body.error).not.toBe(ONLY_THE_OWNER);
    expect(authAdmin.generateLink).not.toHaveBeenCalled();
  });

  it('resend invite by an Admin who is not the Owner sends the email, and the answer has no link field at all; the Owner gets the link', async () => {
    const { org, owner, other } = await company();
    const tech = await fx.addUser(org, 'tom', 'TECHNICIAN');
    await db.user.update({ where: { id: tech.id }, data: { has_login: false } });

    const byOther = await (await fx.signedInAs(other)).post(`/api/users/${tech.id}/invite`);
    expect(byOther.status).toBe(200);
    expect(byOther.body.email_sent).toBe(true);
    expect(Object.keys(byOther.body)).not.toContain('invite_url');
    expect(JSON.stringify(byOther.body)).not.toContain('accept-invite');
    expect(sendUserInviteEmail).toHaveBeenCalledTimes(1);
    expect(sendUserInviteEmail.mock.calls[0]![0]).toMatchObject({ to: tech.email });

    // The email failing does not hand the link over either.
    sendUserInviteEmail.mockResolvedValueOnce(false);
    const failed = await (await fx.signedInAs(other)).post(`/api/users/${tech.id}/invite`);
    expect(failed.status).toBe(200);
    expect(failed.body.email_sent).toBe(false);
    expect(Object.keys(failed.body)).not.toContain('invite_url');

    const byOwner = await (await fx.signedInAs(owner)).post(`/api/users/${tech.id}/invite`);
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.invite_url).toContain('/accept-invite?token=');
    expect(byOwner.body.invite_url).toBe(sendUserInviteEmail.mock.calls.at(-1)![0].inviteUrl);
  });

  it('refuses a person who stopped being the Owner a moment ago, even with a warm sign-in cache', async () => {
    const { org, owner, other } = await company();
    const target = await fx.addUser(org, 'tara', 'ADMIN');
    const tech = await fx.addUser(org, 'tom', 'TECHNICIAN');
    await db.user.update({ where: { id: tech.id }, data: { has_login: false } });

    // The Owner signs in: the sign-in cache now holds them, as the Owner.
    const asOwner = await fx.signedInAs(owner);
    expect((await asOwner.get('/api/auth/me')).body.user.org_owner_user_id).toBe(owner.id);
    // Ownership moves (a support fix, or a hand-over): the cache is not told.
    await db.organization.update({ where: { id: org }, data: { owner_user_id: other.id } });

    const demote = await (await fx.signedInAs(owner)).patch(`/api/users/${target.id}`, { role: 'TECHNICIAN' });
    expect(demote.status).toBe(403);
    expect(demote.body.error).toBe(ONLY_THE_OWNER);
    const resend = await (await fx.signedInAs(owner)).post(`/api/users/${tech.id}/invite`);
    expect(resend.status).toBe(200);
    expect(Object.keys(resend.body)).not.toContain('invite_url');
    expect(await db.user.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ is_admin: true, role: 'ADMIN' });

    // The new Owner may.
    expect((await (await fx.signedInAs(other)).patch(`/api/users/${target.id}`, { role: 'TECHNICIAN' })).status).toBe(200);
  });

  it('makes the Owner check under the company lock: ownership that moves while the change waits for the lock refuses it', async () => {
    const { org, owner, other } = await company();
    const target = await fx.addUser(org, 'tara', 'ADMIN');
    const asOwner = await fx.signedInAs(owner);

    let pending: Promise<Response> | undefined;
    await db.$transaction(async (tx) => {
      // Hold the company row, as a hand-over of ownership would while it runs.
      await tx.$executeRaw`SELECT id FROM organizations WHERE id = ${org}::uuid FOR UPDATE`;
      pending = asOwner.patch(`/api/users/${target.id}`, { role: 'TECHNICIAN' }).then((r) => r);
      // Wait until the demotion is blocked on that lock.
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const rows = await db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
        waiting = Number(rows[0]!.n) > 0;
      }
      expect(waiting, 'the demotion waits for the company lock').toBe(true);
      await tx.organization.update({ where: { id: org }, data: { owner_user_id: other.id } });
    }, { timeout: 20_000 });

    const res = await pending!;
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(ONLY_THE_OWNER);
    expect(await db.user.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ is_admin: true, role: 'ADMIN' });
  });

  it('two concurrent demotions leave the company with its Owner and at least one Admin', async () => {
    const { org, owner, other } = await company();
    const third = await fx.addUser(org, 'tess', 'ADMIN');
    await warm(owner, other, third);
    const as = (p: Person) => fx.signedInAs(p);
    const demote = async (by: Person, who: Person) => (await as(by)).patch(`/api/users/${who.id}`, { role: 'TECHNICIAN' });

    const results = await Promise.all([
      demote(other, third), demote(third, other), demote(other, owner), demote(third, owner), demote(owner, other), demote(owner, third),
    ]);
    const statuses = results.map((r) => r.status);
    // The two Admins who are not the Owner are refused on each other (403) and on the Owner (409); the Owner's go through.
    expect(statuses).toEqual([403, 403, 409, 409, 200, 200]);

    const company2 = await db.organization.findUniqueOrThrow({ where: { id: org }, select: { owner_user_id: true } });
    expect(company2.owner_user_id).toBe(owner.id);
    expect(await db.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({ is_admin: true, is_active: true });
    expect(await db.user.count({ where: { organization_id: org, is_admin: true, is_active: true } })).toBeGreaterThanOrEqual(1);
  });

  it('in a company with no Owner, two Admins demoting each other at once are both refused and both stay Admins', async () => {
    const { org, owner: first, other: second } = await company();
    await db.organization.update({ where: { id: org }, data: { owner_user_id: null } });
    await warm(first, second);
    const [a, b] = await Promise.all([
      (await fx.signedInAs(first)).patch(`/api/users/${second.id}`, { role: 'TECHNICIAN' }),
      (await fx.signedInAs(second)).patch(`/api/users/${first.id}`, { role: 'TECHNICIAN' }),
    ]);
    expect([a.status, b.status]).toEqual([403, 403]);
    expect(await db.user.count({ where: { organization_id: org, is_admin: true, is_active: true } })).toBe(2);
  });

  it('journey: the Owner makes someone an Admin; another Admin cannot demote, deactivate or delete them; the Owner can', async () => {
    const { org, owner, other } = await company();

    // The Owner invites a new Admin.
    const invited = await (await fx.signedInAs(owner)).post('/api/users/invite', newPersonBody({ role: 'ADMIN' }));
    expect(invited.status).toBe(201);
    expect(invited.body.user.is_admin).toBe(true);
    const newAdmin = invited.body.user.id as string;

    // Another Admin tries to demote, deactivate and (once deactivated) delete them: each refused, each logged once.
    const asOther = () => fx.signedInAs(other);
    const tries = [
      await (await asOther()).patch(`/api/users/${newAdmin}`, { role: 'TECHNICIAN' }),
      await (await asOther()).delete(`/api/users/${newAdmin}`, {}),
    ];
    await db.user.update({ where: { id: newAdmin }, data: { is_active: false } });
    tries.push(await (await asOther()).delete(`/api/users/${newAdmin}/permanent`));
    await db.user.update({ where: { id: newAdmin }, data: { is_active: true } });
    expect(tries.map((r) => [r.status, r.body.error])).toEqual(Array(3).fill([403, ONLY_THE_OWNER]));
    const rows = await deniedRows(other, 3);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.resource_id === newAdmin)).toBe(true);
    expect(await db.user.findUniqueOrThrow({ where: { id: newAdmin } })).toMatchObject({ is_admin: true, is_active: true, role: 'ADMIN' });

    // The Owner does each.
    const asOwner = () => fx.signedInAs(owner);
    expect((await (await asOwner()).patch(`/api/users/${newAdmin}`, { role: 'TECHNICIAN' })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: newAdmin } })).is_admin).toBe(false);
    expect((await (await asOwner()).delete(`/api/users/${newAdmin}`, {})).status).toBe(200);
    const deleted = await (await asOwner()).delete(`/api/users/${newAdmin}/permanent`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(await db.user.findUnique({ where: { id: newAdmin } })).toBeNull();
  });
});
