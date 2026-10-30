/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.8 - who reads the main mailbox, and what they see in it.

   "Reads the main mailbox" = the people linked to it on the Sender Address page and the people on Communication scope
   All; while nobody ACTIVE is linked, the Admins (the holders of Manage roles and permissions until AL-18). Under "Linked to me" the main mailbox
   lists only conversations started in it after go-live: not record conversations, not migrated ones, not ones moved in
   from a leaver's mailbox, and not vendor-tied ones for a person without View vendors. Under All it lists everything in it.
   The list, the single read, mark read, reply, the attachment link, the counts and the menu badge share one rule.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding exactly the
   switch values under test, against a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } }, log: [{ emit: 'event', level: 'query' }] });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { sendComposedEmail } from '../lib/email';

const suite = realClient ? describe : describe.skip;

suite('the main mailbox is read by its linked people, by M11\'s rule (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_readers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = { api: () => Promise<Api> };
  let sequence = 0;

  /** A company with its main mailbox. */
  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const main = await db.mailbox.create({ data: { organization_id: made.org, kind: 'main', status: 'active' }, select: { id: true } });
    return { ...made, main: main.id };
  }

  /** Every switch that needs one of these goes off with it, so the set stays storable. */
  const withDependantsOff = (off: string[]): Record<string, boolean> => {
    const out: Record<string, boolean> = Object.fromEntries(off.map((k) => [k, false]));
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of SWITCH_CATALOG) {
        if (!(s.key in out) && s.requires.some((r) => out[r] === false)) { out[s.key] = false; grew = true; }
      }
    }
    return out;
  };

  /** A person on a fresh custom role of this base holding exactly these switch values, with the Email page open. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & Who> {
    const key = `mmb-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, view_invoices: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'attached',
        ...switchValues,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const link = (org: string, main: string, person: Person) =>
    db.mailboxReader.create({ data: { organization_id: org, mailbox_id: main, user_id: person.id } });

  async function userMailbox(org: string, owner: Person, holder: Person | null = owner) {
    // A person's own mailbox has an address: a hand-written email goes out from it (PRD 10, S10.11), and a person without
    // one cannot send. Asking again for an owner's mailbox returns the one they have.
    const existing = await db.mailbox.findFirst({ where: { organization_id: org, kind: 'user', user_id: owner.id }, select: { id: true } });
    if (existing) {
      if (holder?.id) await db.mailbox.update({ where: { id: existing.id }, data: { holder_user_id: holder.id } });
      return existing.id;
    }
    const id = randomUUID();
    await db.mailbox.create({
      data: { id, organization_id: org, kind: 'user', user_id: owner.id, holder_user_id: holder?.id ?? null, status: 'active' },
    });
    await db.mailboxAddress.create({ data: { local_part: `u-${id}`, organization_id: org, mailbox_id: id, is_primary: true } });
    return id;
  }

  type Message = { direction?: 'out' | 'in'; sentBy?: string; jobId?: string; vendorId?: string; customerId?: string };
  type Conversation = {
    origin?: string; record?: { type: string; id: string }; assignedTo?: string; messages?: Message[];
  };

  /** A conversation in `mailboxId`, holding the messages given (one unread inbound message when none are). */
  async function addConversation(org: string, mailboxId: string, customer: string | null, conv: Conversation = {}) {
    const thread = randomUUID();
    await db.emailThread.create({
      data: {
        id: thread, organization_id: org, mailbox_id: mailboxId, origin: conv.origin ?? (conv.record ? 'record' : 'started'),
        record_type: conv.record?.type ?? null, record_id: conv.record?.id ?? null, assigned_to_user_id: conv.assignedTo ?? null,
      },
    });
    const ids: string[] = [];
    for (const m of conv.messages ?? [{}]) {
      const id = randomUUID();
      const out = m.direction === 'out';
      await db.email.create({
        data: {
          id, organization_id: org, thread_id: thread, customer_id: m.customerId ?? (m.vendorId ? null : customer), job_id: m.jobId ?? null,
          vendor_id: m.vendorId ?? null,
          account: 'user', direction: out ? 'out' : 'in', folder: out ? 'sent' : 'inbox',
          sent_by_user_id: m.sentBy ?? null,
          from: { name: null, email: out ? 'office@example.com' : 'customer@example.com' },
          to: out ? 'customer@example.com' : 'office@example.com',
          subject: 'run-main-mailbox', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
        select: { id: true },
      });
      ids.push(id);
    }
    return { thread, ids, first: ids[0]! };
  }

  const listed = async (person: Who, query = '') => {
    const res = await (await person.api()).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };
  const opens = async (person: Who, id: string) =>
    (await (await person.api()).get(`/api/communication/emails/${id}`)).status === 200;

  type MailboxList = {
    scope: string; selected: string; selected_unread: number; total_unread: number;
    mine: { id: string | null; unread: number }; held: { id: string }[]; main: { id: string; unread: number } | null;
  };
  const mailboxList = async (person: Who, query = ''): Promise<MailboxList> => {
    const res = await (await person.api()).get(`/api/communication/mailboxes${query}`);
    expect(res.status).toBe(200);
    return res.body;
  };
  const badge = async (person: Who) => {
    const res = await (await person.api()).get('/api/communication/unread-counts');
    expect(res.status).toBe(200);
    return res.body.email as number;
  };

  // The people who read it while nobody active is linked were the holders of Manage roles and permissions; since AL-18 that is
  // the Admins, who read every mailbox anyway.
  const ADMIN = { is_admin: true };

  describe('who reads it, under "Linked to me"', () => {
    it('lists post-go-live main mailbox mail to a linked person, and not to a person who is not linked', async () => {
      const { org, customer, main } = await newOrg();
      const linked = await personWith(org, {});
      const stranger = await personWith(org, {});
      await link(org, main, linked);
      const mail = await addConversation(org, main, customer);

      expect(await listed(linked)).toContain(mail.first);
      expect(await opens(linked, mail.first)).toBe(true);
      expect(await listed(stranger)).not.toContain(mail.first);
      expect(await opens(stranger, mail.first)).toBe(false);
    });

    it('shows "Main mailbox" in the mailbox list of a reader, with its unread count, and not to a person who does not read it', async () => {
      const { org, customer, main } = await newOrg();
      const linked = await personWith(org, {});
      const stranger = await personWith(org, {});
      await link(org, main, linked);
      await addConversation(org, main, customer);
      await addConversation(org, main, customer);

      expect((await mailboxList(linked)).main).toEqual({ id: main, unread: 2 });
      expect((await mailboxList(linked)).total_unread).toBe(2);
      expect((await mailboxList(stranger)).main).toBeNull();
      expect((await mailboxList(stranger)).total_unread).toBe(0);
    });

    it('lists the main mailbox\'s mail to an Admin while nobody is linked, and to nobody else', async () => {
      const { org, customer, main } = await newOrg();
      const holder = await personWith(org, ADMIN);
      const stranger = await personWith(org, {});
      const mail = await addConversation(org, main, customer);

      expect(await listed(holder)).toContain(mail.first);
      expect(await opens(holder, mail.first)).toBe(true);
      expect((await mailboxList(holder)).main).toEqual({ id: main, unread: 1 });
      expect(await badge(holder)).toBe(1);
      expect(await listed(stranger)).not.toContain(mail.first);
    });

    it('keeps an Admin reading it once somebody active is linked: an Admin reads every mailbox', async () => {
      const { org, customer, main } = await newOrg();
      const admin = await personWith(org, ADMIN);
      const linked = await personWith(org, {});
      const mail = await addConversation(org, main, customer);
      await link(org, main, linked);

      expect(await listed(admin)).toContain(mail.first);
      expect(await opens(admin, mail.first)).toBe(true);
      expect(await listed(linked)).toContain(mail.first);
    });

    it('lets a linked person who is also an Admin read it', async () => {
      const { org, customer, main } = await newOrg();
      const both = await personWith(org, ADMIN);
      await link(org, main, both);
      const mail = await addConversation(org, main, customer);
      expect(await listed(both)).toContain(mail.first);
    });

    it('lists every conversation in the main mailbox on All, linked or not, and the migrated and record ones too', async () => {
      const { org, customer, main } = await newOrg();
      const wide = await personWith(org, { communication_scope: 'all' });
      const other = await personWith(org, {});
      await link(org, main, other);
      const job = await fx.addJob(org, customer, { crew: [] });
      const started = await addConversation(org, main, customer);
      const migrated = await addConversation(org, main, customer, { origin: 'migrated' });
      const moved = await addConversation(org, main, customer, { origin: 'moved' });
      const record = await addConversation(org, main, customer, { record: { type: 'job', id: job.id } });

      expect(await listed(wide, `?mailbox=${main}`)).toEqual(expect.arrayContaining([started.first, migrated.first, moved.first, record.first]));
      expect((await mailboxList(wide)).main).toEqual({ id: main, unread: 4 });
    });
  });

  describe('what a reader sees in it', () => {
    it('lists only conversations started in it after go-live: not migrated, moved-in or record ones', async () => {
      const { org, admin, customer, main } = await newOrg();
      const reader = await personWith(org, {});
      await link(org, main, reader);
      const job = await fx.addJob(org, customer, { crew: [reader.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: reader.id });
      const started = await addConversation(org, main, customer);
      const migrated = await addConversation(org, main, customer, { origin: 'migrated' });
      const moved = await addConversation(org, main, customer, { origin: 'moved' });
      // Record conversations the reader can open the record of: they follow the record, never the shared box.
      const jobNotice = await addConversation(org, main, customer, { record: { type: 'job', id: job.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] });
      const invoiceMail = await addConversation(org, main, customer, { record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] });
      void admin;

      // The reader is on the job's crew, so the job notice and the invoice mail are theirs as one of the record's people (S10.9):
      // on their Email page and in "My mailbox", but never through the main mailbox entry. Migrated and moved-in ones are not.
      const ids = await listed(reader);
      expect(ids).toContain(started.first);
      for (const c of [migrated, moved]) for (const id of c.ids) expect(ids, id).not.toContain(id);
      for (const c of [jobNotice, invoiceMail]) expect(ids).toEqual(expect.arrayContaining(c.ids));
      // Picking the main mailbox on the Email page lists only what was started in it.
      const picked = await listed(reader, `?mailbox=${main}`);
      expect(picked).toEqual([started.first]);
      // Counts agree with the list: the main mailbox counts what it lists, the menu badge everything the section lists.
      expect((await mailboxList(reader)).main).toEqual({ id: main, unread: 1 });
      expect(await badge(reader)).toBe(3);
      expect((await mailboxList(reader, `?selected=${main}`)).selected_unread).toBe(1);
    });

    it('reaches a migrated conversation only through a record the person can open, never through being assigned it (M1)', async () => {
      const { org, admin, customer, main } = await newOrg();
      const reader = await personWith(org, {});
      await link(org, main, reader);
      const job = await fx.addJob(org, customer, { crew: [reader.id] });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      // Assigned to the reader, its message on a job they are not on: nothing about it is theirs but the assignment.
      const assigned = await addConversation(org, main, customer, { origin: 'migrated', assignedTo: reader.id, messages: [{ direction: 'in', jobId: otherJob.id }] });
      const onMyJob = await addConversation(org, main, customer, { origin: 'migrated', messages: [{ direction: 'in', jobId: job.id }] });
      const ids = await listed(reader);
      expect(ids).not.toContain(assigned.first);
      expect(await opens(reader, assigned.first)).toBe(false);
      expect(ids).not.toContain(onMyJob.first);
      expect(await opens(reader, onMyJob.first)).toBe(true);
    });

    it('does not list a vendor-tied conversation to a person without View vendors, and lists it to one with', async () => {
      const { org, customer, main } = await newOrg();
      const without = await personWith(org, { view_vendors: false });
      const withVendors = await personWith(org, { view_vendors: true });
      await link(org, main, without);
      await link(org, main, withVendors);
      const vendor = await db.vendor.create({ data: { organization_id: org, name: 'Supplier Co', category: 'Supplies' }, select: { id: true } });
      const tied = await addConversation(org, main, customer, { messages: [{ direction: 'in', vendorId: vendor.id }] });
      const plain = await addConversation(org, main, customer);

      expect(await listed(without)).toEqual(expect.arrayContaining([plain.first]));
      expect(await listed(without)).not.toContain(tied.first);
      expect(await opens(without, tied.first)).toBe(false);
      expect((await mailboxList(without)).main).toEqual({ id: main, unread: 1 });
      expect(await badge(without)).toBe(1);
      expect(await listed(withVendors)).toEqual(expect.arrayContaining([plain.first, tied.first]));
      expect((await mailboxList(withVendors)).main).toEqual({ id: main, unread: 2 });
    });

    it('reads, marks read and unread, attaches and replies in a main mailbox conversation as its reader, and refuses all of it to a person who does not read it', async () => {
      vi.mocked(sendComposedEmail).mockImplementation(async () => ({
        status: 'sent', providerMessageId: `re_${randomUUID()}`, fromAddress: 'no-reply@mail.test.com', fromName: null,
      }) as never);
      const { org, customer, main } = await newOrg();
      const reader = await personWith(org, { contact_customers: true });
      const stranger = await personWith(org, { contact_customers: true });
      await userMailbox(org, reader);
      await userMailbox(org, stranger);
      await link(org, main, reader);
      const mail = await addConversation(org, main, customer, { messages: [{ direction: 'in' }, { direction: 'in' }] });
      await db.emailAttachment.create({
        data: {
          email_id: mail.first, file_name: 'quote.pdf', content_type: 'application/pdf', file_size: 10,
          storage_path: `${org}/email/${mail.first}/quote.pdf`, position: 0, organization_id: org,
        },
      });

      const r = await reader.api();
      expect((await r.get(`/api/communication/emails/${mail.first}`)).status).toBe(200);
      expect((await r.get(`/api/communication/emails/${mail.first}/attachments/0`)).status).toBe(200);
      expect((await r.patch('/api/communication/emails/thread-read', { thread_id: mail.thread })).body).toEqual({ updated: 2 });
      expect(await badge(reader)).toBe(0);
      expect((await r.patch('/api/communication/emails/thread-unread', { thread_id: mail.thread })).status).toBe(200);
      expect(await badge(reader)).toBe(2);
      const reply = await r.post('/api/communication/emails', { to: 'customer@example.com', subject: 'Re', body: ['Hi'], thread_id: mail.thread });
      expect(reply.status).toBe(201);
      expect(await db.email.count({ where: { thread_id: mail.thread, direction: 'out' } })).toBe(1);

      const s = await stranger.api();
      expect((await s.get(`/api/communication/emails/${mail.first}`)).status).toBe(404);
      expect((await s.get(`/api/communication/emails/${mail.first}/attachments/0`)).status).toBe(404);
      expect((await s.patch('/api/communication/emails/thread-read', { thread_id: mail.thread })).body).toEqual({ updated: 0 });
      const stray = await s.post('/api/communication/emails', { to: 'customer@example.com', subject: 'Re', body: ['Hi'], thread_id: mail.thread });
      expect(stray.status).toBe(201);
      expect(await db.email.count({ where: { thread_id: mail.thread, direction: 'out' } })).toBe(1);
    });

    it('keeps read state per person: a reader opening main mailbox mail does not read it for another reader', async () => {
      const { org, customer, main } = await newOrg();
      const a = await personWith(org, {});
      const b = await personWith(org, {});
      await link(org, main, a);
      await link(org, main, b);
      const mail = await addConversation(org, main, customer);
      await (await a.api()).patch('/api/communication/emails/thread-read', { thread_id: mail.thread });
      expect(await badge(a)).toBe(0);
      expect(await badge(b)).toBe(1);
    });
  });

  describe('unlinking', () => {
    it('takes effect on the very next request, and the person keeps nothing that was only assigned to them or written in by them (M1)', async () => {
      const { org, customer, main } = await newOrg();
      const reader = await personWith(org, {});
      const colleague = await personWith(org, {});
      await link(org, main, reader);
      await link(org, main, colleague);
      const mail = await addConversation(org, main, customer);
      const assigned = await addConversation(org, main, customer, { assignedTo: reader.id });
      const wroteIn = await addConversation(org, main, customer, { messages: [{ direction: 'in' }, { direction: 'out', sentBy: reader.id }] });
      expect(await listed(reader)).toEqual(expect.arrayContaining([mail.first, assigned.first, ...wroteIn.ids]));

      await db.mailboxReader.deleteMany({ where: { user_id: reader.id } });

      const after = await listed(reader);
      for (const id of [mail.first, assigned.first, ...wroteIn.ids]) {
        expect(after, id).not.toContain(id);
        expect(await opens(reader, id), id).toBe(false);
      }
      expect((await mailboxList(reader)).main).toBeNull();
      // Picking the main mailbox no longer works: the page falls back to the person's own.
      const fallback = await mailboxList(reader, `?selected=${main}`);
      expect(fallback.selected).toBe('mine');
      expect(await listed(colleague)).toContain(mail.first);
    });

    it('goes through the Sender Address routes the same way: unlink, then the next request sees nothing', async () => {
      const { org, customer, main, admin } = await newOrg();
      const reader = await personWith(org, {});
      const mail = await addConversation(org, main, customer);
      // Adding and removing a reader is an Admin's alone (M8, D3).
      const s = await fx.signedInAs(admin);
      expect((await s.put(`/api/organization/email-sender/readers/${reader.id}`)).status).toBe(200);
      expect(await listed(reader)).toContain(mail.first);
      expect((await s.delete(`/api/organization/email-sender/readers/${reader.id}`)).status).toBe(200);
      expect(await listed(reader)).not.toContain(mail.first);
    });
  });

  describe('another company', () => {
    it('never reaches the main mailbox of another company, linked or not, and never lists it as a mailbox to pick', async () => {
      const mine = await newOrg();
      const theirs = await newOrg();
      const reader = await personWith(mine.org, {});
      const wide = await personWith(mine.org, { communication_scope: 'all' });
      await link(mine.org, mine.main, reader);
      const foreign = await addConversation(theirs.org, theirs.main, theirs.customer);

      for (const person of [reader, wide]) {
        expect(await listed(person)).not.toContain(foreign.first);
        expect(await listed(person, `?mailbox=${theirs.main}`)).not.toContain(foreign.first);
        expect(await opens(person, foreign.first)).toBe(false);
        expect((await mailboxList(person, `?selected=${theirs.main}`)).selected).toBe('mine');
      }
      // A link row naming the other company's mailbox gives nothing either.
      await db.mailboxReader.create({ data: { organization_id: mine.org, mailbox_id: theirs.main, user_id: reader.id } });
      expect(await listed(reader)).not.toContain(foreign.first);
    });
  });

  describe('what it costs on the hosted database\'s one connection', () => {
    it('answers the mailbox list and the menu badge in a fixed number of reads however much mail the main mailbox holds, for a reader and for a person who is not', async () => {
      const { org, customer, main } = await newOrg();
      const reader = await personWith(org, {});
      const stranger = await personWith(org, {});
      await link(org, main, reader);
      const queries: string[] = [];
      (db as unknown as { $on: (e: 'query', cb: (q: { query: string }) => void) => void }).$on('query', (q) => { queries.push(q.query); });
      const reads = async (person: Who, path: string) => {
        const api = await person.api();
        await api.get(path);
        queries.length = 0;
        const res = await api.get(path);
        expect(res.status).toBe(200);
        return queries.length;
      };
      await addConversation(org, main, customer);
      const before = {
        readerList: await reads(reader, '/api/communication/mailboxes'),
        readerBadge: await reads(reader, '/api/communication/unread-counts'),
        strangerList: await reads(stranger, '/api/communication/mailboxes'),
        strangerBadge: await reads(stranger, '/api/communication/unread-counts'),
      };
      for (let i = 0; i < 30; i++) await addConversation(org, main, customer);
      const after = {
        readerList: await reads(reader, '/api/communication/mailboxes'),
        readerBadge: await reads(reader, '/api/communication/unread-counts'),
        strangerList: await reads(stranger, '/api/communication/mailboxes'),
        strangerBadge: await reads(stranger, '/api/communication/unread-counts'),
      };
      // eslint-disable-next-line no-console
      console.info(`reads per request, reader: list ${after.readerList}, badge ${after.readerBadge}; not a reader: list ${after.strangerList}, badge ${after.strangerBadge}`);
      expect(after).toEqual(before);
      // Before S10.8 the same person cost 4 reads for the list and 7 for the badge. The main mailbox adds ONE read to every
      // Email request (who reads it, in a single statement), and one count to a reader's list; a reader's badge costs no more
      // than anyone's. The numbers are pinned so a change that makes the main mailbox cost more has to say so. S10.9 adds ONE
      // read to every Email request of a person on "Linked to me" (the record's people: one statement that starts at the
      // person's own jobs and leads, whatever the company's mail), so 5 -> 6, 6 -> 7 and 8 -> 9. S10.18 adds the Needs review
      // folder's counts to the mailbox list only: ONE grouped count of the held messages the person sees, and, for a person who
      // reads a mailbox, one read that settles whether any held reply points at a record conversation (none here, so no reach is
      // worked out): 7 -> 9. A person who reads no mailbox has nothing to count and is asked nothing (6 stays 6). The badge is
      // untouched: held mail is never unread mail.
      // Ticket 37 adds ONE read to every signed-in request: the person's access stamp, read from the database so a change made
      // on another server is seen at once (lib/permissions/accessStamp.ts). 9 -> 10, 6 -> 7.
      expect(after).toEqual({ readerList: 10, readerBadge: 10, strangerList: 7, strangerBadge: 10 });
      expect(await badge(reader)).toBe(31);
      // The badge is the same few reads whether the person reads the main mailbox or not (the reader adds none).
      expect(after.readerBadge).toBe(after.strangerBadge);
    });
  });

  describe('every main mailbox endpoint with Access Communication off', () => {
    it('refuses a linked person who has the Email page off, whatever the link', async () => {
      const { org, customer, main } = await newOrg();
      const off = await personWith(org, { ...withDependantsOff(['access_communication']) });
      await link(org, main, off);
      const mail = await addConversation(org, main, customer);
      const api = await off.api();
      expect((await api.get('/api/communication/emails')).status).toBe(403);
      expect((await api.get(`/api/communication/emails/${mail.first}`)).status).toBe(403);
      expect((await api.get('/api/communication/mailboxes')).status).toBe(403);
    });
  });

  beforeEach(() => {
    vi.mocked(sendComposedEmail).mockClear();
  });
});
