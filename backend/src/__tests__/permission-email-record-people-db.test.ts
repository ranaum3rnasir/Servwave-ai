/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.9 - record conversations with a customer reply list for the record's people.

   Under "Linked to me", a record conversation (the one a send to a customer opens about a job, a lead, an estimate or an
   invoice) with a customer reply in it joins the Email page of the record's people: the person who sent it by hand, the
   job's Sold By or the lead's Owner, its crew, its Dispatcher. Each only while they can open the record and, for an invoice
   or an estimate, that invoice or estimate. It is worked out from the record on every read, so losing the record loses the
   conversation on the next request. One rule serves the list, the single read, mark read, reply, the attachment link, the
   per-mailbox counts and the menu badge.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding exactly the
   switch values under test, against a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

suite('record conversations list for the record\'s people, by M11\'s rule (real database)', () => {
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
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;

  /** A company with its main mailbox, which nobody is linked to. */
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
  const INVOICES_VIEW_OFF = withDependantsOff(['view_invoices']);
  const ESTIMATES_VIEW_OFF = withDependantsOff(['view_estimates']);

  /** A person on a fresh custom role of this base holding exactly these switch values, with the Email page open. */
  async function personWith(org: string, values: Record<string, boolean | string> = {}, base: Role = 'DISPATCHER'): Promise<Who> {
    const key = `rpp-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, estimates_scope: 'attached', view_invoices: true, invoices_scope: 'attached',
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'linked_to_me',
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  type Message = { direction: 'out' | 'in'; sentBy?: string; match?: 'MATCHED' | 'UNMATCHED_SENDER' };

  /**
   * The conversation a send to a customer opened about a record, in the main mailbox with origin "record" (what the S10.4
   * migration and the sends leave). An outbound message is the system email the send mirrored; an inbound one is the
   * customer's reply. `sentBy` is the person who pressed Send by hand.
   */
  async function addRecordConversation(
    org: string, mailbox: string, customer: string, record: { type: string; id: string }, messages: Message[] = [{ direction: 'out' }],
  ) {
    const thread = randomUUID();
    await db.emailThread.create({
      data: { id: thread, organization_id: org, mailbox_id: mailbox, origin: 'record', record_type: record.type, record_id: record.id },
    });
    const ids: string[] = [];
    for (const m of messages) ids.push(await addMessage(org, thread, customer, m));
    return { thread, ids, org, customer };
  }

  async function addMessage(org: string, thread: string, customer: string, m: Message) {
    const id = randomUUID();
    const out = m.direction === 'out';
    await db.email.create({
      data: {
        id, organization_id: org, thread_id: thread, customer_id: customer,
        account: out ? 'system' : 'user', direction: m.direction, folder: out ? 'sent' : 'inbox',
        sent_by_user_id: m.sentBy ?? null, inbound_match: out ? null : m.match ?? 'MATCHED',
        from: { name: null, email: out ? 'office@example.com' : 'customer@example.com' },
        to: out ? 'customer@example.com' : 'office@example.com',
        subject: 'run-record-people', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
      },
      select: { id: true },
    });
    return id;
  }

  /** The customer writes back into the conversation. */
  const customerReplies = (c: { thread: string; org: string; customer: string }, match?: Message['match']) =>
    addMessage(c.org, c.thread, c.customer, { direction: 'in', match });

  const listed = async (person: Who, query = '') => {
    const res = await (await person.api()).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };
  const opens = async (person: Who, id: string) =>
    (await (await person.api()).get(`/api/communication/emails/${id}`)).status === 200;
  const badge = async (person: Who) => {
    const res = await (await person.api()).get('/api/communication/unread-counts');
    expect(res.status).toBe(200);
    return res.body.email as number;
  };

  describe('a job\'s people', () => {
    it('lists a job conversation to its Sold By, its crew and its Dispatcher once the customer has replied, and not before', async () => {
      const { org, customer, main } = await newOrg();
      const soldBy = await personWith(org);
      const crew = await personWith(org);
      const dispatcher = await personWith(org);
      const stranger = await personWith(org);
      const job = await fx.addJob(org, customer, { soldBy: soldBy.id, crew: [crew.id], dispatcher: dispatcher.id });
      const convo = await addRecordConversation(org, main, customer, { type: 'job', id: job.id });
      const people = [soldBy, crew, dispatcher];

      for (const p of people) {
        expect(await listed(p, '?folder=inbox'), 'before a reply, inbox').toEqual([]);
        expect(await listed(p, '?folder=sent'), 'before a reply, sent').toEqual([]);
        expect(await badge(p)).toBe(0);
      }

      const reply = await customerReplies(convo);
      for (const p of people) {
        expect(await listed(p, '?folder=inbox'), 'inbox').toEqual([reply]);
        expect(await listed(p, '?folder=sent'), 'sent').toEqual([convo.ids[0]]);
        expect(await opens(p, reply)).toBe(true);
        expect(await opens(p, convo.ids[0]!)).toBe(true);
        expect(await badge(p)).toBe(1);
      }
      expect(await listed(stranger)).toEqual([]);
      expect(await opens(stranger, reply)).toBe(false);
      expect(await badge(stranger)).toBe(0);
    });

    it('lists it to the person who sent the conversation\'s first email by hand, while they can open the job, and to nobody else it was not for', async () => {
      const { org, customer, main } = await newOrg();
      const sender = await personWith(org, { jobs_scope: 'all' });
      const blind = await personWith(org, { ...withDependantsOff(['view_jobs']) });
      const job = await fx.addJob(org, customer, { crew: [] });
      const convo = await addRecordConversation(org, main, customer, { type: 'job', id: job.id }, [{ direction: 'out', sentBy: sender.id }]);
      const reply = await customerReplies(convo);

      expect(await listed(sender, '?folder=inbox')).toEqual([reply]);
      expect(await opens(sender, reply)).toBe(true);
      expect(await badge(sender)).toBe(1);
      expect(await listed(blind, '?folder=inbox')).toEqual([]);
    });

    it('stops listing it the moment the person is taken off the crew, no longer Sold By, no longer the Dispatcher, or can no longer open jobs', async () => {
      const { org, customer, main } = await newOrg();
      const crew = await personWith(org);
      const soldBy = await personWith(org);
      const dispatcher = await personWith(org);
      const job = await fx.addJob(org, customer, { crew: [crew.id], soldBy: soldBy.id, dispatcher: dispatcher.id });
      const convo = await addRecordConversation(org, main, customer, { type: 'job', id: job.id });
      const reply = await customerReplies(convo);
      const stillListed = async (p: Who) => (await listed(p, '?folder=inbox')).includes(reply);
      expect([await stillListed(crew), await stillListed(soldBy), await stillListed(dispatcher)]).toEqual([true, true, true]);

      await fx.removeCrew(job.visitId!, crew.id);
      await db.job.update({ where: { id: job.id }, data: { salesperson_id: null, dispatcher_id: null }, select: { id: true } });

      expect([await stillListed(crew), await stillListed(soldBy), await stillListed(dispatcher)]).toEqual([false, false, false]);
      expect(await opens(crew, reply)).toBe(false);
      expect(await badge(crew)).toBe(0);

      // Back on the job, but with the right to open jobs switched off: the conversation is not theirs to read.
      await db.job.update({ where: { id: job.id }, data: { salesperson_id: soldBy.id }, select: { id: true } });
      expect(await stillListed(soldBy)).toBe(true);
      const key = (await db.user.findUniqueOrThrow({ where: { id: soldBy.id }, select: { custom_role: { select: { key: true } } } })).custom_role!.key;
      await setRoleSwitchValues({ organizationId: org, roleKey: key, values: withDependantsOff(['view_jobs']), actorId: null, reason: 'manual' });
      expect(await stillListed(soldBy)).toBe(false);
      expect(await opens(soldBy, reply)).toBe(false);
    });

    it('asks a scope that is not the Attached rows about the record: a Team scope lists it, and Team with no department does not', async () => {
      const { org, customer, main } = await newOrg();
      const department = await fx.addDepartment(org, 'Doors');
      const team = await personWith(org, { jobs_scope: 'team' });
      const teamless = await personWith(org, { jobs_scope: 'team' });
      await db.user.update({ where: { id: team.id }, data: { department_id: department }, select: { id: true } });
      const teamJob = await fx.addJob(org, customer, { crew: [team.id, teamless.id] });
      const teamReply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'job', id: teamJob.id }));
      expect(await listed(team, '?folder=inbox')).toEqual([teamReply]);
      expect(await badge(team)).toBe(1);
      // A Team scope for a person who is on no team reaches nothing, so the job is not theirs to read, crew or not.
      expect(await listed(teamless, '?folder=inbox')).toEqual([]);
      expect(await badge(teamless)).toBe(0);
    });

    it('does not count a reply that is not the customer\'s: an outbound message, or a wrong-sender reply nobody has linked', async () => {
      const { org, customer, main } = await newOrg();
      const crew = await personWith(org);
      const job = await fx.addJob(org, customer, { crew: [crew.id] });
      const convo = await addRecordConversation(org, main, customer, { type: 'job', id: job.id }, [{ direction: 'out' }, { direction: 'out' }]);
      // A wrong-sender reply is held with no conversation: it is on nobody's list until a person links it.
      const held = randomUUID();
      await db.email.create({
        data: {
          id: held, organization_id: org, thread_id: null, customer_id: customer, account: 'user', direction: 'in', folder: 'inbox',
          inbound_match: 'UNMATCHED_SENDER', reply_token: null,
          from: { name: null, email: 'stranger@example.com' }, to: 'office@example.com', subject: 'run-record-people',
          snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
      });
      expect(await listed(crew)).toEqual([]);
      expect(await badge(crew)).toBe(0);

      // Linked by hand (what the link route writes), it is the customer's reply and the conversation joins the list.
      await db.email.update({ where: { id: held }, data: { thread_id: convo.thread, inbound_match: 'MATCHED' }, select: { id: true } });
      expect(await listed(crew, '?folder=inbox')).toEqual([held]);
      expect(await badge(crew)).toBe(1);
    });

    it('never lists another company\'s conversation, even one about a job that names the person as its Sold By', async () => {
      const mine = await newOrg();
      const theirs = await newOrg();
      const person = await personWith(mine.org);
      const foreignJob = await fx.addJob(theirs.org, theirs.customer, { soldBy: person.id });
      const convo = await addRecordConversation(theirs.org, theirs.main, theirs.customer, { type: 'job', id: foreignJob.id });
      const reply = await customerReplies(convo);
      expect(await listed(person)).not.toContain(reply);
      expect(await opens(person, reply)).toBe(false);
      expect(await badge(person)).toBe(0);
    });
  });

  describe('one rule everywhere', () => {
    it('reads, marks read and unread, opens the attachment and replies as one of the record\'s people, and refuses all of it to a person who is not', async () => {
      vi.mocked(sendComposedEmail).mockImplementation(async () => ({
        status: 'sent', providerMessageId: `re_${randomUUID()}`, fromAddress: 'no-reply@mail.test.com', fromName: null,
      }) as never);
      const { org, customer, main } = await newOrg();
      const crew = await personWith(org, { contact_customers: true });
      const stranger = await personWith(org, { contact_customers: true });
      await userMailbox(org, crew);
      const job = await fx.addJob(org, customer, { crew: [crew.id] });
      const convo = await addRecordConversation(org, main, customer, { type: 'job', id: job.id });
      const reply = await customerReplies(convo);
      await db.emailAttachment.create({
        data: {
          email_id: reply, file_name: 'photo.pdf', content_type: 'application/pdf', file_size: 10,
          storage_path: `${org}/email/${reply}/photo.pdf`, position: 0, organization_id: org,
        },
      });

      const own = await crew.api();
      expect((await own.get(`/api/communication/emails/${reply}`)).status).toBe(200);
      expect((await own.get(`/api/communication/emails/${reply}/attachments/0`)).status).toBe(200);
      expect(await badge(crew)).toBe(1);
      expect((await own.patch('/api/communication/emails/thread-read', { thread_id: convo.thread })).body).toEqual({ updated: 2 });
      expect(await badge(crew)).toBe(0);
      expect((await own.patch('/api/communication/emails/thread-unread', { thread_id: convo.thread })).status).toBe(200);
      expect(await badge(crew)).toBe(1);
      const sent = await own.post('/api/communication/emails', { to: 'customer@example.com', subject: 'Re', body: ['Hi'], thread_id: convo.thread });
      expect(sent.status).toBe(201);
      expect(await db.email.count({ where: { thread_id: convo.thread, direction: 'out', sent_by_user_id: crew.id } })).toBe(1);

      const other = await stranger.api();
      expect((await other.get(`/api/communication/emails/${reply}`)).status).toBe(404);
      expect((await other.get(`/api/communication/emails/${reply}/attachments/0`)).status).toBe(404);
      expect((await other.patch('/api/communication/emails/thread-read', { thread_id: convo.thread })).body).toEqual({ updated: 0 });
      expect(await badge(stranger)).toBe(0);
    });

    it('keeps read state per person: one of the record\'s people opening the reply does not read it for another', async () => {
      const { org, customer, main } = await newOrg();
      const a = await personWith(org);
      const b = await personWith(org);
      const job = await fx.addJob(org, customer, { crew: [a.id], soldBy: b.id });
      const convo = await addRecordConversation(org, main, customer, { type: 'job', id: job.id });
      await customerReplies(convo);
      await (await a.api()).patch('/api/communication/emails/thread-read', { thread_id: convo.thread });
      expect(await badge(a)).toBe(0);
      expect(await badge(b)).toBe(1);
    });
  });

  describe('a lead\'s people', () => {
    it('lists a lead conversation to its Owner, a walkthrough performer and its Dispatcher once the customer has replied, and not to an assignee or anyone else', async () => {
      const { org, customer, main } = await newOrg();
      const owner = await personWith(org);
      const performer = await personWith(org);
      const dispatcher = await personWith(org);
      const assignee = await personWith(org);
      const stranger = await personWith(org);
      const lead = await fx.addLead(org, customer, { owner: owner.id, dispatcher: dispatcher.id, walkthroughCrew: [performer.id], assignees: [assignee.id] });
      const convo = await addRecordConversation(org, main, customer, { type: 'lead', id: lead.id });
      for (const p of [owner, performer, dispatcher]) expect(await listed(p, '?folder=inbox')).toEqual([]);

      const reply = await customerReplies(convo);
      for (const p of [owner, performer, dispatcher]) {
        expect(await listed(p, '?folder=inbox')).toEqual([reply]);
        expect(await opens(p, reply)).toBe(true);
        expect(await badge(p)).toBe(1);
      }
      // An assignee can open the lead, so the single read (the record's rule) opens the conversation; it is not on their list.
      expect(await listed(assignee, '?folder=inbox')).toEqual([]);
      expect(await opens(assignee, reply)).toBe(true);
      expect(await badge(assignee)).toBe(0);
      expect(await listed(stranger, '?folder=inbox')).toEqual([]);
      expect(await opens(stranger, reply)).toBe(false);
    });

    it('stops listing it when the Owner changes', async () => {
      const { org, customer, main } = await newOrg();
      const owner = await personWith(org);
      const lead = await fx.addLead(org, customer, { owner: owner.id });
      const reply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'lead', id: lead.id }));
      expect(await listed(owner, '?folder=inbox')).toEqual([reply]);
      await db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: null }, select: { id: true } });
      expect(await listed(owner, '?folder=inbox')).toEqual([]);
    });
  });

  describe('an estimate\'s and an invoice\'s people', () => {
    it('lists an estimate conversation to the people of the job or lead it is tied to, while they can open the estimate', async () => {
      const { org, customer, main } = await newOrg();
      const soldBy = await personWith(org);
      const noEstimates = await personWith(org, { ...ESTIMATES_VIEW_OFF });
      const owner = await personWith(org);
      const job = await fx.addJob(org, customer, { soldBy: soldBy.id });
      const onJob = await fx.addEstimate(org, customer, (await newCreator(org)).id, { jobId: job.id });
      const jobConvo = await addRecordConversation(org, main, customer, { type: 'estimate', id: onJob.id });
      const jobReply = await customerReplies(jobConvo);
      const lead = await fx.addLead(org, customer, { owner: owner.id });
      const onLead = await fx.addEstimate(org, customer, (await newCreator(org)).id, { leadId: lead.id });
      const leadReply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'estimate', id: onLead.id }));

      expect(await listed(soldBy, '?folder=inbox')).toEqual([jobReply]);
      expect(await listed(owner, '?folder=inbox')).toEqual([leadReply]);
      // Sold By on a job whose estimate they cannot open: not listed, not readable, not counted.
      await db.job.update({ where: { id: job.id }, data: { salesperson_id: noEstimates.id }, select: { id: true } });
      expect(await listed(noEstimates, '?folder=inbox')).toEqual([]);
      expect(await opens(noEstimates, jobReply)).toBe(false);
      expect(await badge(noEstimates)).toBe(0);
    });

    it('lists an estimate on a job to the Owner of its lead as well, as M6 tells them', async () => {
      const { org, customer, main } = await newOrg();
      const owner = await personWith(org);
      const lead = await fx.addLead(org, customer, { owner: owner.id });
      const job = await fx.addJob(org, customer, { fromLead: lead.id });
      const estimate = await fx.addEstimate(org, customer, (await newCreator(org)).id, { leadId: lead.id, jobId: job.id });
      const reply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'estimate', id: estimate.id }));
      expect(await listed(owner, '?folder=inbox')).toEqual([reply]);
    });

    it('lists an invoice conversation to its job\'s people while they can open the invoice, and keeps the creator rule', async () => {
      const { org, customer, main } = await newOrg();
      const soldBy = await personWith(org);
      const creator = await personWith(org, { ...INVOICES_VIEW_OFF });
      const noInvoices = await personWith(org, { ...INVOICES_VIEW_OFF });
      const job = await fx.addJob(org, customer, { soldBy: soldBy.id, crew: [creator.id, noInvoices.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: creator.id });
      const reply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'invoice', id: invoice.id }));

      expect(await listed(soldBy, '?folder=inbox')).toEqual([reply]);
      // View invoices off, but the invoice is theirs while they are on its job: the creator rule opens it.
      expect(await listed(creator, '?folder=inbox')).toEqual([reply]);
      expect(await opens(creator, reply)).toBe(true);
      expect(await badge(creator)).toBe(1);
      // On the job, View invoices off, not the creator: nothing.
      expect(await listed(noInvoices, '?folder=inbox')).toEqual([]);
      expect(await opens(noInvoices, reply)).toBe(false);
      expect(await badge(noInvoices)).toBe(0);
    });

    it('ties a deposit invoice with no job to its estimate\'s job, else its estimate\'s lead', async () => {
      const { org, customer, main } = await newOrg();
      const soldBy = await personWith(org);
      const owner = await personWith(org);
      const job = await fx.addJob(org, customer, { soldBy: soldBy.id });
      const jobEstimate = await fx.addEstimate(org, customer, (await newCreator(org)).id, { jobId: job.id });
      const lead = await fx.addLead(org, customer, { owner: owner.id });
      const leadEstimate = await fx.addEstimate(org, customer, (await newCreator(org)).id, { leadId: lead.id });
      const viaJob = await fx.addInvoice(org, customer, { estimateId: jobEstimate.id });
      const viaLead = await fx.addInvoice(org, customer, { estimateId: leadEstimate.id });
      const jobReply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'invoice', id: viaJob.id }));
      const leadReply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'invoice', id: viaLead.id }));
      expect(await listed(soldBy, '?folder=inbox')).toEqual([jobReply]);
      expect(await listed(owner, '?folder=inbox')).toEqual([leadReply]);
    });
  });

  type MailboxList = {
    selected: string; selected_unread: number; total_unread: number;
    mine: { id: string | null; unread: number }; held: { id: string; unread: number }[]; main: { id: string; unread: number } | null;
  };
  const mailboxList = async (person: Who, query = ''): Promise<MailboxList> => {
    const res = await (await person.api()).get(`/api/communication/mailboxes${query}`);
    expect(res.status).toBe(200);
    return res.body;
  };
  const link = (org: string, main: string, person: Who) =>
    db.mailboxReader.create({ data: { organization_id: org, mailbox_id: main, user_id: person.id } });
  async function userMailbox(org: string, owner: Who, holder: Who | null = owner) {
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

  describe('in which mailbox it appears', () => {
    it('shows a record conversation to a reader of the main mailbox who is one of its people in "My mailbox" and the section, never in "Main mailbox"', async () => {
      const { org, customer, main } = await newOrg();
      const reader = await personWith(org);
      const mine = await userMailbox(org, reader);
      await link(org, main, reader);
      const job = await fx.addJob(org, customer, { crew: [reader.id] });
      const reply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'job', id: job.id }));
      const started = await db.emailThread.create({ data: { organization_id: org, mailbox_id: main, origin: 'started' }, select: { id: true } });
      const startedMail = await addMessage(org, started.id, customer, { direction: 'in' });

      expect((await listed(reader, '?folder=inbox')).sort()).toEqual([reply, startedMail].sort());
      expect(await listed(reader, '?folder=inbox&mailbox=mine')).toEqual([reply]);
      expect(await listed(reader, `?folder=inbox&mailbox=${main}`)).toEqual([startedMail]);
      expect(await listed(reader, `?folder=inbox&mailbox=${mine}`)).toEqual([]);

      const list = await mailboxList(reader);
      expect(list.main).toEqual({ id: main, unread: 1 });
      expect(list.mine).toEqual({ id: mine, unread: 1 });
      expect(list.total_unread).toBe(2);
      expect(list.selected).toBe('mine');
      expect(list.selected_unread).toBe(1);
      expect((await mailboxList(reader, `?selected=${main}`)).selected_unread).toBe(1);
      expect(await badge(reader)).toBe(2);
    });

    it('shows it to a person who does not read the main mailbox in "My mailbox" too, with no "Main mailbox" entry', async () => {
      const { org, customer, main } = await newOrg();
      const crew = await personWith(org);
      const job = await fx.addJob(org, customer, { crew: [crew.id] });
      const reply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'job', id: job.id }));

      expect(await listed(crew, '?folder=inbox&mailbox=mine')).toEqual([reply]);
      const list = await mailboxList(crew);
      expect(list.main).toBeNull();
      expect(list.mine.unread).toBe(1);
      expect(list.total_unread).toBe(1);
      expect(await badge(crew)).toBe(1);
    });

    it('does not show a reader of the main mailbox who is not one of the record\'s people the conversation anywhere', async () => {
      const { org, customer, main } = await newOrg();
      const reader = await personWith(org, { jobs_scope: 'all' });
      await link(org, main, reader);
      const job = await fx.addJob(org, customer, { crew: [] });
      const reply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'job', id: job.id }));

      expect(await listed(reader, '?folder=inbox')).toEqual([]);
      expect(await listed(reader, `?folder=inbox&mailbox=${main}`)).toEqual([]);
      // They can open the job, so the record's own tab and the single read still reach it.
      expect(await opens(reader, reply)).toBe(true);
      const list = await mailboxList(reader);
      expect([list.main?.unread, list.mine.unread, list.total_unread]).toEqual([0, 0, 0]);
    });

    it('counts a conversation in the mailbox it sits in once, for a person who holds that mailbox and is one of its people', async () => {
      const { org, customer, main } = await newOrg();
      const sender = await personWith(org);
      const handedOver = await personWith(org);
      const leaver = await personWith(org);
      const own = await userMailbox(org, sender);
      const theirs = await userMailbox(org, leaver, handedOver);
      const job = await fx.addJob(org, customer, { crew: [sender.id, handedOver.id] });
      const reply = await customerReplies(await addRecordConversation(org, own, customer, { type: 'job', id: job.id }));
      void main;

      expect(await listed(sender, `?folder=inbox&mailbox=${own}`)).toEqual([reply]);
      const list = await mailboxList(sender);
      expect(list.mine.unread).toBe(1);
      expect(list.total_unread).toBe(1);
      // The mailbox handed to the other person is theirs to read, and the conversation is theirs as one of the job's people.
      const handed = await mailboxList(handedOver);
      expect(handed.total_unread).toBe(1);
      expect(handed.mine.unread).toBe(1);
      expect(handed.held).toEqual([expect.objectContaining({ id: theirs, unread: 0 })]);
    });

    it('lists it under All as it lists everything, and "My mailbox" there is unchanged', async () => {
      const { org, customer, main } = await newOrg();
      const wide = await personWith(org, { communication_scope: 'all' });
      const job = await fx.addJob(org, customer, { crew: [wide.id] });
      const reply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'job', id: job.id }));
      expect(await listed(wide, '?folder=inbox')).toEqual([reply]);
      expect(await listed(wide, `?folder=inbox&mailbox=${main}`)).toEqual([reply]);
      expect(await listed(wide, '?folder=inbox&mailbox=mine')).toEqual([]);
      const list = await mailboxList(wide);
      expect([list.total_unread, list.mine.unread]).toEqual([1, 0]);
    });
  });

  type Tie = { kind: 'job' | 'lead'; id: string; label: string };
  type Row = { id: string; recordTie?: Tie | null };
  const rows = async (person: Who, query = '?folder=inbox') => {
    const res = await (await person.api()).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return res.body.emails as Row[];
  };

  describe('the Inbox row names the job or lead', () => {
    it('labels a job conversation with the job number, a lead conversation with the lead number, and sends the link target', async () => {
      const { org, customer, main } = await newOrg();
      const person = await personWith(org);
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const lead = await fx.addLead(org, customer, { owner: person.id });
      const jobNumber = (await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { job_number: true } })).job_number;
      const leadNumber = (await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { lead_number: true } })).lead_number;
      const onJob = await customerReplies(await addRecordConversation(org, main, customer, { type: 'job', id: job.id }));
      const onLead = await customerReplies(await addRecordConversation(org, main, customer, { type: 'lead', id: lead.id }));

      const byId = new Map((await rows(person)).map((r) => [r.id, r]));
      expect(byId.get(onJob)?.recordTie).toEqual({ kind: 'job', id: job.id, label: jobNumber });
      expect(byId.get(onLead)?.recordTie).toEqual({ kind: 'lead', id: lead.id, label: leadNumber });
      // The single read carries the same label.
      const one = await (await person.api()).get(`/api/communication/emails/${onJob}`);
      expect(one.body.email.recordTie).toEqual({ kind: 'job', id: job.id, label: jobNumber });
    });

    it('labels an estimate\'s and an invoice\'s conversation with the job or lead it is tied to, by the one tie rule', async () => {
      const { org, customer, main } = await newOrg();
      const person = await personWith(org);
      const creator = await newCreator(org);
      const lead = await fx.addLead(org, customer, { owner: person.id });
      const job = await fx.addJob(org, customer, { soldBy: person.id });
      const leadEstimate = await fx.addEstimate(org, customer, creator.id, { leadId: lead.id });
      const jobEstimate = await fx.addEstimate(org, customer, creator.id, { jobId: job.id });
      const invoiceOnJob = await fx.addInvoice(org, customer, { jobId: job.id });
      const depositOnLead = await fx.addInvoice(org, customer, { estimateId: leadEstimate.id });
      const numbers = {
        job: (await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { job_number: true } })).job_number,
        lead: (await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { lead_number: true } })).lead_number,
      };
      const reply = async (type: string, id: string) => customerReplies(await addRecordConversation(org, main, customer, { type, id }));
      const a = await reply('estimate', leadEstimate.id);
      const b = await reply('estimate', jobEstimate.id);
      const c = await reply('invoice', invoiceOnJob.id);
      const d = await reply('invoice', depositOnLead.id);

      const byId = new Map((await rows(person)).map((r) => [r.id, r.recordTie]));
      expect(byId.get(a)).toEqual({ kind: 'lead', id: lead.id, label: numbers.lead });
      expect(byId.get(b)).toEqual({ kind: 'job', id: job.id, label: numbers.job });
      expect(byId.get(c)).toEqual({ kind: 'job', id: job.id, label: numbers.job });
      expect(byId.get(d)).toEqual({ kind: 'lead', id: lead.id, label: numbers.lead });
    });

    it('does not name a record the person cannot open, and has no label for a conversation that is not about a job or lead', async () => {
      const { org, customer, main } = await newOrg();
      const person = await personWith(org, { ...withDependantsOff(['view_jobs']) });
      const job = await fx.addJob(org, customer, { soldBy: person.id });
      const estimate = await fx.addEstimate(org, customer, (await newCreator(org)).id, { jobId: job.id });
      const reply = await customerReplies(await addRecordConversation(org, main, customer, { type: 'estimate', id: estimate.id }));
      const plain = await db.emailThread.create({ data: { organization_id: org, assigned_to_user_id: person.id, mailbox_id: main }, select: { id: true } });
      const plainMail = await addMessage(org, plain.id, customer, { direction: 'in' });

      const byId = new Map((await rows(person)).map((r) => [r.id, r.recordTie ?? null]));
      expect(byId.has(reply)).toBe(true);
      expect(byId.get(reply)).toBeNull();
      expect(byId.get(plainMail)).toBeNull();
    });
  });

  describe('what it costs on the hosted database\'s one connection', () => {
    it('answers the list, the mailbox list and the menu badge in a fixed number of reads however many records the person is on', async () => {
      const { org, customer, main } = await newOrg();
      const person = await personWith(org);
      const wide = await personWith(org, { communication_scope: 'all' });
      const creator = await newCreator(org);
      const queries: string[] = [];
      (db as unknown as { $on: (e: 'query', cb: (q: { query: string }) => void) => void }).$on('query', (q) => { queries.push(q.query); });
      const reads = async (who: Who, path: string) => {
        const api = await who.api();
        await api.get(path);
        queries.length = 0;
        const res = await api.get(path);
        expect(res.status).toBe(200);
        return queries.length;
      };
      const measure = async (who: Who) => ({
        list: await reads(who, '/api/communication/emails?folder=inbox'),
        mailboxes: await reads(who, '/api/communication/mailboxes'),
        badge: await reads(who, '/api/communication/unread-counts'),
      });
      /** A job, an estimate on it and an invoice on it, with the person on the crew and a customer reply in each conversation. */
      const addRecords = async () => {
        const job = await fx.addJob(org, customer, { crew: [person.id, wide.id] });
        const estimate = await fx.addEstimate(org, customer, creator.id, { jobId: job.id });
        const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
        for (const record of [{ type: 'job', id: job.id }, { type: 'estimate', id: estimate.id }, { type: 'invoice', id: invoice.id }]) {
          await customerReplies(await addRecordConversation(org, main, customer, record));
        }
      };
      await addRecords();
      const before = { person: await measure(person), wide: await measure(wide) };
      for (let i = 0; i < 10; i++) await addRecords();
      const after = { person: await measure(person), wide: await measure(wide) };
      // eslint-disable-next-line no-console
      console.info(`reads per request, Linked to me: ${JSON.stringify(after.person)}; All: ${JSON.stringify(after.wide)}`);
      expect(after).toEqual(before);
      expect(await badge(person)).toBe(33);
      // The poll every person makes every 30 seconds is the badge: S10.8 pinned 8 reads for a person on "Linked to me". The
      // record's people add ONE (the statement that starts at the person's own jobs and leads and finds their conversations,
      // recordPeopleThreads): the person's row scope on each kind of record is held by the Attached rows it already lists, so
      // it costs no read, and the rest of the badge is the same filter as before with a list of conversation ids in it. The
      // mailbox list is the same one read more (5 -> 6), the Email list too (11 -> 12), and under All nothing changed (2).
      // The Email list adds its labels for a page that names records: one read each for the estimates, the invoices, then the
      // jobs and leads they tie to (here a job, an estimate and an invoice: 9 -> 12, and under All 5 -> 8), none for a page
      // with no record conversation.
      // S10.18 adds the Needs review folder's counts to the mailbox list: one grouped count of the held messages a person sees
      // (a person who reads no mailbox is asked nothing), so under All 7 -> 8.
      expect(after).toEqual({ person: { list: 12, mailboxes: 6, badge: 9 }, wide: { list: 8, mailboxes: 8, badge: 2 } });
    });
  });

  /** A person who made estimates, with no part in the records under test. */
  async function newCreator(org: string) {
    return (await personWith(org, {}, 'ADMIN'));
  }
});
