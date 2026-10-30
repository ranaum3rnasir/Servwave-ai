/* =============================================================================
   Payments go-live P3 - the Payments page read API (/api/payments-page/*), called as people on custom roles
   (never a built-in role name). Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

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

suite('Payments page read API (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    for (const org of orgs) {
      const q = (sql: string) => db.$executeRawUnsafe(sql).catch(() => undefined);
      await q(`DELETE FROM disputes WHERE organization_id = '${org}'`);
      await q(`UPDATE payments SET payout_id = NULL WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`);
      await q(`DELETE FROM payouts WHERE organization_id = '${org}'`);
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const o = await fx.newOrg();
    orgs.push(o.org);
    await db.organization.update({ where: { id: o.org }, data: { timezone: 'America/New_York' } });
    return o;
  }

  /** A person on a fresh custom role holding exactly these switch values on top of the base role's preset. */
  async function personWith(org: string, values: Record<string, boolean | string | string[]>, name = 'viewer') {
    const key = `pp-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person: Person = await fx.addUser(org, `${name}${sequence}`, 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: key });
    return { ...person, api: () => fx.signedInAs(person) };
  }
  /** Sees every invoice and every payment figure. */
  const finance = (org: string) => personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'all', refund_payments: false }, 'finance');

  type PayOpts = {
    amount?: number; tip?: number | null; serviceFee?: number | null; method?: 'CARD' | 'ACH' | 'CASH'; online?: boolean;
    state?: 'PROCESSING' | 'SUCCEEDED' | 'FAILED'; paidAt?: Date; stripeFee?: number | null; platformFee?: number | null;
    net?: number | null; payoutId?: string | null; reference?: string | null; voidedAt?: Date | null; voidCategory?: 'CHARGEBACK' | 'ERROR' | null;
    failureCode?: string | null; cardLast4?: string | null; id?: string; bankName?: string;
  };
  /** A payment on the invoice. Online (card or bank, with a processor intent) unless told otherwise. */
  async function addPayment(invoiceId: string, o: PayOpts = {}) {
    const id = o.id ?? randomUUID();
    const method = o.method ?? 'CARD';
    const online = o.online ?? method !== 'CASH';
    await db.payment.create({
      data: {
        id, invoice_id: invoiceId, amount: o.amount ?? 100, method, paid_at: o.paidAt ?? new Date(),
        state: o.state ?? 'SUCCEEDED', tip_amount: o.tip ?? null, service_fee_amount: o.serviceFee ?? null,
        stripe_fee_amount: o.stripeFee === undefined ? 3.2 : o.stripeFee, platform_fee_amount: o.platformFee === undefined ? 0 : o.platformFee,
        net_amount: o.net === undefined ? 96.8 : o.net,
        stripe_payment_intent_id: online ? `pi_test_${id.slice(0, 12)}` : null,
        reference_number: o.reference ?? null, payout_id: o.payoutId ?? null,
        voided_at: o.voidedAt ?? null, void_category: o.voidCategory ?? null, failure_code: o.failureCode ?? null,
        card_brand: method === 'CARD' ? 'visa' : null, card_last4: method === 'CARD' ? (o.cardLast4 ?? '4242') : null,
        bank_name: method === 'ACH' ? (o.bankName ?? 'STRIPE TEST BANK') : null, bank_last4: method === 'ACH' ? '6789' : null,
      },
    });
    return id;
  }
  async function addRefund(org: string, invoiceId: string, paymentId: string, by: string, amount: number, state: 'PENDING' | 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED', createdAt?: Date) {
    await db.refund.create({
      data: {
        ...(createdAt ? { created_at: createdAt } : {}),
        organization_id: org, invoice_id: invoiceId, payment_id: paymentId, amount, method: 'CARD', reason_category: 'CUSTOMER_REQUEST',
        refunded_by: by, state,
      },
    });
  }
  async function addDispute(org: string, invoiceId: string, paymentId: string, status: 'NEEDS_RESPONSE' | 'UNDER_REVIEW' | 'WON' | 'LOST' | 'CLOSED', amount = 100) {
    return db.dispute.create({
      data: {
        organization_id: org, invoice_id: invoiceId, payment_id: paymentId, stripe_dispute_id: `dp_test_${randomUUID().slice(0, 12)}`,
        status, reason: 'fraudulent', amount, evidence_due_by: new Date(Date.now() + 7 * 86_400_000),
        closed_at: status === 'WON' || status === 'LOST' || status === 'CLOSED' ? new Date() : null,
      },
    });
  }
  async function addPayout(org: string, o: { status?: string; amount?: number; arrival?: string | null; label?: string | null; createdAt?: Date } = {}) {
    return db.payout.create({
      data: {
        ...(o.createdAt ? { created_at: o.createdAt } : {}),
        organization_id: org, stripe_payout_id: `po_test_${randomUUID().slice(0, 12)}`, status: o.status ?? 'PAID', amount: o.amount ?? 500,
        arrival_date: o.arrival === null ? null : new Date(`${o.arrival ?? '2026-10-10'}T00:00:00Z`), destination_label: o.label ?? 'Test Bank ••6789',
      },
    });
  }
  const invoiceIn = async (org: string, customer: string, opts: Parameters<typeof fx.addInvoice>[2] = {}) => (await fx.addInvoice(org, customer, opts)).id;
  const iso = (s: string) => new Date(s);
  const WINDOW = 'from=2026-10-01&to=2026-10-31';

  const ROUTES: Array<[string, (id: string) => string]> = [
    ['summary', () => `/api/payments-page/summary?${WINDOW}`],
    ['payments', () => '/api/payments-page/payments'],
    ['export', () => '/api/payments-page/payments/export'],
    ['detail', (id) => `/api/payments-page/payments/${id}`],
    ['payouts', () => '/api/payments-page/payouts'],
    ['payout detail', (id) => `/api/payments-page/payouts/${id}`],
    ['payout payments', (id) => `/api/payments-page/payouts/${id}/payments`],
  ];

  describe('the gate', () => {
    it('refuses every route without View payments and lets them in with it', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const payment = await addPayment(invoice, { paidAt: iso('2026-10-05T16:00:00Z') });
      const payout = await addPayout(org);
      const off = await personWith(org, { view_payments: false, view_invoices: true, invoices_scope: 'all' });
      const on = await finance(org);
      for (const [name, url] of ROUTES) {
        const target = name.startsWith('payout') && name !== 'payouts' ? url(payout.id) : url(payment);
        expect((await (await off.api()).get(target)).status, `${name} without View payments`).toBe(403);
        const allowed = await (await on.api()).get(target);
        expect(allowed.status, `${name} with View payments`).toBe(200);
      }
    });
  });

  /** A second customer, so a test can have a name another person must not see. */
  async function addCustomer(org: string, company: string) {
    const id = randomUUID();
    await db.customer.create({
      data: { id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'COMPANY', segment: 'COMMERCIAL', company_name: company },
    });
    return id;
  }
  type Row = Record<string, any>;
  const listOf = async (api: Api, query = '') => (await api.get(`/api/payments-page/payments?${query}`)).body as { payments: Row[]; pagination: Row };

  describe('GET /payments', () => {
    it('lists online payments only, newest first, with the figures the page shows', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const paid = await addPayment(invoice, { amount: 100, tip: 5, serviceFee: 3, stripeFee: 3.5, platformFee: 0, net: 104.5, paidAt: iso('2026-10-05T16:00:00Z') });
      await addRefund(org, invoice, paid, admin.id, 20);
      await addRefund(org, invoice, paid, admin.id, 7, 'FAILED');
      const failed = await addPayment(invoice, { amount: 40, method: 'ACH', state: 'FAILED', failureCode: 'insufficient_funds', stripeFee: null, platformFee: null, net: null, paidAt: iso('2026-10-06T16:00:00Z') });
      await addPayment(invoice, { amount: 30, method: 'CASH', paidAt: iso('2026-10-07T16:00:00Z') });
      await addPayment(invoice, { amount: 31, reference: 'DEPOSIT-CREDIT', paidAt: iso('2026-10-07T16:00:00Z') });
      await addPayment(invoice, { amount: 32, online: false, method: 'CARD', paidAt: iso('2026-10-07T16:00:00Z') }); // no processor intent
      const body = await listOf(await (await finance(org)).api(), WINDOW);
      expect(body.payments.map((r) => r.id)).toEqual([failed, paid]);
      const row = body.payments[1];
      expect(row).toMatchObject({
        id: paid, status: 'Refund failed', method: 'CARD', method_label: 'Credit card', method_detail: 'Visa •••• 4242',
        amount: 108, fee: 3.5, net: 104.5, refunded: 20, payout: null, payout_status: 'awaiting', restricted: false,
        customer: { id: customer, name: 'Pat Payer' }, invoice: { id: invoice },
      });
      expect(row.date).toBe('2026-10-05T16:00:00.000Z');
      expect(body.payments[0]).toMatchObject({ status: 'Failed', method: 'ACH', fee: null, net: null, payout_status: null, method_detail: 'Bank •••• 6789' });
      expect(body.pagination).toMatchObject({ page: 1, limit: 25, total: 2 });
    });

    it('shows the payout a payment was paid out in, by ServWave id and short code', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const payout = await addPayout(org, { status: 'IN_TRANSIT', arrival: '2026-10-09' });
      await addPayment(invoice, { payoutId: payout.id, paidAt: iso('2026-10-05T16:00:00Z') });
      const [row] = (await listOf(await (await finance(org)).api(), WINDOW)).payments;
      expect(row.payout).toMatchObject({ id: payout.id, status: 'IN_TRANSIT', arrival_date: '2026-10-09' });
      expect(row.payout_status).toBe('in_transit');
      expect(JSON.stringify(row)).not.toContain(payout.stripe_payout_id);
    });

    it('marks rows on invoices the caller cannot open as restricted and keeps the amounts', async () => {
      const { org, customer } = await newOrg();
      const secret = await addCustomer(org, 'Hidden Holdings');
      const me = await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'attached' });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = await invoiceIn(org, customer, { jobId: job.id });
      const theirs = await invoiceIn(org, secret);
      const myPayment = await addPayment(mine, { amount: 10, paidAt: iso('2026-10-05T16:00:00Z') });
      const theirPayment = await addPayment(theirs, { amount: 20, paidAt: iso('2026-10-06T16:00:00Z') });
      const body = await listOf(await me.api(), WINDOW);
      const byId = Object.fromEntries(body.payments.map((r) => [r.id, r]));
      expect(byId[myPayment]).toMatchObject({ restricted: false, customer: { name: 'Pat Payer' }, invoice: { id: mine } });
      expect(byId[theirPayment]).toMatchObject({ restricted: true, customer: null, invoice: null, amount: 20, status: 'Succeeded', method: 'CARD' });
      expect(JSON.stringify(byId[theirPayment])).not.toMatch(/Hidden Holdings|INV-/);
      // searching a hidden customer's name or invoice number finds nothing
      expect((await listOf(await me.api(), 'q=Hidden')).payments).toEqual([]);
      const hiddenNumber = (await db.invoice.findUniqueOrThrow({ where: { id: theirs } })).invoice_number;
      expect((await listOf(await me.api(), `q=${hiddenNumber}`)).payments).toEqual([]);
      // a name the caller can see still matches
      expect((await listOf(await me.api(), 'q=payer')).payments.map((r) => r.id)).toEqual([myPayment]);
      // an admin sees the name
      expect((await listOf(await (await finance(org)).api(), 'q=Hidden')).payments.map((r) => r.id)).toEqual([theirPayment]);
    });

    it('searches customer name, invoice number and payment id prefix, case-insensitively', async () => {
      const { org, customer } = await newOrg();
      const other = await addCustomer(org, 'Acme Roofing');
      const a = await addPayment(await invoiceIn(org, customer), { paidAt: iso('2026-10-05T16:00:00Z') });
      const invoiceB = await invoiceIn(org, other);
      const b = await addPayment(invoiceB, { paidAt: iso('2026-10-06T16:00:00Z') });
      const api = await (await finance(org)).api();
      const ids = async (q: string) => (await listOf(api, `q=${encodeURIComponent(q)}`)).payments.map((r) => r.id);
      expect(await ids('acme roof')).toEqual([b]);
      expect(await ids('PAT payer')).toEqual([a]);
      const number = (await db.invoice.findUniqueOrThrow({ where: { id: invoiceB } })).invoice_number;
      expect(await ids(number.toLowerCase())).toEqual([b]);
      expect(await ids(a.slice(0, 8).toUpperCase())).toEqual([a]);
      expect(await ids('nothing-matches-this')).toEqual([]);
    });

    it('never shows another company\'s payments', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const mine = await addPayment(await invoiceIn(a.org, a.customer));
      await addPayment(await invoiceIn(b.org, b.customer));
      const body = await listOf(await (await finance(a.org)).api());
      expect(body.payments.map((r) => r.id)).toEqual([mine]);
    });

    it('pages 120 payments with equal dates in 5 pages without a duplicate or a gap, and clamps limit to 100', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const when = iso('2026-10-05T16:00:00Z');
      const made: string[] = [];
      for (let i = 0; i < 120; i++) made.push(await addPayment(invoice, { paidAt: when }));
      const api = await (await finance(org)).api();
      const seen: string[] = [];
      for (let page = 1; page <= 5; page++) {
        const body = await listOf(api, `limit=25&page=${page}`);
        expect(body.payments.length).toBe(page < 5 ? 25 : 20);
        expect(body.pagination).toMatchObject({ page, limit: 25, total: 120, totalPages: 5 });
        seen.push(...body.payments.map((r) => r.id));
      }
      expect(new Set(seen).size).toBe(120);
      expect([...seen].sort()).toEqual([...made].sort());
      const big = await listOf(api, 'limit=500');
      expect(big.payments.length).toBe(100);
      expect(big.pagination.limit).toBe(100);
    });

    describe('filters', () => {
      async function seeded() {
        const o = await newOrg();
        const invoice = await invoiceIn(o.org, o.customer);
        const at = (d: number) => iso(`2026-10-${String(d).padStart(2, '0')}T16:00:00Z`);
        const ids = {
          succeeded: await addPayment(invoice, { amount: 100, paidAt: at(1) }),
          pending: await addPayment(invoice, { amount: 200, method: 'ACH', state: 'PROCESSING', paidAt: at(2) }),
          failed: await addPayment(invoice, { amount: 300, method: 'ACH', state: 'FAILED', paidAt: at(3) }),
          refunded: await addPayment(invoice, { amount: 400, paidAt: at(4) }),
          partial: await addPayment(invoice, { amount: 500, tip: 50, serviceFee: 10, paidAt: at(5) }),
          disputed: await addPayment(invoice, { amount: 600, paidAt: at(6) }),
          wonDispute: await addPayment(invoice, { amount: 650, paidAt: at(7) }),
          chargedBack: await addPayment(invoice, { amount: 700, voidedAt: at(8), voidCategory: 'CHARGEBACK', paidAt: at(8) }),
        };
        await addRefund(o.org, invoice, ids.refunded, o.admin.id, 400);
        await addRefund(o.org, invoice, ids.partial, o.admin.id, 100);
        await addRefund(o.org, invoice, ids.pending, o.admin.id, 50, 'PENDING'); // pending refund is not money back
        await addDispute(o.org, invoice, ids.disputed, 'NEEDS_RESPONSE', 600);
        await addDispute(o.org, invoice, ids.wonDispute, 'WON', 650);
        const api = await (await finance(o.org)).api();
        const ask = async (q: string) => (await listOf(api, q)).payments.map((r) => r.id).sort();
        return { ...o, ids, api, ask, invoice };
      }
      const sorted = (...x: string[]) => [...x].sort();

      it('reads each display status from the ledger', async () => {
        const { ids, api } = await seeded();
        const all = (await listOf(api)).payments;
        const statusOf = Object.fromEntries(all.map((r) => [r.id, r.status]));
        expect(statusOf).toEqual({
          [ids.succeeded]: 'Succeeded', [ids.pending]: 'Pending', [ids.failed]: 'Failed', [ids.refunded]: 'Refunded',
          [ids.partial]: 'Partially refunded', [ids.disputed]: 'Disputed', [ids.wonDispute]: 'Succeeded', [ids.chargedBack]: 'Charged back',
        });
      });

      it('filters by each status alone', async () => {
        const { ids, ask } = await seeded();
        expect(await ask('status=succeeded')).toEqual(sorted(ids.succeeded, ids.wonDispute));
        expect(await ask('status=pending')).toEqual([ids.pending]);
        expect(await ask('status=failed')).toEqual([ids.failed]);
        expect(await ask('status=refunded')).toEqual([ids.refunded]);
        expect(await ask('status=partially_refunded')).toEqual([ids.partial]);
        expect(await ask('status=disputed')).toEqual([ids.disputed]);
        expect(await ask('status=charged_back')).toEqual([ids.chargedBack]);
      });

      it('combines statuses, and chips, and drops an invalid value instead of failing', async () => {
        const { ids, ask, api } = await seeded();
        expect(await ask('status=pending,failed')).toEqual(sorted(ids.pending, ids.failed));
        expect(await ask('status[]=pending&status[]=disputed')).toEqual(sorted(ids.pending, ids.disputed));
        expect(await ask('chip=refunded')).toEqual(sorted(ids.refunded, ids.partial));
        expect(await ask('chip=disputed')).toEqual([ids.disputed]);
        expect(await ask('chip=failed&status=failed,pending')).toEqual([ids.failed]);
        expect((await api.get('/api/payments-page/payments?status=nonsense')).status).toBe(200);
        expect(await ask('status=nonsense,pending')).toEqual([ids.pending]);
        expect((await listOf(api, 'chip=nonsense')).payments.length).toBe(8);
        expect((await api.get('/api/payments-page/payments?method=BITCOIN&payout_status=sideways')).status).toBe(200);
      });

      it('filters by method, payout status and an amount range on the charged amount', async () => {
        const { ids, ask, org } = await seeded();
        expect(await ask('method=ACH')).toEqual(sorted(ids.pending, ids.failed));
        const paidOut = await addPayout(org, { status: 'PAID' });
        const failedOut = await addPayout(org, { status: 'FAILED' });
        const transit = await addPayout(org, { status: 'IN_TRANSIT' });
        await db.payment.update({ where: { id: ids.succeeded }, data: { payout_id: paidOut.id } });
        await db.payment.update({ where: { id: ids.refunded }, data: { payout_id: failedOut.id } });
        await db.payment.update({ where: { id: ids.wonDispute }, data: { payout_id: transit.id } });
        expect(await ask('payout_status=paid')).toEqual([ids.succeeded]);
        expect(await ask('payout_status=failed')).toEqual([ids.refunded]);
        expect(await ask('payout_status=in_transit')).toEqual([ids.wonDispute]);
        expect(await ask('payout_status=awaiting')).toEqual(sorted(ids.partial, ids.disputed));
        // the partial payment is 500 + 50 tip + 10 service fee = 560 charged
        expect(await ask('amount_min=550&amount_max=570')).toEqual([ids.partial]);
        expect(await ask('amount_min=500&amount_max=560')).toEqual([ids.partial]);
        expect(await ask('amount_min=600')).toEqual(sorted(ids.disputed, ids.wonDispute, ids.chargedBack));
        expect(await ask('amount_max=100')).toEqual([ids.succeeded]);
        expect(await ask('amount_min=nope')).toEqual(await ask(''));
      });

      it('combines facets with the period and the search', async () => {
        const { ids, ask } = await seeded();
        expect(await ask('method=CARD&status=succeeded,refunded&from=2026-10-01&to=2026-10-04')).toEqual(sorted(ids.succeeded, ids.refunded));
        expect(await ask('from=2026-10-03&to=2026-10-03')).toEqual([ids.failed]);
        expect(await ask('q=pat&status=failed')).toEqual([ids.failed]);
      });

      it('sorts by date, amount, fee and net with the id as the tiebreak, and refuses an unknown column', async () => {
        const { org, customer } = await newOrg();
        const invoice = await invoiceIn(org, customer);
        const small = await addPayment(invoice, { amount: 10, tip: 100, stripeFee: 9, platformFee: 0, net: 101, paidAt: iso('2026-10-03T16:00:00Z') });
        const mid = await addPayment(invoice, { amount: 50, stripeFee: 1, platformFee: 0, net: 49, paidAt: iso('2026-10-02T16:00:00Z') });
        const big = await addPayment(invoice, { amount: 90, stripeFee: 4, platformFee: 0, net: 86, paidAt: iso('2026-10-01T16:00:00Z') });
        const nofee = await addPayment(invoice, { amount: 70, stripeFee: null, platformFee: null, net: null, paidAt: iso('2026-10-04T16:00:00Z') });
        const api = await (await finance(org)).api();
        const order = async (q: string) => (await listOf(api, q)).payments.map((r) => r.id);
        expect(await order('')).toEqual([nofee, small, mid, big]);
        expect(await order('sortBy=date&sortDir=asc')).toEqual([big, mid, small, nofee]);
        // small is charged 110, which beats big's 90 even though its invoice amount is lowest
        expect(await order('sortBy=amount&sortDir=desc')).toEqual([small, big, nofee, mid]);
        expect(await order('sortBy=amount&sortDir=asc')).toEqual([mid, nofee, big, small]);
        expect(await order('sortBy=fee&sortDir=desc')).toEqual([small, big, mid, nofee]);
        expect(await order('sortBy=net&sortDir=desc')).toEqual([small, big, mid, nofee]);
        expect((await api.get('/api/payments-page/payments?sortBy=customer_name')).status).toBe(400);
      });
    });
  });

  describe('GET /payments/export', () => {
    it('returns every matching row without paging, as Restricted where the caller cannot open the invoice', async () => {
      const { org, customer } = await newOrg();
      const secret = await addCustomer(org, 'Hidden Holdings');
      const me = await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'attached' });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = await invoiceIn(org, customer, { jobId: job.id });
      const theirs = await invoiceIn(org, secret);
      for (let i = 0; i < 30; i++) await addPayment(mine, { paidAt: iso('2026-10-05T16:00:00Z') });
      await addPayment(theirs, { amount: 20, paidAt: iso('2026-10-06T16:00:00Z') });
      const res = await (await me.api()).get(`/api/payments-page/payments/export?${WINDOW}`);
      expect(res.status).toBe(200);
      expect(res.body.payments.length).toBe(31);
      const restricted = res.body.payments.filter((r: Row) => r.restricted);
      expect(restricted.length).toBe(1);
      expect(restricted[0]).toMatchObject({ customer: null, invoice: null, customer_name: 'Restricted', invoice_number: 'Restricted', amount: 20 });
      expect(JSON.stringify(res.body)).not.toMatch(/Hidden Holdings/);
    });

    it('answers 413 above 10,000 rows with the narrowing message', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      await db.$executeRawUnsafe(
        `INSERT INTO payments (id, invoice_id, amount, method, paid_at, state, stripe_payment_intent_id)
         SELECT gen_random_uuid(), '${invoice}'::uuid, 1, 'CARD', '2026-10-05T16:00:00Z', 'SUCCEEDED', 'pi_bulk_' || g FROM generate_series(1, 10001) g`,
      );
      const api = await (await finance(org)).api();
      const res = await api.get('/api/payments-page/payments/export');
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('Narrow the period or the filters');
      await db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id = '${invoice}'::uuid AND stripe_payment_intent_id LIKE 'pi_bulk_%'`);
      expect((await api.get('/api/payments-page/payments/export')).status).toBe(200);
    }, 120_000);

    it('writes one audit row with the filters and no row data', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const paid = await addPayment(invoice, { paidAt: iso('2026-10-05T16:00:00Z') });
      const person = await finance(org);
      const res = await (await person.api()).get(`/api/payments-page/payments/export?${WINDOW}&status=succeeded&q=pat`);
      expect(res.status).toBe(200);
      const rows = await db.auditLog.findMany({ where: { org_id: org, action: 'payments.exported' } });
      expect(rows.length).toBe(1);
      expect(rows[0].actor_id).toBe(person.id);
      expect(rows[0].metadata).toMatchObject({ filters: { from: '2026-10-01', to: '2026-10-31', status: 'succeeded', q: 'pat' } });
      const text = JSON.stringify(rows[0].metadata);
      expect(text).not.toContain(paid);
      expect(text).not.toMatch(/Payer|INV-/);
    });

    it('never exports another company\'s payments', async () => {
      const a = await newOrg();
      const b = await newOrg();
      await addPayment(await invoiceIn(b.org, b.customer));
      const res = await (await (await finance(a.org)).api()).get('/api/payments-page/payments/export');
      expect(res.body.payments).toEqual([]);
    });
  });

  describe('GET /payments/:id', () => {
    async function detailSetup() {
      const o = await newOrg();
      const invoice = await invoiceIn(o.org, o.customer);
      await db.invoice.update({ where: { id: invoice }, data: { status: 'PAID' } });
      const payout = await addPayout(o.org, { status: 'PAID', arrival: '2026-10-08' });
      const id = await addPayment(invoice, { amount: 100, tip: 5, serviceFee: 3, stripeFee: 3.5, platformFee: 0, net: 104.5, payoutId: payout.id, paidAt: iso('2026-10-05T16:00:00Z') });
      return { ...o, invoice, id, payout };
    }

    it('never names the processor as the bank, on the detail or the list, and keeps a real bank', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const sandbox = await addPayment(invoice, { amount: 35, method: 'ACH', state: 'FAILED', failureCode: 'insufficient_funds', stripeFee: null, platformFee: null, net: null, paidAt: iso('2026-10-06T16:00:00Z') });
      const real = await addPayment(invoice, { amount: 36, method: 'ACH', bankName: 'First Example Bank', paidAt: iso('2026-10-07T16:00:00Z') });
      const api = await (await finance(org)).api();
      const detail = await api.get(`/api/payments-page/payments/${sandbox}`);
      expect(detail.status).toBe(200);
      expect(detail.body.method_detail).toBe('Bank •••• 6789');
      expect(JSON.stringify(detail.body)).not.toMatch(/stripe/i);
      expect((await api.get(`/api/payments-page/payments/${real}`)).body.method_detail).toBe('First Example Bank •••• 6789');
      const list = await listOf(api, WINDOW);
      expect(list.payments.map((r) => r.method_detail).sort()).toEqual(['Bank •••• 6789', 'First Example Bank •••• 6789']);
      expect(JSON.stringify(list)).not.toMatch(/stripe/i);
    });

    it('returns the row plus the invoice amount, tip, service fee, refunds, dispute, timeline and flags', async () => {
      const { org, admin, invoice, id, payout } = await detailSetup();
      await addRefund(org, invoice, id, admin.id, 20);
      const dispute = await addDispute(org, invoice, id, 'NEEDS_RESPONSE', 100);
      const refundPerson = await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'all', refund_payments: true });
      const res = await (await refundPerson.api()).get(`/api/payments-page/payments/${id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id, amount: 108, invoice_amount: 100, tip: 5, service_fee: 3, fee: 3.5, net: 104.5, refunded: 20, status: 'Disputed',
        failure_text: null, can_refund: false, refundable_amount: 80, can_respond_dispute: true, can_open_invoice: true,
        payout: { id: payout.id },
      });
      expect(res.body.refunds).toHaveLength(1);
      expect(res.body.refunds[0]).toMatchObject({ amount: 20, state: 'SUCCEEDED', reason_category: 'CUSTOMER_REQUEST', by: 'Test Admin' });
      expect(res.body.dispute).toMatchObject({ id: dispute.id, status: 'NEEDS_RESPONSE', amount: 100, reason_text: 'The cardholder says they did not make this payment' });
      expect(res.body.dispute.respond_by).toBeTruthy();
      expect(res.body.timeline.map((e: Row) => e.label)).toEqual(['Paid', `Paid out in PO-${payout.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`, 'Refunded $20.00', 'Dispute opened']);
    });

    it('says why a failed bank payment failed in ServWave\'s words', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const id = await addPayment(invoice, { method: 'ACH', state: 'FAILED', failureCode: 'insufficient_funds' });
      const res = await (await (await finance(org)).api()).get(`/api/payments-page/payments/${id}`);
      expect(res.body.failure_text).toBe('Insufficient funds');
      expect(res.body.can_refund).toBe(false);
    });

    it('withholds can_refund from a view-only caller, a failed payment and a fully refunded one', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      await db.invoice.update({ where: { id: invoice }, data: { status: 'PAID' } });
      const ok = await addPayment(invoice, { amount: 100 });
      const gone = await addPayment(invoice, { amount: 100 });
      await addRefund(org, invoice, gone, admin.id, 100);
      const failed = await addPayment(invoice, { state: 'FAILED' });
      // Each person is signed in right before their own calls: the test sign-in answers for whoever signed in last.
      const viewOnly = await finance(org);
      expect((await (await viewOnly.api()).get(`/api/payments-page/payments/${ok}`)).body.can_refund).toBe(false);
      const refunder = await (await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'all', refund_payments: true })).api();
      expect((await refunder.get(`/api/payments-page/payments/${ok}`)).body.can_refund).toBe(true);
      expect((await refunder.get(`/api/payments-page/payments/${gone}`)).body).toMatchObject({ can_refund: false, refundable_amount: 0, status: 'Refunded' });
      expect((await refunder.get(`/api/payments-page/payments/${failed}`)).body.can_refund).toBe(false);
    });

    it('answers 404 for a payment on an invoice the caller cannot open, another company\'s payment and a made-up id', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const hidden = await addPayment(await invoiceIn(a.org, a.customer));
      const foreign = await addPayment(await invoiceIn(b.org, b.customer));
      const narrow = await (await personWith(a.org, { view_payments: true, view_invoices: true, invoices_scope: 'attached' })).api();
      expect((await narrow.get(`/api/payments-page/payments/${hidden}`)).status).toBe(404);
      const api = await (await finance(a.org)).api();
      expect((await api.get(`/api/payments-page/payments/${foreign}`)).status).toBe(404);
      expect((await api.get(`/api/payments-page/payments/${randomUUID()}`)).status).toBe(404);
      expect((await api.get('/api/payments-page/payments/not-an-id')).status).toBe(404);
      expect((await api.get(`/api/payments-page/payments/${hidden}`)).status).toBe(200);
    });
  });


  describe('P6 carry-forward: the drawer never offers a refund the refund route refuses', () => {
    const paidInvoice = async (org: string, customer: string, status: 'PAID' | 'PARTIALLY_REFUNDED' | 'DRAFT' | 'VOIDED' | 'DISPUTED' = 'PAID') => {
      const id = await invoiceIn(org, customer);
      await db.invoice.update({ where: { id }, data: { status } });
      return id;
    };
    const refunderApi = async (org: string) =>
      (await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'all', refund_payments: true })).api();

    it('caps a DEPOSIT invoice at the credit not yet drawn down onto another invoice', async () => {
      const { org, customer } = await newOrg();
      const deposit = await paidInvoice(org, customer);
      await db.invoice.update({ where: { id: deposit }, data: { kind: 'DEPOSIT' } });
      const target = await invoiceIn(org, customer);
      const id = await addPayment(deposit, { amount: 100 });
      await db.depositCreditApplication.create({ data: { organization_id: org, deposit_invoice_id: deposit, target_invoice_id: target, amount: 60 } });
      const api = await refunderApi(org);
      const open = await api.get(`/api/payments-page/payments/${id}`);
      expect(open.body).toMatchObject({ refundable_amount: 40, can_refund: true });

      await db.depositCreditApplication.create({ data: { organization_id: org, deposit_invoice_id: deposit, target_invoice_id: target, amount: 40 } });
      const spent = await (await refunderApi(org)).get(`/api/payments-page/payments/${id}`);
      expect(spent.body).toMatchObject({ refundable_amount: 0, can_refund: false });
    });

    it('caps at what the invoice has net paid when a hand refund with no payment named already took some', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await paidInvoice(org, customer, 'PARTIALLY_REFUNDED');
      const id = await addPayment(invoice, { amount: 100 });
      await db.refund.create({
        data: { organization_id: org, invoice_id: invoice, payment_id: null, amount: 60, method: 'CASH', reason_category: 'CUSTOMER_REQUEST', refunded_by: admin.id, state: 'SUCCEEDED' },
      });
      const res = await (await refunderApi(org)).get(`/api/payments-page/payments/${id}`);
      expect(res.body).toMatchObject({ refundable_amount: 40, can_refund: true });
    });

    it('offers nothing on an invoice the refund route would refuse (not paid)', async () => {
      const { org, customer } = await newOrg();
      const api = await refunderApi(org);
      for (const status of ['DRAFT', 'VOIDED', 'DISPUTED'] as const) {
        const id = await addPayment(await paidInvoice(org, customer, status), { amount: 100 });
        const res = await api.get(`/api/payments-page/payments/${id}`);
        expect(res.body, status).toMatchObject({ refundable_amount: 0, can_refund: false });
      }
    });

    it('offers the whole payment again after its only refund failed (the Refund again button has room)', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await paidInvoice(org, customer);
      const id = await addPayment(invoice, { amount: 100 });
      await addRefund(org, invoice, id, admin.id, 20, 'FAILED');
      const res = await (await refunderApi(org)).get(`/api/payments-page/payments/${id}`);
      expect(res.body).toMatchObject({ refundable_amount: 100, can_refund: true });
    });

    it('still offers the whole payment on an ordinary paid invoice', async () => {
      const { org, customer } = await newOrg();
      const id = await addPayment(await paidInvoice(org, customer), { amount: 100 });
      const res = await (await refunderApi(org)).get(`/api/payments-page/payments/${id}`);
      expect(res.body).toMatchObject({ refundable_amount: 100, can_refund: true });
    });
  });

  describe('P6 carry-forward: raw processor columns stay on the server', () => {
    it('never puts a failure code, a payout summary or a refund failure code in any route\'s JSON', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      await db.invoice.update({ where: { id: invoice }, data: { status: 'PAID' } });
      await db.organization.update({ where: { id: org }, data: { payout_summary: { interval: 'weekly', weekly_anchor: 'monday', bank_label: 'Test Bank 6789', raw_marker: 'rawsummarymarker' } } });
      const failed = await addPayment(invoice, { state: 'FAILED', method: 'ACH', failureCode: 'rawfailuremarker_zz' });
      const ok = await addPayment(invoice, { amount: 100, paidAt: iso('2026-10-05T16:00:00Z') });
      await addRefund(org, invoice, ok, admin.id, 5);
      await db.refund.updateMany({ where: { payment_id: ok }, data: { failure_code: 'rawrefundmarker_zz' } });
      const payout = await addPayout(org, { status: 'FAILED', arrival: '2026-10-08' });
      await db.payout.update({ where: { id: payout.id }, data: { failure_code: 'rawpayoutmarker_zz' } });
      const api = await (await finance(org)).api();
      const urls = [
        `/api/payments-page/summary?${WINDOW}`, '/api/payments-page/payments', '/api/payments-page/payments/export',
        `/api/payments-page/payments/${failed}`, `/api/payments-page/payments/${ok}`, '/api/payments-page/payouts', `/api/payments-page/payouts/${payout.id}`,
      ];
      for (const url of urls) {
        const res = await api.get(url);
        expect(res.status, url).toBe(200);
        const text = JSON.stringify(res.body);
        expect(text, url).not.toMatch(/rawfailuremarker|rawrefundmarker|rawpayoutmarker|rawsummarymarker/);
        expect(text, url).not.toMatch(/"(failure_code|payout_summary|raw_marker)"/);
      }
      // The ServWave wording of a failure does reach the screen.
      const detail = await api.get(`/api/payments-page/payments/${failed}`);
      expect(typeof detail.body.failure_text === 'string' || detail.body.failure_text === null).toBe(true);
    });
  });

  describe('P6: the Disputed chip count', () => {
    it('counts the period\'s payments whose dispute is still open', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const a = await addPayment(invoice, { paidAt: iso('2026-10-05T16:00:00Z') });
      const b = await addPayment(invoice, { paidAt: iso('2026-10-06T16:00:00Z') });
      const c = await addPayment(invoice, { paidAt: iso('2026-10-07T16:00:00Z') });
      const outside = await addPayment(invoice, { paidAt: iso('2026-09-07T16:00:00Z') });
      await addDispute(org, invoice, a, 'NEEDS_RESPONSE');
      await addDispute(org, invoice, b, 'UNDER_REVIEW');
      await addDispute(org, invoice, c, 'WON');
      await addDispute(org, invoice, outside, 'NEEDS_RESPONSE');
      const res = await (await (await finance(org)).api()).get(`/api/payments-page/summary?${WINDOW}`);
      expect(res.body.disputed_count).toBe(2);
    });

    it('is zero when nothing is disputed', async () => {
      const { org, customer } = await newOrg();
      await addPayment(await invoiceIn(org, customer), { paidAt: iso('2026-10-05T16:00:00Z') });
      const res = await (await (await finance(org)).api()).get(`/api/payments-page/summary?${WINDOW}`);
      expect(res.body.disputed_count).toBe(0);
    });
  });

  describe('payouts', () => {
    async function payoutSetup() {
      const o = await newOrg();
      const invoice = await invoiceIn(o.org, o.customer);
      const payout = await addPayout(o.org, { status: 'PAID', amount: 5000, arrival: '2026-10-08' });
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) ids.push(await addPayment(invoice, { amount: 100, tip: i === 0 ? 10 : null, stripeFee: 3, platformFee: 1, net: i === 0 ? 106 : 96, payoutId: payout.id, paidAt: iso('2026-10-05T16:00:00Z') }));
      return { ...o, invoice, payout, ids };
    }

    it('lists payouts newest first with a ServWave reference and the payment count, filtered by status', async () => {
      const { org, payout } = await payoutSetup();
      const newer = await addPayout(org, { status: 'IN_TRANSIT', amount: 70, arrival: '2026-10-12', label: null });
      const api = await (await finance(org)).api();
      const all = (await api.get('/api/payments-page/payouts')).body;
      expect(all.payouts.map((p: Row) => p.id)).toEqual([newer.id, payout.id]);
      expect(all.payouts[1]).toMatchObject({
        id: payout.id, reference: `PO-${payout.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`, arrival_date: '2026-10-08',
        status: 'PAID', destination_label: 'Test Bank ••6789', amount: 5000, payment_count: 30,
      });
      expect(all.pagination).toMatchObject({ page: 1, total: 2 });
      expect((await api.get('/api/payments-page/payouts?status=in_transit')).body.payouts.map((p: Row) => p.id)).toEqual([newer.id]);
      expect((await api.get('/api/payments-page/payouts?status=bogus')).status).toBe(200);
    });

    it('shows the payout with totals over its whole contents, and pages the payments inside with footer totals from all pages', async () => {
      const { org, payout, ids } = await payoutSetup();
      const api = await (await finance(org)).api();
      const head = (await api.get(`/api/payments-page/payouts/${payout.id}`)).body;
      expect(head).toMatchObject({ id: payout.id, status: 'PAID', amount: 5000, payment_count: 30, totals: { amount: 3010, fee: 120, net: 2890 } });
      const seen: string[] = [];
      let sumNet = 0;
      for (let page = 1; page <= 2; page++) {
        const body = (await api.get(`/api/payments-page/payouts/${payout.id}/payments?limit=20&page=${page}`)).body;
        expect(body.pagination).toMatchObject({ page, limit: 20, total: 30, totalPages: 2 });
        expect(body.totals).toEqual({ amount: 3010, fee: 120, net: 2890 });
        for (const r of body.payments) {
          seen.push(r.id);
          sumNet += r.net;
          expect(Object.keys(r).sort()).toEqual(['amount', 'charged_amount', 'customer', 'fee', 'id', 'invoice', 'net', 'reference', 'refunded', 'restricted', 'voided']);
        }
      }
      expect(new Set(seen).size).toBe(30);
      expect([...seen].sort()).toEqual([...ids].sort());
      expect(Math.round(sumNet * 100)).toBe(289000);
    });

    it('applies the row privacy rule inside a payout', async () => {
      const { org, customer, payout } = await payoutSetup();
      const me = await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'attached' });
      const body = (await (await me.api()).get(`/api/payments-page/payouts/${payout.id}/payments`)).body;
      expect(body.payments.every((r: Row) => r.restricted && r.customer === null && r.invoice === null)).toBe(true);
      expect(body.totals.amount).toBe(3010);
      expect(JSON.stringify(body)).not.toContain(customer);
    });

    it('never shows another company\'s payouts', async () => {
      const a = await newOrg();
      const b = await payoutSetup();
      const api = await (await finance(a.org)).api();
      expect((await api.get('/api/payments-page/payouts')).body.payouts).toEqual([]);
      expect((await api.get(`/api/payments-page/payouts/${b.payout.id}`)).status).toBe(404);
      expect((await api.get(`/api/payments-page/payouts/${b.payout.id}/payments`)).status).toBe(404);
      expect((await api.get('/api/payments-page/payouts/not-an-id')).status).toBe(404);
    });
  });

  describe('payout detail actions (P8 fix round 1)', () => {
    it('offers update_bank_account only on a failed payout, and only to a caller who may manage the payout account', async () => {
      const { org } = await newOrg();
      const failed = await addPayout(org, { status: 'FAILED', arrival: '2026-10-08' });
      const paid = await addPayout(org, { status: 'PAID', arrival: '2026-10-09' });
      const manager = await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'all', manage_payout_account: true }, 'manager');
      const viewer = await finance(org);
      // The sign-in is one shared stub, so each call signs in as its person just before it.
      const actions = async (who: typeof viewer, id: string) => (await (await who.api()).get(`/api/payments-page/payouts/${id}`)).body.actions;
      expect(await actions(manager, failed.id)).toEqual({ update_bank_account: true });
      expect(await actions(manager, paid.id)).toEqual({ update_bank_account: false });
      expect(await actions(viewer, failed.id)).toEqual({ update_bank_account: false });
    });
  });

  describe('what the bodies never carry', () => {
    it('has no vendor name and no processor-id-shaped string in any route\'s JSON', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const payout = await addPayout(org, { status: 'FAILED', arrival: '2026-10-08' });
      await db.payout.update({ where: { id: payout.id }, data: { failure_code: 'account_closed' } });
      const id = await addPayment(invoice, { payoutId: payout.id, paidAt: iso('2026-10-05T16:00:00Z') });
      await db.payment.update({ where: { id }, data: { stripe_charge_id: `ch_leaktest${randomUUID().slice(0, 8)}`, stripe_account_id: `acct_leaktest${randomUUID().slice(0, 8)}`, stripe_checkout_session_id: `cs_leaktest${randomUUID().slice(0, 8)}` } });
      await addRefund(org, invoice, id, admin.id, 10);
      await db.refund.updateMany({ where: { payment_id: id }, data: { stripe_refund_id: `re_leaktest${randomUUID().slice(0, 8)}` } });
      await addDispute(org, invoice, id, 'NEEDS_RESPONSE');
      const api = await (await finance(org)).api();
      const urls = [
        `/api/payments-page/summary?${WINDOW}`, '/api/payments-page/payments', '/api/payments-page/payments/export', `/api/payments-page/payments/${id}`,
        '/api/payments-page/payouts', `/api/payments-page/payouts/${payout.id}`, `/api/payments-page/payouts/${payout.id}/payments`,
      ];
      for (const url of urls) {
        const res = await api.get(url);
        expect(res.status, url).toBe(200);
        const text = JSON.stringify(res.body);
        expect(text, url).not.toMatch(/stripe/i);
        expect(text, url).not.toMatch(/\b(pi|po|acct|ch|re|cs|dp)_[A-Za-z0-9]/);
      }
    });
  });

  describe('GET /summary', () => {
    it('adds the charged amount, fees, refunds and net of the collected online payments in the period', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      // charged 100 + 5 tip + 3 service fee = 108; fee 3.5; net on the charged basis 104.5
      const a = await addPayment(invoice, { amount: 100, tip: 5, serviceFee: 3, stripeFee: 3.5, platformFee: 0, net: 104.5, paidAt: iso('2026-10-05T16:00:00Z') });
      await addPayment(invoice, { amount: 50, stripeFee: 1.75, platformFee: 0.25, net: 48, paidAt: iso('2026-10-06T16:00:00Z') });
      // fee not captured yet: counts toward collected and is counted in fees_pending
      await addPayment(invoice, { amount: 20, stripeFee: null, platformFee: null, net: null, paidAt: iso('2026-10-07T16:00:00Z') });
      // not money collected, hand-recorded, deposit credit, or outside the period
      await addPayment(invoice, { amount: 999, state: 'FAILED', paidAt: iso('2026-10-05T16:00:00Z') });
      await addPayment(invoice, { amount: 998, state: 'PROCESSING', method: 'ACH', paidAt: iso('2026-10-05T16:00:00Z') });
      await addPayment(invoice, { amount: 997, method: 'CASH', paidAt: iso('2026-10-05T16:00:00Z') });
      await addPayment(invoice, { amount: 996, reference: 'DEPOSIT-CREDIT', paidAt: iso('2026-10-05T16:00:00Z') });
      await addPayment(invoice, { amount: 995, paidAt: iso('2026-09-20T16:00:00Z') });
      await addRefund(org, invoice, a, admin.id, 10);
      await addRefund(org, invoice, a, admin.id, 99, 'FAILED');
      const res = await (await (await finance(org)).api()).get(`/api/payments-page/summary?${WINDOW}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ collected: 178, fees: 5.5, refunds: 10, net: 142.5, count: 3, fees_pending: 1 });
    });

    it('answers 400 naming the field for a bad range', async () => {
      const { org } = await newOrg();
      const api = await (await finance(org)).api();
      const reversed = await api.get('/api/payments-page/summary?from=2026-10-10&to=2026-10-01');
      expect(reversed.status).toBe(400);
      expect(reversed.body.error).toMatch(/\bto\b/i);
      const tooLong = await api.get('/api/payments-page/summary?from=2025-01-01&to=2026-10-01');
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error).toMatch(/\bto\b|\bfrom\b/i);
      const missing = await api.get('/api/payments-page/summary?to=2026-10-01');
      expect(missing.status).toBe(400);
      expect(missing.body.error).toMatch(/\bfrom\b/i);
    });

    it('puts a payment at 23:30 org time on the to day in, and 00:30 the next day out, across the DST change', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      // New York leaves daylight time on 2026-11-01 (that day has 25 hours).
      await addPayment(invoice, { amount: 11, paidAt: iso('2026-11-02T04:30:00Z') }); // 23:30 EST on Nov 1: in
      await addPayment(invoice, { amount: 22, paidAt: iso('2026-11-02T05:30:00Z') }); // 00:30 EST on Nov 2: out
      await addPayment(invoice, { amount: 33, paidAt: iso('2026-11-01T04:30:00Z') }); // 00:30 EDT on Nov 1: in (the day's first hour)
      await addPayment(invoice, { amount: 44, paidAt: iso('2026-11-01T03:30:00Z') }); // 23:30 EDT on Oct 31: out
      const res = await (await (await finance(org)).api()).get('/api/payments-page/summary?from=2026-11-01&to=2026-11-01');
      expect(res.status).toBe(200);
      expect(res.body.collected).toBe(44);
      expect(res.body.count).toBe(2);
    });

    it('counts restricted rows too: totals are company-wide for every caller who passes the gate', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer); // nobody is attached to it
      await addPayment(invoice, { amount: 100, paidAt: iso('2026-10-05T16:00:00Z') });
      const narrow = await personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'attached' });
      const res = await (await narrow.api()).get(`/api/payments-page/summary?${WINDOW}`);
      expect(res.status).toBe(200);
      expect(res.body.collected).toBe(100);
    });

    it('never includes another company\'s payments', async () => {
      const a = await newOrg();
      const b = await newOrg();
      await addPayment(await invoiceIn(a.org, a.customer), { amount: 100, paidAt: iso('2026-10-05T16:00:00Z') });
      await addPayment(await invoiceIn(b.org, b.customer), { amount: 7000, paidAt: iso('2026-10-05T16:00:00Z') });
      const res = await (await (await finance(a.org)).api()).get(`/api/payments-page/summary?${WINDOW}`);
      expect(res.body.collected).toBe(100);
      expect(res.body.count).toBe(1);
    });

    it('ties to the payment fees report for the same window', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      await addPayment(invoice, { amount: 100, tip: 5, serviceFee: 3, stripeFee: 3.5, platformFee: 0, net: 104.5, paidAt: iso('2026-10-05T16:00:00Z') });
      await addPayment(invoice, { amount: 250.4, stripeFee: 7.5, platformFee: 1, net: 241.9, paidAt: iso('2026-10-12T16:00:00Z') });
      const admin = await fx.signedInAs((await db.user.findFirstOrThrow({ where: { organization_id: org, role: 'ADMIN' } })) as Person);
      const page = await admin.get(`/api/payments-page/summary?${WINDOW}`);
      const report = await admin.get(`/api/reports/payment-fees?${WINDOW}`);
      expect(report.status).toBe(200);
      expect(page.body.collected).toBe(report.body.charged);
      expect(page.body.net).toBe(report.body.net);
      expect(page.body.fees).toBe(report.body.stripeFees + report.body.platformFees);
    });

    describe('next payout', () => {
      it('sums what is collected and not yet paid out, all time, and what is in transit, and reads the schedule', async () => {
        const { org, customer } = await newOrg();
        const invoice = await invoiceIn(org, customer);
        const transit = await addPayout(org, { status: 'IN_TRANSIT', amount: 300, arrival: '2026-10-14' });
        await addPayout(org, { status: 'PENDING', amount: 80, arrival: '2026-10-16' });
        await addPayout(org, { status: 'PAID', amount: 9999, arrival: '2026-09-01' });
        // awaiting payout: all time, so a payment outside the period counts
        await addPayment(invoice, { net: 40, paidAt: iso('2026-08-01T16:00:00Z') });
        await addPayment(invoice, { net: 60, paidAt: iso('2026-10-05T16:00:00Z') });
        await addPayment(invoice, { net: 500, payoutId: transit.id, paidAt: iso('2026-10-05T16:00:00Z') });
        await addPayment(invoice, { net: 25, state: 'PROCESSING', method: 'ACH', paidAt: iso('2026-10-05T16:00:00Z') });
        await db.organization.update({
          where: { id: org },
          data: { payout_summary: { interval: 'weekly', weekly_anchor: 'friday', delay_days: 2, bank_label: 'Test Bank ••6789' } },
        });
        const res = await (await (await finance(org)).api()).get(`/api/payments-page/summary?${WINDOW}`);
        expect(res.body.next_payout).toEqual({
          amount: 100, in_transit: 380, date: '2026-10-14', schedule_text: 'Weekly on Fridays', bank_label: 'Test Bank ••6789',
        });
      });

      it('takes succeeded refunds off what is awaiting payout, and ignores pending and failed ones', async () => {
        const { org, customer, admin } = await newOrg();
        const invoice = await invoiceIn(org, customer);
        const refunded = await addPayment(invoice, { net: 80, paidAt: iso('2026-10-05T16:00:00Z') });
        await addPayment(invoice, { net: 50, paidAt: iso('2026-10-06T16:00:00Z') });
        const other = await addPayment(invoice, { net: 30, paidAt: iso('2026-10-07T16:00:00Z') });
        await addRefund(org, invoice, refunded, admin.id, 20);
        await addRefund(org, invoice, other, admin.id, 5, 'PENDING');
        await addRefund(org, invoice, other, admin.id, 5, 'FAILED');
        const res = await (await (await finance(org)).api()).get(`/api/payments-page/summary?${WINDOW}`);
        expect(res.body.next_payout.amount).toBe(140);
        expect(res.body.net).toBe(140);
      });

      it('has no date and no schedule when nothing is known', async () => {
        const { org } = await newOrg();
        const res = await (await (await finance(org)).api()).get(`/api/payments-page/summary?${WINDOW}`);
        expect(res.body.next_payout).toEqual({ amount: 0, in_transit: 0, date: null, schedule_text: null, bank_label: null });
      });
    });
  });

  describe('conductor fixes (dispute rights, money integrity, scale)', () => {
    const refunder = (org: string) => personWith(org, { view_payments: true, view_invoices: true, invoices_scope: 'all', refund_payments: true }, 'refunder');

    it('shows Respond to a dispute only to a Refund payments holder, never to a view-only caller', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const id = await addPayment(invoice, { amount: 100 });
      await addDispute(org, invoice, id, 'NEEDS_RESPONSE', 100);
      const viewOnly = await (await finance(org)).api();
      const seen = (await viewOnly.get(`/api/payments-page/payments/${id}`)).body;
      expect(seen.dispute).toMatchObject({ status: 'NEEDS_RESPONSE' });
      expect(seen.can_respond_dispute).toBe(false);
      const holder = await (await refunder(org)).api();
      expect((await holder.get(`/api/payments-page/payments/${id}`)).body.can_respond_dispute).toBe(true);
    });

    it('withholds can_refund while a dispute is open on the payment, and gives it back once the dispute is closed', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      await db.invoice.update({ where: { id: invoice }, data: { status: 'PAID' } });
      const needs = await addPayment(invoice, { amount: 100 });
      const review = await addPayment(invoice, { amount: 100 });
      const won = await addPayment(invoice, { amount: 100 });
      await addDispute(org, invoice, needs, 'NEEDS_RESPONSE');
      await addDispute(org, invoice, review, 'UNDER_REVIEW');
      await addDispute(org, invoice, won, 'WON');
      const api = await (await refunder(org)).api();
      expect((await api.get(`/api/payments-page/payments/${needs}`)).body.can_refund).toBe(false);
      expect((await api.get(`/api/payments-page/payments/${review}`)).body.can_refund).toBe(false);
      expect((await api.get(`/api/payments-page/payments/${won}`)).body.can_refund).toBe(true);
    });

    describe('payout totals', () => {
      it('leave out voided payments, take off succeeded refunds, and say whether the net matches the payout', async () => {
        const { org, customer, admin } = await newOrg();
        const invoice = await invoiceIn(org, customer);
        const payout = await addPayout(org, { status: 'PAID', amount: 130, arrival: '2026-10-08', createdAt: iso('2026-10-07T12:00:00Z') });
        const a = await addPayment(invoice, { amount: 100, stripeFee: 3, platformFee: 1, net: 96, payoutId: payout.id });
        await addPayment(invoice, { amount: 50, stripeFee: 2, platformFee: 0, net: 48, payoutId: payout.id });
        // a chargeback: voided, so it is not money in this payout
        await addPayment(invoice, { amount: 400, stripeFee: 10, platformFee: 0, net: 390, payoutId: payout.id, voidedAt: iso('2026-10-06T10:00:00Z'), voidCategory: 'CHARGEBACK' });
        await addRefund(org, invoice, a, admin.id, 14, 'SUCCEEDED', iso('2026-10-06T12:00:00Z'));
        await addRefund(org, invoice, a, admin.id, 99, 'PENDING');
        const api = await (await finance(org)).api();
        const head = (await api.get(`/api/payments-page/payouts/${payout.id}`)).body;
        // 96 + 48 - 14 = 130, the payout's own amount
        expect(head.totals).toEqual({ amount: 150, fee: 6, net: 130 });
        expect(head).toMatchObject({ net_matches_payout: true, net_difference: 0 });
        const rows = (await api.get(`/api/payments-page/payouts/${payout.id}/payments`)).body;
        expect(rows.totals).toEqual({ amount: 150, fee: 6, net: 130 });
        await db.payout.update({ where: { id: payout.id }, data: { amount: 125.5 } });
        const off = (await api.get(`/api/payments-page/payouts/${payout.id}`)).body;
        expect(off).toMatchObject({ net_matches_payout: false, net_difference: 4.5 });
        expect(JSON.stringify(off)).not.toMatch(/po_test_/);
      });
      it('does not call a payout drifted because of a refund or chargeback that came after it was created', async () => {
        const { org, customer, admin } = await newOrg();
        const invoice = await invoiceIn(org, customer);
        // the payout was sent for 96 + 48 + 390 = 534
        const payout = await addPayout(org, { status: 'PAID', amount: 534, arrival: '2026-10-08', createdAt: iso('2026-10-07T12:00:00Z') });
        const a = await addPayment(invoice, { amount: 100, stripeFee: 3, platformFee: 1, net: 96, payoutId: payout.id });
        await addPayment(invoice, { amount: 50, stripeFee: 2, platformFee: 0, net: 48, payoutId: payout.id });
        const later = await addPayment(invoice, { amount: 400, stripeFee: 10, platformFee: 0, net: 390, payoutId: payout.id });
        // a refund and a chargeback after the payout was created come off a later payout, not this one
        await addRefund(org, invoice, a, admin.id, 14, 'SUCCEEDED', iso('2026-10-09T12:00:00Z'));
        await db.payment.update({ where: { id: later }, data: { voided_at: iso('2026-10-09T10:00:00Z'), void_category: 'CHARGEBACK' } });
        const api = await (await finance(org)).api();
        const head = (await api.get(`/api/payments-page/payouts/${payout.id}`)).body;
        expect(head).toMatchObject({ net_matches_payout: true, net_difference: 0 });
        // a payment missing from the payout is still caught, even with a refund that would offset it
        await db.payment.update({ where: { id: a }, data: { payout_id: null } });
        const drift = (await api.get(`/api/payments-page/payouts/${payout.id}`)).body;
        expect(drift).toMatchObject({ net_matches_payout: false, net_difference: -96 });
      });
    });

    describe('round 3 fixes', () => {
      it('counts money in a PENDING payout in the next-payout block exactly once', async () => {
        const { org, customer } = await newOrg();
        const invoice = await invoiceIn(org, customer);
        const pending = await addPayout(org, { status: 'PENDING', amount: 80, arrival: '2026-10-16' });
        await addPayment(invoice, { net: 80, payoutId: pending.id, paidAt: iso('2026-10-05T16:00:00Z') });
        const res = await (await (await finance(org)).api()).get(`/api/payments-page/summary?${WINDOW}`);
        expect(res.body.next_payout).toMatchObject({ amount: 0, in_transit: 80, date: '2026-10-16' });
      });

      it('makes a payout footer equal the sum of its rows, with refunded and voided rows marked', async () => {
        const { org, customer, admin } = await newOrg();
        const invoice = await invoiceIn(org, customer);
        const payout = await addPayout(org, { status: 'PAID', amount: 130, arrival: '2026-10-08', createdAt: iso('2026-10-07T12:00:00Z') });
        const normal = await addPayment(invoice, { amount: 50, stripeFee: 2, platformFee: 0, net: 48, payoutId: payout.id });
        const refunded = await addPayment(invoice, { amount: 100, stripeFee: 3, platformFee: 1, net: 96, payoutId: payout.id });
        const voided = await addPayment(invoice, { amount: 400, stripeFee: 10, platformFee: 0, net: 390, payoutId: payout.id, voidedAt: iso('2026-10-06T10:00:00Z'), voidCategory: 'CHARGEBACK' });
        await addRefund(org, invoice, refunded, admin.id, 14, 'SUCCEEDED', iso('2026-10-06T12:00:00Z'));
        const api = await (await finance(org)).api();
        const head = (await api.get(`/api/payments-page/payouts/${payout.id}`)).body;
        expect(head.payment_count).toBe(2);
        const body = (await api.get(`/api/payments-page/payouts/${payout.id}/payments`)).body;
        expect(body.payment_count).toBe(2);
        expect(body.voided_count).toBe(1);
        const byId = new Map<string, Row>(body.payments.map((r: Row) => [r.id, r]));
        expect(byId.get(normal)).toMatchObject({ refunded: 0, net: 48, voided: false });
        expect(byId.get(refunded)).toMatchObject({ refunded: 14, net: 82, voided: false });
        expect(byId.get(voided)).toMatchObject({ voided: true, net: 0, amount: 0, fee: 0 });
        const sum = (k: string) => Math.round(body.payments.reduce((t: number, r: Row) => t + r[k], 0) * 100) / 100;
        expect({ amount: sum('amount'), fee: sum('fee'), net: sum('net') }).toEqual(body.totals);
        expect(body.totals).toEqual(head.totals);
      });

      it('answers 400 for a sortBy that names an inherited object property', async () => {
        const { org } = await newOrg();
        const api = await (await finance(org)).api();
        for (const key of ['constructor', 'toString', '__proto__']) {
          const res = await api.get(`/api/payments-page/payments?sortBy=${key}`);
          expect(res.status).toBe(400);
          expect(res.body.code ?? res.body.error).toMatch(/INVALID_SORT_FIELD|sort/i);
        }
      });
    });

    describe('refunds against a payment whose fees are not captured yet', () => {
      it('are left out of net and of the next payout until the net is known', async () => {
        const { org, customer, admin } = await newOrg();
        const invoice = await invoiceIn(org, customer);
        const known = await addPayment(invoice, { net: 80, paidAt: iso('2026-10-05T16:00:00Z') });
        const unknown = await addPayment(invoice, { amount: 60, stripeFee: null, platformFee: null, net: null, paidAt: iso('2026-10-06T16:00:00Z') });
        await addRefund(org, invoice, known, admin.id, 20);
        await addRefund(org, invoice, unknown, admin.id, 15);
        const res = await (await (await finance(org)).api()).get(`/api/payments-page/summary?${WINDOW}`);
        // net 80 - 20; the unknown payment adds no net, so its refund takes none off. The refunds figure still shows both.
        expect(res.body).toMatchObject({ net: 60, refunds: 35, fees_pending: 1 });
        expect(res.body.next_payout.amount).toBe(60);
      });
    });

    describe('sorting and facets over many rows', () => {
      async function seed() {
        const { org, customer, admin } = await newOrg();
        const invoice = await invoiceIn(org, customer);
        const made: Array<{ id: string; charged: number; fee: number | null }> = [];
        for (let i = 0; i < 60; i++) {
          // charged = amount + tip: all distinct, and the order differs from the invoice amount order
          const amount = 10 + ((i * 7) % 60);
          const tip = i % 2 === 0 ? 100 + (i / 2) * 70 : null;
          const fee = i % 10 === 9 ? null : ((i * 13) % 50) / 10;
          const id = await addPayment(invoice, {
            amount, tip, stripeFee: fee, platformFee: fee == null ? null : 0, net: fee == null ? null : amount - fee,
            paidAt: iso(`2026-10-${String(1 + (i % 28)).padStart(2, '0')}T16:00:00Z`),
          });
          made.push({ id, charged: amount + (tip ?? 0), fee });
        }
        return { org, customer, admin, invoice, made };
      }
      const pagesOf = async (api: Api, q: string) => {
        const ids: string[] = [];
        for (let page = 1; page <= 3; page++) {
          const body = await listOf(api, `${q}&limit=25&page=${page}`);
          expect(body.pagination).toMatchObject({ total: 60, totalPages: 3 });
          ids.push(...body.payments.map((r) => r.id));
        }
        return ids;
      };

      it('orders by charged amount and by fee across pages with no gap or repeat', async () => {
        const { org, made } = await seed();
        const api = await (await finance(org)).api();
        const tie = (a: string, b: string, dir: 1 | -1) => (a < b ? -dir : a > b ? dir : 0);
        const byAmount = [...made].sort((a, b) => b.charged - a.charged || tie(a.id, b.id, -1));
        expect(await pagesOf(api, 'sortBy=amount&sortDir=desc')).toEqual(byAmount.map((m) => m.id));
        const asc = [...made].sort((a, b) => a.charged - b.charged || tie(a.id, b.id, 1));
        expect(await pagesOf(api, 'sortBy=amount&sortDir=asc')).toEqual(asc.map((m) => m.id));
        const known = made.filter((m) => m.fee != null);
        const unknown = made.filter((m) => m.fee == null);
        const feeAsc = [...known].sort((a, b) => a.fee! - b.fee! || tie(a.id, b.id, 1)).concat([...unknown].sort((a, b) => tie(a.id, b.id, 1)));
        expect(await pagesOf(api, 'sortBy=fee&sortDir=asc')).toEqual(feeAsc.map((m) => m.id));
        const feeDesc = [...known].sort((a, b) => b.fee! - a.fee! || tie(a.id, b.id, -1)).concat([...unknown].sort((a, b) => tie(a.id, b.id, -1)));
        expect(await pagesOf(api, 'sortBy=fee&sortDir=desc')).toEqual(feeDesc.map((m) => m.id));
      });

      it('never loads the whole matching list into memory to sort or filter: only the page\'s own rows are read', async () => {
        const { org, admin, invoice, made } = await seed();
        await addRefund(org, invoice, made[0].id, admin.id, 1);
        const api = await (await finance(org)).api();
        const spy = vi.spyOn(db.payment, 'findMany');
        try {
          for (const q of ['sortBy=amount&sortDir=desc', 'sortBy=fee&sortDir=asc', 'status=partially_refunded', 'amount_min=20&amount_max=400']) {
            spy.mockClear();
            const body = await listOf(api, `${q}&limit=10`);
            expect(body.payments.length).toBeGreaterThan(0);
            for (const [args] of spy.mock.calls) {
              const ids = (args as { where?: { id?: { in?: string[] } } })?.where?.id?.in;
              expect(Array.isArray(ids) && ids.length <= 10, q).toBe(true);
            }
          }
        } finally {
          spy.mockRestore();
        }
      });

      it('filters by refunded status and by charged-amount range with the sort and the paging applied', async () => {
        const { org, admin, invoice, made } = await seed();
        const byCharged = [...made].sort((a, b) => b.charged - a.charged);
        // the five biggest are refunded in full (a full refund is the invoice amount), the next five in part
        const amountOf = async (id: string) => Number((await db.payment.findUniqueOrThrow({ where: { id } })).amount);
        for (const m of byCharged.slice(0, 5)) await addRefund(org, invoice, m.id, admin.id, await amountOf(m.id));
        for (const m of byCharged.slice(5, 10)) await addRefund(org, invoice, m.id, admin.id, 1);
        const api = await (await finance(org)).api();
        const full = await listOf(api, 'status=refunded&sortBy=amount&sortDir=asc&limit=3&page=2');
        expect(full.pagination).toMatchObject({ total: 5, totalPages: 2 });
        expect(full.payments.map((r) => r.id)).toEqual(
          byCharged.slice(0, 5).reverse().slice(3).map((m) => m.id),
        );
        const part = await listOf(api, 'status=partially_refunded&limit=100');
        expect(part.payments.map((r) => r.id).sort()).toEqual(byCharged.slice(5, 10).map((m) => m.id).sort());
        const both = await listOf(api, 'chip=refunded&limit=100');
        expect(both.pagination.total).toBe(10);
        const lo = byCharged[20].charged;
        const hi = byCharged[10].charged;
        const range = await listOf(api, `amount_min=${lo}&amount_max=${hi}&sortBy=amount&sortDir=desc&limit=100`);
        expect(range.payments.map((r) => r.id)).toEqual(byCharged.slice(10, 21).map((m) => m.id));
      });
    });
  });
  describe('another company\'s ids are never read (defense in depth)', () => {
    it('does not return a payment of another company that sits in this company\'s payout', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const payout = await addPayout(a.org, { status: 'PAID', arrival: '2026-10-09' });
      const mine = await addPayment(await invoiceIn(a.org, a.customer), { payoutId: payout.id, paidAt: iso('2026-10-05T16:00:00Z') });
      const theirs = await addPayment(await invoiceIn(b.org, b.customer), { payoutId: payout.id, paidAt: iso('2026-10-06T16:00:00Z') });
      const api = await (await finance(a.org)).api();
      const body = (await api.get(`/api/payments-page/payouts/${payout.id}/payments`)).body as { payments: Row[] };
      expect(body.payments.map((r) => r.id)).toEqual([mine]);
      expect(JSON.stringify(body)).not.toContain(theirs);
    });

    it('reads payments by id only inside the caller\'s company', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const mine = await addPayment(await invoiceIn(a.org, a.customer));
      const theirs = await addPayment(await invoiceIn(b.org, b.customer));
      const { recordsInOrder } = await import('../controllers/payments-page.controller.js');
      const found = await recordsInOrder({ user: { organization_id: a.org } } as never, [theirs, mine]);
      expect(found.map((r) => r.id)).toEqual([mine]);
    });

    it('lets an invoice opener confirm the company even for a caller who reaches every invoice', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const mine = await invoiceIn(a.org, a.customer);
      const theirs = await invoiceIn(b.org, b.customer);
      const { invoiceOpenerFor } = await import('../lib/permissions/invoiceAccess.js');
      const user = await db.user.findUniqueOrThrow({ where: { id: a.admin.id } });
      const req = { user: { ...user, organization_id: a.org } } as never;
      // By default a company-wide caller's opener answers for the ids it is given; asked to check the company it keeps only this company's.
      expect([...(await (await invoiceOpenerFor(req))([mine, theirs]))].sort()).toEqual([mine, theirs].sort());
      expect([...(await (await invoiceOpenerFor(req, { checkOrg: true }))([mine, theirs]))]).toEqual([mine]);
    });
  });

  describe('V7-05a: Refund failed, short codes, customer number', () => {
    const resolveFailed = (org: string, refundId: string, by: string) =>
      db.paymentAttentionResolution.create({
        data: { organization_id: org, item_key: `failed_refund:${refundId}`, resolution: 'SETTLED', note: null, resolved_by: by, resolved_by_name: 'Riley Resolver' },
      });
    async function failedRefund(org: string, invoiceId: string, paymentId: string, by: string, amount = 25, createdAt?: Date) {
      const r = await db.refund.create({
        data: {
          ...(createdAt ? { created_at: createdAt } : {}), organization_id: org, invoice_id: invoiceId, payment_id: paymentId, amount, method: 'CARD',
          reason_category: 'CUSTOMER_REQUEST', refunded_by: by, state: 'FAILED', failure_code: 'insufficient_funds',
        },
      });
      return r.id;
    }
    const statusOf = async (api: Api, id: string) => (await listOf(api, WINDOW)).payments.find((r) => r.id === id)?.status;

    it('reads Refund failed only for a failed refund nobody has dealt with', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const open = await addPayment(invoice, { paidAt: iso('2026-10-05T16:00:00Z') });
      const handled = await addPayment(invoice, { paidAt: iso('2026-10-05T16:01:00Z') });
      const covered = await addPayment(invoice, { paidAt: iso('2026-10-05T16:02:00Z') });
      const plain = await addPayment(invoice, { paidAt: iso('2026-10-05T16:03:00Z') });
      await failedRefund(org, invoice, open, admin.id);
      await resolveFailed(org, await failedRefund(org, invoice, handled, admin.id), admin.id);
      await failedRefund(org, invoice, covered, admin.id, 25, iso('2026-10-06T10:00:00Z'));
      await addRefund(org, invoice, covered, admin.id, 25, 'SUCCEEDED', iso('2026-10-06T11:00:00Z'));
      const api = await (await finance(org)).api();
      expect(await statusOf(api, open)).toBe('Refund failed');
      expect(await statusOf(api, handled)).toBe('Succeeded');
      expect(await statusOf(api, covered)).toBe('Partially refunded');
      expect(await statusOf(api, plain)).toBe('Succeeded');
    });

    it('never sets the flag from another company\'s refund', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const invoiceA = await invoiceIn(a.org, a.customer);
      const invoiceB = await invoiceIn(b.org, b.customer);
      const payment = await addPayment(invoiceA, { paidAt: iso('2026-10-05T16:00:00Z') });
      // A refund row that belongs to company B but points at company A's payment.
      await failedRefund(b.org, invoiceB, payment, b.admin.id);
      expect(await statusOf(await (await finance(a.org)).api(), payment)).toBe('Succeeded');
    });

    it('filters on refund_failed and every other status leaves those rows out', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const at = (n: number) => iso(`2026-10-05T16:0${n}:00Z`);
      const succeededFailed = await addPayment(invoice, { paidAt: at(0) });
      const partlyFailed = await addPayment(invoice, { paidAt: at(1) });
      const chargedBackFailed = await addPayment(invoice, { paidAt: at(2), voidedAt: at(2), voidCategory: 'CHARGEBACK' });
      const voidedFailed = await addPayment(invoice, { paidAt: at(3), voidedAt: at(3), voidCategory: 'ERROR' });
      const refundedFailed = await addPayment(invoice, { paidAt: at(4), amount: 50 });
      const plain = await addPayment(invoice, { paidAt: at(5) });
      await addRefund(org, invoice, partlyFailed, admin.id, 10, 'SUCCEEDED', iso('2026-10-04T10:00:00Z'));
      await addRefund(org, invoice, refundedFailed, admin.id, 50, 'SUCCEEDED', iso('2026-10-04T10:00:00Z'));
      for (const p of [succeededFailed, partlyFailed, chargedBackFailed, voidedFailed, refundedFailed]) await failedRefund(org, invoice, p, admin.id);
      const api = await (await finance(org)).api();
      const ids = async (status: string) => (await listOf(api, `${WINDOW}&status=${status}`)).payments.map((r) => r.id).sort();
      expect(await ids('refund_failed')).toEqual([succeededFailed, partlyFailed, chargedBackFailed, voidedFailed, refundedFailed].sort());
      expect(await ids('succeeded')).toEqual([plain]);
      for (const status of ['refunded', 'partially_refunded', 'charged_back', 'voided']) {
        expect(await ids(status), status).toEqual([]);
      }
    });

    it('writes Refund failed into the export', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const p = await addPayment(invoice, { paidAt: iso('2026-10-05T16:00:00Z') });
      await failedRefund(org, invoice, p, admin.id);
      const res = await (await (await finance(org)).api()).get(`/api/payments-page/payments/export?${WINDOW}`);
      expect(res.body.payments.map((r: Row) => r.status)).toEqual(['Refund failed']);
    });

    it('asks the database once per page for the flag, not once per row', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      for (let i = 0; i < 6; i++) {
        const p = await addPayment(invoice, { paidAt: iso(`2026-10-05T16:0${i}:00Z`) });
        if (i % 2 === 0) await failedRefund(org, invoice, p, admin.id);
      }
      const api = await (await finance(org)).api();
      const spy = vi.spyOn(db, '$queryRaw');
      try {
        const body = await listOf(api, WINDOW);
        expect(body.payments.filter((r) => r.status === 'Refund failed').length).toBe(3);
        const flagQueries = spy.mock.calls.filter((c) => JSON.stringify(c[0]).includes('failed_refund:'));
        expect(flagQueries.length).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('returns refund_failed on the detail: the newest open one, with the reason in plain words', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const p = await addPayment(invoice, { paidAt: iso('2026-10-05T16:00:00Z') });
      const clear = await addPayment(invoice, { paidAt: iso('2026-10-05T17:00:00Z') });
      await failedRefund(org, invoice, p, admin.id, 10, iso('2026-10-06T10:00:00Z'));
      await failedRefund(org, invoice, p, admin.id, 30, iso('2026-10-07T10:00:00Z'));
      const api = await (await finance(org)).api();
      const res = await api.get(`/api/payments-page/payments/${p}`);
      expect(res.body.status).toBe('Refund failed');
      expect(res.body.refund_failed).toMatchObject({ amount: 30, date: '2026-10-07T10:00:00.000Z' });
      expect(typeof res.body.refund_failed.failure_text).toBe('string');
      expect(res.body.refund_failed.failure_text.length).toBeGreaterThan(0);
      expect(JSON.stringify(res.body.refund_failed)).not.toMatch(/\bre_[A-Za-z0-9]|stripe/i);
      expect((await api.get(`/api/payments-page/payments/${clear}`)).body.refund_failed).toBeNull();
    });

    it('picks the newest OPEN failed refund, not a newer one a person already resolved', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const p = await addPayment(invoice, { paidAt: iso('2026-10-05T16:00:00Z') });
      await failedRefund(org, invoice, p, admin.id, 10, iso('2026-10-06T10:00:00Z'));
      await resolveFailed(org, await failedRefund(org, invoice, p, admin.id, 30, iso('2026-10-07T10:00:00Z')), admin.id);
      const res = await (await (await finance(org)).api()).get(`/api/payments-page/payments/${p}`);
      expect(res.body.status).toBe('Refund failed');
      expect(res.body.refund_failed).toMatchObject({ amount: 10, date: '2026-10-06T10:00:00.000Z' });
    });

    it('falls back to the plain sentence when the failed refund has no reason code', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const p = await addPayment(invoice, { paidAt: iso('2026-10-05T16:00:00Z') });
      const id = await failedRefund(org, invoice, p, admin.id);
      await db.refund.update({ where: { id }, data: { failure_code: null } });
      const res = await (await (await finance(org)).api()).get(`/api/payments-page/payments/${p}`);
      expect(res.body.refund_failed.failure_text).toBe('The refund did not reach the customer');
    });

    it('finds a payment by its PMT- code in any case, and returns the code and customer number on rows, detail, export and payout rows', async () => {
      const { org, customer, tag } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const payout = await addPayout(org);
      const p = await addPayment(invoice, { paidAt: iso('2026-10-05T16:00:00Z'), payoutId: payout.id });
      await addPayment(invoice, { paidAt: iso('2026-10-05T16:01:00Z') });
      const code = `PMT-${p.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      const api = await (await finance(org)).api();
      for (const q of [code, code.toLowerCase(), p.slice(0, 8)]) {
        expect((await listOf(api, `${WINDOW}&q=${q}`)).payments.map((r) => r.id), q).toEqual([p]);
      }
      const row = (await listOf(api, WINDOW)).payments.find((r) => r.id === p)!;
      expect(row.reference).toBe(code);
      expect(row.customer).toEqual({ id: customer, name: 'Pat Payer', customer_number: `C-${tag}` });
      expect((await api.get(`/api/payments-page/payments/${p}`)).body).toMatchObject({ reference: code, customer: { customer_number: `C-${tag}` } });
      expect((await api.get(`/api/payments-page/payments/export?${WINDOW}`)).body.payments.find((r: Row) => r.id === p).reference).toBe(code);
      const inPayout = (await api.get(`/api/payments-page/payouts/${payout.id}/payments`)).body.payments[0];
      expect(inPayout).toMatchObject({ reference: code, customer: { customer_number: `C-${tag}` } });
    });

    it('puts a DSP- code on the dispute of the payment detail', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const p = await addPayment(invoice, { paidAt: iso('2026-10-05T16:00:00Z') });
      const d = await addDispute(org, invoice, p, 'NEEDS_RESPONSE');
      const res = await (await (await finance(org)).api()).get(`/api/payments-page/payments/${p}`);
      expect(res.body.dispute.reference).toBe(`DSP-${d.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`);
      expect(JSON.stringify(res.body.dispute)).not.toContain(d.stripe_dispute_id);
    });

    it('reads a bank payment returned after it cleared as Charged back, and one returned before as Failed (N-18)', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const after = await addPayment(invoice, { method: 'ACH', paidAt: iso('2026-10-05T16:00:00Z'), voidedAt: iso('2026-10-08T10:00:00Z'), voidCategory: 'CHARGEBACK' });
      const before = await addPayment(invoice, { method: 'ACH', state: 'FAILED', failureCode: 'insufficient_funds', paidAt: iso('2026-10-05T16:01:00Z') });
      const api = await (await finance(org)).api();
      expect(await statusOf(api, after)).toBe('Charged back');
      expect(await statusOf(api, before)).toBe('Failed');
    });
  });
});
