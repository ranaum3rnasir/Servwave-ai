/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.8 - the record's Communication tab shows the whole job or lead.

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
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('the record Communication tab shows the whole job or lead (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_thread_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM messages WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}' AND kind = 'user'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
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

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `tab-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        access_communication: true, view_communication: true, communication_scope: 'attached', ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The values of a person with the Communication section closed: the three Show switches need it on. */
  const SECTION_CLOSED = { access_communication: false, show_phone: false, show_text: false, show_email: false };

  /** A person on "Linked to me" with no number: their section lists show nothing of the office's lines. */
  const narrowPerson = (org: string, values: Record<string, boolean | string> = {}) =>
    personWith(org, { see_main_line_when_no_number: false, ...values }, 'TECHNICIAN');

  async function addNumber(org: string) {
    const id = randomUUID();
    await db.phoneNumber.create({
      data: { id, organization_id: org, e164: `+1555${String(++sequence).padStart(7, '0')}`, label: 'run-unlinked', is_org_default: false, status: 'active' },
    });
    return id;
  }

  type Ties = { jobId?: string; leadId?: string; customerId?: string };

  async function addCall(org: string, numberId: string, ties: Ties = {}) {
    const id = randomUUID();
    await db.callSession.create({
      data: {
        id, organization_id: org, direction: 'in', from_number: '+15555550100', to_number: '+15555550199', status: 'completed',
        answered_by: {}, started_at: new Date(), phone_number_id: numberId,
        job_id: ties.jobId ?? null, lead_id: ties.leadId ?? null, customer_id: ties.customerId ?? null,
      },
    });
    return id;
  }

  /** One text in a new conversation with the customer, on the number, tied as given. Returns the message and its conversation. */
  async function addText(org: string, customer: string, numberId: string, ties: { jobId?: string; leadId?: string } = {}) {
    const thread = randomUUID();
    await db.messageThread.create({
      data: { id: thread, organization_id: org, channel: 'sms', campaign_type: 'customer_care', customer_id: customer },
      select: { id: true },
    });
    const id = randomUUID();
    await db.message.create({
      data: {
        id, organization_id: org, thread_id: thread, direction: 'in', body: 'run-text', ts: new Date(), status: 'received',
        phone_number_id: numberId, job_id: ties.jobId ?? null, lead_id: ties.leadId ?? null,
      },
      select: { id: true },
    });
    return { id, thread };
  }

  /**
   * A mailbox held by `holder`, or by nobody. A person's own mailbox has an address: a hand-written email goes out from it
   * (PRD 10, S10.11), and a person without one cannot send. Asking again for a holder's mailbox returns the one they have.
   */
  async function addMailbox(org: string, holder: string | null = null) {
    const existing = holder ? await db.mailbox.findFirst({ where: { organization_id: org, kind: 'user', user_id: holder }, select: { id: true } }) : null;
    if (existing) return existing.id;
    const id = randomUUID();
    await db.mailbox.create({ data: { id, organization_id: org, kind: 'user', user_id: holder, holder_user_id: holder, status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `u-${id}`, organization_id: org, mailbox_id: id, is_primary: true } });
    return id;
  }

  /** One email tied as given, in `threadId` or a new conversation in a mailbox nobody in the test holds. */
  async function addEmail(org: string, ties: Ties = {}, opts: { threadId?: string; createdAt?: Date } = {}) {
    let thread = opts.threadId;
    if (!thread) {
      thread = randomUUID();
      await db.emailThread.create({ data: { id: thread, organization_id: org, mailbox_id: await addMailbox(org), origin: 'started' } });
    }
    const id = randomUUID();
    await db.email.create({
      data: {
        id, organization_id: org, account: 'user', from: { name: null, email: 'customer@example.com' }, to: 'office@example.com',
        subject: 'run-email', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()), folder: 'inbox', thread_id: thread,
        job_id: ties.jobId ?? null, lead_id: ties.leadId ?? null, customer_id: ties.customerId ?? null,
        ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
      },
      select: { id: true },
    });
    return id;
  }

  const tabIds = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

  describe('the job tab', () => {
    it('lists a call and a text on a number not linked to a person on Attached and "Linked to me", opens the call and the conversation, and keeps both out of their section lists', async () => {
      const { org, customer } = await newOrg();
      const unlinked = await addNumber(org);
      const person = await narrowPerson(org);
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const call = await addCall(org, unlinked, { jobId: job.id, customerId: customer });
      const text = await addText(org, customer, unlinked, { jobId: job.id });
      const api = await person.api();

      const tab = await api.get(`/api/jobs/${job.id}/communications`);
      expect(tab.status).toBe(200);
      expect(tabIds(tab.body)).toEqual(expect.arrayContaining([call, text.id]));

      expect((await api.get(`/api/communication/calls/${call}`)).status).toBe(200);
      const opened = await api.get(`/api/communication/threads/${text.thread}`);
      expect(opened.status).toBe(200);
      expect(opened.body.thread.messages.map((m: { id: string }) => m.id)).toContain(text.id);

      expect((await api.get('/api/communication/calls')).body.calls.map((c: { id: string }) => c.id)).not.toContain(call);
      expect((await api.get('/api/communication/threads')).body.threads.map((t: { id: string }) => t.id)).not.toContain(text.thread);
    });

    it('shows the full tab on any job to a person whose data scope is All', async () => {
      const { org, admin, customer } = await newOrg();
      const unlinked = await addNumber(org);
      const wide = await narrowPerson(org, { jobs_scope: 'all' });
      const job = await fx.addJob(org, customer, { crew: [admin.id] });
      const call = await addCall(org, unlinked, { jobId: job.id });
      const text = await addText(org, customer, unlinked, { jobId: job.id });
      const email = await addEmail(org, { jobId: job.id, customerId: customer });

      const tab = await (await wide.api()).get(`/api/jobs/${job.id}/communications`);
      expect(tab.status).toBe(200);
      expect(tabIds(tab.body)).toEqual(expect.arrayContaining([call, text.id, email]));
    });

    it('refuses the tab on a job the person is not on', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await narrowPerson(org);
      const job = await fx.addJob(org, customer, { crew: [admin.id] });
      expect((await (await person.api()).get(`/api/jobs/${job.id}/communications`)).status).toBe(404);
    });

    it('keeps the tab and what opens from it for a person with Access Communication off, while the section stays closed', async () => {
      const { org, customer } = await newOrg();
      const unlinked = await addNumber(org);
      const person = await narrowPerson(org, SECTION_CLOSED);
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const call = await addCall(org, unlinked, { jobId: job.id });
      const text = await addText(org, customer, unlinked, { jobId: job.id });
      const api = await person.api();

      const tab = await api.get(`/api/jobs/${job.id}/communications`);
      expect(tab.status).toBe(200);
      expect(tabIds(tab.body)).toEqual(expect.arrayContaining([call, text.id]));
      expect((await api.get(`/api/communication/calls/${call}`)).status).toBe(200);
      expect((await api.get(`/api/communication/threads/${text.thread}`)).status).toBe(200);
      expect((await api.get('/api/communication/calls')).status).toBe(403);
    });

    it('lists a customer reply and an estimate email tied to the job, on any section scope, and the reply carried over from the lead', async () => {
      const { org, customer } = await newOrg();
      const lead = await fx.addLead(org, customer);
      const person = await narrowPerson(org);
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const reply = await addEmail(org, { jobId: job.id, customerId: customer });
      const estimateEmail = await addEmail(org, { jobId: job.id, leadId: lead.id, customerId: customer });
      const someoneElses = await addEmail(org, { customerId: customer });

      for (const scope of ['attached', 'all']) {
        const on = await narrowPerson(org, { communication_scope: scope });
        const job2 = await fx.addJob(org, customer, { crew: [on.id] });
        const mine = await addEmail(org, { jobId: job2.id, customerId: customer });
        const tab = await (await on.api()).get(`/api/jobs/${job2.id}/communications`);
        expect(tabIds(tab.body), scope).toContain(mine);
      }
      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(tabIds(tab.body)).toEqual(expect.arrayContaining([reply, estimateEmail]));
      expect(tabIds(tab.body)).not.toContain(someoneElses);
    });
  });

  describe('the lead tab', () => {
    it('lists a call and a text on a number not linked to a person on Attached, and the full tab on any lead to a person on All', async () => {
      const { org, admin, customer } = await newOrg();
      const unlinked = await addNumber(org);
      const person = await narrowPerson(org);
      const mine = await fx.addLead(org, customer, { assignees: [person.id], owner: person.id });
      const theirs = await fx.addLead(org, customer, { assignees: [admin.id], owner: admin.id });
      const call = await addCall(org, unlinked, { leadId: mine.id });
      const text = await addText(org, customer, unlinked, { leadId: mine.id });
      const email = await addEmail(org, { leadId: mine.id, customerId: customer });
      const onTheirs = await addCall(org, unlinked, { leadId: theirs.id });
      const api = await person.api();

      const tab = await api.get(`/api/leads/${mine.id}/communications`);
      expect(tab.status).toBe(200);
      expect(tabIds(tab.body)).toEqual(expect.arrayContaining([call, text.id, email]));
      expect((await api.get(`/api/communication/calls/${call}`)).status).toBe(200);
      expect((await api.get(`/api/leads/${theirs.id}/communications`)).status).toBe(404);

      const wide = await narrowPerson(org, { leads_scope: 'all' });
      const all = await (await wide.api()).get(`/api/leads/${theirs.id}/communications`);
      expect(all.status).toBe(200);
      expect(tabIds(all.body)).toContain(onTheirs);
    });

    it('keeps the job over the lead: a row on the lead that also names a job the person cannot open stays out', async () => {
      const { org, admin, customer } = await newOrg();
      const unlinked = await addNumber(org);
      const person = await narrowPerson(org);
      const lead = await fx.addLead(org, customer, { assignees: [person.id], owner: person.id });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      const leadOnly = await addCall(org, unlinked, { leadId: lead.id });
      const alsoOnOtherJob = await addCall(org, unlinked, { leadId: lead.id, jobId: otherJob.id });

      const tab = await (await person.api()).get(`/api/leads/${lead.id}/communications`);
      expect(tabIds(tab.body)).toContain(leadOnly);
      expect(tabIds(tab.body)).not.toContain(alsoOnOtherJob);
    });

    it('keeps the tab for a person with Access Communication off', async () => {
      const { org, customer } = await newOrg();
      const unlinked = await addNumber(org);
      const person = await narrowPerson(org, SECTION_CLOSED);
      const lead = await fx.addLead(org, customer, { assignees: [person.id], owner: person.id });
      const call = await addCall(org, unlinked, { leadId: lead.id });
      const api = await person.api();
      expect(tabIds((await api.get(`/api/leads/${lead.id}/communications`)).body)).toContain(call);
      expect((await api.get(`/api/communication/calls/${call}`)).status).toBe(200);
    });
  });

  describe('the customer tab', () => {
    it('leaves out the job-tied call, and its recording and transcript, for a person who can open the customer but not the job, and keeps the customer-only call', async () => {
      const { org, admin, customer } = await newOrg();
      const unlinked = await addNumber(org);
      const person = await narrowPerson(org, { play_recording: true, view_transcript: true });
      // The person reaches the customer through a job of their own, and not through the job the call is tied to.
      await fx.addJob(org, customer, { crew: [person.id] });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      const jobTied = await addCall(org, unlinked, { jobId: otherJob.id, customerId: customer });
      const customerOnly = await addCall(org, unlinked, { customerId: customer });
      const textOnOtherJob = await addText(org, customer, unlinked, { jobId: otherJob.id });
      const textCustomerOnly = await addText(org, customer, unlinked);
      const emailOnOtherJob = await addEmail(org, { jobId: otherJob.id, customerId: customer });
      const emailCustomerOnly = await addEmail(org, { customerId: customer });
      const api = await person.api();

      const tab = await api.get(`/api/customers/${customer}/communications`);
      expect(tab.status).toBe(200);
      expect(tabIds(tab.body)).toEqual(expect.arrayContaining([customerOnly, textCustomerOnly.id, emailCustomerOnly]));
      for (const left of [jobTied, textOnOtherJob.id, emailOnOtherJob]) expect(tabIds(tab.body)).not.toContain(left);

      expect((await api.get(`/api/communication/calls/${customerOnly}`)).status).toBe(200);
      for (const path of ['', '/recording', '/transcript']) {
        expect((await api.get(`/api/communication/calls/${jobTied}${path}`)).status, `job-tied call ${path}`).toBe(404);
      }
    });

    it('lists a job-tied row for a person who is on that job, and a lead-tied row only for the lead\'s people', async () => {
      const { org, admin, customer } = await newOrg();
      const unlinked = await addNumber(org);
      const person = await narrowPerson(org);
      const myJob = await fx.addJob(org, customer, { crew: [person.id] });
      const myLead = await fx.addLead(org, customer, { assignees: [person.id], owner: person.id });
      const otherLead = await fx.addLead(org, customer, { assignees: [admin.id], owner: admin.id });
      const onMyJob = await addCall(org, unlinked, { jobId: myJob.id, customerId: customer });
      const onMyLead = await addCall(org, unlinked, { leadId: myLead.id, customerId: customer });
      const onOtherLead = await addCall(org, unlinked, { leadId: otherLead.id, customerId: customer });

      const ids = tabIds((await (await person.api()).get(`/api/customers/${customer}/communications`)).body);
      expect(ids).toEqual(expect.arrayContaining([onMyJob, onMyLead]));
      expect(ids).not.toContain(onOtherLead);
    });
  });

  describe('the reply guard that answers "this conversation changed"', () => {
    const COMPOSING = new Date(Date.now() - 60 * 60_000);
    const before = new Date(COMPOSING.getTime() - 60_000);
    const after = new Date(COMPOSING.getTime() + 60_000);
    const reply = (api: Api, thread: string) =>
      api.post('/api/communication/emails', { to: 'customer@example.com', body: ['reply'], thread_id: thread, composing_since: COMPOSING.toISOString() });

    async function conversationReachedThroughAJob() {
      const { org, admin, customer } = await newOrg();
      const person = await narrowPerson(org, { contact_customers: true });
      const myJob = await fx.addJob(org, customer, { crew: [person.id] });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      const colleaguesMailbox = await addMailbox(org, (await personWith(org, {})).id);
      await addMailbox(org, person.id);
      const thread = randomUUID();
      await db.emailThread.create({ data: { id: thread, organization_id: org, mailbox_id: colleaguesMailbox, origin: 'started' } });
      return { org, person, myJob, otherJob, customer, thread };
    }

    it('returns, for a conversation reached only through a job, the newer messages on a job the person can open and none from another', async () => {
      const { org, person, myJob, otherJob, customer, thread } = await conversationReachedThroughAJob();
      await addEmail(org, { jobId: myJob.id, customerId: customer }, { threadId: thread, createdAt: before });
      const newerOnMyJob = await addEmail(org, { jobId: myJob.id, customerId: customer }, { threadId: thread, createdAt: after });
      const newerOnOtherJob = await addEmail(org, { jobId: otherJob.id, customerId: customer }, { threadId: thread, createdAt: after });

      const res = await reply(await person.api(), thread);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('THREAD_CHANGED');
      const ids = res.body.messages.map((m: { id: string }) => m.id);
      expect(ids).toContain(newerOnMyJob);
      expect(ids).not.toContain(newerOnOtherJob);
      expect(JSON.stringify(res.body)).not.toContain(newerOnOtherJob);
    });

    it('does not trip on a newer message the person cannot read', async () => {
      const { org, person, myJob, otherJob, customer, thread } = await conversationReachedThroughAJob();
      await addEmail(org, { jobId: myJob.id, customerId: customer }, { threadId: thread, createdAt: before });
      const newerOnOtherJob = await addEmail(org, { jobId: otherJob.id, customerId: customer }, { threadId: thread, createdAt: after });

      const res = await reply(await person.api(), thread);
      expect(res.status).not.toBe(409);
      expect(JSON.stringify(res.body)).not.toContain(newerOnOtherJob);
    });

    it('returns every newer message of a conversation in the person\'s own mailbox, whatever it is tied to', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await narrowPerson(org, { contact_customers: true });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      const thread = randomUUID();
      await db.emailThread.create({ data: { id: thread, organization_id: org, mailbox_id: await addMailbox(org, person.id), origin: 'started' } });
      await addEmail(org, {}, { threadId: thread, createdAt: before });
      const newer = await addEmail(org, { jobId: otherJob.id, customerId: customer }, { threadId: thread, createdAt: after });

      const res = await reply(await person.api(), thread);
      expect(res.status).toBe(409);
      expect(res.body.messages.map((m: { id: string }) => m.id)).toContain(newer);
    });
  });
});
