/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.7 - the Email page's mailbox list and M11's mailbox rule.

   Under "Linked to me" a conversation is in a person's list when it sits in a mailbox they hold (unless it is a record
   conversation they can no longer reach), or it is assigned to them, or they wrote in it. Under All it is every
   conversation in every mailbox. A record conversation follows its record in every mailbox. Read state stays per person.

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

suite('the Email page lists mailboxes by M11\'s rule (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
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
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `mbx-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, view_invoices: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'attached',
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The user mailbox issued to `owner`, held by `holder` (the owner unless it was handed over). */
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

  /** The company's main mailbox, made once. */
  async function mainMailbox(org: string): Promise<string> {
    const found = await db.mailbox.findFirst({ where: { organization_id: org, kind: 'main' }, select: { id: true } });
    if (found) return found.id;
    const id = randomUUID();
    await db.mailbox.create({ data: { id, organization_id: org, kind: 'main', status: 'active' } });
    return id;
  }

  type Message = { direction?: 'out' | 'in'; sentBy?: string; jobId?: string; customerId?: string; subject?: string };
  type Conversation = {
    origin?: string; record?: { type: string; id: string }; assignedTo?: string; messages?: Message[];
  };

  /** A conversation in `mailboxId`, holding the messages given (one unread inbound message when none are). */
  async function addConversation(org: string, mailboxId: string, customer: string, conv: Conversation = {}) {
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
          id, organization_id: org, thread_id: thread, customer_id: m.customerId ?? customer, job_id: m.jobId ?? null,
          account: out ? 'user' : 'user', direction: out ? 'out' : 'in', folder: out ? 'sent' : 'inbox',
          sent_by_user_id: m.sentBy ?? null,
          from: { name: null, email: out ? 'office@example.com' : 'customer@example.com' },
          to: out ? 'customer@example.com' : 'office@example.com',
          subject: m.subject ?? 'run-mailbox', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
        select: { id: true },
      });
      ids.push(id);
    }
    return { thread, ids, first: ids[0]! };
  }

  const listed = async (person: { api: () => Promise<Api> }, query = '') => {
    const res = await (await person.api()).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };

  const INVOICES_VIEW_OFF = withDependantsOff(['view_invoices']);
  const ESTIMATES_VIEW_OFF = withDependantsOff(['view_estimates']);

  /** What a person can read of one message, through the by-id route. */
  const opens = async (person: { api: () => Promise<Api> }, id: string) =>
    (await (await person.api()).get(`/api/communication/emails/${id}`)).status === 200;

  describe('under "Linked to me" and All', () => {
    it('lists the own mailbox and not a colleague\'s, not even what is assigned to the person or what they wrote in (M1)', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const colleague = await personWith(org, {});
      const mine = await userMailbox(org, person);
      const theirs = await userMailbox(org, colleague);
      const inMine = await addConversation(org, mine, customer);
      const inTheirs = await addConversation(org, theirs, customer);
      const assigned = await addConversation(org, theirs, customer, { assignedTo: person.id });
      const wroteIn = await addConversation(org, theirs, customer, {
        messages: [{ direction: 'in' }, { direction: 'out', sentBy: person.id }],
      });

      const ids = await listed(person);
      expect(ids).toContain(inMine.first);
      for (const id of [inTheirs.first, ...assigned.ids, ...wroteIn.ids]) {
        expect(ids, id).not.toContain(id);
        expect(await opens(person, id), id).toBe(false);
      }
      // "My mailbox" narrows the section: it cannot bring them back either.
      const mineOnly = await listed(person, '?mailbox=mine');
      for (const id of [...assigned.ids, ...wroteIn.ids]) expect(mineOnly, id).not.toContain(id);
    });

    it('lists a mailbox handed to the person, by whoever it was issued to', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const leaver = await personWith(org, {});
      const handed = await userMailbox(org, leaver, person);
      const inHanded = await addConversation(org, handed, customer);
      expect(await listed(person)).toContain(inHanded.first);
    });

    it('lists every mailbox on All, and only the one mailbox picked', async () => {
      const { org, customer } = await newOrg();
      const wide = await personWith(org, { communication_scope: 'all' });
      const a = await personWith(org, {});
      const b = await personWith(org, {});
      const mailboxA = await userMailbox(org, a);
      const mailboxB = await userMailbox(org, b);
      const main = await mainMailbox(org);
      const inA = await addConversation(org, mailboxA, customer);
      const inB = await addConversation(org, mailboxB, customer);
      const inMain = await addConversation(org, main, customer);

      expect(await listed(wide)).toEqual(expect.arrayContaining([inA.first, inB.first, inMain.first]));
      expect(await listed(wide, `?mailbox=${mailboxA}`)).toEqual([inA.first]);
      expect(await listed(wide, `?mailbox=${main}`)).toEqual([inMain.first]);
    });

    it('keeps a mailbox the person may not open from listing: a colleague\'s id falls back to their own mailbox', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const colleague = await personWith(org, {});
      const mine = await userMailbox(org, person);
      const theirs = await userMailbox(org, colleague);
      const inMine = await addConversation(org, mine, customer);
      const inTheirs = await addConversation(org, theirs, customer);
      expect(await listed(person, `?mailbox=${theirs}`)).toEqual([inMine.first]);
      expect(await listed(person, `?mailbox=${theirs}`)).not.toContain(inTheirs.first);
    });
  });

  describe('record conversations follow the record, in every mailbox', () => {
    it('keeps an invoice, an estimate and a job notice (and their customer replies) out of the list and the by-id read of a person who cannot open the record, whichever mailbox they sit in', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, { ...INVOICES_VIEW_OFF, ...ESTIMATES_VIEW_OFF });
      const mine = await userMailbox(org, person);
      const main = await mainMailbox(org);
      const job = await fx.addJob(org, customer, { crew: [admin.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });

      const everything = [];
      for (const box of [mine, main]) {
        everything.push(
          await addConversation(org, box, customer, { record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] }),
          await addConversation(org, box, customer, { record: { type: 'estimate', id: estimate.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] }),
          await addConversation(org, box, customer, { record: { type: 'job', id: job.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] }),
        );
      }
      const ids = await listed(person);
      for (const c of everything) for (const id of c.ids) {
        expect(ids, id).not.toContain(id);
        expect(await opens(person, id), id).toBe(false);
      }
    });

    it('lists them, in the person\'s own mailbox, for one who can open the record, and opens the whole conversation including the reply', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const mine = await userMailbox(org, person);
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const mine1 = await addConversation(org, mine, customer, { record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] });
      const mine2 = await addConversation(org, mine, customer, { record: { type: 'estimate', id: estimate.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] });
      const mine3 = await addConversation(org, mine, customer, { record: { type: 'job', id: job.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] });
      const ids = await listed(person);
      for (const c of [mine1, mine2, mine3]) for (const id of c.ids) {
        expect(ids).toContain(id);
        expect(await opens(person, id)).toBe(true);
      }
    });

    it('opens an invoice conversation for the person who made the invoice while they are on the job with View invoices on, and not once they are taken off it (attachment wins)', async () => {
      const { org, customer } = await newOrg();
      const creator = await personWith(org, { view_invoices: true, jobs_scope: 'attached', leads_scope: 'attached' });
      const mine = await userMailbox(org, creator);
      const job = await fx.addJob(org, customer, { crew: [creator.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: creator.id });
      const conv = await addConversation(org, mine, customer, { record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] });

      expect(await listed(creator)).toEqual(expect.arrayContaining(conv.ids));
      expect(await opens(creator, conv.ids[1]!)).toBe(true);

      await fx.removeCrew(job.visitId!, creator.id);
      expect(await listed(creator)).not.toEqual(expect.arrayContaining(conv.ids));
      for (const id of conv.ids) expect(await opens(creator, id)).toBe(false);
    });

    it('keeps an ordinary conversation in the person\'s own mailbox, tied to a job they were taken off, listed and readable', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const mine = await userMailbox(org, person);
      const job = await fx.addJob(org, customer, { crew: [person.id, admin.id] });
      const conv = await addConversation(org, mine, customer, { messages: [{ direction: 'in', jobId: job.id }, { direction: 'out', sentBy: person.id, jobId: job.id }] });
      expect(await listed(person)).toEqual(expect.arrayContaining(conv.ids));

      await fx.removeCrew(job.visitId!, person.id);
      expect(await listed(person)).toEqual(expect.arrayContaining(conv.ids));
      for (const id of conv.ids) expect(await opens(person, id)).toBe(true);
    });

    it('does not list a pre-migration conversation to a person who merely reads the company, opens it through a job they can open, and neither lists nor opens it for being assigned to them (M1)', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const main = await mainMailbox(org);
      const myJob = await fx.addJob(org, customer, { crew: [person.id] });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      const onMyJob = await addConversation(org, main, customer, { origin: 'migrated', messages: [{ direction: 'in', jobId: myJob.id }] });
      const onOtherJob = await addConversation(org, main, customer, { origin: 'migrated', messages: [{ direction: 'in', jobId: otherJob.id }] });
      const assigned = await addConversation(org, main, customer, { origin: 'migrated', assignedTo: person.id, messages: [{ direction: 'in', jobId: otherJob.id }] });

      const ids = await listed(person);
      expect(ids).not.toContain(onMyJob.first);
      expect(ids).not.toContain(onOtherJob.first);
      expect(ids).not.toContain(assigned.first);
      expect(await opens(person, onMyJob.first)).toBe(true);
      expect(await opens(person, onOtherJob.first)).toBe(false);
      expect(await opens(person, assigned.first)).toBe(false);
    });

    it('does not let assignment or a message the person wrote reopen a record conversation they can no longer open', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, { ...INVOICES_VIEW_OFF });
      const colleague = await personWith(org, {});
      const theirs = await userMailbox(org, colleague);
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      const assigned = await addConversation(org, theirs, customer, { record: { type: 'invoice', id: invoice.id }, assignedTo: person.id, messages: [{ direction: 'out', jobId: job.id }] });
      const wrote = await addConversation(org, theirs, customer, { record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', sentBy: person.id, jobId: job.id }] });
      const ids = await listed(person);
      expect(ids).not.toContain(assigned.first);
      expect(ids).not.toContain(wrote.first);
      expect(await opens(person, assigned.first)).toBe(false);
    });

    it('keeps a calendar entry notice (a record conversation tied to its customer) out of reach of a person who cannot open the customer, whichever way it came to them', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const colleague = await personWith(org, {});
      const mine = await userMailbox(org, person);
      const theirs = await userMailbox(org, colleague);
      const main = await mainMailbox(org);
      await fx.addJob(org, customer, { crew: [admin.id] });
      const entry = { type: 'calendar_entry', id: randomUUID() };
      const messages: Message[] = [{ direction: 'out' }, { direction: 'in' }];
      const inMine = await addConversation(org, mine, customer, { record: entry, messages });
      const inMain = await addConversation(org, main, customer, { record: entry, messages });
      const assigned = await addConversation(org, theirs, customer, { record: entry, assignedTo: person.id, messages });
      const wrote = await addConversation(org, theirs, customer, { record: entry, messages: [{ direction: 'out', sentBy: person.id }] });
      const ids = await listed(person);
      for (const c of [inMine, inMain, assigned, wrote]) for (const id of c.ids) {
        expect(ids, id).not.toContain(id);
        expect(await opens(person, id), id).toBe(false);
      }
    });

    it('lists a calendar entry notice in the person\'s own mailbox, and opens it from a colleague\'s, once they can open its customer', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const colleague = await personWith(org, {});
      const mine = await userMailbox(org, person);
      const theirs = await userMailbox(org, colleague);
      await fx.addJob(org, customer, { crew: [person.id] });
      const entry = { type: 'calendar_entry', id: randomUUID() };
      const messages: Message[] = [{ direction: 'out' }, { direction: 'in' }];
      const inMine = await addConversation(org, mine, customer, { record: entry, messages });
      const inTheirs = await addConversation(org, theirs, customer, { record: entry, messages });
      const ids = await listed(person);
      for (const id of inMine.ids) {
        expect(ids).toContain(id);
        expect(await opens(person, id)).toBe(true);
      }
      for (const id of inTheirs.ids) {
        expect(ids).not.toContain(id);
        expect(await opens(person, id)).toBe(true);
      }
    });

    it('opens a record conversation in a colleague\'s mailbox through the record alone, without listing it, unless the person is one of the record\'s people', async () => {
      const { org, customer } = await newOrg();
      // Can open every job, but is none of this job's people: the record opens it for them, their Email page does not list it.
      const person = await personWith(org, { jobs_scope: 'all' });
      const crew = await personWith(org, {});
      const colleague = await personWith(org, {});
      const theirs = await userMailbox(org, colleague);
      const job = await fx.addJob(org, customer, { crew: [crew.id] });
      const notice = await addConversation(org, theirs, customer, { record: { type: 'job', id: job.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] });
      expect(await listed(person)).not.toContain(notice.first);
      for (const id of notice.ids) expect(await opens(person, id)).toBe(true);
      // S10.9: the job's crew has the customer's reply on their own Email page, wherever the conversation sits.
      expect(await listed(crew)).toEqual(expect.arrayContaining(notice.ids));
    });

    it('lists every record conversation of every mailbox on All, the invoice ones included', async () => {
      const { org, admin, customer } = await newOrg();
      const wide = await personWith(org, { communication_scope: 'all', ...INVOICES_VIEW_OFF });
      const colleague = await personWith(org, {});
      const theirs = await userMailbox(org, colleague);
      const job = await fx.addJob(org, customer, { crew: [admin.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      const conv = await addConversation(org, theirs, customer, { record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] });
      expect(await listed(wide)).toEqual(expect.arrayContaining(conv.ids));
      for (const id of conv.ids) expect(await opens(wide, id)).toBe(true);
    });
  });

  describe('unread counts and the mailbox list', () => {
    type MailboxList = {
      scope: string; selected: string; selected_label: string | null; selected_unread: number; total_unread: number;
      mine: { id: string | null; unread: number } | null;
      held: { id: string; name: string; unread: number }[];
      main: { id: string; unread: number } | null;
      people: { items: { id: string; name: string; unread: number }[]; total: number; offset: number; limit: number } | null;
    };
    const mailboxList = async (person: { api: () => Promise<Api> }, query = ''): Promise<MailboxList> => {
      const res = await (await person.api()).get(`/api/communication/mailboxes${query}`);
      expect(res.status).toBe(200);
      return res.body;
    };
    const badge = async (person: { api: () => Promise<Api> }) => {
      const res = await (await person.api()).get('/api/communication/unread-counts');
      expect(res.status).toBe(200);
      return res.body.email as number;
    };

    it('counts the Email menu badge and each mailbox with the one filter the list uses', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, { ...INVOICES_VIEW_OFF });
      const colleague = await personWith(org, {});
      const leaver = await personWith(org, {});
      const mine = await userMailbox(org, person);
      const theirs = await userMailbox(org, colleague);
      const handed = await userMailbox(org, leaver, person);
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      await addConversation(org, mine, customer);
      await addConversation(org, mine, customer);
      await addConversation(org, handed, customer);
      for (let i = 0; i < 3; i++) await addConversation(org, theirs, customer);
      await addConversation(org, theirs, customer, { assignedTo: person.id });
      // An invoice conversation in the person's own mailbox, which they cannot open: counted nowhere.
      await addConversation(org, mine, customer, { record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] });

      const list = await mailboxList(person);
      expect(list.scope).toBe('attached');
      // The conversation assigned to the person from a colleague's mailbox is counted nowhere: assignment opens nothing (M1).
      expect(list.mine).toMatchObject({ id: mine, unread: 2 });
      expect(list.held).toEqual([expect.objectContaining({ id: handed, unread: 1 })]);
      expect(list.main).toBeNull();
      expect(list.people).toBeNull();
      expect(list.total_unread).toBe(3);
      expect(list.selected_unread).toBe(2);
      expect((await mailboxList(person, `?selected=${handed}`)).selected_unread).toBe(1);
      // The mailbox itself, picked by its id, counts its own conversations only.
      expect((await mailboxList(person, `?selected=${mine}`)).selected_unread).toBe(2);
      expect(await badge(person)).toBe(3);
      // What the page lists under "My mailbox" is what its count says.
      expect(await listed(person, '?mailbox=mine')).toHaveLength(list.mine!.unread);
    });

    it('lists every mailbox on All with one grouped count, and a person\'s mailbox by name', async () => {
      const { org, customer } = await newOrg();
      const wide = await personWith(org, { communication_scope: 'all' });
      const a = await personWith(org, {});
      const b = await personWith(org, {});
      const mailboxA = await userMailbox(org, a);
      const mailboxB = await userMailbox(org, b);
      const main = await mainMailbox(org);
      await addConversation(org, mailboxA, customer);
      await addConversation(org, mailboxB, customer);
      await addConversation(org, mailboxB, customer);
      await addConversation(org, main, customer);

      const list = await mailboxList(wide);
      expect(list.scope).toBe('all');
      expect(list.main).toMatchObject({ id: main, unread: 1 });
      expect(list.total_unread).toBe(4);
      expect(await badge(wide)).toBe(4);
      const byId = new Map(list.people!.items.map((i) => [i.id, i]));
      expect(byId.get(mailboxA)).toMatchObject({ unread: 1 });
      expect(byId.get(mailboxB)).toMatchObject({ unread: 2 });
      expect(byId.get(mailboxB)!.name).toContain('Tester');
    });

    it('keeps read state per person: a person on All opening a colleague\'s conversation does not read it for its holder', async () => {
      const { org, customer } = await newOrg();
      const wide = await personWith(org, { communication_scope: 'all' });
      const holder = await personWith(org, {});
      const theirs = await userMailbox(org, holder);
      const conv = await addConversation(org, theirs, customer, { messages: [{ direction: 'in' }, { direction: 'in' }] });
      const before = await mailboxList(wide);
      expect(before.people!.items.find((i) => i.id === theirs)!.unread).toBe(2);

      const opened = await (await wide.api()).patch('/api/communication/emails/thread-read', { thread_id: conv.thread });
      expect(opened.body).toEqual({ updated: 2 });
      await (await wide.api()).get(`/api/communication/emails/${conv.first}`);

      // The opener's own count fell; the holder's did not.
      expect((await mailboxList(wide)).people!.items.find((i) => i.id === theirs)!.unread).toBe(0);
      expect((await mailboxList(holder)).mine!.unread).toBe(2);
      expect(await badge(holder)).toBe(2);
      expect(await db.emailReadState.count({ where: { organization_id: org, user_id: holder.id } })).toBe(0);
    });

    it('answers the mailbox list in a fixed number of reads however many mailboxes the company has, and pages and searches the people', async () => {
      const { org, customer } = await newOrg();
      const wide = await personWith(org, { communication_scope: 'all' });
      const COUNT = 300;
      const users = Array.from({ length: COUNT }, (_, n) => ({
        id: randomUUID(), organization_id: org, email: `box${n}-${org.slice(0, 8)}@example.test`,
        first_name: `Zoe${String(n).padStart(3, '0')}`, last_name: 'Mailbox', role: 'DISPATCHER' as const,
      }));
      await db.user.createMany({ data: users });
      const boxes = users.map((u) => ({ id: randomUUID(), organization_id: org, kind: 'user', user_id: u.id, holder_user_id: u.id, status: 'active' }));
      await db.mailbox.createMany({ data: boxes });
      const threads = boxes.map((b) => ({ id: randomUUID(), organization_id: org, mailbox_id: b.id, origin: 'started' }));
      await db.emailThread.createMany({ data: threads });
      await db.email.createMany({
        data: threads.map((t) => ({
          id: randomUUID(), organization_id: org, thread_id: t.id, customer_id: customer, account: 'user', direction: 'in', folder: 'inbox',
          from: { name: null, email: 'customer@example.com' }, to: 'office@example.com', subject: 'run-mailbox', snippet: 's',
          body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        })),
      });

      const queries: string[] = [];
      (db as unknown as { $on: (e: 'query', cb: (q: { query: string }) => void) => void }).$on('query', (q) => { queries.push(q.query); });
      const api = await wide.api();
      await api.get('/api/communication/mailboxes');
      queries.length = 0;
      const first = await api.get('/api/communication/mailboxes');
      const reads = queries.length;
      expect(first.status).toBe(200);
      // eslint-disable-next-line no-console
      console.info(`mailbox list reads with ${COUNT} mailboxes on All: ${reads}`);
      const list = first.body as MailboxList;
      expect(list.people!.total).toBe(COUNT);
      expect(list.people!.items.length).toBeLessThanOrEqual(list.people!.limit);
      expect(list.people!.items.every((i) => i.unread === 1)).toBe(true);
      expect(list.total_unread).toBe(COUNT);

      // A small company costs the same number of reads.
      const small = await newOrg();
      const lone = await personWith(small.org, { communication_scope: 'all' });
      const smallApi = await lone.api();
      await smallApi.get('/api/communication/mailboxes');
      queries.length = 0;
      await smallApi.get('/api/communication/mailboxes');
      expect(reads).toBeLessThanOrEqual(queries.length + 1);

      const second = await mailboxList(wide, `?offset=${list.people!.limit}`);
      expect(second.people!.items[0]!.id).not.toBe(list.people!.items[0]!.id);
      const found = await mailboxList(wide, '?search=zoe123');
      expect(found.people!.total).toBe(1);
      expect(found.people!.items[0]).toMatchObject({ name: 'Zoe123 Mailbox', unread: 1 });
    }, 120_000);

    it('lists a mailbox picked from the people list, and resolves the selection the page shows', async () => {
      const { org, customer } = await newOrg();
      const wide = await personWith(org, { communication_scope: 'all' });
      const other = await personWith(org, {});
      const theirs = await userMailbox(org, other);
      const inTheirs = await addConversation(org, theirs, customer);
      expect((await mailboxList(wide, `?selected=${theirs}`)).selected).toBe(theirs);
      expect((await mailboxList(wide, `?selected=${theirs}`)).selected_label).toMatch(/ Tester's mailbox$/);
      expect((await mailboxList(wide, '?selected=mine')).selected_label).toBeNull();
      expect((await mailboxList(wide, '?selected=all')).selected).toBe('all');
      expect((await mailboxList(wide, '?selected=nonsense')).selected).toBe('mine');
      expect(await listed(wide, `?mailbox=${theirs}`)).toEqual([inTheirs.first]);

      expect((await mailboxList(wide, `?selected=${theirs}`)).selected_unread).toBe(1);
      expect((await mailboxList(wide, '?selected=all')).selected_unread).toBe(1);

      const narrow = await personWith(org, {});
      expect((await mailboxList(narrow, '?selected=all')).selected).toBe('mine');
      expect((await mailboxList(narrow, `?selected=${theirs}`)).selected).toBe('mine');
    });

    it('answers the mailbox list and the menu badge in a fixed number of reads however much unread mail and how many record conversations the person has', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const mine = await userMailbox(org, person);
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const api = await person.api();
      const queries: string[] = [];
      (db as unknown as { $on: (e: 'query', cb: (q: { query: string }) => void) => void }).$on('query', (q) => { queries.push(q.query); });
      const reads = async (path: string) => {
        await api.get(path);
        queries.length = 0;
        const res = await api.get(path);
        expect(res.status).toBe(200);
        return queries.length;
      };
      await addConversation(org, mine, customer);
      await addConversation(org, mine, customer, { record: { type: 'job', id: job.id }, messages: [{ direction: 'in', jobId: job.id }] });
      const listBefore = await reads('/api/communication/mailboxes');
      const badgeBefore = await reads('/api/communication/unread-counts');
      for (let i = 0; i < 25; i++) {
        await addConversation(org, mine, customer);
        await addConversation(org, mine, customer, { record: { type: 'job', id: job.id }, messages: [{ direction: 'in', jobId: job.id }] });
      }
      const listAfter = await reads('/api/communication/mailboxes');
      const badgeAfter = await reads('/api/communication/unread-counts');
      // eslint-disable-next-line no-console
      console.info(`reads on "Linked to me": mailbox list ${listAfter}, menu badge ${badgeAfter}`);
      expect(listAfter).toBe(listBefore);
      expect(badgeAfter).toBe(badgeBefore);
      expect((await mailboxList(person)).mine!.unread).toBe(52);
    });

    it('counts the picked mailbox even when it sits beyond the first page of people', async () => {
      const { org, customer } = await newOrg();
      const wide = await personWith(org, { communication_scope: 'all' });
      const early = await personWith(org, {});
      const late = await personWith(org, {});
      await db.user.update({ where: { id: early.id }, data: { first_name: 'Aaron' }, select: { id: true } });
      await db.user.update({ where: { id: late.id }, data: { first_name: 'Zelda' }, select: { id: true } });
      await userMailbox(org, early);
      const lateBox = await userMailbox(org, late);
      await addConversation(org, lateBox, customer);
      await addConversation(org, lateBox, customer);

      const list = await mailboxList(wide, `?selected=${lateBox}&limit=1`);
      expect(list.people!.items.map((i) => i.id)).not.toContain(lateBox);
      expect(list.selected).toBe(lateBox);
      expect(list.selected_unread).toBe(2);
    });
  });

  describe('every mailbox endpoint, under "Linked to me", All and with Access Communication off', () => {
    const SECTION_OFF = withDependantsOff(['access_communication']);

    async function setup() {
      const { org, customer } = await newOrg();
      const colleague = await personWith(org, {});
      const theirs = await userMailbox(org, colleague);
      const inTheirs = await addConversation(org, theirs, customer, { messages: [{ direction: 'in' }, { direction: 'in' }] });
      const mineOf = async (person: Person) => {
        const box = await userMailbox(org, person);
        return addConversation(org, box, customer, { messages: [{ direction: 'in' }, { direction: 'in' }] });
      };
      return { org, customer, colleague, theirs, inTheirs, mineOf };
    }

    /** Every endpoint the Email page uses, called as the person, against their own conversation and a colleague's. */
    async function callEvery(person: { api: () => Promise<Api> }, own: { thread: string; first: string }, others: { thread: string; first: string }) {
      const api = await person.api();
      return {
        list: (await api.get('/api/communication/emails')).status,
        detail: (await api.get(`/api/communication/emails/${own.first}`)).status,
        detailOther: (await api.get(`/api/communication/emails/${others.first}`)).status,
        attachment: (await api.get(`/api/communication/emails/${own.first}/attachments/0`)).status,
        read: (await api.patch('/api/communication/emails/thread-read', { thread_id: own.thread })).status,
        unread: (await api.patch('/api/communication/emails/thread-unread', { thread_id: own.thread })).status,
        counts: (await api.get('/api/communication/unread-counts')).status,
        mailboxes: (await api.get('/api/communication/mailboxes')).status,
        myMailbox: (await api.get('/api/communication/my-mailbox')).status,
      };
    }

    it('refuses every one of them without Access Communication, the own mailbox included', async () => {
      const { org, mineOf, inTheirs } = await setup();
      const person = await personWith(org, { ...SECTION_OFF });
      const own = await mineOf(person);
      const results = await callEvery(person, own, inTheirs);
      for (const [name, status] of Object.entries(results)) expect(status, name).toBe(403);
    });

    it('answers a person on "Linked to me" for their own conversation and refuses a colleague\'s by id', async () => {
      const { org, mineOf, inTheirs } = await setup();
      const person = await personWith(org, {});
      const own = await mineOf(person);
      const results = await callEvery(person, own, inTheirs);
      expect(results).toMatchObject({ list: 200, detail: 200, detailOther: 404, read: 200, unread: 200, counts: 200, mailboxes: 200, myMailbox: 200 });
      expect(results.attachment).toBe(404); // the message has no attachment: not a refusal of the gate
    });

    it('answers a person on All for a colleague\'s conversation too', async () => {
      const { org, mineOf, inTheirs } = await setup();
      const person = await personWith(org, { communication_scope: 'all' });
      const own = await mineOf(person);
      const results = await callEvery(person, own, inTheirs);
      expect(results).toMatchObject({ list: 200, detail: 200, detailOther: 200, read: 200, unread: 200, counts: 200, mailboxes: 200 });
    });
  });

  describe('compose and reply', () => {
    const SECTION_OFF = withDependantsOff(['access_communication']);
    // No email leaves the machine: the dispatch is the suite-wide stub, answering each send with its own message id.
    beforeEach(() => {
      vi.mocked(sendComposedEmail).mockImplementation(async () => ({
        status: 'sent', providerMessageId: `re_${randomUUID()}`, fromAddress: 'no-reply@mail.test.com', fromName: null,
      }) as never);
    });
    const send = async (person: { api: () => Promise<Api> }, body: Record<string, unknown>) =>
      (await person.api()).post('/api/communication/emails', { to: 'customer@example.com', subject: 'Hello', body: ['Hi'], ...body });

    it('refuses a reply and a send from the Email page without Access Communication, and still lets a record tab send', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, { ...SECTION_OFF, contact_customers: true });
      const mine = await userMailbox(org, person);
      const conv = await addConversation(org, mine, customer);
      const job = await fx.addJob(org, customer, { crew: [person.id] });

      expect((await send(person, { thread_id: conv.thread })).status).toBe(403);
      expect((await send(person, {})).status).toBe(403);
      // A reply that also names a job is still a reply.
      expect((await send(person, { thread_id: conv.thread, job_id: job.id })).status).toBe(403);
      // The job's own tab sends with no section at all.
      expect((await send(person, { job_id: job.id })).status).toBe(201);
    });

    it('replies in the person\'s own conversation, and never into a colleague\'s mailbox', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, { contact_customers: true });
      const colleague = await personWith(org, {});
      const mine = await userMailbox(org, person);
      const theirs = await userMailbox(org, colleague);
      const own = await addConversation(org, mine, customer);
      const other = await addConversation(org, theirs, customer);

      const reply = await send(person, { thread_id: own.thread });
      expect(reply.status).toBe(201);
      expect(await db.email.count({ where: { thread_id: own.thread, direction: 'out' } })).toBe(1);

      const stray = await send(person, { thread_id: other.thread });
      expect(stray.status).toBe(201);
      expect(await db.email.count({ where: { thread_id: other.thread } })).toBe(1);
    });

    it('replies in any conversation for a person on All, and a send they compose is theirs to list', async () => {
      const { org, customer } = await newOrg();
      const wide = await personWith(org, { communication_scope: 'all', contact_customers: true });
      await userMailbox(org, wide);
      const colleague = await personWith(org, {});
      const theirs = await userMailbox(org, colleague);
      const other = await addConversation(org, theirs, customer);
      expect((await send(wide, { thread_id: other.thread })).status).toBe(201);
      expect(await db.email.count({ where: { thread_id: other.thread, direction: 'out' } })).toBe(1);

      const narrow = await personWith(org, { contact_customers: true });
      await userMailbox(org, narrow);
      const composed = await send(narrow, {});
      expect(composed.status).toBe(201);
      expect(await listed(narrow, '?mailbox=mine')).toContain(composed.body.email.id);
    });
  });

  describe('the attachment link, and replying into a record conversation', () => {
    async function withAttachment(org: string, email: string) {
      await db.emailAttachment.create({
        data: {
          email_id: email, file_name: 'quote.pdf', content_type: 'application/pdf', file_size: 10,
          storage_path: `${org}/email/${email}/quote.pdf`, position: 0, organization_id: org,
        },
      });
    }

    it('mints an attachment link for a message the person can read and not for a colleague\'s', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const colleague = await personWith(org, {});
      const mine = await addConversation(org, await userMailbox(org, person), customer);
      const theirs = await addConversation(org, await userMailbox(org, colleague), customer);
      await withAttachment(org, mine.first);
      await withAttachment(org, theirs.first);
      const api = await person.api();
      expect((await api.get(`/api/communication/emails/${mine.first}/attachments/0`)).status).toBe(200);
      expect((await api.get(`/api/communication/emails/${theirs.first}/attachments/0`)).status).toBe(404);
    });

    it('keeps the PDF of an invoice conversation from a person who cannot open the invoice, whichever mailbox it sits in', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, { ...INVOICES_VIEW_OFF });
      const mine = await userMailbox(org, person);
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      const conv = await addConversation(org, mine, customer, { record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', jobId: job.id }] });
      await withAttachment(org, conv.first);
      expect((await (await person.api()).get(`/api/communication/emails/${conv.first}/attachments/0`)).status).toBe(404);
    });

    it('does not let a reply land in a record conversation the person cannot open', async () => {
      vi.mocked(sendComposedEmail).mockImplementation(async () => ({
        status: 'sent', providerMessageId: `re_${randomUUID()}`, fromAddress: 'no-reply@mail.test.com', fromName: null,
      }) as never);
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, { ...INVOICES_VIEW_OFF, contact_customers: true });
      const mine = await userMailbox(org, person);
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      const conv = await addConversation(org, mine, customer, { record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }] });

      const reply = await (await person.api()).post('/api/communication/emails', { to: 'customer@example.com', subject: 'Re', body: ['Hi'], thread_id: conv.thread });
      expect(reply.status).toBe(201);
      expect(await db.email.count({ where: { thread_id: conv.thread } })).toBe(2);
    });
  });
});
