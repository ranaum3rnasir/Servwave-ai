/* =============================================================================
   Roles & Permissions security, M3 (ticket 29): the people list is names-only for non-Admins.

   Only an Admin (the `is_admin` flag on the person) gets a colleague's full record: email, phone, the Admin flag, role,
   sign-in state, mailbox. Everyone else gets id, first and last name, avatar and whether the person is active, on every
   lane that lists people: the people list, a person's details and the communication team list. The assignee picker
   keeps answering them. A teammate is still emailed from the inbox by id: the server resolves the address inside the
   sender's company, so the team list never has to carry it (Q3, ruling b1).

   One table: each lane called as a Technician, a Dispatcher and a Sales rep (custom roles holding their preset's values
   from the switch catalog, with the switches the lanes need on) and as an Admin. Then one journey through the API.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient, resendSend } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, resendSend: vi.fn() };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    domains = { create: vi.fn(), get: vi.fn(), verify: vi.fn(), remove: vi.fn() };
  },
}));
vi.mock('../lib/email', async (importOriginal) => {
  const { env } = await import('../config/env.js');
  Object.assign(env, { RESEND_API_KEY: 're_test_key', MAILBOX_DOMAIN: 'staging.mail.test.com', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com' });
  return importOriginal();
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { presetSwitchSet, type BuiltInRole } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** What a non-Admin gets for a person (ruling Q1), written out rather than read from the code under test. */
const NAMES_ONLY_KEYS = ['avatar_url', 'first_name', 'id', 'is_active', 'last_name'];
/** What a non-Admin gets for a member of the communication team list (ruling Q1). */
const TEAM_MEMBER_KEYS = ['id', 'name', 'online'];

/** The switches the three lanes and the inbox send ask for, on top of each preset: View users, the Communication section and Show Email. */
const LANE_SWITCHES = {
  view_users: true, view_communication: true, access_communication: true, show_email: true, contact_customers: true,
};

const keysOf = (row: object) => Object.keys(row).sort();

suite('the people list is names-only for non-Admins (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['email_read_states', 'emails', 'reply_tokens', 'email_threads', 'mailbox_readers', 'mailbox_addresses', 'mailboxes']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });
  beforeEach(() => {
    resendSend.mockReset();
    resendSend.mockImplementation(async () => ({ data: { id: `re_${randomUUID()}` }, error: null }));
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;

  /** A company that sends mail (main mailbox and address), with a colleague whose phone is on file. */
  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const part = `co${made.tag}`;
    await db.organization.update({ where: { id: made.org }, data: { email_sending_enabled: true, email_sender_local_part: part } });
    const main = await db.mailbox.create({ data: { organization_id: made.org, kind: 'main', status: 'active' }, select: { id: true } });
    await db.mailboxAddress.create({ data: { local_part: part, organization_id: made.org, mailbox_id: main.id, is_primary: true } });
    const colleague = await fx.addUser(made.org, `colleague${++sequence}`, 'TECHNICIAN');
    await db.user.update({ where: { id: colleague.id }, data: { phone: '+16175550123', phone_ext: '42' } });
    return { ...made, part, colleague };
  }
  type World = Awaited<ReturnType<typeof newOrg>>;

  /** A person on a fresh custom role holding their preset's catalog values, with the lanes' switches on, and their own mailbox. */
  async function personOn(w: World, base: BuiltInRole & Role): Promise<Who> {
    const key = `names-${base.toLowerCase()}-${++sequence}`;
    const role = await fx.addCustomRole(w.org, key, base);
    await fx.setRoleSwitches(w.org, key, { ...presetSwitchSet(base), ...LANE_SWITCHES });
    const person = await fx.addUser(w.org, `p${sequence}`, base, { customRoleId: role.id, basedOnRoleKey: key });
    await withMailbox(w, person);
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** An Admin who is not the Owner: the flag on a person on a custom role, so no role name decides anything. */
  async function adminOf(w: World): Promise<Who> {
    const key = `names-adm-${++sequence}`;
    const role = await fx.addCustomRole(w.org, key, 'DISPATCHER');
    const person = await fx.addUser(w.org, `adm${sequence}`, 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: key, isAdmin: true });
    await withMailbox(w, person);
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  async function withMailbox(w: World, person: Person) {
    const mailbox = randomUUID();
    await db.mailbox.create({ data: { id: mailbox, organization_id: w.org, kind: 'user', user_id: person.id, holder_user_id: person.id, status: 'active' } });
    await db.mailboxAddress.create({
      data: { local_part: `${person.email.split('@')[0]}.${w.part}`.toLowerCase(), organization_id: w.org, mailbox_id: mailbox, is_primary: true },
    });
  }

  const NON_ADMINS: Array<BuiltInRole & Role> = ['TECHNICIAN', 'DISPATCHER', 'SALES'];

  describe.each(NON_ADMINS)('a %s (custom role on the preset) gets names only', (base) => {
    let w: World;
    let me: Who;
    beforeAll(async () => {
      w = await newOrg();
      me = await personOn(w, base);
    }, 60_000);

    it('from the people list, however the address is written: id, name, avatar and active, and no one\'s email, phone or Admin flag', async () => {
      for (const path of ['/api/users', '/api/users/', '/API/USERS', '/api/Users/']) {
        const res = await (await me.api()).get(path);
        expect(res.status, path).toBe(200);
        const rows = res.body.users as Array<Record<string, unknown>>;
        expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([w.admin.id, w.colleague.id, me.id]));
        for (const row of rows) expect(keysOf(row), path).toEqual(NAMES_ONLY_KEYS);
        const text = JSON.stringify(res.body);
        expect(text).not.toContain(w.colleague.email);
        expect(text).not.toContain(w.admin.email);
        expect(text).not.toContain('6175550123');
      }
    });

    it('from a person\'s details, with or without a trailing "/" or capitals', async () => {
      for (const path of [`/api/users/${w.colleague.id}`, `/api/users/${w.colleague.id}/`, `/API/USERS/${w.colleague.id}`, `/api/users/${w.admin.id}`]) {
        const res = await (await me.api()).get(path);
        expect(res.status, path).toBe(200);
        expect(keysOf(res.body.user), path).toEqual(NAMES_ONLY_KEYS);
      }
      const colleague = (await (await me.api()).get(`/api/users/${w.colleague.id}`)).body.user;
      expect(colleague).toMatchObject({ id: w.colleague.id, first_name: expect.any(String), last_name: 'Tester', is_active: true });
    });

    it('from the communication team list: id, name and online, never the email or role', async () => {
      for (const path of ['/api/communication/team-members', '/api/communication/team-members/', '/API/Communication/Team-Members']) {
        const res = await (await me.api()).get(path);
        expect(res.status, path).toBe(200);
        const members = res.body.members as Array<Record<string, unknown>>;
        expect(members.map((m) => m.id)).toEqual(expect.arrayContaining([w.admin.id, w.colleague.id]));
        for (const m of members) expect(keysOf(m), path).toEqual(TEAM_MEMBER_KEYS);
        expect(JSON.stringify(res.body)).not.toContain(w.colleague.email);
      }
    });

    it('cannot find the Admins by filtering the people list on role', async () => {
      const res = await (await me.api()).get('/api/users?role=ADMIN');
      expect(res.status).toBe(200);
      // The filter is not applied for a non-Admin, so the answer does not single out who holds the Admin role.
      expect((res.body.users as Array<{ id: string }>).map((r) => r.id)).toEqual(expect.arrayContaining([w.colleague.id, me.id]));
    });

    it('still gets the assignee picker\'s rows', async () => {
      const res = await (await me.api()).get('/api/users/assignable?purpose=directory');
      expect(res.status).toBe(200);
      expect((res.body as Array<{ id: string; first_name: string }>).map((r) => r.id)).toEqual(expect.arrayContaining([w.colleague.id, w.admin.id]));
    });

    it('gets "not found" for a person in another company', async () => {
      const other = await newOrg();
      const res = await (await me.api()).get(`/api/users/${other.colleague.id}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(other.colleague.email);
    });
  });

  describe('an Admin', () => {
    it('still gets the full record on the people list, a person\'s details and the team list', async () => {
      const w = await newOrg();
      const admin = await adminOf(w);
      const list = await (await admin.api()).get('/api/users');
      expect(list.status).toBe(200);
      const colleague = (list.body.users as Array<Record<string, unknown>>).find((r) => r.id === w.colleague.id)!;
      expect(colleague).toMatchObject({ email: w.colleague.email, phone: '+16175550123', is_admin: false, role: 'TECHNICIAN', has_login: expect.any(Boolean) });
      const detail = await (await admin.api()).get(`/api/users/${w.colleague.id}`);
      expect(detail.body.user).toMatchObject({ email: w.colleague.email, phone: '+16175550123', is_admin: false });
      const team = await (await admin.api()).get('/api/communication/team-members');
      expect((team.body.members as Array<Record<string, unknown>>).find((m) => m.id === w.colleague.id)).toMatchObject({
        email: w.colleague.email, role: 'TECHNICIAN',
      });
      // The role filter still narrows for an Admin.
      const admins = await (await admin.api()).get('/api/users?role=TECHNICIAN');
      expect((admins.body.users as Array<{ id: string }>).map((r) => r.id)).toContain(w.colleague.id);
      expect((admins.body.users as Array<{ id: string }>).map((r) => r.id)).not.toContain(w.admin.id);
    });
  });

  describe('emailing a teammate by id (ruling Q3, b1)', () => {
    const sentTo = () => resendSend.mock.calls.map((c) => JSON.stringify((c[0] as { to: unknown }).to)).join(' ');

    it('reaches the teammate: the server resolves their address inside the sender\'s company', async () => {
      const w = await newOrg();
      const me = await personOn(w, 'TECHNICIAN');
      const second = await fx.addUser(w.org, `second${++sequence}`, 'SALES');
      const res = await (await me.api()).post('/api/communication/emails', { to_user_ids: [w.colleague.id, second.id], subject: 'Hi', body: ['Hi'] });
      expect(res.status).toBe(201);
      expect(resendSend).toHaveBeenCalledTimes(1);
      expect(sentTo()).toContain(w.colleague.email);
      expect(sentTo()).toContain(second.email);
    });

    it('takes the id list as one comma-separated field too (the form the inbox posts)', async () => {
      const w = await newOrg();
      const me = await personOn(w, 'SALES');
      const res = await (await me.api()).post('/api/communication/emails', { to_user_ids: `${w.colleague.id},${w.admin.id}`, subject: 'Hi', body: ['Hi'] });
      expect(res.status).toBe(201);
      expect(sentTo()).toContain(w.colleague.email);
      expect(sentTo()).toContain(w.admin.email);
    });

    it('refuses an id from another company, an inactive person and an id that names no one, and sends nothing', async () => {
      const w = await newOrg();
      const me = await personOn(w, 'DISPATCHER');
      const other = await newOrg();
      const gone = await fx.addUser(w.org, `gone${++sequence}`, 'SALES');
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
      for (const id of [other.colleague.id, gone.id, randomUUID()]) {
        const res = await (await me.api()).post('/api/communication/emails', { to_user_ids: [w.colleague.id, id], subject: 'Hi', body: ['Hi'] });
        expect(res.status, id).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain(other.colleague.email);
      }
      expect(resendSend).not.toHaveBeenCalled();
    });

    it('reaches every teammate named by id, and the same person twice is one recipient; an id in capitals names no one and sends nothing', async () => {
      const w = await newOrg();
      const me = await personOn(w, 'TECHNICIAN');
      const second = await fx.addUser(w.org, `second${++sequence}`, 'SALES');

      const both = await (await me.api()).post('/api/communication/emails', { to_user_ids: [w.colleague.id, second.id], subject: 'Hi', body: ['Hi'] });
      expect(both.status).toBe(201);
      expect(resendSend).toHaveBeenCalledTimes(1);
      expect(sentTo()).toContain(w.colleague.email);
      expect(sentTo()).toContain(second.email);

      resendSend.mockClear();
      const twice = await (await me.api()).post('/api/communication/emails', {
        to_user_ids: `${w.colleague.id},${w.colleague.id}`, subject: 'Hi', body: ['Hi'],
      });
      expect(twice.status).toBe(201);
      expect(sentTo().split(w.colleague.email).length - 1).toBe(1);

      // Another spelling of a uuid names nobody (pre-PR review fixes, SR-2), alone or beside one in lower case: 404, nothing sent.
      for (const ids of [[w.colleague.id.toUpperCase()], [w.colleague.id, second.id.toUpperCase()], `${w.colleague.id},${w.colleague.id.toUpperCase()}`]) {
        resendSend.mockClear();
        const res = await (await me.api()).post('/api/communication/emails', { to_user_ids: ids, subject: 'Hi', body: ['Hi'] });
        expect(res.status, JSON.stringify(ids)).toBe(404);
        expect(resendSend).not.toHaveBeenCalled();
      }
    });

    it('refuses a person whose personal data was erased, even if their row still says active, and sends nothing', async () => {
      const w = await newOrg();
      const me = await personOn(w, 'SALES');
      const erased = await fx.addUser(w.org, `erased${++sequence}`, 'SALES');
      await db.user.update({ where: { id: erased.id }, data: { erased_at: new Date(), is_active: true } });
      const res = await (await me.api()).post('/api/communication/emails', { to_user_ids: [erased.id], subject: 'Hi', body: ['Hi'] });
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(erased.email);
      expect(resendSend).not.toHaveBeenCalled();
    });

    it('refuses a person with Show Email off before any id is looked at, a local one and another company\'s alike, and sends nothing', async () => {
      const w = await newOrg();
      const other = await newOrg();
      const key = `names-noemail-${++sequence}`;
      const role = await fx.addCustomRole(w.org, key, 'TECHNICIAN');
      await fx.setRoleSwitches(w.org, key, { ...presetSwitchSet('TECHNICIAN'), ...LANE_SWITCHES, show_email: false });
      const person = await fx.addUser(w.org, `noemail${sequence}`, 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: key });
      await withMailbox(w, person);
      for (const id of [w.colleague.id, other.colleague.id]) {
        const res = await (await fx.signedInAs(person)).post('/api/communication/emails', { to_user_ids: [id], subject: 'Hi', body: ['Hi'] });
        expect(res.status, id).toBe(403);
        expect(JSON.stringify(res.body)).not.toContain(w.colleague.email);
        expect(JSON.stringify(res.body)).not.toContain(other.colleague.email);
      }
      expect(resendSend).not.toHaveBeenCalled();
    });

    it('refuses a send with neither an address nor a teammate', async () => {
      const w = await newOrg();
      const me = await personOn(w, 'TECHNICIAN');
      const res = await (await me.api()).post('/api/communication/emails', { to_user_ids: [], subject: 'Hi', body: ['Hi'] });
      expect(res.status).toBe(400);
      expect(resendSend).not.toHaveBeenCalled();
    });

    it('leaves an Admin\'s send to an address as it was', async () => {
      const w = await newOrg();
      const admin = await adminOf(w);
      const res = await (await admin.api()).post('/api/communication/emails', { to: w.colleague.email, subject: 'Hi', body: ['Hi'] });
      expect(res.status).toBe(201);
      expect(sentTo()).toContain(w.colleague.email);
    });
  });

  describe('the journey: a Technician opens a job, picks an assignee, sees the team and emails a teammate', () => {
    it('gets names only on every people list, while an Admin gets the full record', async () => {
      const w = await newOrg();
      const tech = await personOn(w, 'TECHNICIAN');
      const job = await fx.addJob(w.org, w.customer, { crew: [tech.id, w.colleague.id] });

      const opened = await (await tech.api()).get(`/api/jobs/${job.id}`);
      expect(opened.status).toBe(200);

      const picker = await (await tech.api()).get('/api/users/assignable?purpose=directory');
      expect(picker.status).toBe(200);
      expect((picker.body as Array<{ id: string }>).map((r) => r.id)).toContain(w.colleague.id);

      const people = await (await tech.api()).get('/api/users');
      for (const row of people.body.users) expect(keysOf(row)).toEqual(NAMES_ONLY_KEYS);
      const team = await (await tech.api()).get('/api/communication/team-members');
      const member = (team.body.members as Array<Record<string, unknown>>).find((m) => m.id === w.colleague.id)!;
      expect(keysOf(member)).toEqual(TEAM_MEMBER_KEYS);

      const sent = await (await tech.api()).post('/api/communication/emails', { to_user_ids: [member.id as string], subject: 'About the job', body: ['See you there'] });
      expect(sent.status).toBe(201);
      expect(JSON.stringify(resendSend.mock.calls[0]![0])).toContain(w.colleague.email);

      const admin = await adminOf(w);
      const full = await (await admin.api()).get(`/api/users/${w.colleague.id}`);
      expect(full.body.user).toMatchObject({ email: w.colleague.email, phone: '+16175550123', is_admin: false });
    });
  });
});
