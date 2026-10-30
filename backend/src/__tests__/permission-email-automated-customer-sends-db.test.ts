/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.13 - every email to a customer carries a reply address tied to its record.

   The automated mail a company sends by itself to a customer (the "estimate approved" email with the signed copy, the
   deposit payment and deposit received confirmations, the deposit and invoice refund notices, the payment receipt and the
   bank payment notices, the job, visit, calendar and walkthrough notices, and an automation email) each names its record and
   carries the hidden reply address the estimate and invoice sends have. Each opens or reuses that record's conversation in
   the company's MAIN mailbox with origin "record"; none is stored as loose system email. Automated mail still goes from the
   main address with the company display name, and the platform-voice notices to the company (no-reply) are unchanged.
   A customer's reply to any of them, through the real inbound path and the real reply-token resolver, joins its record
   conversation and shows on the job's or lead's tab; an automation email about a lead is saved on the lead. Mail to staff
   that names no record is in no mailbox.

   The real dispatcher and the real senders run, against a real migrated database (TEST_DATABASE_URL); the suite skips when
   it is unset. Only the mail provider's client is faked, so the headers that "went out" are read back and compared with the
   stored email. People who read a tab are on custom roles built from switches (never a built-in role name). No email leaves
   the machine. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient, resendSend, fetchReceived, statements } = vi.hoisted(() => {
  // The statements the app sends while `statements.on` is set, so a test can count what one send costs.
  const statements = { on: false, sql: [] as string[] };
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const client = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: 'event', level: 'query' }] });
    (client as unknown as { $on(event: 'query', cb: (e: { query: string }) => void): void }).$on('query', (e) => {
      if (statements.on) statements.sql.push(e.query);
    });
    return client;
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, resendSend: vi.fn(), fetchReceived: vi.fn(), statements };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// Only the mail provider's client is faked.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    domains = { create: vi.fn(), get: vi.fn(), verify: vi.fn(), remove: vi.fn() };
  },
}));
// The provider call that fetches a received message is the only inbound thing replaced.
vi.mock('../lib/inbound-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inbound-email')>()),
  fetchReceivedEmail: fetchReceived,
}));
// The suite-wide setup replaces the dispatcher with a stub; here the real one runs, with the provider key and the
// mailbox domain set BEFORE it loads (it builds its client at load).
vi.mock('../lib/email', async (importOriginal) => {
  const { env } = await import('../config/env.js');
  Object.assign(env, {
    RESEND_API_KEY: 're_test_key', MAILBOX_DOMAIN: 'staging.mail.test.com', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    EMAIL_REPLY_DOMAIN: 'reply.test.com',
  });
  return importOriginal();
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('every email to a customer carries a reply address tied to its record (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM notifications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_attachments WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM resend_events WHERE (payload->'data'->>'email_id') LIKE 'rp-s10-13-${org.slice(0, 8)}%'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_readers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  beforeEach(() => {
    resendSend.mockReset();
    resendSend.mockImplementation(async () => ({ data: { id: `re_${randomUUID()}` }, error: null }));
    fetchReceived.mockReset();
  });

  let sequence = 0;
  const CUSTOMER_EMAIL = 'angel@example.com';
  type Email = typeof import('../lib/email');
  const email = async (): Promise<Email> => import('../lib/email.js');

  /** A company that sends mail, with its main mailbox and address, and a customer with an email on file. */
  async function newOrg(opts: { sending?: boolean } = {}) {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const part = `co${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: { email_sending_enabled: opts.sending ?? true, email_sender_local_part: part },
    });
    await db.customer.update({ where: { id: made.customer }, data: { email: CUSTOMER_EMAIL } });
    const main = await db.mailbox.create({ data: { organization_id: made.org, kind: 'main', status: 'active' }, select: { id: true } });
    await db.mailboxAddress.create({ data: { local_part: part, organization_id: made.org, mailbox_id: main.id, is_primary: true } });
    const orgRow = await db.organization.findUniqueOrThrow({ where: { id: made.org } });
    return { ...made, main: main.id, part, orgRow };
  }
  type World = Awaited<ReturnType<typeof newOrg>>;

  /** A person on a fresh custom role holding exactly these switch values, with their own mailbox and address. */
  async function personWith(w: World, values: Record<string, boolean | string> = {}, base: Role = 'DISPATCHER') {
    const key = `acs-role-${++sequence}`;
    const role = await fx.addCustomRole(w.org, key, base);
    await setRoleSwitchValues({
      organizationId: w.org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, edit_estimates: true,
        view_invoices: true, edit_invoices: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'attached',
        contact_customers: true,
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(w.org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const orgBranding = (w: World) => ({ id: w.org, name: w.orgRow.name, logo_url: null, brand_color: '#0C2D3A' });
  const mainAddress = (w: World) => `${w.part}@staging.mail.test.com`;
  const companyName = (w: World) => w.orgRow.name;

  /** The message the mocked provider was last given. */
  const lastSent = () => resendSend.mock.calls.at(-1)![0] as { from: string; replyTo: string; to: string; subject: string };
  const headerOf = (header: string) => {
    const m = /^"(.*)" <(.*)>$/.exec(header)!;
    return { name: m[1]!, address: m[2]! };
  };

  /** The record conversations a record opened. */
  const conversationsOf = (w: World, recordId: string) => db.emailThread.findMany({
    where: { organization_id: w.org, origin: 'record', record_id: recordId }, orderBy: { created_at: 'asc' },
  });

  /** The conversation a send's reply address resolves to, through the real resolver. */
  async function threadOfReplyAddress(replyTo: string) {
    const { parseReplyAddress, resolveReplyToken } = await import('../lib/reply-token.js');
    return (await resolveReplyToken(db, parseReplyAddress(replyTo)!))?.thread_id ?? null;
  }

  /**
   * What a send to a customer must leave behind: the header from the main address with the company name, a reply address
   * that resolves to a conversation in the MAIN mailbox about the named record, and the stored email on that conversation.
   */
  async function expectTiedToRecord(w: World, record: { type: string; id: string }, opts: { subject?: RegExp } = {}) {
    const sent = lastSent();
    expect(headerOf(sent.from), 'the main address and the company display name').toEqual({ name: companyName(w), address: mainAddress(w) });
    expect(sent.replyTo, 'a reply address').toMatch(/reply\.test\.com>?$/);
    if (opts.subject) expect(sent.subject).toMatch(opts.subject);
    const threadId = await threadOfReplyAddress(sent.replyTo);
    expect(threadId, 'the reply address resolves to a conversation').not.toBeNull();
    const thread = await db.emailThread.findUniqueOrThrow({ where: { id: threadId! } });
    expect(thread).toMatchObject({ organization_id: w.org, mailbox_id: w.main, origin: 'record', record_type: record.type, record_id: record.id });
    const stored = await db.email.findMany({ where: { organization_id: w.org, thread_id: threadId! } });
    expect(stored.length, 'the stored email is on the conversation').toBeGreaterThan(0);
    const mine = stored.at(-1)!;
    expect(mine.from).toEqual({ name: companyName(w), email: mainAddress(w) });
    expect(mine.sent_by_user_id, 'an automated send records nobody').toBeNull();
    expect(await db.email.count({ where: { organization_id: w.org, thread_id: null } }), 'no loose system email').toBe(0);
    return { thread, stored: mine };
  }

  describe('the "estimate approved" email', () => {
    it('names its estimate, goes from the main address, and opens that estimate\'s conversation in the main mailbox', async () => {
      const w = await newOrg();
      const job = await fx.addJob(w.org, w.customer, {});
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: job.id });
      const { sendEstimateApprovedNotification } = await email();

      await sendEstimateApprovedNotification({
        estimateId: estimate.id, org: orgBranding(w), to: CUSTOMER_EMAIL, customerName: 'Pat Payer', estimateNumber: 'E-1', total: '$100.00',
        record: { organizationId: w.org, customerId: w.customer, jobId: job.id },
      });

      expect(resendSend).toHaveBeenCalledTimes(1);
      const { stored } = await expectTiedToRecord(w, { type: 'estimate', id: estimate.id }, { subject: /Approved/ });
      expect(stored.job_id, 'saved on the job when the estimate has one').toBe(job.id);
    });
  });

  describe('the deposit confirmations and the deposit refund notice', () => {
    /** An estimate on a lead, the way a deposit that arrived before any job exists is filed. */
    async function leadEstimate(w: World) {
      const lead = await fx.addLead(w.org, w.customer, {});
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { leadId: lead.id });
      return { lead, estimate, record: { organizationId: w.org, customerId: w.customer, leadId: lead.id } };
    }

    it('the deposit payment confirmation names the estimate and opens its conversation in the main mailbox', async () => {
      const w = await newOrg();
      const { estimate, record, lead } = await leadEstimate(w);
      const { sendDepositPaymentConfirmation } = await email();

      await sendDepositPaymentConfirmation({
        organizationId: w.org, to: CUSTOMER_EMAIL, customerName: 'Pat Payer', estimateNumber: 'E-2', estimateId: estimate.id,
        depositAmount: 50, totalCharged: 50, paymentMethod: 'Credit Card', companyName: companyName(w), record,
      });

      const { stored } = await expectTiedToRecord(w, { type: 'estimate', id: estimate.id }, { subject: /Deposit Receipt/ });
      expect(stored.lead_id, 'saved on the lead').toBe(lead.id);
    });

    it('the deposit received confirmation names the estimate and opens its conversation in the main mailbox', async () => {
      const w = await newOrg();
      const { estimate, record } = await leadEstimate(w);
      const { sendDepositReceivedConfirmation } = await email();

      await sendDepositReceivedConfirmation({
        organizationId: w.org, to: CUSTOMER_EMAIL, customerName: 'Pat Payer', estimateNumber: 'E-3', estimateId: estimate.id,
        depositAmount: 50, paymentMethod: 'CHECK', receivedDate: '2026-10-01', companyName: companyName(w), record,
      });

      await expectTiedToRecord(w, { type: 'estimate', id: estimate.id }, { subject: /Deposit Received/ });
    });

    it('the deposit refund notice names the estimate and opens its conversation in the main mailbox', async () => {
      const w = await newOrg();
      const { estimate, record } = await leadEstimate(w);
      const { sendRefundNotification } = await email();

      await sendRefundNotification({
        organizationId: w.org, to: CUSTOMER_EMAIL, customerName: 'Pat Payer', estimateNumber: 'E-4', estimateId: estimate.id,
        refundAmount: 50, reason: 'Cancelled', companyName: companyName(w), record,
      });

      await expectTiedToRecord(w, { type: 'estimate', id: estimate.id }, { subject: /Refund Issued/ });
    });

    it('share ONE conversation with the approval email of the same estimate, and one reply address', async () => {
      const w = await newOrg();
      const { estimate, record } = await leadEstimate(w);
      const { sendDepositPaymentConfirmation, sendEstimateApprovedNotification } = await email();

      await sendDepositPaymentConfirmation({
        organizationId: w.org, to: CUSTOMER_EMAIL, customerName: 'Pat Payer', estimateNumber: 'E-5', estimateId: estimate.id,
        depositAmount: 50, totalCharged: 50, paymentMethod: 'Credit Card', companyName: companyName(w), record,
      });
      await sendEstimateApprovedNotification({
        estimateId: estimate.id, org: orgBranding(w), to: CUSTOMER_EMAIL, customerName: 'Pat Payer', estimateNumber: 'E-5', total: '$100.00', record,
      });

      const [first, second] = resendSend.mock.calls.map((c) => c[0] as { replyTo: string });
      expect(second!.replyTo).toBe(first!.replyTo);
      expect(await conversationsOf(w, estimate.id)).toHaveLength(1);
      expect(await db.email.count({ where: { organization_id: w.org, thread_id: (await conversationsOf(w, estimate.id))[0]!.id } })).toBe(2);
    });
  });

  /** The real runner: the entity is loaded as a run loads it, and the SEND_EMAIL step executes against it. */
  async function runAutomation(
    w: World, entity: { type: string; id: string },
    config: Record<string, unknown> = { recipients: ['customer'] },
    adjust: (bundle: import('../services/automations/executors').ExecutionBundle) => import('../services/automations/executors').ExecutionBundle = (b) => b,
  ) {
    const { loadExecutionBundle } = await import('../services/automations/context.js');
    const { executeAction } = await import('../services/automations/executors.js');
    const loaded = await loadExecutionBundle({ entityType: entity.type, entityId: entity.id, organizationId: w.org, dedupeKey: `acs:${randomUUID()}` });
    expect(loaded, 'the entity loads').not.toBeNull();
    return executeAction(
      { id: randomUUID(), name: 'Follow up', action_type: 'SEND_EMAIL', action_config: { subject: 'A quick note', body: 'Hello {{customer.first_name}}', ...config }, organization_id: w.org } as never,
      adjust(loaded!.bundle),
    );
  }

  describe('an automation email', () => {
    it('about a job is tied to the job, goes from the main address, and is saved on the job', async () => {
      const w = await newOrg();
      const job = await fx.addJob(w.org, w.customer, {});

      const res = await runAutomation(w, { type: 'job', id: job.id });

      expect(res.status).toBe('SENT');
      const { stored } = await expectTiedToRecord(w, { type: 'job', id: job.id }, { subject: /quick note/ });
      expect(stored.job_id).toBe(job.id);
      expect(stored.customer_id).toBe(w.customer);
    });

    it('about a lead is tied to the lead and saved on the lead, and the lead\'s people read it on the lead\'s tab', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const lead = await fx.addLead(w.org, w.customer, { assignees: [jane.id] });

      const res = await runAutomation(w, { type: 'lead', id: lead.id });

      expect(res.status).toBe('SENT');
      const { stored } = await expectTiedToRecord(w, { type: 'lead', id: lead.id });
      expect(stored.lead_id, 'saved on the lead').toBe(lead.id);
      const tab = await (await jane.api()).get(`/api/leads/${lead.id}/communications`);
      expect(tab.status).toBe(200);
      expect((tab.body.items as { id: string }[]).map((i) => i.id)).toContain(stored.id);
    });

    it('about an estimate is tied to the estimate; about an invoice, to the invoice', async () => {
      const w = await newOrg();
      const job = await fx.addJob(w.org, w.customer, {});
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: job.id });
      const invoice = await fx.addInvoice(w.org, w.customer, { jobId: job.id });

      expect((await runAutomation(w, { type: 'estimate', id: estimate.id })).status).toBe('SENT');
      await expectTiedToRecord(w, { type: 'estimate', id: estimate.id });
      expect((await runAutomation(w, { type: 'invoice', id: invoice.id })).status).toBe('SENT');
      await expectTiedToRecord(w, { type: 'invoice', id: invoice.id });
    });

    it('with no job or lead at all is tied to the customer', async () => {
      const w = await newOrg();
      const job = await fx.addJob(w.org, w.customer, {});

      // A trigger that names neither a job nor a lead nor an estimate nor an invoice, for a customer who is on the bundle.
      const res = await runAutomation(w, { type: 'job', id: job.id }, { recipients: ['customer'] }, (b) => ({ ...b, entityRef: { type: 'task', id: randomUUID(), label: null }, jobRef: null }));

      expect(res.status).toBe('SENT');
      await expectTiedToRecord(w, { type: 'customer', id: w.customer });
    });

    it('reuses one conversation and one reply address for the same record and customer', async () => {
      const w = await newOrg();
      const job = await fx.addJob(w.org, w.customer, {});

      await runAutomation(w, { type: 'job', id: job.id });
      await runAutomation(w, { type: 'job', id: job.id });

      const [first, second] = resendSend.mock.calls.map((c) => c[0] as { replyTo: string });
      expect(second!.replyTo).toBe(first!.replyTo);
      expect(await conversationsOf(w, job.id)).toHaveLength(1);
    });

    it('reaches a customer\'s opted-in extra address as the customer, and a teammate\'s copy stays unreplyable and in no mailbox', async () => {
      const w = await newOrg();
      const teammate = await personWith(w);
      const job = await fx.addJob(w.org, w.customer, {});
      await db.customerEmail.create({ data: { customer_id: w.customer, email: 'angel.home@example.com', receives_emails: true } });

      const res = await runAutomation(w, { type: 'job', id: job.id }, { recipients: ['customer', 'specific_user'], user_ids: [teammate.id] });

      expect(res.status).toBe('SENT');
      const bySubject = (to: string) => resendSend.mock.calls.map((c) => c[0] as { to: string; replyTo?: string }).find((m) => m.to === to)!;
      expect(bySubject(CUSTOMER_EMAIL).replyTo, 'the customer\'s primary address').toBeTruthy();
      expect(bySubject('angel.home@example.com').replyTo, 'the customer\'s extra address').toBeTruthy();
      expect(bySubject(teammate.email).replyTo, 'a teammate\'s copy').toBeUndefined();
      const teammateRow = await db.email.findFirstOrThrow({ where: { organization_id: w.org, to: teammate.email } });
      expect(teammateRow.thread_id, 'a teammate\'s copy is in no mailbox').toBeNull();
      expect(await db.email.count({ where: { organization_id: w.org, thread_id: null, to: { not: teammate.email } } }), 'no customer copy is loose').toBe(0);
      expect(await conversationsOf(w, job.id), 'one conversation per customer address').toHaveLength(2);
    });
  });

  describe('every other automated send to a customer', () => {
    it('is walked path by path: each names its record, goes from the main address, and leaves no loose email', async () => {
      const w = await newOrg();
      const e = await email();
      const job = await fx.addJob(w.org, w.customer, {});
      const lead = await fx.addLead(w.org, w.customer, {});
      const invoice = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
      const entry = randomUUID();
      const base = { organizationId: w.org, org: orgBranding(w), to: CUSTOMER_EMAIL, customerName: 'Pat Payer', timezone: 'America/New_York' };
      const invoiceRecord = { organizationId: w.org, customerId: w.customer, jobId: job.id, jobLabel: 'J-1', entityType: 'invoice', entityId: invoice.id };
      const jobRecord = { organizationId: w.org, customerId: w.customer, jobId: job.id, jobLabel: 'J-1', entityType: 'job', entityId: job.id };
      const leadRecord = { organizationId: w.org, customerId: w.customer, leadId: lead.id, entityType: 'lead', entityId: lead.id };
      const entryRecord = { organizationId: w.org, customerId: w.customer, entityType: 'calendar_entry', entityId: entry };
      const when = new Date('2026-11-02T15:00:00.000Z');

      const sends: { name: string; record: { type: string; id: string }; run: () => Promise<unknown> }[] = [
        { name: 'payment received', record: { type: 'invoice', id: invoice.id },
          run: () => e.sendPaymentReceivedEmail({ ...base, invoiceNumber: 'I-1', amount: 50, method: 'CARD', newBalance: 50, record: invoiceRecord }) },
        { name: 'bank payment processing', record: { type: 'invoice', id: invoice.id },
          run: () => e.sendBankPaymentProcessingEmail({ ...base, invoiceNumber: 'I-1', amount: 50, record: invoiceRecord }) },
        { name: 'bank payment failed', record: { type: 'invoice', id: invoice.id },
          run: () => e.sendBankPaymentFailedEmail({ ...base, invoiceNumber: 'I-1', amount: 50, record: invoiceRecord }) },
        { name: 'invoice refund', record: { type: 'invoice', id: invoice.id },
          run: () => e.sendInvoiceRefundNotification({ ...base, invoiceNumber: 'I-1', invoiceId: invoice.id, refundAmount: 20, record: invoiceRecord }) },
        { name: 'job scheduled', record: { type: 'job', id: job.id },
          run: () => e.sendJobScheduledEmail({ ...base, jobNumber: 'J-1', technicianName: 'Sam', serviceAddress: '1 Test Way', scheduledStart: when, record: jobRecord }) },
        { name: 'job rescheduled', record: { type: 'job', id: job.id },
          run: () => e.sendJobRescheduledEmail({ ...base, jobNumber: 'J-1', technicianName: 'Sam', serviceAddress: '1 Test Way', newScheduledStart: when, record: jobRecord }) },
        { name: 'visit cancelled', record: { type: 'job', id: job.id },
          run: () => e.sendJobVisitCancelledEmail({ ...base, jobNumber: 'J-1', reason: 'Weather', cancelledStart: when, record: jobRecord }) },
        { name: 'calendar entry scheduled', record: { type: 'calendar_entry', id: entry },
          run: () => e.sendCalendarEntryScheduledEmail({ ...base, entryTitle: 'Open house', start: when, record: entryRecord }) },
        { name: 'calendar entry moved', record: { type: 'calendar_entry', id: entry },
          run: () => e.sendCalendarEntryMovedEmail({ ...base, entryTitle: 'Open house', newStart: when, record: entryRecord }) },
        { name: 'calendar entry cancelled', record: { type: 'calendar_entry', id: entry },
          run: () => e.sendCalendarEntryCancelledEmail({ ...base, entryTitle: 'Open house', cancelledStart: when, record: entryRecord }) },
        { name: 'walkthrough scheduled', record: { type: 'lead', id: lead.id },
          run: () => e.sendWalkthroughScheduledEmail({ ...base, scheduledDate: when, performerName: 'Sam', serviceAddress: '1 Test Way', companyName: companyName(w), record: leadRecord }) },
        { name: 'walkthrough rescheduled', record: { type: 'lead', id: lead.id },
          run: () => e.sendWalkthroughRescheduledEmail({ ...base, newDate: when, performerName: 'Sam', serviceAddress: '1 Test Way', record: leadRecord }) },
      ];

      for (const send of sends) {
        resendSend.mockClear();
        await send.run();
        expect(resendSend, send.name).toHaveBeenCalledTimes(1);
        await expectTiedToRecord(w, send.record);
      }
    });
  });

  describe('a send to a non-customer, and the platform voice', () => {
    it('stays out of every mailbox when it names no record, and the notices to the company keep the no-reply address', async () => {
      const w = await newOrg();
      const e = await email();
      const threadsBefore = await db.emailThread.count({ where: { organization_id: w.org } });

      await e.sendDepositPaidAlert({ organizationId: w.org, to: 'owner@example.com', estimateNumber: 'E-9', customerName: 'Pat Payer', paymentMethod: 'CARD' });
      await e.sendAutomationEmail({ organizationId: w.org, to: 'owner@example.com', subject: '[Test] A note', text: 'hi', html: '<p>hi</p>' });
      await e.sendPaymentsActionNeededEmail({ organizationId: w.org, to: 'owner@example.com', orgName: companyName(w), fixUrl: 'https://app.example.com/fix' });
      await e.sendOwnerPaymentNoticeEmail({ organizationId: w.org, to: 'owner@example.com', subject: 'A dispute', heading: 'A dispute', lines: ['x'], actionUrl: 'https://app.example.com/p', actionLabel: 'Open' });

      expect(resendSend).toHaveBeenCalledTimes(4);
      const sent = resendSend.mock.calls.map((c) => c[0] as { from: string; replyTo?: string });
      expect(sent[0]!.replyTo, 'a staff alert').toBeUndefined();
      expect(sent[1]!.replyTo, 'a test send to the caller').toBeUndefined();
      // The platform voice is unchanged: the shared no-reply address, no company name, no reply address.
      for (const notice of sent.slice(2)) {
        expect(notice.from).toBe('no-reply@mail.test.com');
        expect(notice.replyTo).toBeUndefined();
      }
      expect(await db.email.count({ where: { organization_id: w.org } }), 'nothing is stored for any of them').toBe(0);
      expect(await db.emailThread.count({ where: { organization_id: w.org } })).toBe(threadsBefore);
    });
  });

  // ─── A customer's reply, through the real inbound path ────────────────────────────────────────────────────────────────

  /** A signature the PDF can draw: a real 1x1 PNG. */
  const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const ARRIVED = new Date('2026-07-01T15:00:00.000Z');

  /** A customer's reply to the address a send carried, arriving through the delivery webhook's handler. */
  async function receive(w: World, replyTo: string) {
    const providerId = `rp-s10-13-${w.org.slice(0, 8)}-${++sequence}`;
    fetchReceived.mockResolvedValueOnce({
      providerId,
      from: `Angel <${CUSTOMER_EMAIL}>`,
      receivedFor: [replyTo],
      to: [replyTo],
      subject: 'Re: your message',
      messageId: `<${providerId}@mail.example.com>`,
      receivedAt: ARRIVED,
      text: 'Thank you, that works.',
      html: '<div>Thank you.</div>',
      headers: { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' },
    });
    const { processResendEvent } = await import('../controllers/resend-webhook.controller.js');
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await processResendEvent(
      `svix-${providerId}-${++sequence}`,
      { type: 'email.received', created_at: ARRIVED.toISOString(), data: { email_id: providerId } } as never,
      res as never,
    );
    expect(res.status).not.toHaveBeenCalled();
    return db.email.findUniqueOrThrow({ where: { provider_message_id: providerId } });
  }

  /** Who the reply rang, apart from the Admin box (which holds every "Alert me about every ..." switch and so is always a copy). */
  async function rungBy(reply: { provider_message_id: string | null }, w: World) {
    const key = `email_inbound:${reply.provider_message_id}`;
    const rows = await db.notification.findMany({
      // One alert per list the bells open (M1): every one of them has a key that starts with the reply's.
      where: { dedup_key: { startsWith: key } }, select: { recipients: { select: { recipient_id: true } } },
    });
    return rows.flatMap((r) => r.recipients.map((x) => x.recipient_id)).filter((id) => id !== w.admin.id).sort();
  }

  const tabIds = async (person: { api: () => Promise<Awaited<ReturnType<typeof fx.signedInAs>>> }, path: string) => {
    const res = await (await person.api()).get(path);
    expect(res.status).toBe(200);
    return (res.body.items as { id: string }[]).map((i) => i.id);
  };

  describe('a customer\'s reply to an automated email', () => {
    it('to an automation email about a job joins the job\'s record conversation and shows on the job\'s tab', async () => {
      const w = await newOrg();
      const crew = await personWith(w);
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      await runAutomation(w, { type: 'job', id: job.id });
      const thread = (await conversationsOf(w, job.id))[0]!;

      const reply = await receive(w, lastSent().replyTo);

      expect(reply).toMatchObject({ thread_id: thread.id, folder: 'inbox', direction: 'in' });
      expect(await tabIds(crew, `/api/jobs/${job.id}/communications`)).toContain(reply.id);
      expect(await rungBy(reply, w), 'the job\'s people hear of the reply').toEqual([crew.id]);
      const customerTab = await (await fx.signedInAs(w.admin)).get(`/api/customers/${w.customer}/communications`);
      expect((customerTab.body.items as { id: string }[]).map((i) => i.id)).toContain(reply.id);
    });

    it('to an automation email about a lead joins the lead\'s conversation and shows on the lead\'s tab', async () => {
      const w = await newOrg();
      const assignee = await personWith(w);
      const lead = await fx.addLead(w.org, w.customer, { assignees: [assignee.id] });
      await runAutomation(w, { type: 'lead', id: lead.id });

      const reply = await receive(w, lastSent().replyTo);

      expect(reply.thread_id).toBe((await conversationsOf(w, lead.id))[0]!.id);
      expect(await tabIds(assignee, `/api/leads/${lead.id}/communications`)).toContain(reply.id);
    });

    it('to the "estimate approved" email joins the estimate\'s conversation and shows on the job\'s tab', async () => {
      const w = await newOrg();
      const crew = await personWith(w);
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: job.id });
      const { sendEstimateApprovedNotification } = await email();
      await sendEstimateApprovedNotification({
        estimateId: estimate.id, org: orgBranding(w), to: CUSTOMER_EMAIL, customerName: 'Pat Payer', estimateNumber: 'E-1', total: '$100.00',
        record: { organizationId: w.org, customerId: w.customer, jobId: job.id },
      });

      const reply = await receive(w, lastSent().replyTo);

      expect(reply.thread_id).toBe((await conversationsOf(w, estimate.id))[0]!.id);
      expect(await tabIds(crew, `/api/jobs/${job.id}/communications`)).toContain(reply.id);
    });

    it('to a deposit confirmation of an estimate on a lead shows on the lead\'s tab', async () => {
      const w = await newOrg();
      const assignee = await personWith(w);
      const lead = await fx.addLead(w.org, w.customer, { assignees: [assignee.id] });
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { leadId: lead.id });
      const { sendDepositPaymentConfirmation } = await email();
      await sendDepositPaymentConfirmation({
        organizationId: w.org, to: CUSTOMER_EMAIL, customerName: 'Pat Payer', estimateNumber: 'E-2', estimateId: estimate.id,
        depositAmount: 50, totalCharged: 50, paymentMethod: 'Credit Card', companyName: companyName(w),
        record: { organizationId: w.org, customerId: w.customer, leadId: lead.id },
      });

      const reply = await receive(w, lastSent().replyTo);

      expect(reply.thread_id).toBe((await conversationsOf(w, estimate.id))[0]!.id);
      expect(await tabIds(assignee, `/api/leads/${lead.id}/communications`)).toContain(reply.id);
    });

    it('to a deposit refund notice and to an invoice refund notice joins its record\'s conversation', async () => {
      const w = await newOrg();
      const crew = await personWith(w);
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: job.id });
      const invoice = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
      const { sendRefundNotification, sendInvoiceRefundNotification } = await email();
      const record = { organizationId: w.org, customerId: w.customer, jobId: job.id };
      await sendRefundNotification({
        organizationId: w.org, to: CUSTOMER_EMAIL, customerName: 'Pat Payer', estimateNumber: 'E-4', estimateId: estimate.id,
        refundAmount: 50, reason: 'Cancelled', companyName: companyName(w), record,
      });
      const depositReply = await receive(w, lastSent().replyTo);
      await sendInvoiceRefundNotification({
        organizationId: w.org, to: CUSTOMER_EMAIL, customerName: 'Pat Payer', invoiceNumber: 'I-1', invoiceId: invoice.id, refundAmount: 20, record,
      });
      const invoiceReply = await receive(w, lastSent().replyTo);

      expect(depositReply.thread_id).toBe((await conversationsOf(w, estimate.id))[0]!.id);
      expect(invoiceReply.thread_id).toBe((await conversationsOf(w, invoice.id))[0]!.id);
      const tab = await tabIds(crew, `/api/jobs/${job.id}/communications`);
      expect(tab).toEqual(expect.arrayContaining([depositReply.id, invoiceReply.id]));
    });
  });

  describe('the real public approval door', () => {
    it('sends the "estimate approved" email tied to the estimate, and the customer\'s reply shows on the lead\'s tab', async () => {
      const w = await newOrg();
      const assignee = await personWith(w);
      const lead = await fx.addLead(w.org, w.customer, { assignees: [assignee.id] });
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { leadId: lead.id });
      const token = `tok-${randomUUID()}`;
      await db.estimate.update({ where: { id: estimate.id }, data: { status: 'SENT', public_token: token, sent_at: new Date() } });
      const { default: request } = await import('supertest');
      const app = (await import('../app.js')).default as never;

      const res = await request(app).post(`/api/estimates/${estimate.id}/approve?token=${token}`).send({ signature_data: ONE_PIXEL_PNG });

      expect(res.status).toBe(200);
      // The email leaves after the answer has gone, so wait for it.
      await vi.waitFor(() => expect(resendSend).toHaveBeenCalledTimes(1), { timeout: 15_000 });
      await vi.waitFor(async () => expect(await conversationsOf(w, estimate.id)).toHaveLength(1), { timeout: 15_000 });
      await vi.waitFor(async () => expect(await db.email.count({ where: { organization_id: w.org, direction: 'out' } })).toBe(1), { timeout: 15_000 });
      await expectTiedToRecord(w, { type: 'estimate', id: estimate.id }, { subject: /Approved/ });
      const reply = await receive(w, lastSent().replyTo);
      expect(await tabIds(assignee, `/api/leads/${lead.id}/communications`)).toContain(reply.id);
    });
  });

  describe('what an automated send costs', () => {
    it('adds one indexed read when the record\'s conversation exists, and a handful of statements on the first send, none in a transaction', async () => {
      const w = await newOrg();
      const job = await fx.addJob(w.org, w.customer, {});
      const runAndCount = async () => {
        statements.sql = [];
        statements.on = true;
        try { await runAutomation(w, { type: 'job', id: job.id }); } finally { statements.on = false; }
        return statements.sql.filter((sql) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql));
      };
      // The run itself loads the job and the customer; only what the SEND added is counted, by table.
      const sendStatements = (sql: string[]) => sql.filter((q) => /reply_tokens|email_threads|"mailboxes"|"emails"|mailbox/i.test(q) || /organizations/i.test(q) && /email_sending_enabled/.test(q));
      const verbs = (sql: string[]) => sql.map((q) => `${q.split(' ')[0]} ${/(?:FROM|INTO|UPDATE) "public"\."(\w+)"/.exec(q)?.[1] ?? '?'}`);

      const first = verbs(sendStatements(await runAndCount()));
      const second = verbs(sendStatements(await runAndCount()));

      // First send for the record: one look for its token, one for the main mailbox, then the conversation, its token and
      // the stored email are written.
      const times = (list: string[], v: string) => list.filter((x) => x === v).length;
      expect(first.filter((v) => v.startsWith('INSERT'))).toEqual(['INSERT email_threads', 'INSERT reply_tokens', 'INSERT emails']);
      expect(times(first, 'SELECT reply_tokens')).toBe(1);
      expect(times(first, 'SELECT mailboxes') - times(second, 'SELECT mailboxes'), 'the main mailbox is looked up only to open a conversation').toBe(1);
      // Every later send: ONE indexed read (the token that finds the conversation) and nothing else beyond what the dispatch
      // always did (the company row and its main address, then the stored email).
      expect(times(second, 'SELECT reply_tokens')).toBe(1);
      expect(second.filter((v) => v.startsWith('INSERT') || v.startsWith('UPDATE'))).toEqual(['INSERT emails']);
    });
  });
});
