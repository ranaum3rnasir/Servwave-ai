/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.3 - creating a user issues their mailbox in the same transaction.

   Through the routes the app calls (POST /api/users/invite and POST /api/users), as a person on a custom role, on a
   client holding ONE connection as the hosted pool does, against a real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset. Covers: the mailbox and address come with the user; a namesake lands in "address
   needed" without an error; a failure after the user is written rolls BOTH back; and the "address needed" bell reaches
   the new user and every active Admin once (holders are people on custom roles built from the
   catalog, never a role name). Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient, Role } from '@prisma/client';

const clientPromise = vi.hoisted(async () => {
  const { oneConnectionClient } = await import('./one-connection-client.js');
  return oneConnectionClient(process.env.TEST_DATABASE_URL);
});
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));

// No email leaves the machine: the invite's set-password email is a stub that reports it was sent.
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/email')>()),
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
}));

// The register, with its issuing function wrapped so a case can make it fail.
vi.mock('../lib/mailbox/register', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/mailbox/register')>();
  return { ...real, issueUserMailbox: vi.fn(real.issueUserMailbox) };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { supabaseAdmin } from '../lib/supabase';
import { issueUserMailbox } from '../lib/mailbox/register';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite('creating a user issues their mailbox (real database, one connection)', () => {
  let db: PrismaClient;
  let fx: ReturnType<typeof switchFixture>;
  beforeAll(async () => {
    db = (await clientPromise) as PrismaClient;
    fx = switchFixture(db, async () => (await import('../app.js')).default as never);
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  const tag = () => randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 8);

  /** A company with a frozen company part and its admin. */
  async function company() {
    const w = await fx.newOrg();
    const part = `acme${tag()}`;
    await db.organization.update({ where: { id: w.org }, data: { email_sender_local_part: part } });
    return { ...w, part };
  }

  /** A person on a fresh custom role holding exactly these switch values (every other toggle off). */
  async function personWith(org: string, values: Record<string, boolean>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `mailbox-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, ...switchValues }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true });
  }

  // Setting a person's address is user management, the Admin flag's alone (AL-18): the people told are the Admins.
  const anAdmin = { view_users: true, is_admin: true };

  const invite = (api: Awaited<ReturnType<typeof fx.signedInAs>>, first: string, last: string) =>
    api.post('/api/users/invite', { first_name: first, last_name: last, email: `${tag()}@example.test`, role: 'TECHNICIAN' });

  async function mailboxOf(userId: string) {
    return db.mailbox.findFirst({ where: { user_id: userId, kind: 'user' }, include: { addresses: true } });
  }

  /**
   * The bells of one verb about one person, with who each went to; waits for the detached send to land. The bell row is written
   * before its recipient rows, so a bell with nobody on it yet is not landed: it waits until every bell has recipients and the
   * recipient count has stopped growing.
   */
  async function bells(org: string, verb: string, about: string) {
    let lastCount = -1;
    for (let i = 0; i < 60; i += 1) {
      const rows = await db.notification.findMany({ where: { organization_id: org, verb, object_id: about }, include: { recipients: true } });
      const count = rows.reduce((n, r) => n + r.recipients.length, 0);
      if (rows.length && rows.every((r) => r.recipients.length > 0) && count === lastCount) return rows;
      lastCount = count;
      await new Promise((r) => setTimeout(r, 100));
    }
    return [];
  }
  const quiet = () => new Promise((r) => setTimeout(r, 700));

  it('an invited user gets a first.last.company mailbox, in the same transaction, and no bell', async () => {
    const w = await company();
    const api = await fx.signedInAs(w.admin);

    const res = await invite(api, 'Jane', 'Smith');

    expect(res.status).toBe(201);
    const box = await mailboxOf(res.body.user.id);
    expect(box).toMatchObject({ organization_id: w.org, status: 'active', holder_user_id: res.body.user.id });
    expect(box!.addresses.map((a) => [a.local_part, a.is_primary])).toEqual([[`jane.smith.${w.part}`, true]]);
    await quiet();
    expect(await db.notification.count({ where: { organization_id: w.org, verb: { startsWith: 'mailbox.' } } })).toBe(0);
  });

  it('a directly created user gets one too', async () => {
    const w = await company();
    const api = await fx.signedInAs(w.admin);
    const id = randomUUID();
    (supabaseAdmin.auth.admin.createUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { user: { id } }, error: null });

    const res = await api.post('/api/users', {
      first_name: 'Ann', last_name: 'Lee', email: `${tag()}@example.test`, password: 'a-long-password-1', role: 'TECHNICIAN',
    });

    expect(res.status).toBe(201);
    expect(res.body.user.id).toBe(id);
    expect((await mailboxOf(id))!.addresses.map((a) => a.local_part)).toEqual([`ann.lee.${w.part}`]);
  });

  it('a namesake is created without an error and lands in "address needed" with no address', async () => {
    const w = await company();
    const api = await fx.signedInAs(w.admin);
    expect((await invite(api, 'Jane', 'Smith')).status).toBe(201);

    const res = await invite(api, 'Jane', 'Smith');

    expect(res.status).toBe(201);
    const box = await mailboxOf(res.body.user.id);
    expect(box).toMatchObject({ status: 'address_needed', holder_user_id: res.body.user.id });
    expect(box!.addresses).toEqual([]);
  });

  it('a hire named like a leaver lands in "address needed" too', async () => {
    const w = await company();
    const api = await fx.signedInAs(w.admin);
    const leaver = await invite(api, 'Jane', 'Smith');
    await db.user.update({ where: { id: leaver.body.user.id }, data: { is_active: false } });

    const hire = await invite(api, 'Jane', 'Smith');

    expect(hire.status).toBe(201);
    expect((await mailboxOf(hire.body.user.id))!.status).toBe('address_needed');
  });

  it('two namesakes invited at the same moment: one gets the address, the other "address needed", neither errors', async () => {
    const w = await company();
    const api = await fx.signedInAs(w.admin);

    const [a, b] = await Promise.all([invite(api, 'Sam', 'Jones'), invite(api, 'Sam', 'Jones')]);

    expect([a.status, b.status]).toEqual([201, 201]);
    const statuses = [(await mailboxOf(a.body.user.id))!.status, (await mailboxOf(b.body.user.id))!.status].sort();
    expect(statuses).toEqual(['active', 'address_needed']);
  });

  it('rings the new user and every active Admin, once, and nobody else', async () => {
    const w = await company();
    // The admin created the user; an Admin on a custom role, a deactivated Admin, and a person who is not an Admin.
    const holder = await personWith(w.org, anAdmin);
    const gone = await personWith(w.org, anAdmin);
    await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
    const bystander = await personWith(w.org, { view_users: true });
    const api = await fx.signedInAs(w.admin);
    expect((await invite(api, 'Jane', 'Smith')).status).toBe(201);
    const second = await invite(api, 'Jane', 'Smith');
    const newUser = second.body.user.id as string;

    const forUser = await bells(w.org, 'mailbox.address_needed', newUser);
    const forHolders = await bells(w.org, 'mailbox.address_needed_admin', newUser);

    expect(forUser).toHaveLength(1);
    expect(forUser[0]!.recipients.map((r) => r.recipient_id)).toEqual([newUser]);
    expect(forUser[0]!.title).toBe("You don't have an email address yet. An admin needs to set one before you can send email.");
    expect(forHolders).toHaveLength(1);
    expect(forHolders[0]!.recipients.map((r) => r.recipient_id).sort()).toEqual([w.admin.id, holder.id].sort());
    expect(forHolders[0]!.recipients.map((r) => r.recipient_id)).not.toContain(gone.id);
    expect(forHolders[0]!.recipients.map((r) => r.recipient_id)).not.toContain(bystander.id);
    expect(forHolders[0]!.title).toBe('Jane Smith has no email address yet');
    // the first Jane got an address and so no bell
    expect(await db.notification.count({ where: { organization_id: w.org, verb: { startsWith: 'mailbox.' } } })).toBe(2);
  });

  it('a new user who is an Admin hears the "you" bell and is left out of the admin one', async () => {
    const w = await company();
    const api = await fx.signedInAs(w.admin);
    expect((await invite(api, 'Zed', 'Quinn')).status).toBe(201);
    // The namesake is invited as an Admin on a custom role.
    const key = `mailbox-role-${++sequence}`;
    const role = await fx.addCustomRole(w.org, key, 'DISPATCHER');

    const second = await api.post('/api/users/invite', {
      first_name: 'Zed', last_name: 'Quinn', email: `${tag()}@example.test`, role: 'DISPATCHER', custom_role_id: role.id, is_admin: true,
    });

    expect(second.status).toBe(201);
    const newUser = second.body.user.id as string;
    const forUser = await bells(w.org, 'mailbox.address_needed', newUser);
    const forHolders = await bells(w.org, 'mailbox.address_needed_admin', newUser);
    expect(forUser[0]!.recipients.map((r) => r.recipient_id)).toEqual([newUser]);
    expect(forHolders[0]!.recipients.map((r) => r.recipient_id)).toEqual([w.admin.id]);
  });

  it('an invite that fails after the user is written leaves neither the user nor a mailbox', async () => {
    const w = await company();
    const api = await fx.signedInAs(w.admin);
    const email = `${tag()}@example.test`;
    vi.mocked(issueUserMailbox).mockRejectedValueOnce(new Error('the register is down'));

    const res = await api.post('/api/users/invite', { first_name: 'Jane', last_name: 'Smith', email, role: 'TECHNICIAN' });

    expect(res.status).toBe(500);
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect(await db.mailbox.count({ where: { organization_id: w.org, kind: 'user' } })).toBe(0);
    expect(await db.mailboxAddress.count({ where: { organization_id: w.org } })).toBe(0);
  });

  it('a direct create that fails after the user is written leaves neither, and removes the login it made', async () => {
    const w = await company();
    const api = await fx.signedInAs(w.admin);
    const email = `${tag()}@example.test`;
    const id = randomUUID();
    (supabaseAdmin.auth.admin.createUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { user: { id } }, error: null });
    const deleteUser = supabaseAdmin.auth.admin.deleteUser as ReturnType<typeof vi.fn>;
    deleteUser.mockClear();
    vi.mocked(issueUserMailbox).mockRejectedValueOnce(new Error('the register is down'));

    const res = await api.post('/api/users', { first_name: 'Ann', last_name: 'Lee', email, password: 'a-long-password-1', role: 'TECHNICIAN' });

    expect(res.status).toBe(500);
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect(await db.mailbox.count({ where: { organization_id: w.org, kind: 'user' } })).toBe(0);
    expect(deleteUser).toHaveBeenCalledWith(id);
  });
});
