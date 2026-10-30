/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.12 - hand-sent estimates, invoices and the staging pickup email go from the
   sender's own mailbox.

   An estimate (with or without a deposit request) or an invoice sent from its page, and the staging pickup email, go out
   from the sender's OWN address with "<name> at <company>" as the display name; a sender with no address is refused, and a
   bulk send is refused as a whole before anything goes out. A hand-sent document opens or reuses its record conversation in
   the sender's mailbox (reuse applies per sending mailbox), with a reply address scoped to it, so the customer's answer
   lands there and rings the record's people; a later automated receipt for the same record opens its own conversation in
   the main mailbox. Attachment wins: the sender reaches the conversation while they can open the record, and not after.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding exactly the
   switch values under test, against a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. The
   real dispatcher runs; only the mail provider's client is faked, so the headers that "went out" are read back and compared
   with the stored email. The inbound half goes through the real webhook handler with the real reply-token resolver. No
   email leaves the machine. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient, resendSend, fetchReceived } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, resendSend: vi.fn(), fetchReceived: vi.fn() };
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
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('hand-sent estimates, invoices and the pickup email go from the sender\'s mailbox (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM resend_events WHERE (payload->'data'->>'email_id') LIKE 'rp-s10-12-${org.slice(0, 8)}%'`));
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

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api>; first: string; last: string };
  let sequence = 0;
  const CUSTOMER_EMAIL = 'angel@example.com';

  /** A company that sends mail, with its main mailbox and address, and a customer with an email on file. */
  async function newOrg(opts: { sending?: boolean; featureOverrides?: Record<string, boolean> } = {}) {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const part = `co${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: {
        email_sending_enabled: opts.sending ?? true, email_sender_local_part: part,
        ...(opts.featureOverrides ? { feature_overrides: opts.featureOverrides } : {}),
      },
    });
    await db.customer.update({ where: { id: made.customer }, data: { email: CUSTOMER_EMAIL } });
    const main = await db.mailbox.create({ data: { organization_id: made.org, kind: 'main', status: 'active' }, select: { id: true } });
    await db.mailboxAddress.create({ data: { local_part: part, organization_id: made.org, mailbox_id: main.id, is_primary: true } });
    return { ...made, main: main.id, part };
  }
  type World = Awaited<ReturnType<typeof newOrg>>;

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

  /** A person on a fresh custom role holding exactly these switch values, with their own mailbox and address. */
  async function personWith(
    w: World,
    values: Record<string, boolean | string> = {},
    opts: { address?: boolean | string } = {},
    base: Role = 'DISPATCHER',
  ): Promise<Who> {
    const key = `hsd-role-${++sequence}`;
    const role = await fx.addCustomRole(w.org, key, base);
    await setRoleSwitchValues({
      organizationId: w.org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, estimates_scope: 'attached', edit_estimates: true,
        view_invoices: true, invoices_scope: 'attached', edit_invoices: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'linked_to_me',
        contact_customers: true,
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(w.org, `p${sequence}`, base, { customRoleId: role.id });
    await userMailbox(w, person, opts.address ?? true);
    return Object.assign(person, { api: () => fx.signedInAs(person), first: `p${sequence}`, last: 'Tester' });
  }

  /** A user's own mailbox: with its primary address (the default), or in "address needed" with none. */
  async function userMailbox(w: World, owner: Person, address: boolean | string = true) {
    const id = randomUUID();
    await db.mailbox.create({
      data: { id, organization_id: w.org, kind: 'user', user_id: owner.id, holder_user_id: owner.id, status: address ? 'active' : 'address_needed' },
    });
    if (address) {
      const local = typeof address === 'string' ? address : `${owner.email.split('@')[0]}.${w.part}`.toLowerCase();
      await db.mailboxAddress.create({ data: { local_part: local, organization_id: w.org, mailbox_id: id, is_primary: true } });
    }
    return id;
  }
  const mailboxOf = async (person: Person) => db.mailbox.findFirstOrThrow({
    where: { user_id: person.id, kind: 'user' }, include: { addresses: { where: { is_primary: true } } },
  });
  const addressOf = async (person: Person) => `${(await mailboxOf(person)).addresses[0]!.local_part}@staging.mail.test.com`;
  const nameOf = (w: World, person: Who) => `${person.first} ${person.last} at switches-${w.tag}`;

  /** The message the mocked provider was last given. */
  const lastSent = () => resendSend.mock.calls.at(-1)![0] as { from: string; replyTo: string; to: string; subject: string };
  /** The header a send went out with, as address and name. */
  const headerOf = (header: string) => {
    const m = /^"(.*)" <(.*)>$/.exec(header)!;
    return { name: m[1]!, address: m[2]! };
  };

  /** Every call the provider got, in order. */
  const sentCalls = () => resendSend.mock.calls.map((c) => c[0] as { from: string; replyTo: string; to: string; subject: string });

  /** The record conversations (one per sending mailbox) a document opened. */
  const conversationsOf = (w: World, recordId: string) => db.emailThread.findMany({
    where: { organization_id: w.org, origin: 'record', record_id: recordId }, orderBy: { created_at: 'asc' },
  });

  /** The conversation a send's reply address resolves to, through the real resolver. */
  async function threadOfReplyAddress(replyTo: string) {
    const { parseReplyAddress, resolveReplyToken } = await import('../lib/reply-token.js');
    return (await resolveReplyToken(db, parseReplyAddress(replyTo)!))?.thread_id ?? null;
  }

  const pickup = (api: Api, stageId: string) =>
    api.post('/api/inventory/job-stages/email', { stageId, to: ['tech@example.com'], subject: 'Pickup ticket' });

  /** A job the sender is on, with an estimate of the job's (made by the admin, so only the job attaches the sender to it). */
  async function jobWithEstimate(w: World, crew: Person[], opts: { soldBy?: Person; dispatcher?: Person } = {}) {
    const job = await fx.addJob(w.org, w.customer, { crew: crew.map((c) => c.id), soldBy: opts.soldBy?.id, dispatcher: opts.dispatcher?.id });
    const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: job.id });
    return { job, estimate };
  }

  describe('an estimate sent from its page goes from the sender\'s own mailbox', () => {
    it('without a deposit request: their address and "<name> at <company>", the stored email says exactly what went out', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const estimate = await fx.addEstimate(w.org, w.customer, jane.id);

      const res = await (await jane.api()).post(`/api/estimates/${estimate.id}/send`, { deposit_required: false });
      expect(res.status).toBe(200);

      const header = headerOf(lastSent().from);
      expect(header).toEqual({ name: nameOf(w, jane), address: await addressOf(jane) });
      const stored = await db.email.findFirstOrThrow({ where: { organization_id: w.org, direction: 'out' } });
      expect(stored.from).toEqual({ name: header.name, email: header.address });
      expect(stored.sent_by_user_id).toBe(jane.id);
    });

    it('opens its record conversation in the sender\'s mailbox, with a reply address that resolves to it, saved on the job', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const { job, estimate } = await jobWithEstimate(w, [jane]);

      expect((await (await jane.api()).post(`/api/estimates/${estimate.id}/send`, { deposit_required: false })).status).toBe(200);

      const threads = await conversationsOf(w, estimate.id);
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({ mailbox_id: (await mailboxOf(jane)).id, origin: 'record', record_type: 'estimate', assigned_to_user_id: null });
      expect(await threadOfReplyAddress(lastSent().replyTo)).toBe(threads[0]!.id);
      const stored = await db.email.findFirstOrThrow({ where: { thread_id: threads[0]!.id } });
      expect(stored).toMatchObject({ job_id: job.id, sent_by_user_id: jane.id });
    });

    it('with a deposit request: the same, from the sender', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const estimate = await fx.addEstimate(w.org, w.customer, jane.id);

      const res = await (await jane.api()).post(`/api/estimates/${estimate.id}/send`, { deposit_required: true, payment_methods: ['CASH'] });
      expect(res.status).toBe(200);

      expect(lastSent().subject).toMatch(/Deposit Required/);
      expect(headerOf(lastSent().from)).toEqual({ name: nameOf(w, jane), address: await addressOf(jane) });
      const [thread] = await conversationsOf(w, estimate.id);
      expect(thread).toMatchObject({ mailbox_id: (await mailboxOf(jane)).id, origin: 'record' });
      expect(await threadOfReplyAddress(lastSent().replyTo)).toBe(thread!.id);
    });

    it('is the same on a resend, and the bulk reminder is a hand send by the person who clicked', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const estimate = await fx.addEstimate(w.org, w.customer, jane.id);
      const api = await jane.api();
      expect((await api.post(`/api/estimates/${estimate.id}/send`, { deposit_required: false })).status).toBe(200);

      expect((await api.post(`/api/estimates/${estimate.id}/send`, { deposit_required: false })).status).toBe(200);
      expect((await api.post('/api/estimates/bulk-send-reminder', { ids: [estimate.id] })).body).toMatchObject({ sent: [estimate.id], failed: [] });

      expect(sentCalls()).toHaveLength(3);
      for (const call of sentCalls()) expect(headerOf(call.from)).toEqual({ name: nameOf(w, jane), address: await addressOf(jane) });
      const stored = await db.email.findMany({ where: { organization_id: w.org, direction: 'out' } });
      expect(stored.map((e) => (e.from as { email: string }).email)).toEqual(Array(3).fill(await addressOf(jane)));
    });
  });

  describe('reuse applies per sending mailbox', () => {
    it('lets one sender sending again reuse their conversation and reply address, and two senders get two conversations', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const joe = await personWith(w);
      const { estimate } = await jobWithEstimate(w, [jane, joe]);

      await (await jane.api()).post(`/api/estimates/${estimate.id}/send`, { deposit_required: false });
      await (await jane.api()).post(`/api/estimates/${estimate.id}/send`, { deposit_required: false });
      expect(await conversationsOf(w, estimate.id), 'one sender, twice').toHaveLength(1);
      const [first, second] = sentCalls();
      expect(first!.replyTo).toBe(second!.replyTo);

      await (await joe.api()).post(`/api/estimates/${estimate.id}/send`, { deposit_required: false });
      const threads = await conversationsOf(w, estimate.id);
      expect(threads.map((t) => t.mailbox_id).sort()).toEqual([(await mailboxOf(jane)).id, (await mailboxOf(joe)).id].sort());
      const [, , third] = sentCalls();
      expect(third!.replyTo).not.toBe(first!.replyTo);
      const [janesBox, joesBox] = [(await mailboxOf(jane)).id, (await mailboxOf(joe)).id];
      expect(await threadOfReplyAddress(third!.replyTo)).toBe(threads.find((t) => t.mailbox_id === joesBox)!.id);
      expect(await threadOfReplyAddress(first!.replyTo)).toBe(threads.find((t) => t.mailbox_id === janesBox)!.id);
    });
  });

  describe('an invoice sent from its page goes from the sender\'s own mailbox', () => {
    /** A job the sender is on, with invoices of the job's. */
    async function jobWithInvoices(w: World, crew: Person[], count = 1) {
      const job = await fx.addJob(w.org, w.customer, { crew: crew.map((c) => c.id) });
      const invoices = [];
      for (let i = 0; i < count; i++) invoices.push(await fx.addInvoice(w.org, w.customer, { jobId: job.id }));
      return { job, invoices };
    }
    const mine = async (w: World, jane: Who) => ({ name: nameOf(w, jane), address: await addressOf(jane) });

    it('on send: their address and name, the stored email says exactly what went out, and its conversation sits in their mailbox', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const { job, invoices: [invoice] } = await jobWithInvoices(w, [jane]);

      expect((await (await jane.api()).post(`/api/invoices/${invoice!.id}/send`, {})).status).toBe(200);

      const header = headerOf(lastSent().from);
      expect(header).toEqual(await mine(w, jane));
      const [thread] = await conversationsOf(w, invoice!.id);
      expect(thread).toMatchObject({ mailbox_id: (await mailboxOf(jane)).id, origin: 'record', record_type: 'invoice' });
      const stored = await db.email.findFirstOrThrow({ where: { thread_id: thread!.id } });
      expect(stored.from).toEqual({ name: header.name, email: header.address });
      expect(stored).toMatchObject({ sent_by_user_id: jane.id, job_id: job.id });
      expect(await threadOfReplyAddress(lastSent().replyTo)).toBe(thread!.id);
    });

    it('on resend, reusing the same conversation', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const { invoices: [invoice] } = await jobWithInvoices(w, [jane]);
      const api = await jane.api();
      expect((await api.post(`/api/invoices/${invoice!.id}/send`, {})).status).toBe(200);

      expect((await api.post(`/api/invoices/${invoice!.id}/resend`, {})).status).toBe(200);

      expect(sentCalls()).toHaveLength(2);
      expect(headerOf(lastSent().from)).toEqual(await mine(w, jane));
      expect(await conversationsOf(w, invoice!.id)).toHaveLength(1);
      expect(sentCalls()[1]!.replyTo).toBe(sentCalls()[0]!.replyTo);
    });

    it('on bulk send and bulk resend: a hand send by the person who clicked, every one from their mailbox', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const { invoices } = await jobWithInvoices(w, [jane], 3);
      const ids = invoices.map((i) => i.id);
      const api = await jane.api();

      const bulk = await api.post('/api/invoices/bulk-send', { ids });
      expect(bulk.body).toMatchObject({ failed: [] });
      expect([...bulk.body.sent].sort()).toEqual([...ids].sort());
      const again = await api.post('/api/invoices/bulk-resend', { ids });
      expect([...again.body.sent].sort()).toEqual([...ids].sort());

      expect(sentCalls()).toHaveLength(6);
      for (const call of sentCalls()) expect(headerOf(call.from)).toEqual(await mine(w, jane));
      const stored = await db.email.findMany({ where: { organization_id: w.org, direction: 'out' } });
      expect(stored.map((e) => (e.from as { email: string }).email)).toEqual(Array(6).fill(await addressOf(jane)));
      for (const invoice of invoices) {
        expect((await conversationsOf(w, invoice.id)).map((t) => t.mailbox_id)).toEqual([(await mailboxOf(jane)).id]);
      }
    });
  });

  describe('the staging pickup email goes from the sender\'s own mailbox', () => {
    async function aStage(w: World, crew: Person[]) {
      const job = await fx.addJob(w.org, w.customer, { crew: crew.map((c) => c.id) });
      const stage = await db.jobStage.create({
        data: {
          organization_id: w.org, job_id: job.id, job_number: `J-${job.id.slice(0, 6)}`, customer: 'Pat Payer', site: '1 Test Way',
          trade: 'Doors', status: 'Staged',
        },
        select: { id: true, job_number: true },
      });
      return { job, stage };
    }
    it('goes out with their address and name, and the stored email says exactly what went out', async () => {
      const w = await newOrg();
      const jane = await personWith(w, { view_stock: true, edit_stock: true });
      const { job, stage } = await aStage(w, [jane]);

      const res = await pickup(await jane.api(), stage.id);
      expect(res.status).toBe(200);

      const header = headerOf(lastSent().from);
      expect(header).toEqual({ name: nameOf(w, jane), address: await addressOf(jane) });
      const stored = await db.email.findFirstOrThrow({ where: { organization_id: w.org, direction: 'out' } });
      expect(stored.from).toEqual({ name: header.name, email: header.address });
      expect(stored.job_id).toBe(job.id);
    });
  });

  describe('a person with no address of their own cannot send a document by hand', () => {
    const MESSAGE = "You don't have an email address yet. An admin needs to set one before you can send email.";

    it.each([
      ['in "address needed"', false],
      ['with no mailbox at all', null],
    ] as const)('is refused on every path, bulk sends as a whole, %s: nothing is sent, stored or moved', async (_label, address) => {
      const w = await newOrg();
      const jane = await personWith(w, { view_stock: true, edit_stock: true }, { address: address === null ? false : address });
      if (address === null) await db.mailbox.deleteMany({ where: { user_id: jane.id } });
      const job = await fx.addJob(w.org, w.customer, { crew: [jane.id] });
      const draft = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: job.id });
      const sentEstimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: job.id });
      await db.estimate.update({ where: { id: sentEstimate.id }, data: { status: 'SENT', public_token: randomUUID() } });
      const invoices = [await fx.addInvoice(w.org, w.customer, { jobId: job.id }), await fx.addInvoice(w.org, w.customer, { jobId: job.id })];
      const issued = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
      await db.invoice.update({ where: { id: issued.id }, data: { status: 'SENT', public_token: randomUUID() } });
      const stage = await db.jobStage.create({
        data: { organization_id: w.org, job_id: job.id, job_number: 'J-1', customer: 'Pat Payer', site: '1 Test Way', trade: 'Doors', status: 'Staged' },
        select: { id: true },
      });
      const api = await jane.api();

      const attempts = [
        await api.post(`/api/estimates/${draft.id}/send`, { deposit_required: false }),
        await api.post(`/api/estimates/${draft.id}/send`, { deposit_required: true, payment_methods: ['CASH'] }),
        await api.post('/api/estimates/bulk-send-reminder', { ids: [sentEstimate.id] }),
        await api.post(`/api/invoices/${invoices[0]!.id}/send`, {}),
        await api.post(`/api/invoices/${issued.id}/resend`, {}),
        await api.post('/api/invoices/bulk-send', { ids: invoices.map((i) => i.id) }),
        await api.post('/api/invoices/bulk-resend', { ids: [issued.id] }),
        await pickup(api, stage.id),
      ];
      for (const res of attempts) {
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: MESSAGE, code: 'ADDRESS_NEEDED' });
      }
      expect(resendSend).not.toHaveBeenCalled();
      expect(await db.email.count({ where: { organization_id: w.org } })).toBe(0);
      expect(await db.emailThread.count({ where: { organization_id: w.org } })).toBe(0);
      expect(await db.replyToken.count({ where: { organization_id: w.org } })).toBe(0);
      expect((await db.estimate.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
      expect((await db.invoice.findMany({ where: { id: { in: invoices.map((i) => i.id) } } })).map((i) => i.status)).toEqual(['DRAFT', 'DRAFT']);
    });

    it('still has automated sends about their records go out, from the company\'s main address, into the main mailbox', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {}, { address: false });
      const invoice = await fx.addInvoice(w.org, w.customer, { createdBy: jane.id });
      const { sendPaymentReceivedEmail } = await import('../lib/email.js');
      await sendPaymentReceivedEmail({
        organizationId: w.org, to: CUSTOMER_EMAIL, customerName: 'Pat', invoiceNumber: 'INV-1', amount: 100, method: 'CASH', newBalance: 0,
        record: { organizationId: w.org, customerId: w.customer, entityType: 'invoice', entityId: invoice.id },
      });
      expect(headerOf(lastSent().from)).toMatchObject({ address: `${w.part}@staging.mail.test.com` });
      expect((await conversationsOf(w, invoice.id)).map((t) => t.mailbox_id)).toEqual([w.main]);
    });
  });

  describe('a later automated receipt opens its own conversation in the main mailbox', () => {
    it('leaves the hand-sent document\'s conversation in the sender\'s mailbox, and a second receipt reuses the main one', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const job = await fx.addJob(w.org, w.customer, { crew: [jane.id] });
      const invoice = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
      expect((await (await jane.api()).post(`/api/invoices/${invoice.id}/send`, {})).status).toBe(200);
      const handSent = lastSent();

      const { sendPaymentReceivedEmail } = await import('../lib/email.js');
      const receipt = () => sendPaymentReceivedEmail({
        organizationId: w.org, to: CUSTOMER_EMAIL, customerName: 'Pat', invoiceNumber: 'INV-1', amount: 100, method: 'CASH', newBalance: 0,
        record: { organizationId: w.org, customerId: w.customer, jobId: job.id, entityType: 'invoice', entityId: invoice.id },
      });
      await receipt();
      const automated = lastSent();
      await receipt();

      // From the company, with the company's name, and a reply address of its own.
      expect(headerOf(automated.from)).toEqual({ name: `switches-${w.tag}`, address: `${w.part}@staging.mail.test.com` });
      expect(automated.replyTo).not.toBe(handSent.replyTo);
      const threads = await conversationsOf(w, invoice.id);
      expect(threads.map((t) => t.mailbox_id).sort()).toEqual([(await mailboxOf(jane)).id, w.main].sort());
      const inMain = threads.find((t) => t.mailbox_id === w.main)!;
      expect(await threadOfReplyAddress(automated.replyTo)).toBe(inMain.id);
      expect(await threadOfReplyAddress(handSent.replyTo)).toBe(threads.find((t) => t.mailbox_id !== w.main)!.id);
      expect(sentCalls().at(-1)!.replyTo, 'the second receipt reuses the main conversation').toBe(automated.replyTo);
      expect(await db.emailThread.count({ where: { organization_id: w.org, mailbox_id: w.main } })).toBe(1);
    });
  });

  // ─── A customer's reply, through the real inbound path ────────────────────────────────────────────────────────────────

  const ARRIVED = new Date('2026-07-01T15:00:00.000Z');

  /** A customer's reply to the address a send carried, arriving through the delivery webhook's handler. */
  async function receive(w: World, replyTo: string, opts: { from?: string } = {}) {
    const providerId = `rp-s10-12-${w.org.slice(0, 8)}-${++sequence}`;
    fetchReceived.mockResolvedValueOnce({
      providerId,
      from: opts.from ?? `Angel <${CUSTOMER_EMAIL}>`,
      receivedFor: [replyTo],
      to: [replyTo],
      subject: 'Re: Your estimate',
      messageId: `<${providerId}@mail.example.com>`,
      receivedAt: ARRIVED,
      text: 'Sounds good, thank you.',
      html: '<div>Sounds good.</div>',
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
    const row = await db.email.findUniqueOrThrow({ where: { provider_message_id: providerId } });
    return { providerId, row };
  }

  /** Who the reply rang, apart from the Admin box (which holds every "Alert me about every ..." switch and so is always a copy). */
  async function rungBy(providerId: string, w: World) {
    const key = `email_inbound:${providerId}`;
    const rows = await db.notification.findMany({
      where: { dedup_key: { in: [key, `${key}:why`] } }, select: { recipients: { select: { recipient_id: true } } },
    });
    return rows.flatMap((r) => r.recipients.map((x) => x.recipient_id)).filter((id) => id !== w.admin.id).sort();
  }
  const sorted = (...people: Person[]) => people.map((p) => p.id).sort();

  const listedIds = async (person: Who, query: string) => {
    const res = await (await person.api()).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };
  const tabIds = async (person: Person & { api: () => Promise<Api> }, path: string) => {
    const res = await (await person.api()).get(path);
    expect(res.status).toBe(200);
    return (res.body.items as { id: string }[]).map((i) => i.id);
  };

  describe('a customer\'s reply to a hand-sent estimate', () => {
    it('joins the estimate\'s conversation in the sender\'s mailbox, shows on the job\'s and the customer\'s tab, and rings the sender, Sold By, crew and Dispatcher', async () => {
      const w = await newOrg();
      const [jane, soldBy, crew, dispatcher] = [await personWith(w), await personWith(w), await personWith(w), await personWith(w)];
      const { job, estimate } = await jobWithEstimate(w, [jane, crew], { soldBy, dispatcher });
      await (await jane.api()).post(`/api/estimates/${estimate.id}/send`, { deposit_required: false });
      const [thread] = await conversationsOf(w, estimate.id);

      const reply = await receive(w, lastSent().replyTo);

      expect(reply.row).toMatchObject({ thread_id: thread!.id, folder: 'inbox', direction: 'in' });
      expect(await rungBy(reply.providerId, w)).toEqual(sorted(jane, soldBy, crew, dispatcher));
      expect(await tabIds(soldBy, `/api/jobs/${job.id}/communications`), 'the job\'s tab').toContain(reply.row.id);
      const customerTab = await (await fx.signedInAs(w.admin)).get(`/api/customers/${w.customer}/communications`);
      expect((customerTab.body.items as { id: string }[]).map((i) => i.id), 'the customer\'s tab').toContain(reply.row.id);
      expect(await listedIds(jane, '?folder=inbox'), 'the sender\'s Email page').toEqual([reply.row.id]);
    });

    it('rings only the others once the sender is taken off the job', async () => {
      const w = await newOrg();
      const [jane, soldBy, crew, dispatcher] = [await personWith(w), await personWith(w), await personWith(w), await personWith(w)];
      const { job, estimate } = await jobWithEstimate(w, [jane, crew], { soldBy, dispatcher });
      await (await jane.api()).post(`/api/estimates/${estimate.id}/send`, { deposit_required: false });
      await fx.removeCrew(job.visitId!, jane.id);

      const reply = await receive(w, lastSent().replyTo);

      expect(await rungBy(reply.providerId, w)).toEqual(sorted(soldBy, crew, dispatcher));
      expect(await listedIds(jane, '?folder=inbox'), 'no longer on the sender\'s Email page').toEqual([]);
      expect(await listedIds(jane, '?folder=sent')).toEqual([]);
    });

    it('goes to the lead\'s tab when the estimate is on a lead, and rings the lead\'s people and the sender', async () => {
      const w = await newOrg();
      const [jane, other] = [await personWith(w), await personWith(w)];
      const lead = await fx.addLead(w.org, w.customer, { assignees: [jane.id, other.id] });
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { leadId: lead.id });
      await (await jane.api()).post(`/api/estimates/${estimate.id}/send`, { deposit_required: false });

      const reply = await receive(w, lastSent().replyTo);

      expect(reply.row.thread_id, 'the estimate\'s conversation').toBe((await conversationsOf(w, estimate.id))[0]!.id);
      expect(await tabIds(other, `/api/leads/${lead.id}/communications`)).toContain(reply.row.id);
      expect((await rungBy(reply.providerId, w))).toEqual(expect.arrayContaining(sorted(jane)));
    });
  });

  describe('attachment wins for a document sent by hand from a job', () => {
    it('lists and opens the conversation in the sender\'s own mailbox while they are on the job, and neither once taken off', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const job = await fx.addJob(w.org, w.customer, { crew: [jane.id] });
      const invoice = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
      expect((await (await jane.api()).post(`/api/invoices/${invoice.id}/send`, {})).status).toBe(200);
      const [thread] = await conversationsOf(w, invoice.id);
      const sentEmail = (await db.email.findFirstOrThrow({ where: { thread_id: thread!.id } })).id;
      // The sender's own correspondence in the same mailbox, tied to the same job: unaffected by the record rule.
      const otherBox = (await mailboxOf(jane)).id;
      const ordinary = randomUUID();
      const ordinaryThread = randomUUID();
      await db.emailThread.create({ data: { id: ordinaryThread, organization_id: w.org, mailbox_id: otherBox, origin: 'started', assigned_to_user_id: jane.id } });
      await db.email.create({
        data: {
          id: ordinary, organization_id: w.org, thread_id: ordinaryThread, customer_id: w.customer, job_id: job.id, account: 'user', direction: 'in',
          folder: 'inbox', from: { name: null, email: CUSTOMER_EMAIL }, to: 'office@example.com', subject: 'Question', snippet: 's', body: ['b'],
          at: '1:00 PM', ts: BigInt(Date.now()),
        },
        select: { id: true },
      });
      const open = async (id: string) => (await (await jane.api()).get(`/api/communication/emails/${id}`)).status;

      expect(await listedIds(jane, '?folder=sent'), 'while on the job').toEqual([sentEmail]);
      expect(await open(sentEmail)).toBe(200);

      await fx.removeCrew(job.visitId!, jane.id);

      expect(await listedIds(jane, '?folder=sent'), 'after being taken off').toEqual([]);
      expect(await open(sentEmail)).toBe(404);
      expect(await listedIds(jane, '?folder=inbox'), 'her own other mail').toEqual([ordinary]);
      expect(await open(ordinary)).toBe(200);
    });
  });

  describe('the existing blocks stand for a document sent by hand', () => {
    it('stops the send while the company has email sending off, and stores nothing', async () => {
      const w = await newOrg({ sending: false });
      const jane = await personWith(w);
      const estimate = await fx.addEstimate(w.org, w.customer, jane.id);
      const invoice = await fx.addInvoice(w.org, w.customer, { createdBy: jane.id });
      const api = await jane.api();

      const attempts = [await api.post(`/api/estimates/${estimate.id}/send`, { deposit_required: false }), await api.post(`/api/invoices/${invoice.id}/send`, {})];
      for (const res of attempts) expect(res.status).toBe(409);
      expect(resendSend).not.toHaveBeenCalled();
      expect(await db.email.count({ where: { organization_id: w.org } })).toBe(0);
      expect(await db.emailThread.count({ where: { organization_id: w.org } })).toBe(0);
    });

    it('stops a send to an address on the suppression list', async () => {
      const w = await newOrg();
      const jane = await personWith(w);
      const estimate = await fx.addEstimate(w.org, w.customer, jane.id);
      const bounced = `bounced-${w.tag}@example.com`;
      await db.customer.update({ where: { id: w.customer }, data: { email: bounced } });
      await db.emailSuppression.create({ data: { address: bounced, category: 'TRANSACTIONAL', kind: 'HARD_BOUNCE' } });
      try {
        const res = await (await jane.api()).post(`/api/estimates/${estimate.id}/send`, { deposit_required: false });
        // Refused as today (the estimate's own wording for a skipped send), and left a draft.
        expect(res.status).toBe(502);
        expect(resendSend).not.toHaveBeenCalled();
        expect((await db.estimate.findUniqueOrThrow({ where: { id: estimate.id } })).status).toBe('DRAFT');
      } finally {
        await db.emailSuppression.deleteMany({ where: { address: bounced } });
      }
    });

    it('refuses a person whose role cannot send estimates or invoices, as it does today', async () => {
      const w = await newOrg();
      const jane = await personWith(w, withDependantsOff(['edit_estimates', 'edit_invoices']));
      const job = await fx.addJob(w.org, w.customer, { crew: [jane.id] });
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: job.id });
      const invoice = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
      const api = await jane.api();
      expect((await api.post(`/api/estimates/${estimate.id}/send`, { deposit_required: false })).status).toBe(403);
      expect((await api.post(`/api/invoices/${invoice.id}/send`, {})).status).toBe(403);
      expect(resendSend).not.toHaveBeenCalled();
    });

    // RULING (S10.12 fix round 1): PRD 10 says "Sending needs Contact customers, as today". For the Email page that is true
    // today; for a document it is not: an estimate or invoice send is gated by its own switch (Send estimates / Send
    // invoices) and a pickup ticket by Edit stock, and PRD 6 says the invoice send on a job "still needs its own switch"
    // (permission-job-done-writes-db holds a role with only that switch). The sentence is read as "as today", so this slice
    // moves the sender's identity, not the gate: Contact customers neither opens nor closes a document send.
    it('keeps today\'s gate on a document send: its own switch decides, Contact customers does not', async () => {
      const w = await newOrg();
      const jane = await personWith(w, { view_stock: true, edit_stock: true, ...withDependantsOff(['contact_customers']) });
      const job = await fx.addJob(w.org, w.customer, { crew: [jane.id] });
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: job.id });
      const invoice = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
      const api = await jane.api();
      expect((await api.post(`/api/estimates/${estimate.id}/send`, { deposit_required: false })).status).toBe(200);
      expect((await api.post(`/api/invoices/${invoice.id}/send`, {})).status).toBe(200);
      expect(resendSend).toHaveBeenCalledTimes(2);
      for (const sent of sentCalls()) expect(headerOf(sent.from).address).toBe(await addressOf(jane));
    });

    it('answers a stage outside the person\'s reach with not found before it asks about their address', async () => {
      const w = await newOrg();
      const jane = await personWith(w, { view_stock: true, edit_stock: true }, { address: false });
      const elsewhere = await fx.addJob(w.org, w.customer, {});
      const outside = await db.jobStage.create({
        data: { organization_id: w.org, job_id: elsewhere.id, job_number: 'J-2', customer: 'Pat Payer', site: '1 Test Way', trade: 'Doors', status: 'Staged' },
        select: { id: true },
      });
      const onIt = await fx.addJob(w.org, w.customer, { crew: [jane.id] });
      const inside = await db.jobStage.create({
        data: { organization_id: w.org, job_id: onIt.id, job_number: 'J-3', customer: 'Pat Payer', site: '1 Test Way', trade: 'Doors', status: 'Staged' },
        select: { id: true },
      });
      const api = await jane.api();
      expect((await pickup(api, outside.id)).status).toBe(404);
      const refused = await pickup(api, inside.id);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('ADDRESS_NEEDED');
      expect(resendSend).not.toHaveBeenCalled();
    });

    it('still lets the document go out while ServWave has the Email plan feature off, as today, from the sender\'s address', async () => {
      const w = await newOrg({ featureOverrides: { email: false } });
      const jane = await personWith(w);
      const estimate = await fx.addEstimate(w.org, w.customer, jane.id);
      expect((await (await jane.api()).post(`/api/estimates/${estimate.id}/send`, { deposit_required: false })).status).toBe(200);
      expect(headerOf(lastSent().from).address).toBe(await addressOf(jane));
    });
  });
});
