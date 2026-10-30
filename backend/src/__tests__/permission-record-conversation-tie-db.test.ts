/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.5 - record conversations and their replies show on the job's and lead's tab.

   A conversation a send to a customer opens about one record is tied to the job or lead of that record, worked out from
   the record each time the tab is read. Its customer replies carry the tie. A conversation about an estimate or an
   invoice shows on the tab only to people who can also open that estimate or invoice (the creator rule included).

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

const suite = realClient ? describe : describe.skip;

suite('record conversations on the job\'s and lead\'s Communication tab (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}' AND kind = 'main'`));
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
  const INVOICES_VIEW_OFF = withDependantsOff(['view_invoices']);
  const ESTIMATES_VIEW_OFF = withDependantsOff(['view_estimates']);

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `tie-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, estimates_scope: 'attached', view_invoices: true, invoices_scope: 'attached',
        access_communication: true, view_communication: true, communication_scope: 'linked_to_me', ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The company's main mailbox, made once. */
  async function mainMailbox(org: string): Promise<string> {
    const found = await db.mailbox.findFirst({ where: { organization_id: org, kind: 'main' }, select: { id: true } });
    if (found) return found.id;
    const id = randomUUID();
    await db.mailbox.create({ data: { id, organization_id: org, kind: 'main', status: 'active' } });
    return id;
  }

  type Message = { direction: 'out' | 'in'; jobId?: string; leadId?: string; subject?: string; createdAt?: Date };

  /**
   * The conversation a send to a customer opened about a record, in the shape the S10.4 migration leaves: in the main
   * mailbox, origin "record", the record it belongs to. An outbound message is the system email the send mirrored (it
   * carries the job or lead the writer stamped, if any); an inbound one is the customer's reply, saved on the customer
   * alone, as the reply path saves it.
   */
  async function addRecordConversation(
    org: string, customer: string, record: { type: string; id: string }, messages: Message[],
  ) {
    const thread = randomUUID();
    await db.emailThread.create({
      data: {
        id: thread, organization_id: org, mailbox_id: await mainMailbox(org), origin: 'record',
        record_type: record.type, record_id: record.id,
      },
    });
    const ids: string[] = [];
    for (const m of messages) {
      const id = randomUUID();
      await db.email.create({
        data: {
          id, organization_id: org, thread_id: thread, customer_id: customer,
          account: m.direction === 'out' ? 'system' : 'user', direction: m.direction, folder: m.direction === 'out' ? 'sent' : 'inbox',
          from: { name: null, email: m.direction === 'out' ? 'office@example.com' : 'customer@example.com' },
          to: m.direction === 'out' ? 'customer@example.com' : 'office@example.com',
          subject: m.subject ?? `run-${record.type}`, snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
          job_id: m.jobId ?? null, lead_id: m.leadId ?? null,
          ...(m.createdAt ? { created_at: m.createdAt } : {}),
        },
        select: { id: true },
      });
      ids.push(id);
    }
    return { thread, ids };
  }

  const tabIds = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

  describe('the job tab', () => {
    it('shows a customer reply to an estimate on the estimate\'s job, and on the customer\'s tab, beside the estimate email', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const estimate = await fx.addEstimate(org, customer, person.id, { jobId: job.id });
      const { ids: [sent, reply] } = await addRecordConversation(org, customer, { type: 'estimate', id: estimate.id }, [
        { direction: 'out', jobId: job.id }, { direction: 'in' },
      ]);
      const api = await person.api();

      const tab = await api.get(`/api/jobs/${job.id}/communications`);
      expect(tab.status).toBe(200);
      expect(tabIds(tab.body)).toEqual(expect.arrayContaining([sent, reply]));
      const shown = tab.body.items.find((i: { id: string }) => i.id === reply);
      expect(shown).toMatchObject({ channel: 'email', direction: 'in', jobId: job.id });

      const customerTab = await api.get(`/api/customers/${customer}/communications`);
      expect(tabIds(customerTab.body)).toContain(reply);
    });

    it('shows a conversation about the job itself (a notice) and its reply to anyone who can open the job, with no estimate or invoice access', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, { ...INVOICES_VIEW_OFF, ...ESTIMATES_VIEW_OFF });
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const { ids: [notice, reply] } = await addRecordConversation(org, customer, { type: 'job', id: job.id }, [
        { direction: 'out', jobId: job.id }, { direction: 'in' },
      ]);
      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(tabIds(tab.body)).toEqual(expect.arrayContaining([notice, reply]));
    });

    it('leaves out the conversations of another job, and of an estimate on another job', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, { estimates_scope: 'all' });
      const mine = await fx.addJob(org, customer, { crew: [person.id] });
      const other = await fx.addJob(org, customer, { crew: [admin.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: other.id });
      const { ids: [sent, reply] } = await addRecordConversation(org, customer, { type: 'estimate', id: estimate.id }, [
        { direction: 'out', jobId: other.id }, { direction: 'in' },
      ]);
      const tab = await (await person.api()).get(`/api/jobs/${mine.id}/communications`);
      expect(tabIds(tab.body)).not.toContain(sent);
      expect(tabIds(tab.body)).not.toContain(reply);
    });

    it('shows an estimate email written before the tie existed, with the lead only on its row, on the job the estimate has since gained', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const lead = await fx.addLead(org, customer, { assignees: [person.id], owner: person.id });
      const job = await fx.addJob(org, customer, { crew: [person.id], fromLead: lead.id });
      const estimate = await fx.addEstimate(org, customer, person.id, { leadId: lead.id, jobId: job.id });
      // The old writer saved the email on the lead alone, and the S10.4 migration left the conversation as a record one.
      const { ids: [oldEmail, reply] } = await addRecordConversation(org, customer, { type: 'estimate', id: estimate.id }, [
        { direction: 'out', leadId: lead.id }, { direction: 'in' },
      ]);
      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(tabIds(tab.body)).toEqual(expect.arrayContaining([oldEmail, reply]));
    });
  });

  describe('a lead and the job made from it', () => {
    it('shows a reply to an estimate sent while the record was a lead on the job after the lead becomes a job, and still on the lead', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const lead = await fx.addLead(org, customer, { assignees: [person.id], owner: person.id });
      const estimate = await fx.addEstimate(org, customer, person.id, { leadId: lead.id });
      const { ids: [sent, reply] } = await addRecordConversation(org, customer, { type: 'estimate', id: estimate.id }, [
        { direction: 'out', leadId: lead.id }, { direction: 'in' },
      ]);
      const api = await person.api();
      // Before it has a job: on the lead's tab, with the reply, and on no job.
      let leadTab = await api.get(`/api/leads/${lead.id}/communications`);
      expect(tabIds(leadTab.body)).toEqual(expect.arrayContaining([sent, reply]));
      expect(leadTab.body.items.find((i: { id: string }) => i.id === reply)).toMatchObject({ leadId: lead.id });

      // The lead becomes a job: the estimate gains it, and nothing about the conversation is rewritten.
      const job = await fx.addJob(org, customer, { crew: [person.id], fromLead: lead.id });
      await db.estimate.update({ where: { id: estimate.id }, data: { job_id: job.id } });

      const jobTab = await api.get(`/api/jobs/${job.id}/communications`);
      expect(tabIds(jobTab.body)).toEqual(expect.arrayContaining([sent, reply]));
      leadTab = await api.get(`/api/leads/${lead.id}/communications`);
      expect(tabIds(leadTab.body)).toEqual(expect.arrayContaining([sent, reply]));
    });

    it('shows a conversation tied to the lead on a job made from the lead, to a person who can open the estimate but not the lead', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, { estimates_scope: 'all' });
      const lead = await fx.addLead(org, customer);
      const job = await fx.addJob(org, customer, { crew: [person.id], fromLead: lead.id });
      const estimate = await fx.addEstimate(org, customer, person.id, { leadId: lead.id });
      const { ids: [sent, reply] } = await addRecordConversation(org, customer, { type: 'estimate', id: estimate.id }, [
        { direction: 'out', leadId: lead.id }, { direction: 'in' },
      ]);
      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(tabIds(tab.body)).toEqual(expect.arrayContaining([sent, reply]));
    });

    it('changes no tie when a Won lead is reopened: the job keeps its conversations, the lead keeps showing them, and new mail about the lead shows on both', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, { reopen_leads: true, change_lead_status_by_hand: true, estimates_scope: 'all', leads_scope: 'all', jobs_scope: 'all' });
      const lead = await fx.addLead(org, customer, { assignees: [person.id], owner: person.id });
      const job = await fx.addJob(org, customer, { crew: [person.id], fromLead: lead.id });
      const won = await fx.addEstimate(org, customer, person.id, { leadId: lead.id, jobId: job.id });
      const first = await addRecordConversation(org, customer, { type: 'estimate', id: won.id }, [
        { direction: 'out', jobId: job.id }, { direction: 'in' },
      ]);
      await db.lead.update({ where: { id: lead.id }, data: { status: 'WON' } });
      const api = await person.api();

      const reopened = await api.post(`/api/leads/${lead.id}/reopen`, { reason: 'The customer wants a second job' });
      expect(reopened.status).toBe(200);

      // A new estimate on the reopened lead has no job yet.
      const second = await fx.addEstimate(org, customer, person.id, { leadId: lead.id });
      const later = await addRecordConversation(org, customer, { type: 'estimate', id: second.id }, [
        { direction: 'out', leadId: lead.id }, { direction: 'in' },
      ]);

      const jobTab = tabIds((await api.get(`/api/jobs/${job.id}/communications`)).body);
      const leadTab = tabIds((await api.get(`/api/leads/${lead.id}/communications`)).body);
      expect(jobTab).toEqual(expect.arrayContaining(first.ids));
      expect(leadTab).toEqual(expect.arrayContaining(first.ids));
      expect(leadTab).toEqual(expect.arrayContaining(later.ids));
      expect(jobTab).toEqual(expect.arrayContaining(later.ids));
    });
  });

  describe('what a tab costs', () => {
    it('makes the same number of database reads for a job with fifty conversations as for one', async () => {
      const queries: string[] = [];
      (db as unknown as { $on: (e: 'query', cb: (q: { query: string }) => void) => void }).$on('query', (q) => { queries.push(q.query); });
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const reads: number[] = [];
      for (const conversations of [1, 50]) {
        const job = await fx.addJob(org, customer, { crew: [person.id] });
        for (let i = 0; i < conversations; i++) {
          const estimate = await fx.addEstimate(org, customer, person.id, { jobId: job.id });
          await addRecordConversation(org, customer, { type: 'estimate', id: estimate.id }, [{ direction: 'out', jobId: job.id }, { direction: 'in' }]);
        }
        const api = await person.api();
        await api.get(`/api/jobs/${job.id}/communications`);
        queries.length = 0;
        const tab = await api.get(`/api/jobs/${job.id}/communications`);
        expect(tab.body.items).toHaveLength(conversations * 2);
        reads.push(queries.length);
        // eslint-disable-next-line no-console
        console.info(`tab reads with ${conversations} conversation(s): ${queries.length} (${queries.filter((q) => /"email_threads"|"emails"/.test(q)).length} on emails)`);
      }
      expect(reads[1]).toBe(reads[0]);
    }, 120_000);
  });

  describe('opening one message, and the counts', () => {
    async function invoiceConversation() {
      const { org, admin, customer } = await newOrg();
      const without = await personWith(org, { ...INVOICES_VIEW_OFF, show_email: true });
      const withInvoices = await personWith(org, { show_email: true });
      const creator = await personWith(org, { ...INVOICES_VIEW_OFF, show_email: true });
      const job = await fx.addJob(org, customer, { crew: [without.id, withInvoices.id, creator.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: creator.id });
      const conversation = await addRecordConversation(org, customer, { type: 'invoice', id: invoice.id }, [
        { direction: 'out', jobId: job.id }, { direction: 'in' },
      ]);
      const notice = await addRecordConversation(org, customer, { type: 'job', id: job.id }, [{ direction: 'in' }]);
      return { org, admin, customer, job, without, withInvoices, creator, conversation, notice };
    }

    it('refuses to open an invoice email or its reply by id for a person who cannot open the invoice, and opens them for one who can', async () => {
      const { without, withInvoices, creator, conversation, notice } = await invoiceConversation();
      const refused = await without.api();
      for (const id of conversation.ids) expect((await refused.get(`/api/communication/emails/${id}`)).status, id).toBe(404);
      for (const person of [withInvoices, creator]) {
        const api = await person.api();
        for (const id of conversation.ids) expect((await api.get(`/api/communication/emails/${id}`)).status, id).toBe(200);
      }
      // A conversation about the job itself still opens through the job.
      expect((await refused.get(`/api/communication/emails/${notice.ids[0]}`)).status).toBe(200);
    });

    it('marks nothing of it read, and links nothing, for a person who cannot open the invoice', async () => {
      const { org, without, conversation } = await invoiceConversation();
      const api = await without.api();
      const marked = await api.patch('/api/communication/emails/thread-read', { thread_id: conversation.thread });
      expect(marked.body).toEqual({ updated: 0 });
      expect(await db.emailReadState.count({ where: { organization_id: org, user_id: without.id } })).toBe(0);
      expect((await api.patch(`/api/communication/emails/threads/${conversation.thread}/archive`, { archived: true })).status).toBe(404);
    });

    it('counts none of the invoice conversation in the Email unread number of a person who cannot open the invoice', async () => {
      const { without, withInvoices, conversation, notice } = await invoiceConversation();
      expect(conversation.ids).toHaveLength(2);
      // The job notice has a customer reply and both are on the job's crew, so it is theirs as one of the job's people (S10.9)
      // and counted. The invoice's reply is counted only for the person who can open the invoice: the number only ever counts
      // what the Email page lists.
      expect((await (await without.api()).get('/api/communication/unread-counts')).body.email).toBe(1);
      expect((await (await withInvoices.api()).get('/api/communication/unread-counts')).body.email).toBe(2);
      void notice;
    });
  });

  describe('an invoice or an estimate conversation on the tab', () => {
    it('leaves out the invoice emails and their replies for a person on the job with View invoices off, and shows them to a person who can open the invoice', async () => {
      const { org, admin, customer } = await newOrg();
      const without = await personWith(org, { ...INVOICES_VIEW_OFF });
      const withInvoices = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [without.id, withInvoices.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      const { ids } = await addRecordConversation(org, customer, { type: 'invoice', id: invoice.id }, [
        { direction: 'out', jobId: job.id }, { direction: 'in' },
      ]);
      const notice = await addRecordConversation(org, customer, { type: 'job', id: job.id }, [{ direction: 'out', jobId: job.id }]);

      const hidden = tabIds((await (await without.api()).get(`/api/jobs/${job.id}/communications`)).body);
      for (const id of ids) expect(hidden).not.toContain(id);
      expect(hidden).toContain(notice.ids[0]);
      expect(tabIds((await (await withInvoices.api()).get(`/api/jobs/${job.id}/communications`)).body)).toEqual(expect.arrayContaining(ids));
    });

    it('shows them to the person who made the invoice while they are on the job, and not to a colleague on the job who did not', async () => {
      const { org, customer } = await newOrg();
      const creator = await personWith(org, { ...INVOICES_VIEW_OFF });
      const colleague = await personWith(org, { ...INVOICES_VIEW_OFF });
      const job = await fx.addJob(org, customer, { crew: [creator.id, colleague.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: creator.id });
      const { ids } = await addRecordConversation(org, customer, { type: 'invoice', id: invoice.id }, [
        { direction: 'out', jobId: job.id }, { direction: 'in' },
      ]);
      expect(tabIds((await (await creator.api()).get(`/api/jobs/${job.id}/communications`)).body)).toEqual(expect.arrayContaining(ids));
      expect(tabIds((await (await colleague.api()).get(`/api/jobs/${job.id}/communications`)).body)).not.toContain(ids[0]);
    });

    it('does the same for an estimate conversation on a job and on a lead', async () => {
      const { org, admin, customer } = await newOrg();
      const without = await personWith(org, { ...ESTIMATES_VIEW_OFF });
      const withEstimates = await personWith(org, {});
      const lead = await fx.addLead(org, customer, { assignees: [without.id, withEstimates.id] });
      const job = await fx.addJob(org, customer, { crew: [without.id, withEstimates.id] });
      const onJob = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const onLead = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      const jobConv = await addRecordConversation(org, customer, { type: 'estimate', id: onJob.id }, [{ direction: 'out', jobId: job.id }, { direction: 'in' }]);
      const leadConv = await addRecordConversation(org, customer, { type: 'estimate', id: onLead.id }, [{ direction: 'out', leadId: lead.id }, { direction: 'in' }]);

      const noJobTab = tabIds((await (await without.api()).get(`/api/jobs/${job.id}/communications`)).body);
      const noLeadTab = tabIds((await (await without.api()).get(`/api/leads/${lead.id}/communications`)).body);
      for (const id of jobConv.ids) expect(noJobTab).not.toContain(id);
      for (const id of leadConv.ids) expect(noLeadTab).not.toContain(id);
      expect(tabIds((await (await withEstimates.api()).get(`/api/jobs/${job.id}/communications`)).body)).toEqual(expect.arrayContaining(jobConv.ids));
      expect(tabIds((await (await withEstimates.api()).get(`/api/leads/${lead.id}/communications`)).body)).toEqual(expect.arrayContaining(leadConv.ids));
    });
  });
});
