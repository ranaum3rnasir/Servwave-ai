/* =============================================================================
   Roles & Permissions security, re-audit pass 2 fixes (fix builder F). One case per finding, each through the HTTP API on a
   real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.

   Every person is on a custom role holding exactly the switches the case is about. Each case also proves its control: the
   person who should see or do the thing still does, so a case cannot pass because nobody gets anything.

     P2-1  a phone number files a record on a customer only when the person can open that customer (the text and call twins of
           N9): a new text conversation, a logged call, a WhatsApp chat, the dialer's "who is this number" answer, and a text
           composed to a typed number (NV-vp3-1, re-audit pass 3), which also leaves no conversation behind when it is
           refused (NV-v3b-1, GitHub #2906);
     P2-2  the payments drawer's refusals and the payment's history name no figure to a person without See prices;
     P2-4  the price-book image upload answers a hidden estimate exactly like a missing one.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The payment processor edge: how a payment was paid and its refunds are answered here, never asked of the processor.
vi.mock('../lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isStripeConfigured: () => true,
  getStripeForOrg: () => ({}),
  retrieveCapturePayerDetail: async () => ({ method: 'card', brand: 'visa', last4: '4242', bank_name: null, description: null }),
  listPaymentIntentRefunds: async () => [],
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('re-audit pass 2 fixes, builder F (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = await fx.listener();
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['unapplied_captures', 'disputes', 'payouts', 'message_threads', 'call_sessions', 'whatsapp_chats']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      // A price-book item outlives its company until the estimate lines that name it are gone (no cascade).
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_line_items WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM price_book_items WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Someone = Person & { api: () => Promise<Api> };
  let sequence = 0;

  async function company(opts: { demo?: boolean } = {}) {
    const made = await fx.newOrg();
    orgs.push(made.org);
    if (opts.demo) await db.organization.update({ where: { id: made.org }, data: { is_demo: true } });
    return made;
  }

  /** These switches off, and every switch that needs one of them off too, so the set is one the product stores. */
  const withDependantsOff = (off: string[]): Record<string, SwitchValue> => {
    const out: Record<string, SwitchValue> = Object.fromEntries(off.map((k) => [k, false]));
    for (let grew = true; grew;) {
      grew = false;
      for (const sw of SWITCH_CATALOG) {
        if (!(sw.key in out) && sw.requires.some((r) => out[r] === false)) { out[sw.key] = false; grew = true; }
      }
    }
    return out;
  };

  /** A person on a fresh custom role with exactly these values on top of the base's preset (`off` and what needs it go off). */
  async function personWith(org: string, on: Record<string, SwitchValue>, off: string[] = [], base: Role = 'DISPATCHER'): Promise<Someone> {
    const key = `fixf-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { ...withDependantsOff(off), ...on }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `fixf${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const text = (res: { body: unknown; text?: string }) => res.text ?? JSON.stringify(res.body);

  // ─── P2-1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('P2-1: a phone number files on a customer only when the person can open that customer', () => {
    const ON = {
      access_communication: true, view_communication: true, contact_customers: true, communication_scope: 'attached',
      view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached',
    };

    /** A customer of the company that nobody else is on, with this phone number. */
    async function phonedCustomer(org: string) {
      const digits = `617555${String(1000 + Math.floor(Math.random() * 8999))}`;
      const id = randomUUID();
      await db.customer.create({
        data: { id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Hidden', last_name: 'Phoned', phone: digits },
      });
      return { id, digits };
    }
    /** The same number written the ways people and phone systems write it. */
    const spellings = (d: string) => [
      d, `+1${d}`, `1${d}`, `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`, `+1 ${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`,
    ];

    type Door = {
      name: string;
      demo?: true;
      /** The request, for this spelling of the number. */
      call: (api: Api, number: string) => Promise<request.Response>;
      /** The customer the record was stored on (null when none); undefined for a door that stores nothing. */
      stored?: (res: request.Response) => Promise<string | null>;
      /** The customer the answer names, as the screen reads it; undefined for a door whose answer names no customer to anyone. */
      named?: (res: request.Response) => string | null;
    };
    const doors: Door[] = [
      {
        name: 'POST /api/communication/threads (a new text conversation)',
        call: (api, n) => api.post('/api/communication/threads', { from_number: n, campaign_type: 'customer_care' }),
        stored: async (res) => (await db.messageThread.findUniqueOrThrow({ where: { id: res.body.thread.id }, select: { customer_id: true } })).customer_id,
        named: (res) => res.body.thread.customerId || null,
      },
      {
        name: 'POST /api/communication/calls, an incoming call',
        call: (api, n) => api.post('/api/communication/calls', { direction: 'in', from_number: n, to_number: '6175550100', status: 'completed' }),
        stored: async (res) => (await db.callSession.findUniqueOrThrow({ where: { id: res.body.call.id }, select: { customer_id: true } })).customer_id,
        named: (res) => res.body.call.customerId ?? null,
      },
      {
        name: 'POST /api/communication/calls, an outgoing call',
        call: (api, n) => api.post('/api/communication/calls', { direction: 'out', from_number: n, to_number: '6175550100', status: 'completed' }),
        stored: async (res) => (await db.callSession.findUniqueOrThrow({ where: { id: res.body.call.id }, select: { customer_id: true } })).customer_id,
        named: (res) => res.body.call.customerId ?? null,
      },
      {
        name: 'POST /api/communication/whatsapp-chats (demo companies only)',
        demo: true,
        call: (api, n) => api.post('/api/communication/whatsapp-chats', { name: 'Someone', org: 'Somewhere', phone: n }),
        // Its answer names no customer to anyone (the chat's customer key is not in it); the stored chat is the proof.
        stored: async (res) => (await db.whatsAppChat.findUniqueOrThrow({ where: { id: res.body.chat.id }, select: { customer_id: true } })).customer_id,
      },
      {
        name: 'GET /api/communication/dialer-search (who is this number)',
        call: (api, n) => api.get(`/api/communication/dialer-search?q=${encodeURIComponent(n)}`),
        named: (res) => res.body.identity?.customerId ?? null,
      },
    ];

    for (const door of doors) {
      it(`${door.name}: names and files no customer the person cannot open, in any spelling; the person who can open it gets it`, async () => {
        const c = await company({ demo: door.demo });
        const hidden = await phonedCustomer(c.org);
        const blind = await personWith(c.org, ON, ['view_customers']);
        const seeing = await personWith(c.org, { ...ON, view_customers: true });
        // The control can open the customer: it is on a job of theirs (customer reach comes with the record).
        await fx.addJob(c.org, hidden.id, { crew: [seeing.id] });
        // The control: one can open the customer, the other cannot.
        expect((await (await seeing.api()).get(`/api/customers/${hidden.id}`)).status).toBe(200);
        expect((await (await blind.api()).get(`/api/customers/${hidden.id}`)).status).not.toBe(200);

        for (const number of spellings(hidden.digits)) {
          const res = await door.call(await blind.api(), number);
          expect(res.status, `${number} ${text(res)}`).toBeLessThan(300);
          expect(text(res), number).not.toContain(hidden.id);
          expect(text(res), number).not.toContain('Phoned');
          if (door.named) expect(door.named(res), number).toBeNull();
          if (door.stored) expect(await door.stored(res), number).toBeNull();
        }

        const control = await door.call(await seeing.api(), hidden.digits);
        expect(control.status, text(control)).toBeLessThan(300);
        if (door.named) expect(door.named(control)).toBe(hidden.id);
        if (door.stored) expect(await door.stored(control)).toBe(hidden.id);
      });
    }

    it('a number that belongs to another company\'s customer files on nobody, for anyone', async () => {
      const mine = await company();
      const theirs = await company();
      const foreign = await phonedCustomer(theirs.org);
      const seeing = await personWith(mine.org, { ...ON, view_customers: true });
      const res = await (await seeing.api()).post('/api/communication/threads', { from_number: foreign.digits, campaign_type: 'customer_care' });
      expect(res.status).toBe(201);
      expect(text(res)).not.toContain(foreign.id);
    });

    // ─── NV-vp3-1 (re-audit pass 3): composing a text to a typed number ───────────────────────────────────────────────
    describe('NV-vp3-1: a text composed to a typed number', () => {
      /** The customer's own text conversation, as an inbound text or someone who can open them would have left it. */
      async function customerThread(org: string, customer: string) {
        const t = await db.messageThread.create({ data: { organization_id: org, channel: 'sms', campaign_type: 'customer_care', customer_id: customer } });
        await db.message.create({ data: { organization_id: org, thread_id: t.id, direction: 'in', body: 'Earlier text', ts: new Date() } as never });
        return t.id;
      }
      const send = (api: Api, number: string) => api.post('/api/communication/sms', { toNumber: number, body: 'Hello there' });

      it('from a person who cannot open the customer: joins no conversation of theirs, files on and names nobody, in any spelling', async () => {
        const c = await company();
        const hidden = await phonedCustomer(c.org);
        const theirs = await customerThread(c.org, hidden.id);
        const blind = await personWith(c.org, ON, ['view_customers']);
        expect((await (await blind.api()).get(`/api/customers/${hidden.id}`)).status).not.toBe(200);
        const before = await db.message.count({ where: { thread_id: theirs } });

        for (const number of spellings(hidden.digits)) {
          const res = await send(await blind.api(), number);
          expect(res.status, `${number} ${text(res)}`).toBe(201);
          expect(res.body.threadId, number).not.toBe(theirs);
          expect(text(res), number).not.toContain(hidden.id);
          const thread = await db.messageThread.findUniqueOrThrow({ where: { id: res.body.threadId }, select: { customer_id: true, lead_id: true } });
          expect(thread, number).toEqual({ customer_id: null, lead_id: null });
        }
        // Nothing was written on the customer: no message in their conversation, no "text sent" on their history.
        expect(await db.message.count({ where: { thread_id: theirs } })).toBe(before);
        expect(await db.timelineEvent.count({ where: { organization_id: c.org, entity_id: hidden.id, event_type: 'SMS_SENT' } })).toBe(0);
        // The person's conversation list names nobody they cannot open.
        const list = await (await blind.api()).get('/api/communication/threads');
        expect(list.status).toBe(200);
        expect(text(list)).not.toContain(hidden.id);
        expect(text(list)).not.toContain('Phoned');
      });

      it('from a person who can open the customer: joins the customer\'s conversation and files on them, as today', async () => {
        const c = await company();
        const hidden = await phonedCustomer(c.org);
        const theirs = await customerThread(c.org, hidden.id);
        const seeing = await personWith(c.org, { ...ON, view_customers: true });
        await fx.addJob(c.org, hidden.id, { crew: [seeing.id] });
        const res = await send(await seeing.api(), hidden.digits);
        expect(res.status, text(res)).toBe(201);
        expect(res.body.threadId).toBe(theirs);
        expect(await db.timelineEvent.count({ where: { organization_id: c.org, entity_id: hidden.id, event_type: 'SMS_SENT' } })).toBe(1);
      });

      it('without Access Communication, the answer does not depend on whether the hidden customer has a conversation', async () => {
        const answers: Array<{ status: number; body: unknown }> = [];
        for (const withThread of [true, false]) {
          const c = await company();
          const hidden = await phonedCustomer(c.org);
          if (withThread) await customerThread(c.org, hidden.id);
          const { access_communication: _section, ...rest } = ON;
          const outsider = await personWith(c.org, rest, ['view_customers', 'access_communication']);
          const res = await send(await outsider.api(), hidden.digits);
          answers.push({ status: res.status, body: res.body });
        }
        expect(answers[0]).toEqual(answers[1]);
        expect(answers[0]!.status).toBe(403);
      });
    });

    // ─── NV-v3b-1 (re-audit pass 3b, GitHub #2906): a refused compose leaves no conversation behind ─────────────────────
    describe('NV-v3b-1: a refused text to a typed number leaves nothing behind', () => {
      const NO_SECTION = { ...ON, access_communication: false, view_customers: true };
      const GATE = { error: 'Starting a new conversation from the inbox requires access to the Communication section.' };
      const freshNumber = () => `617555${String(1000 + Math.floor(Math.random() * 8999))}`;
      const threads = (org: string) => db.messageThread.count({ where: { organization_id: org } });

      type Refused = { name: string; body: (ctx: { org: string; other: string; mine: string; admin: string; customer: string }) => Record<string, unknown>; status: number; error: string };
      const refused: Refused[] = [
        { name: 'a made-up job', body: () => ({ jobId: randomUUID() }), status: 404, error: 'Job not found' },
        { name: 'a job the person is not on', body: (x) => ({ jobId: x.admin }), status: 404, error: 'Job not found' },
        { name: 'another company\'s job', body: (x) => ({ jobId: x.other }), status: 404, error: 'Job not found' },
        { name: 'a made-up job beside a customer the person can contact', body: (x) => ({ customerId: x.customer, jobId: randomUUID() }), status: 404, error: 'Job not found' },
        { name: 'a lead the person is not on', body: (x) => ({ leadId: x.mine }), status: 404, error: 'Lead not found' },
        { name: 'a customer the person cannot contact', body: (x) => ({ customerId: x.customer }), status: 404, error: 'Customer not found' },
      ];

      for (const r of refused) {
        it(`${r.name}: refused before any conversation exists, so the plain send that follows is refused as for a new number`, async () => {
          const c = await company();
          const elsewhere = await company();
          const person = await personWith(c.org, NO_SECTION, ['access_communication']);
          const adminsJob = await fx.addJob(c.org, c.customer, { crew: [c.admin.id] });
          const othersJob = await fx.addJob(elsewhere.org, elsewhere.customer, { crew: [elsewhere.admin.id] });
          const hiddenLead = await fx.addLead(c.org, c.customer, { owner: c.admin.id });
          // The customer the person can contact (a job of theirs) for the "beside a customer" row; nobody's for the last row.
          const contactable = r.name.includes('beside');
          const customer = (await phonedCustomer(c.org)).id;
          if (contactable) await fx.addJob(c.org, customer, { crew: [person.id] });
          const ctx = { org: c.org, other: othersJob.id, mine: hiddenLead.id, admin: adminsJob.id, customer };
          const number = freshNumber();
          const before = await threads(c.org);

          const res = await (await person.api()).post('/api/communication/sms', { toNumber: number, body: 'Hello there', ...r.body(ctx) });
          expect({ status: res.status, body: res.body }).toEqual({ status: r.status, body: { error: r.error } });
          expect(await threads(c.org)).toBe(before);

          const plain = await (await person.api()).post('/api/communication/sms', { toNumber: number, body: 'Hello again' });
          expect({ status: plain.status, body: plain.body }).toEqual({ status: 403, body: GATE });
          expect(await threads(c.org)).toBe(before);
          expect(await db.message.count({ where: { organization_id: c.org } })).toBe(0);
        });
      }

      it('#2906: a made-up job no longer leaves an empty conversation in the inbox', async () => {
        const c = await company();
        const person = await personWith(c.org, NO_SECTION, ['access_communication']);
        const res = await (await person.api()).post('/api/communication/sms', { toNumber: freshNumber(), body: 'Hi', jobId: randomUUID() });
        expect(res.status).toBe(404);
        expect(await db.messageThread.count({ where: { organization_id: c.org, messages: { none: {} } } })).toBe(0);
      });

      it('keeps today\'s answers for a job the person is on, and for an Admin', async () => {
        const c = await company();
        const person = await personWith(c.org, NO_SECTION, ['access_communication']);
        const phoned = await phonedCustomer(c.org);
        const ownJob = await fx.addJob(c.org, phoned.id, { crew: [person.id] });
        // A job-anchored compose to a number the job's customer carries stays ungated (#2046: the job is already in the
        // person's view). Since #3016 a number the job does not carry is refused (anchored-text-destination-db.test.ts).
        const anchored = await (await person.api()).post('/api/communication/sms', { toNumber: phoned.digits, body: 'On my way', jobId: ownJob.id });
        expect(anchored.status, text(anchored)).toBe(201);
        expect(anchored.body.message.jobId).toBe(ownJob.id);
        const admin = await (await fx.signedInAs(c.admin)).post('/api/communication/sms', { toNumber: freshNumber(), body: 'Hello' });
        expect(admin.status, text(admin)).toBe(201);
      });
    });
  });

  // ─── P2-2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('P2-2: the payments drawer and a payment\'s history name no figure without See prices', () => {
    const COMMON = { view_payments: true, view_invoices: true, jobs_scope: 'all', view_jobs: true, view_customers: true, refund_payments: true };
    const FIGURES = ['77.77', '55.55', '5.43', '33.33', '44.44', '22.22', '99999', '$'];

    async function drawer() {
      const c = await company();
      const meant = await fx.addInvoice(c.org, c.customer);
      await db.invoice.update({ where: { id: meant.id }, data: { status: 'SENT', total_amount: 4321.09, subtotal: 4321.09, amount_due: 3210.98 } });
      const small = await fx.addInvoice(c.org, c.customer);
      await db.invoice.update({ where: { id: small.id }, data: { status: 'SENT', total_amount: 5.43, subtotal: 5.43, amount_due: 5.43 } });
      const payment = await db.unappliedCapture.create({
        data: {
          organization_id: c.org, invoice_id: meant.id, reason: 'AMOUNT_MISMATCH', amount: 77.77, source_key: `session:fixf-${randomUUID()}`, status: 'OPEN',
          stripe_payment_intent_id: `pi_fixf_${randomUUID().slice(0, 10)}`, stripe_account_id: 'acct_fixf_x',
        },
      });
      const refund = await db.unappliedCapture.create({
        data: {
          organization_id: c.org, invoice_id: meant.id, reason: 'REFUND_UNMATCHED', amount: 55.55, source_key: `refund:fixf-${randomUUID()}`, status: 'OPEN',
          stripe_refund_id: `re_fixf_${randomUUID().slice(0, 10)}`,
        },
      });
      const blind = await personWith(c.org, COMMON, ['see_prices']);
      const seeing = await personWith(c.org, { ...COMMON, see_prices: true });
      return { c, meant, small, payment, refund, blind, seeing };
    }

    type Refusal = { name: string; call: (api: Api, d: Awaited<ReturnType<typeof drawer>>) => Promise<request.Response>; status: number; blind: string; seeing: string };
    const refusals: Refusal[] = [
      {
        name: 'refunding more than is left on an unapplied payment',
        call: (api, d) => api.post(`/api/payments-needing-attention/${d.payment.id}/refund`, { amount: 99999 }),
        status: 400, blind: 'Enter a smaller amount.', seeing: 'Enter $77.77 or less.',
      },
      {
        name: 'attaching a payment to an invoice with less due',
        call: (api, d) => api.post(`/api/payments-needing-attention/${d.payment.id}/attach`, { invoice_id: d.small.id }),
        status: 409,
        blind: 'This payment is more than is due on {small}.',
        seeing: 'Only $5.43 is due on {small}, less than this $77.77 payment.',
      },
      {
        name: 'attaching a refund to an invoice with no payment to take it',
        call: (api, d) => api.post(`/api/payments-needing-attention/${d.refund.id}/attach`, { invoice_id: d.meant.id }),
        status: 409,
        blind: '{meant} has no payment with enough left to refund. Choose another invoice.',
        seeing: '{meant} has no payment with $55.55 left to refund. Choose another invoice.',
      },
    ];

    for (const r of refusals) {
      it(`${r.name}: the refusal names no figure to a person without See prices, and the figures to one with`, async () => {
        const d = await drawer();
        const fill = (s: string) => s.replace('{small}', `INV-${d.small.id.slice(0, 8)}`).replace('{meant}', `INV-${d.meant.id.slice(0, 8)}`);
        const hidden = await r.call(await d.blind.api(), d);
        expect(hidden.status, text(hidden)).toBe(r.status);
        expect(hidden.body.error).toBe(fill(r.blind));
        for (const figure of FIGURES) expect(text(hidden), figure).not.toContain(figure);
        const shown = await r.call(await d.seeing.api(), d);
        expect(shown.status, text(shown)).toBe(r.status);
        expect(shown.body.error).toBe(fill(r.seeing));
        // Nothing moved for either of them.
        expect((await db.unappliedCapture.findMany({ where: { organization_id: d.c.org }, select: { status: true } })).map((x) => x.status)).toEqual(['OPEN', 'OPEN']);
      });
    }

    it('a payment\'s history says Refunded, Refund pending and Refund failed with no figure; with See prices it says how much', async () => {
      const d = await drawer();
      const job = await fx.addJob(d.c.org, d.c.customer);
      const inv = await fx.addInvoice(d.c.org, d.c.customer, { jobId: job.id });
      await db.invoice.update({ where: { id: inv.id }, data: { status: 'PAID', total_amount: 8123.45, subtotal: 8123.45, amount_due: 0 } });
      const payment = await db.payment.create({
        data: {
          invoice_id: inv.id, amount: 8123.45, method: 'CARD', paid_at: new Date(Date.now() - 3_600_000), state: 'SUCCEEDED',
          stripe_payment_intent_id: `pi_fixf_${randomUUID().slice(0, 10)}`, card_brand: 'visa', card_last4: '4242',
        },
      });
      for (const [amount, state] of [[33.33, 'SUCCEEDED'], [44.44, 'PENDING'], [22.22, 'FAILED']] as const) {
        await db.refund.create({
          data: { invoice_id: inv.id, payment_id: payment.id, amount, method: 'CARD', reason_category: 'GOODWILL', refunded_by: d.c.admin.id, state, organization_id: d.c.org },
        });
      }
      const door = `/api/payments-page/payments/${payment.id}`;
      const hidden = await (await d.blind.api()).get(door);
      expect(hidden.status, text(hidden)).toBe(200);
      const labels = (hidden.body.timeline as { label: string }[]).map((e) => e.label);
      expect(labels).toEqual(expect.arrayContaining(['Refunded', 'Refund pending', 'Refund failed']));
      for (const figure of ['33.33', '44.44', '22.22', '8123.45', '8,123.45']) expect(text(hidden), figure).not.toContain(figure);
      const shown = await (await d.seeing.api()).get(door);
      expect(shown.status).toBe(200);
      expect((shown.body.timeline as { label: string }[]).map((e) => e.label))
        .toEqual(expect.arrayContaining(['Refunded $33.33', 'Refund of $44.44 pending', 'Refund of $22.22 failed']));
    });
  });

  // ─── P2-4 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('P2-4: the price-book image upload names an estimate by id', () => {
    const ESTIMATES = { view_estimates: true, edit_estimates: true, see_prices: true, view_leads: true, leads_scope: 'attached', view_jobs: true, jobs_scope: 'attached' };

    it('answers an estimate out of reach exactly like one that does not exist, in a multipart form and a plain body', async () => {
      const c = await company();
      const person = await personWith(c.org, ESTIMATES);
      const item = randomUUID();
      await db.priceBookItem.create({ data: { id: item, organization_id: c.org, name: 'Door', sku: `SKU-${item.slice(0, 8)}`, unit_price: 10 } });
      const hidden = await fx.addEstimate(c.org, c.customer, c.admin.id);
      await db.estimateLineItem.update({ where: { id: hidden.lineId }, data: { price_book_item_id: item } });
      // The person's own estimate: on a lead they are on, with a line for the item.
      const lead = await fx.addLead(c.org, c.customer, { assignees: [person.id] });
      const mine = await fx.addEstimate(c.org, c.customer, person.id, { leadId: lead.id });
      await db.estimateLineItem.update({ where: { id: mine.lineId }, data: { price_book_item_id: item } });

      await fx.signedInAs(person);
      const bearer = `Bearer switches-${person.id}`;
      const path = `/api/price-book/items/${item}/image`;
      const multipart = (estimateId: string) => request(app).post(path).set('Authorization', bearer).field('estimate_id', estimateId);
      const json = (estimateId: string) => request(app).post(path).set('Authorization', bearer).send({ estimate_id: estimateId });

      for (const send of [multipart, json]) {
        const missing = await send(randomUUID());
        expect(missing.status).toBe(404);
        const outOfReach = await send(hidden.id);
        expect({ status: outOfReach.status, body: outOfReach.body }).toEqual({ status: missing.status, body: missing.body });
        // The person's own estimate, spelled any way but the canonical one, names nothing either.
        const shouted = await send(mine.id.toUpperCase());
        expect(shouted.status).toBe(404);
        // The control: their own estimate gets past the estimate check to the file check.
        const own = await send(mine.id);
        expect({ status: own.status, body: own.body }).toEqual({ status: 400, body: { error: 'No file provided' } });
      }
      expect((await db.priceBookItem.findUniqueOrThrow({ where: { id: item }, select: { image_url: true, photo_url: true } }))).toEqual({ image_url: null, photo_url: null });
    });
  });
});
