/* =============================================================================
   Payments go-live P4 - the Needs attention list, its resolved history and its actions (/api/payments-page/attention/*),
   called as people on custom roles (never a built-in role name). Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
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
import { sendBankPaymentFailedEmail } from '../lib/email';
import { getStripeForOrg } from '../lib/stripe';

const suite = realClient ? describe : describe.skip;
const sendFailedEmail = sendBankPaymentFailedEmail as unknown as ReturnType<typeof vi.fn>;

suite('Needs attention API (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  beforeEach(() => {
    sendFailedEmail.mockReset();
    sendFailedEmail.mockResolvedValue({ status: 'sent' });
  });

  const orgs: string[] = [];
  afterAll(async () => {
    for (const org of orgs) {
      const q = (sql: string) => db.$executeRawUnsafe(sql).catch(() => undefined);
      await q(`DELETE FROM payment_attention_resolutions WHERE organization_id = '${org}'`);
      await q(`DELETE FROM unapplied_captures WHERE organization_id = '${org}'`);
      await q(`DELETE FROM disputes WHERE organization_id = '${org}'`);
      await q(`DELETE FROM payouts WHERE organization_id = '${org}'`);
      await q(`DELETE FROM audit_logs WHERE org_id = '${org}'`);
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Item = Record<string, any>;
  let sequence = 0;

  async function newOrg() {
    const o = await fx.newOrg();
    orgs.push(o.org);
    return o;
  }

  /** A person on a fresh custom role holding exactly these switch values on top of the base role's preset. */
  async function personWith(org: string, values: Record<string, boolean | string | string[]>, name = 'viewer') {
    const key = `pa-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person: Person = await fx.addUser(org, `${name}${sequence}`, 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: key });
    return { ...person, api: () => fx.signedInAs(person) };
  }
  const SEES_ALL = { view_payments: true, view_invoices: true, invoices_scope: 'all' } as const;
  const viewer = (org: string) => personWith(org, { ...SEES_ALL, refund_payments: false, send_payment_links: false, manage_payout_account: false }, 'viewer');
  const refunder = (org: string) => personWith(org, { ...SEES_ALL, refund_payments: true, send_payment_links: false, manage_payout_account: false }, 'refunder');
  const linker = (org: string) => personWith(org, { ...SEES_ALL, refund_payments: true, send_payment_links: true, manage_payout_account: false }, 'linker');
  const owner = (org: string) => personWith(org, { ...SEES_ALL, refund_payments: true, send_payment_links: true, manage_payout_account: true }, 'owner');

  const invoiceIn = async (org: string, customer: string, opts: Parameters<typeof fx.addInvoice>[2] = {}) => (await fx.addInvoice(org, customer, opts)).id;
  const days = (n: number) => new Date(Date.now() + n * 86_400_000);
  const ago = (n: number) => days(-n);

  async function addPayment(invoiceId: string, o: {
    amount?: number; method?: 'CARD' | 'ACH' | 'CASH'; state?: 'PROCESSING' | 'SUCCEEDED' | 'FAILED'; paidAt?: Date; failureCode?: string | null; voidedAt?: Date | null;
  } = {}) {
    const id = randomUUID();
    const method = o.method ?? 'ACH';
    await db.payment.create({
      data: {
        id, invoice_id: invoiceId, amount: o.amount ?? 100, method, paid_at: o.paidAt ?? ago(1), state: o.state ?? 'FAILED',
        stripe_payment_intent_id: method === 'CASH' ? null : `pi_test_${id.slice(0, 12)}`, failure_code: o.failureCode ?? null, voided_at: o.voidedAt ?? null,
        bank_name: method === 'ACH' ? 'Test Bank' : null, bank_last4: method === 'ACH' ? '6789' : null,
        card_brand: method === 'CARD' ? 'visa' : null, card_last4: method === 'CARD' ? '4242' : null,
      },
    });
    return id;
  }
  async function addRefund(org: string, invoiceId: string, paymentId: string, by: string, amount: number, state: 'PENDING' | 'SUCCEEDED' | 'FAILED', createdAt: Date, extra: { failureCode?: string; fromUnapplied?: boolean } = {}) {
    const id = randomUUID();
    await db.refund.create({
      data: {
        id, created_at: createdAt, organization_id: org, invoice_id: invoiceId, payment_id: paymentId, amount, method: 'ACH', reason_category: 'CUSTOMER_REQUEST', reason: 'Customer asked',
        refunded_by: by, state, failure_code: extra.failureCode ?? null, from_unapplied_capture: extra.fromUnapplied ?? false,
      },
    });
    return id;
  }
  async function addDispute(org: string, invoiceId: string, paymentId: string, o: { status?: 'NEEDS_RESPONSE' | 'UNDER_REVIEW' | 'WON' | 'LOST' | 'CLOSED'; bank?: boolean; due?: Date | null; createdAt?: Date } = {}) {
    const d = await db.dispute.create({
      data: {
        organization_id: org, invoice_id: invoiceId, payment_id: paymentId, stripe_dispute_id: `dp_test_${randomUUID().slice(0, 12)}`,
        status: o.status ?? 'NEEDS_RESPONSE', reason: 'fraudulent', amount: 100, evidence_due_by: o.due === undefined ? days(7) : o.due, is_bank_return: o.bank ?? false,
        ...(o.createdAt ? { created_at: o.createdAt } : {}),
      },
    });
    return d.id;
  }
  async function addPayout(org: string, o: { status?: string; createdAt?: Date; failureCode?: string | null } = {}) {
    const p = await db.payout.create({
      data: {
        organization_id: org, stripe_payout_id: `po_test_${randomUUID().slice(0, 12)}`, status: o.status ?? 'FAILED', amount: 500,
        arrival_date: new Date('2026-10-10T00:00:00Z'), processor_created_at: o.createdAt ?? ago(2), failure_code: o.failureCode ?? 'account_closed',
      },
    });
    return p.id;
  }
  async function addUnapplied(org: string, o: { invoiceId?: string | null; reason?: string; status?: 'OPEN' | 'REFUNDED' | 'RESOLVED'; createdAt?: Date; amount?: number; onRecord?: boolean } = {}) {
    const id = randomUUID();
    const onRecord = o.onRecord ?? true;
    await db.unappliedCapture.create({
      data: {
        id, organization_id: org, invoice_id: o.invoiceId ?? null, reason: o.reason ?? 'OVERPAYMENT', amount: o.amount ?? 25, status: o.status ?? 'OPEN',
        source_key: `src-${id}`, created_at: o.createdAt ?? ago(3),
        stripe_payment_intent_id: onRecord ? `pi_test_${id.slice(0, 12)}` : null, stripe_account_id: onRecord ? `acct_test_${id.slice(0, 8)}` : null,
        ...(o.status === 'REFUNDED' ? { refunded_at: new Date() } : {}),
      },
    });
    return id;
  }

  /** One open item of each kind, newest first in the order they are listed. */
  async function oneOfEach(org: string, customer: string, adminId: string) {
    const invoice = await invoiceIn(org, customer);
    const failedPayment = await addPayment(invoice, { failureCode: 'insufficient_funds', paidAt: ago(1) });
    const refundedPayment = await addPayment(invoice, { state: 'SUCCEEDED', paidAt: ago(30) });
    const failedRefund = await addRefund(org, invoice, refundedPayment, adminId, 20, 'FAILED', ago(2), { failureCode: 'account_closed' });
    const cardPayment = await addPayment(invoice, { method: 'CARD', state: 'SUCCEEDED', paidAt: ago(20) });
    const dispute = await addDispute(org, invoice, cardPayment, { createdAt: ago(3) });
    const payout = await addPayout(org, { createdAt: ago(4) });
    const unmatched = await addUnapplied(org, { invoiceId: invoice, createdAt: ago(5) });
    const unmatchedRefund = await addUnapplied(org, { reason: 'REFUND_UNMATCHED', createdAt: ago(6), onRecord: false });
    return { invoice, failedPayment, refundedPayment, failedRefund, cardPayment, dispute, payout, unmatched, unmatchedRefund };
  }

  const listOf = async (api: Api, query = 'view=open') => (await api.get(`/api/payments-page/attention?${query}`)).body as { items: Item[]; pagination: Item; counts: { open: number; resolved: number } };
  const BASE = '/api/payments-page/attention';

  describe('the gate', () => {
    it('refuses the summary and the list without View payments and lets them in with it', async () => {
      const { org } = await newOrg();
      const off = await personWith(org, { view_payments: false, view_invoices: true, invoices_scope: 'all' });
      const on = await viewer(org);
      for (const url of [`${BASE}/summary`, BASE]) {
        expect((await (await off.api()).get(url)).status, `${url} without View payments`).toBe(403);
        expect((await (await on.api()).get(url)).status, `${url} with View payments`).toBe(200);
      }
    });

    it('gives each write route its own switch', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const v = await viewer(org);
      const r = await refunder(org);
      const l = await linker(org);
      const o = await owner(org);
      const key = (type: string, id: string) => `${BASE}/${type}:${id}`;
      // view-only: nothing is allowed
      expect((await (await v.api()).post(`${key('failed_payment', ids.failedPayment)}/resolve`, {})).status).toBe(403);
      expect((await (await v.api()).post(`${key('failed_payment', ids.failedPayment)}/contact-customer`, {})).status).toBe(403);
      expect((await (await v.api()).post(`${key('failed_payout', ids.payout)}/resolve`, {})).status).toBe(403);
      // Refund payments alone cannot send the customer a pay-again link, and cannot settle a payout
      expect((await (await r.api()).post(`${key('failed_payment', ids.failedPayment)}/contact-customer`, {})).status).toBe(403);
      expect((await (await r.api()).post(`${key('failed_payout', ids.payout)}/resolve`, {})).status).toBe(403);
      // Send payment links alone cannot mark a payment resolved
      const linksOnly = await personWith(org, { ...SEES_ALL, refund_payments: false, send_payment_links: true }, 'linksonly');
      expect((await (await linksOnly.api()).post(`${key('failed_payment', ids.failedPayment)}/resolve`, {})).status).toBe(403);
      // each switch opens its own door
      expect((await (await r.api()).post(`${key('failed_payment', ids.failedPayment)}/resolve`, {})).status).toBe(200);
      expect((await (await o.api()).post(`${key('failed_payout', ids.payout)}/resolve`, {})).status).toBe(200);
      expect(l).toBeTruthy();
    });
  });

  describe('GET /attention?view=open', () => {
    it('carries the same payout reference as the payouts list on a failed payout, open and resolved, and never the processor id', async () => {
      const { org } = await newOrg();
      const failed = await addPayout(org, { createdAt: ago(4) });
      const api = await (await owner(org)).api();
      const payouts = (await api.get('/api/payments-page/payouts')).body.payouts as Array<{ id: string; reference: string }>;
      const reference = payouts.find((p) => p.id === failed)!.reference;
      expect(reference).toMatch(/^PO-[0-9A-F]{8}$/);

      const open = (await listOf(api, 'view=open')).items.find((i) => i.type === 'failed_payout');
      expect(open?.payout_reference).toBe(reference);
      // A later paid payout resolves the failed one; the reference stays on the resolved item.
      await addPayout(org, { status: 'PAID', createdAt: ago(1) });
      const resolved = (await listOf(api, 'view=resolved')).items.find((i) => i.type === 'failed_payout');
      expect(resolved?.payout_reference).toBe(reference);
      const stripeId = (await db.payout.findUniqueOrThrow({ where: { id: failed } })).stripe_payout_id;
      expect(JSON.stringify(open)).not.toContain(stripeId);
    });

    it('has no payout reference on any other kind of item', async () => {
      const { org, customer, admin } = await newOrg();
      await oneOfEach(org, customer, admin.id);
      const body = await listOf(await (await owner(org)).api());
      for (const i of body.items) {
        if (i.type !== 'failed_payout') expect(i.payout_reference).toBeNull();
      }
    });

    it('lists one of every kind, newest first, in ServWave words, with the actions this caller has', async () => {
      const { org, customer, admin } = await newOrg();
      await db.customer.update({ where: { id: customer }, data: { email: 'delivered@resend.dev' } });
      const ids = await oneOfEach(org, customer, admin.id);
      const body = await listOf(await (await owner(org)).api());
      expect(body.items.map((i) => i.type)).toEqual(['failed_payment', 'failed_refund', 'dispute', 'failed_payout', 'unmatched_payment', 'unmatched_refund']);
      expect(body.items.map((i) => i.key)).toEqual([
        `failed_payment:${ids.failedPayment}`, `failed_refund:${ids.failedRefund}`, `dispute:${ids.dispute}`,
        `failed_payout:${ids.payout}`, `unmatched_payment:${ids.unmatched}`, `unmatched_refund:${ids.unmatchedRefund}`,
      ]);
      const by = Object.fromEntries(body.items.map((i) => [i.type, i]));
      expect(by.failed_payment).toMatchObject({
        status: 'open', title: 'Bank payment failed', detail: 'Insufficient funds', amount: 100, restricted: false, payment_id: ids.failedPayment,
        invoice: { id: ids.invoice }, customer: { id: customer, name: 'Pat Payer' }, actions: ['contact_customer', 'mark_resolved'], resolution: null, resolved_at: null,
      });
      expect(by.failed_refund).toMatchObject({
        title: 'Refund failed', detail: 'The bank account is closed', amount: 20, actions: ['refund_again', 'mark_settled'], payment_id: ids.refundedPayment,
        refund_again: { invoice_id: ids.invoice, payment_id: ids.refundedPayment, amount: 20, reason_category: 'CUSTOMER_REQUEST', reason: 'Customer asked' },
      });
      expect(by.dispute).toMatchObject({ title: 'Dispute needs a response', dispute_id: ids.dispute, actions: ['respond'] });
      expect(by.dispute.detail).toBe('The cardholder says they did not make this payment');
      expect(by.dispute.respond_by).toBeTruthy();
      expect(by.dispute.days_left).toBeGreaterThanOrEqual(6);
      expect(by.failed_payout).toMatchObject({ title: 'Payout failed', detail: 'The bank account is closed', payout_id: ids.payout, actions: ['update_bank_account'] });
      expect(by.unmatched_payment).toMatchObject({ title: 'Money received that is not on an invoice', detail: 'Paid more than the balance due. This is the part that was not applied.', actions: ['refund', 'mark_resolved'], amount: 25 });
      expect(by.unmatched_refund.actions).toEqual(['mark_resolved']);
      expect(body.counts).toEqual({ open: 6, resolved: 0 });
      expect(body.pagination).toMatchObject({ page: 1, total: 6 });
      // no processor id or name in the body
      expect(JSON.stringify(body)).not.toMatch(/stripe|pi_test|po_test|dp_test|acct_test/i);
    });

    it('gives a view-only caller the same list with no actions on any item', async () => {
      const { org, customer, admin } = await newOrg();
      await oneOfEach(org, customer, admin.id);
      const body = await listOf(await (await viewer(org)).api());
      expect(body.items).toHaveLength(6);
      expect(body.items.every((i) => Array.isArray(i.actions) && i.actions.length === 0)).toBe(true);
    });

    it('offers refund actions to Refund payments and adds Contact customer with Send payment links', async () => {
      const { org, customer, admin } = await newOrg();
      await db.customer.update({ where: { id: customer }, data: { email: 'delivered@resend.dev' } });
      await oneOfEach(org, customer, admin.id);
      const actionsOf = async (p: Awaited<ReturnType<typeof refunder>>) => Object.fromEntries((await listOf(await p.api())).items.map((i) => [i.type, i.actions]));
      expect(await actionsOf(await refunder(org))).toMatchObject({
        failed_payment: ['mark_resolved'], failed_refund: ['refund_again', 'mark_settled'], dispute: ['respond'], failed_payout: [], unmatched_payment: ['refund', 'mark_resolved'],
      });
      expect(await actionsOf(await linker(org))).toMatchObject({ failed_payment: ['contact_customer', 'mark_resolved'], failed_payout: [] });
    });

    it('offers no Contact customer when the customer has no email on file', async () => {
      const { org, customer, admin } = await newOrg();
      await oneOfEach(org, customer, admin.id);
      const row = (await listOf(await (await linker(org)).api())).items.find((i) => i.type === 'failed_payment')!;
      expect(row.actions).toEqual(['mark_resolved']);
    });

    it('filters by type and by search, and never lists a bank payment that holds a dispute as a failed payment', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const invoice = ids.invoice;
      const bankReturn = await addPayment(invoice, { state: 'FAILED', paidAt: ago(1) });
      await addDispute(org, invoice, bankReturn, { bank: true, createdAt: ago(1) });
      const api = await (await owner(org)).api();
      const only = await listOf(api, 'view=open&type[]=dispute&type[]=failed_payout');
      expect(only.items.map((i) => i.type).sort()).toEqual(['dispute', 'dispute', 'failed_payout']);
      expect((await listOf(api)).items.filter((i) => i.type === 'failed_payment').map((i) => i.payment_id)).toEqual([ids.failedPayment]);
      const number = (await db.invoice.findUniqueOrThrow({ where: { id: invoice } })).invoice_number;
      expect((await listOf(api, `view=open&q=${number}`)).items.length).toBeGreaterThan(0);
      expect((await listOf(api, 'view=open&q=nothing-matches-this')).items).toEqual([]);
      expect((await listOf(api, 'view=open&q=payer')).items.length).toBeGreaterThan(0);
    });

    it('narrows to the items of one payment with payment_id, whatever the length of the open backlog, and to nothing for a payment with none', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const api = await (await owner(org)).api();
      const failed = await listOf(api, `view=open&payment_id=${ids.failedPayment}`);
      expect(failed.items.map((i) => i.key)).toEqual([`failed_payment:${ids.failedPayment}`]);
      expect(failed.pagination.total).toBe(1);
      // A dispute and a failed refund hang on their own payments; the payout and the unmatched money on none.
      expect((await listOf(api, `view=open&payment_id=${ids.cardPayment}`)).items.map((i) => i.type)).toEqual(['dispute']);
      expect((await listOf(api, `view=open&payment_id=${ids.refundedPayment}`)).items.map((i) => i.type)).toEqual(['failed_refund']);
      expect((await listOf(api, `view=open&payment_id=${randomUUID()}`)).items).toEqual([]);
      // Another company's payment id finds nothing here, and a malformed id is refused rather than guessed at.
      const other = await newOrg();
      const otherIds = await oneOfEach(other.org, other.customer, other.admin.id);
      expect((await listOf(api, `view=open&payment_id=${otherIds.failedPayment}`)).items).toEqual([]);
      expect((await api.get(`${BASE}?view=open&payment_id=not-a-uuid`)).status).toBe(400);
    });

    it('rejects an unknown view or type', async () => {
      const { org } = await newOrg();
      const api = await (await viewer(org)).api();
      expect((await api.get(`${BASE}?view=sideways`)).status).toBe(400);
      expect((await api.get(`${BASE}?type[]=bogus`)).status).toBe(400);
    });
  });

  describe('restricted items', () => {
    it('keeps the amount and date of an item on an invoice the caller cannot open, hides its names and actions, and counts it the same', async () => {
      const { org, customer, admin } = await newOrg();
      const secret = randomUUID();
      await db.customer.create({ data: { id: secret, organization_id: org, customer_number: `C-${secret.slice(0, 8)}`, kind: 'COMPANY', segment: 'COMMERCIAL', company_name: 'Hidden Holdings' } });
      await db.customer.update({ where: { id: secret }, data: { email: 'delivered@resend.dev' } });
      const me = await personWith(org, { ...SEES_ALL, invoices_scope: 'attached', refund_payments: true, send_payment_links: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = await invoiceIn(org, customer, { jobId: job.id });
      const theirs = await invoiceIn(org, secret);
      const myPayment = await addPayment(mine, { amount: 10, paidAt: ago(2) });
      const theirPayment = await addPayment(theirs, { amount: 20, paidAt: ago(1) });
      const theirSettled = await addPayment(theirs, { state: 'SUCCEEDED', paidAt: ago(40) });
      const theirRefund = await addRefund(org, theirs, theirSettled, admin.id, 5, 'FAILED', ago(3));
      const theirCard = await addPayment(theirs, { method: 'CARD', state: 'SUCCEEDED', paidAt: ago(30) });
      await addDispute(org, theirs, theirCard, { createdAt: ago(4) });
      const theirUnmatched = await addUnapplied(org, { invoiceId: theirs, createdAt: ago(5) });
      const orgLevel = await addUnapplied(org, { createdAt: ago(6) });

      const body = await listOf(await me.api());
      const byKey = Object.fromEntries(body.items.map((i) => [i.key, i]));
      expect(byKey[`failed_payment:${myPayment}`]).toMatchObject({ restricted: false, customer: { name: 'Pat Payer' }, actions: ['mark_resolved'] });
      expect(byKey[`failed_payment:${theirPayment}`]).toMatchObject({ restricted: true, customer: null, invoice: null, amount: 20, actions: [], status: 'open' });
      expect(byKey[`failed_payment:${theirPayment}`].date).toBeTruthy();
      expect(byKey[`failed_refund:${theirRefund}`]).toMatchObject({ restricted: true, actions: [], refund_again: null, amount: 5 });
      const dispute = body.items.find((i) => i.type === 'dispute')!;
      expect(dispute).toMatchObject({ restricted: true, actions: [], customer: null });
      expect(byKey[`unmatched_payment:${theirUnmatched}`]).toMatchObject({ restricted: true, actions: [], amount: 25 });
      const hiddenNumber = (await db.invoice.findUniqueOrThrow({ where: { id: theirs } })).invoice_number;
      expect(JSON.stringify(body)).not.toContain('Hidden Holdings');
      expect(JSON.stringify(body)).not.toContain(hiddenNumber);
      // an item on the org itself (no invoice) is not for a narrowed caller: absent from the list and from the counts
      expect(byKey[`unmatched_payment:${orgLevel}`]).toBeUndefined();
      expect(body.counts.open).toBe(body.items.length);
      expect(body.pagination.total).toBe(body.items.length);
      const summary = (await (await me.api()).get(`${BASE}/summary`)).body;
      expect(summary.open).toBe(body.items.length);
      // a caller who reaches every invoice sees the org-level item and the names
      const all = await listOf(await (await owner(org)).api());
      expect(all.items.find((i) => i.key === `unmatched_payment:${orgLevel}`)).toBeTruthy();
      expect(all.items.find((i) => i.key === `failed_payment:${theirPayment}`)).toMatchObject({ restricted: false, customer: { name: 'Hidden Holdings' } });
      // searching a hidden name finds nothing for the narrowed caller
      expect((await listOf(await me.api(), 'view=open&q=Hidden')).items).toEqual([]);
    });
  });

  describe('restricted items carry no free text', () => {
    it('blanks the note, the resolver, the detail text and the source ids on an invoice the caller cannot open', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, { ...SEES_ALL, invoices_scope: 'attached', refund_payments: true });
      const theirs = await invoiceIn(org, customer);
      const resolvedPayment = await addPayment(theirs, { amount: 30, paidAt: ago(2), failureCode: 'insufficient_funds' });
      await db.paymentAttentionResolution.create({
        data: { organization_id: org, item_key: `failed_payment:${resolvedPayment}`, resolution: 'RESOLVED', note: 'Called Dana Quill about the bounce', resolved_by: admin.id, resolved_by_name: 'Riley Resolver' },
      });
      const openPayment = await addPayment(theirs, { amount: 40, paidAt: ago(1), failureCode: 'account_closed' });
      const cardPayment = await addPayment(theirs, { method: 'CARD', state: 'SUCCEEDED', paidAt: ago(30) });
      const dispute = await addDispute(org, theirs, cardPayment, { createdAt: ago(4) });
      const api = await me.api();
      const open = await listOf(api);
      const done = await listOf(api, 'view=resolved');
      const all = [...open.items, ...done.items];
      expect(all.map((i) => i.key)).toEqual(expect.arrayContaining([`failed_payment:${openPayment}`, `failed_payment:${resolvedPayment}`, `dispute:${dispute}`]));
      for (const item of all) {
        expect(item).toMatchObject({ restricted: true, detail: '', payment_id: null, dispute_id: null, payout_id: null });
        expect(item.amount).not.toBeNull();
        expect(item.date).toBeTruthy();
      }
      const gone = done.items.find((i) => i.key === `failed_payment:${resolvedPayment}`)!;
      expect(gone.resolved_by_name).toBeNull();
      expect(gone.resolution.note).toBeNull();
      const text = JSON.stringify([open, done]);
      expect(text).not.toContain('Dana Quill');
      expect(text).not.toContain('Riley Resolver');
      // the item key still carries the row id (it is the handle the write routes refuse for this caller); no other field does
      expect(text.split(openPayment)).toHaveLength(2);
      expect(text.split(dispute)).toHaveLength(2);
    });
  });

  describe('tenants', () => {
    it('never lists another company\'s items, and answers 404 for its key', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const theirs = await oneOfEach(b.org, b.customer, b.admin.id);
      await oneOfEach(a.org, a.customer, a.admin.id);
      const me = await owner(a.org);
      const body = await listOf(await me.api());
      expect(body.items).toHaveLength(6);
      expect(JSON.stringify(body)).not.toContain(theirs.failedPayment);
      expect((await (await me.api()).get(`${BASE}/summary`)).body.open).toBe(6);
      const api = await me.api();
      expect((await api.post(`${BASE}/failed_payment:${theirs.failedPayment}/resolve`, {})).status).toBe(404);
      expect((await api.post(`${BASE}/failed_payment:${theirs.failedPayment}/contact-customer`, {})).status).toBe(404);
      expect((await api.post(`${BASE}/failed_payout:${theirs.payout}/resolve`, {})).status).toBe(404);
      expect(await db.paymentAttentionResolution.count({ where: { item_key: { contains: theirs.failedPayment } } })).toBe(0);
    });
  });

  describe('GET /attention/summary', () => {
    it('counts what is open by kind, equal to the list\'s open count', async () => {
      const { org, customer, admin } = await newOrg();
      await oneOfEach(org, customer, admin.id);
      const api = await (await viewer(org)).api();
      const summary = (await api.get(`${BASE}/summary`)).body;
      expect(summary).toEqual({
        open: 6,
        by_type: { failed_payment: 1, failed_refund: 1, dispute: 1, failed_payout: 1, unmatched_payment: 1, unmatched_refund: 1 },
      });
      expect((await listOf(api)).counts.open).toBe(6);
    });
  });

  describe('POST /attention/:key/resolve', () => {
    it('closes an item with a note, once, writes the audit row, and moves it to the resolved list', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const me = await refunder(org);
      const api = await me.api();
      const key = `failed_payment:${ids.failedPayment}`;
      const first = await api.post(`${BASE}/${key}/resolve`, { note: 'Customer paid by cheque' });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ key, resolution: { text: 'Marked resolved', note: 'Customer paid by cheque' } });
      const again = await api.post(`${BASE}/${key}/resolve`, { note: 'ignored' });
      expect(again.status).toBe(200);
      expect(again.body.resolution.note).toBe('Customer paid by cheque');
      expect(await db.paymentAttentionResolution.count({ where: { organization_id: org, item_key: key } })).toBe(1);
      const row = await db.paymentAttentionResolution.findFirstOrThrow({ where: { organization_id: org, item_key: key } });
      expect(row.resolved_by).toBe(me.id);
      expect(row.resolved_by_name).toBe(`${(await db.user.findUniqueOrThrow({ where: { id: me.id } })).first_name} Tester`);

      const open = await listOf(api);
      expect(open.items.map((i) => i.key)).not.toContain(key);
      const resolved = await listOf(api, 'view=resolved');
      expect(resolved.items).toHaveLength(1);
      expect(resolved.items[0]).toMatchObject({ key, status: 'resolved', actions: [], resolved_by_name: row.resolved_by_name, resolution: { text: 'Marked resolved', note: 'Customer paid by cheque' } });
      expect(resolved.items[0].resolved_at).toBeTruthy();
      expect(resolved.counts).toEqual({ open: 5, resolved: 1 });
      await new Promise((r) => setTimeout(r, 100));
      const audits = await db.auditLog.findMany({ where: { org_id: org, action: 'payments.attention_resolved' } });
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toMatchObject({ item_key: key });
    });

    it('words a settled refund "Marked settled"', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const api = await (await refunder(org)).api();
      const key = `failed_refund:${ids.failedRefund}`;
      expect((await api.post(`${BASE}/${key}/resolve`, {})).status).toBe(200);
      const resolved = await listOf(api, 'view=resolved');
      expect(resolved.items[0]).toMatchObject({ key, resolution: { text: 'Marked settled', note: null } });
    });

    it('refuses a note over 500 characters, naming the field, and an item that is not open', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const api = await (await owner(org)).api();
      const key = `failed_payment:${ids.failedPayment}`;
      const tooLong = await api.post(`${BASE}/${key}/resolve`, { note: 'x'.repeat(20_001) });
      expect(tooLong.status).toBe(400);
      expect(JSON.stringify(tooLong.body)).toMatch(/note/i);
      expect(await db.paymentAttentionResolution.count({ where: { organization_id: org } })).toBe(0);
      expect((await api.post(`${BASE}/${key}/resolve`, { note: 'x'.repeat(20_000) })).status).toBe(200);
      // not open: paid invoice
      const paidInvoice = await invoiceIn(org, customer);
      const failed = await addPayment(paidInvoice);
      await db.invoice.update({ where: { id: paidInvoice }, data: { status: 'PAID' } });
      expect((await api.post(`${BASE}/failed_payment:${failed}/resolve`, {})).status).toBe(409);
      // a dispute and an unmatched capture keep their own doors
      expect((await api.post(`${BASE}/dispute:${ids.dispute}/resolve`, {})).status).toBe(400);
      expect((await api.post(`${BASE}/unmatched_payment:${ids.unmatched}/resolve`, {})).status).toBe(400);
      expect((await api.post(`${BASE}/not-a-key/resolve`, {})).status).toBe(404);
    });

    it('needs Manage payout account for a failed payout', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const key = `failed_payout:${ids.payout}`;
      expect((await (await (await refunder(org)).api()).post(`${BASE}/${key}/resolve`, {})).status).toBe(403);
      const res = await (await (await owner(org)).api()).post(`${BASE}/${key}/resolve`, { note: 'New bank added' });
      expect(res.status).toBe(200);
      const resolved = await listOf(await (await owner(org)).api(), 'view=resolved&type[]=failed_payout');
      expect(resolved.items[0]).toMatchObject({ key, resolution: { text: 'Marked resolved', note: 'New bank added' } });
    });

    it('is refused for an item on an invoice the caller cannot open', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { ...SEES_ALL, invoices_scope: 'attached', refund_payments: true });
      const hidden = await invoiceIn(org, customer);
      const failed = await addPayment(hidden);
      const res = await (await me.api()).post(`${BASE}/failed_payment:${failed}/resolve`, {});
      expect(res.status).toBe(403);
    });
  });

  describe('POST /attention/:key/contact-customer', () => {
    const setup = async () => {
      const o = await newOrg();
      await db.customer.update({ where: { id: o.customer }, data: { email: 'delivered@resend.dev' } });
      const invoice = await invoiceIn(o.org, o.customer);
      await db.invoice.update({ where: { id: invoice }, data: { public_token: `tok-${invoice.slice(0, 12)}`, status: 'SENT' } });
      const failed = await addPayment(invoice, { amount: 75 });
      const me = await linker(o.org);
      return { ...o, invoice, failed, me, key: `failed_payment:${failed}` };
    };

    it('sends the pay-again email once with the invoice link, records it, and throttles a second send', async () => {
      const s = await setup();
      const api = await s.me.api();
      const sent = await api.post(`${BASE}/${s.key}/contact-customer`, {});
      expect(sent.status).toBe(200);
      expect(sendFailedEmail).toHaveBeenCalledTimes(1);
      const arg = sendFailedEmail.mock.calls[0][0];
      expect(arg).toMatchObject({ organizationId: s.org, to: 'delivered@resend.dev', amount: 75 });
      expect(arg.payUrl).toContain(`/p/invoices/${s.invoice}?token=tok-`);
      expect(JSON.stringify(arg)).not.toMatch(/stripe/i);
      const timeline = await db.timelineEvent.findMany({ where: { organization_id: s.org, entity_id: s.invoice, event_type: 'PAYMENT_CUSTOMER_ASKED_TO_PAY_AGAIN' } });
      expect(timeline).toHaveLength(1);
      expect(timeline[0].description).toBe('Customer asked to pay again');
      await new Promise((r) => setTimeout(r, 100));
      expect(await db.auditLog.count({ where: { org_id: s.org, action: 'payments.attention_contacted' } })).toBe(1);
      const second = await api.post(`${BASE}/${s.key}/contact-customer`, {});
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('Already sent a moment ago.');
      expect(sendFailedEmail).toHaveBeenCalledTimes(1);
    });

    it('answers 409 when the invoice is paid or voided, or the customer has no email', async () => {
      const s = await setup();
      const api = await s.me.api();
      await db.invoice.update({ where: { id: s.invoice }, data: { status: 'PAID' } });
      // an item whose invoice is paid is no longer open
      expect((await api.post(`${BASE}/${s.key}/contact-customer`, {})).status).toBe(409);
      await db.invoice.update({ where: { id: s.invoice }, data: { status: 'VOIDED' } });
      expect((await api.post(`${BASE}/${s.key}/contact-customer`, {})).status).toBe(409);
      await db.invoice.update({ where: { id: s.invoice }, data: { status: 'SENT' } });
      await db.customer.update({ where: { id: s.customer }, data: { email: null } });
      const noEmail = await api.post(`${BASE}/${s.key}/contact-customer`, {});
      expect(noEmail.status).toBe(409);
      expect(noEmail.body.error).toMatch(/email/i);
      expect(sendFailedEmail).not.toHaveBeenCalled();
    });

    it('sends the email with no transaction open: the throttle claim is already committed when the mail layer runs', async () => {
      const s = await setup();
      const api = await s.me.api();
      let claimsSeenBySender = -1;
      sendFailedEmail.mockImplementationOnce(async () => {
        // db is a separate client: it sees the row only if the claiming transaction has already committed.
        claimsSeenBySender = await db.timelineEvent.count({ where: { organization_id: s.org, entity_id: s.invoice, event_type: 'PAYMENT_CUSTOMER_ASKED_TO_PAY_AGAIN' } });
        return { status: 'sent' };
      });
      expect((await api.post(`${BASE}/${s.key}/contact-customer`, {})).status).toBe(200);
      expect(claimsSeenBySender).toBe(1);
    });

    it('records nothing and allows a retry when the email cannot be sent', async () => {
      const s = await setup();
      const api = await s.me.api();
      sendFailedEmail.mockRejectedValueOnce(new Error('mail down'));
      const failed = await api.post(`${BASE}/${s.key}/contact-customer`, {});
      expect(failed.status).toBe(500);
      const asked = () => db.timelineEvent.count({ where: { organization_id: s.org, entity_id: s.invoice, event_type: 'PAYMENT_CUSTOMER_ASKED_TO_PAY_AGAIN' } });
      expect(await asked()).toBe(0);
      const retry = await api.post(`${BASE}/${s.key}/contact-customer`, {});
      expect(retry.status).toBe(200);
      expect(sendFailedEmail).toHaveBeenCalledTimes(2);
      expect(await asked()).toBe(1);
    });

    it.each([
      ['a suppressed address', { status: 'skipped', reason: 'suppressed' }, 409],
      ['a send that failed inside the mail layer', { status: 'failed' }, 502],
      ['no mail key configured', { status: 'skipped', reason: 'no_api_key' }, 502],
    ])('says so, records nothing and allows a retry for %s', async (_name, outcome, status) => {
      const s = await setup();
      const api = await s.me.api();
      sendFailedEmail.mockResolvedValueOnce(outcome);
      const res = await api.post(`${BASE}/${s.key}/contact-customer`, {});
      expect(res.status).toBe(status);
      expect(res.body.sent).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/stripe|resend|supabase/i);
      const asked = () => db.timelineEvent.count({ where: { organization_id: s.org, entity_id: s.invoice, event_type: 'PAYMENT_CUSTOMER_ASKED_TO_PAY_AGAIN' } });
      expect(await asked()).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(await db.auditLog.count({ where: { org_id: s.org, action: 'payments.attention_contacted' } })).toBe(0);
      expect((await api.post(`${BASE}/${s.key}/contact-customer`, {})).status).toBe(200);
      expect(await asked()).toBe(1);
    });

    it('sends one email when two clicks arrive at once', async () => {
      const s = await setup();
      const api = await s.me.api();
      const [a, b] = await Promise.all([api.post(`${BASE}/${s.key}/contact-customer`, {}), api.post(`${BASE}/${s.key}/contact-customer`, {})]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(sendFailedEmail).toHaveBeenCalledTimes(1);
      expect(await db.timelineEvent.count({ where: { organization_id: s.org, entity_id: s.invoice, event_type: 'PAYMENT_CUSTOMER_ASKED_TO_PAY_AGAIN' } })).toBe(1);
    });

    it('only works on a failed payment', async () => {
      const s = await setup();
      const refundedPayment = await addPayment(s.invoice, { state: 'SUCCEEDED' });
      const failedRefund = await addRefund(s.org, s.invoice, refundedPayment, s.admin.id, 5, 'FAILED', ago(1));
      expect((await (await s.me.api()).post(`${BASE}/failed_refund:${failedRefund}/contact-customer`, {})).status).toBe(400);
    });
  });

  describe('items resolve themselves', () => {
    it('a later successful refund on the payment resolves the failed refund with the refunder\'s name', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const payment = await addPayment(invoice, { state: 'SUCCEEDED', paidAt: ago(30) });
      const failed = await addRefund(org, invoice, payment, admin.id, 20, 'FAILED', ago(5));
      const sam = await fx.addUser(org, 'Sam', 'ADMIN');
      await db.user.update({ where: { id: sam.id }, data: { first_name: 'Sam', last_name: 'Refunder' } });
      // a smaller later refund does not settle it; one for at least the amount does
      await addRefund(org, invoice, payment, sam.id, 5, 'SUCCEEDED', ago(4));
      const api = await (await viewer(org)).api();
      expect((await listOf(api)).items.map((i) => i.key)).toEqual([`failed_refund:${failed}`]);
      await addRefund(org, invoice, payment, sam.id, 20, 'SUCCEEDED', ago(3));
      expect((await listOf(api)).items).toEqual([]);
      const resolved = (await listOf(api, 'view=resolved')).items;
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ key: `failed_refund:${failed}`, resolved_by_name: 'Sam Refunder', resolution: { text: 'Refunded again', note: null } });
    });

    it('one later refund settles only one of two equal failed refunds', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const payment = await addPayment(invoice, { state: 'SUCCEEDED', paidAt: ago(30), amount: 200 });
      const f1 = await addRefund(org, invoice, payment, admin.id, 50, 'FAILED', ago(6));
      const f2 = await addRefund(org, invoice, payment, admin.id, 50, 'FAILED', ago(5));
      await addRefund(org, invoice, payment, admin.id, 50, 'SUCCEEDED', ago(4));
      const api = await (await viewer(org)).api();
      expect((await listOf(api)).items.map((i) => i.key)).toEqual([`failed_refund:${f1}`]);
      expect((await listOf(api, 'view=resolved')).items.map((i) => i.key)).toEqual([`failed_refund:${f2}`]);
    });

    it('a partial refund, succeeded or pending, does not hide a failed refund', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const payment = await addPayment(invoice, { state: 'SUCCEEDED', paidAt: ago(30), amount: 200 });
      const failed = await addRefund(org, invoice, payment, admin.id, 50, 'FAILED', ago(6));
      await addRefund(org, invoice, payment, admin.id, 20, 'SUCCEEDED', ago(5));
      await addRefund(org, invoice, payment, admin.id, 20, 'PENDING', ago(4));
      const api = await (await viewer(org)).api();
      expect((await listOf(api)).items.map((i) => i.key)).toEqual([`failed_refund:${failed}`]);
    });

    it('a later refund still PENDING that covers the amount resolves the failed refund, and if it then fails it shows as its own failed item', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const payment = await addPayment(invoice, { state: 'SUCCEEDED', paidAt: ago(30), amount: 200 });
      const failed = await addRefund(org, invoice, payment, admin.id, 50, 'FAILED', ago(6));
      const pending = await addRefund(org, invoice, payment, admin.id, 50, 'PENDING', ago(4));
      const api = await (await viewer(org)).api();
      expect((await listOf(api)).items).toEqual([]);
      expect((await listOf(api, 'view=resolved')).items[0]).toMatchObject({ key: `failed_refund:${failed}`, resolution: { text: 'Refunded again' } });
      await db.refund.update({ where: { id: pending }, data: { state: 'FAILED' } });
      const open = (await listOf(api)).items.map((i) => i.key).sort();
      expect(open).toEqual([`failed_refund:${failed}`, `failed_refund:${pending}`].sort());
    });

    it('a later successful refund by someone with no name on record still settles the failed refund (refunded_by is NOT NULL, so the join is a left join only for safety)', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const payment = await addPayment(invoice, { state: 'SUCCEEDED', paidAt: ago(30) });
      const failed = await addRefund(org, invoice, payment, admin.id, 20, 'FAILED', ago(5));
      const nameless = await fx.addUser(org, 'Nameless', 'ADMIN');
      await db.user.update({ where: { id: nameless.id }, data: { first_name: '', last_name: '' } });
      await addRefund(org, invoice, payment, nameless.id, 20, 'SUCCEEDED', ago(3));
      const api = await (await viewer(org)).api();
      expect((await listOf(api)).items).toEqual([]);
      expect((await listOf(api, 'view=resolved')).items[0]).toMatchObject({ key: `failed_refund:${failed}`, resolution: { text: 'Refunded again' }, resolved_by_name: null });
    });

    it('a failed bank payment stays open after a partial payment (succeeded or processing) and closes once later non-failed payments cover it, even in flight', async () => {
      const { org, customer } = await newOrg();
      const api = await (await viewer(org)).api();
      const make = async () => {
        const invoice = await invoiceIn(org, customer);
        const failed = await addPayment(invoice, { amount: 500, paidAt: ago(5) });
        return { invoice, failed };
      };
      const partial = await make();
      const processing = await make();
      const covered = await make();
      const split = await make();
      await addPayment(partial.invoice, { amount: 10, state: 'SUCCEEDED', method: 'CARD', paidAt: ago(1) });
      await addPayment(processing.invoice, { amount: 100, state: 'PROCESSING', paidAt: ago(1) });
      const inFlight = await make();
      await addPayment(inFlight.invoice, { amount: 500, state: 'PROCESSING', paidAt: ago(1) });
      await addPayment(covered.invoice, { amount: 500, state: 'SUCCEEDED', method: 'CARD', paidAt: ago(1) });
      await addPayment(split.invoice, { amount: 200, state: 'SUCCEEDED', method: 'CARD', paidAt: ago(2) });
      await addPayment(split.invoice, { amount: 300, state: 'SUCCEEDED', method: 'CARD', paidAt: ago(1) });
      const open = (await listOf(api)).items.filter((i) => i.type === 'failed_payment').map((i) => i.payment_id).sort();
      expect(open).toEqual([partial.failed, processing.failed].sort());
      const resolved = Object.fromEntries((await listOf(api, 'view=resolved')).items.map((i) => [i.payment_id, i.resolution.text]));
      expect(resolved).toMatchObject({ [covered.failed]: 'Paid again', [split.failed]: 'Paid again', [inFlight.failed]: 'Paid again' });
    });

    it('a later paid payout resolves a failed payout', async () => {
      const { org } = await newOrg();
      const failed = await addPayout(org, { createdAt: ago(5) });
      const api = await (await viewer(org)).api();
      expect((await listOf(api)).items.map((i) => i.key)).toEqual([`failed_payout:${failed}`]);
      await addPayout(org, { status: 'PENDING', createdAt: ago(3) });
      expect((await listOf(api)).items).toHaveLength(1);
      await addPayout(org, { status: 'PAID', createdAt: ago(1) });
      expect((await listOf(api)).items).toEqual([]);
      expect((await listOf(api, 'view=resolved')).items[0]).toMatchObject({ key: `failed_payout:${failed}`, resolution: { text: 'Payout sent' } });
    });

    it('a paid invoice, a voided invoice or a later payment resolves a failed payment', async () => {
      const { org, customer } = await newOrg();
      const api = await (await viewer(org)).api();
      const make = async () => {
        const invoice = await invoiceIn(org, customer);
        const failed = await addPayment(invoice, { paidAt: ago(5) });
        return { invoice, failed };
      };
      const paid = await make();
      const voided = await make();
      const again = await make();
      const pending = await make();
      expect((await listOf(api)).items).toHaveLength(4);
      await db.invoice.update({ where: { id: paid.invoice }, data: { status: 'PAID' } });
      await db.invoice.update({ where: { id: voided.invoice }, data: { status: 'VOIDED' } });
      await addPayment(again.invoice, { state: 'SUCCEEDED', method: 'CARD', paidAt: ago(1) });
      await addPayment(pending.invoice, { state: 'FAILED', paidAt: ago(1) });
      const open = (await listOf(api)).items.map((i) => i.payment_id).sort();
      expect(open).toEqual([pending.failed, ...(await db.payment.findMany({ where: { invoice_id: pending.invoice, id: { not: pending.failed } } })).map((p) => p.id)].sort());
      const resolved = Object.fromEntries((await listOf(api, 'view=resolved')).items.map((i) => [i.payment_id, i.resolution.text]));
      expect(resolved).toMatchObject({ [paid.failed]: 'Paid another way', [voided.failed]: 'Invoice voided', [again.failed]: 'Paid again' });
    });
  });

  describe('disputes', () => {
    it('lists while NEEDS_RESPONSE and withholds respond for a bank return, a past-due dispute, a restricted invoice and a caller without Refund payments', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const card = await addPayment(invoice, { method: 'CARD', state: 'SUCCEEDED' });
      const good = await addDispute(org, invoice, card);
      const bank = await addDispute(org, invoice, await addPayment(invoice, { method: 'ACH', state: 'SUCCEEDED' }), { bank: true });
      const late = await addDispute(org, invoice, await addPayment(invoice, { method: 'CARD', state: 'SUCCEEDED' }), { due: ago(1) });
      const hiddenInvoice = await invoiceIn(org, customer);
      const hidden = await addDispute(org, hiddenInvoice, await addPayment(hiddenInvoice, { method: 'CARD', state: 'SUCCEEDED' }));
      const narrowed = await personWith(org, { ...SEES_ALL, invoices_scope: 'attached', refund_payments: true });
      const job = await fx.addJob(org, customer, { crew: [narrowed.id] });
      await db.invoice.update({ where: { id: invoice }, data: { job_id: job.id } });
      const actions = async (p: { api: () => Promise<Api> }) => Object.fromEntries((await listOf(await p.api())).items.map((i) => [String(i.key).replace('dispute:', ''), i]));
      const asRefunder = await actions(await refunder(org));
      expect(asRefunder[good].actions).toEqual(['respond']);
      expect(asRefunder[bank].actions).toEqual([]);
      expect(asRefunder[late].actions).toEqual([]);
      expect(asRefunder[late].days_left).toBeLessThan(0);
      expect(asRefunder[bank].title).toBe('Bank payment returned');
      const asViewer = await actions(await viewer(org));
      expect(asViewer[good].actions).toEqual([]);
      expect(asViewer[good].status).toBe('open');
      const asNarrow = await actions(narrowed);
      expect(asNarrow[good].actions).toEqual(['respond']);
      expect(asNarrow[hidden]).toMatchObject({ restricted: true, actions: [] });
    });

    it('is resolved with "Evidence submitted" after a signed dispute update moves it to UNDER_REVIEW', async () => {
      const app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
      vi.mocked(getStripeForOrg).mockReturnValue({
        stripe: {
          checkout: { sessions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) } },
          paymentIntents: { retrieve: vi.fn().mockResolvedValue({ latest_charge: null }) },
          applicationFees: { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() },
        },
        stripeAccount: undefined,
      } as unknown as ReturnType<typeof getStripeForOrg>);
      const { org, customer, tag } = await newOrg();
      const account = `acct_pa_${tag}`;
      await db.organization.update({ where: { id: org }, data: { stripe_account_id: account, accepted_payment_methods: ['CARD'] } });
      const invoice = await invoiceIn(org, customer);
      await db.invoice.update({ where: { id: invoice }, data: { status: 'PAID', paid_at: new Date() } });
      const payment = randomUUID();
      await db.payment.create({
        data: {
          id: payment, invoice_id: invoice, amount: 100, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date(),
          stripe_payment_intent_id: `pi_pa_${tag}`, stripe_charge_id: `ch_pa_${tag}`, stripe_account_id: account, created_by_source: 'CLIENT',
        },
      });
      const dispute = (status: string) => ({
        id: `dp_pa_${tag}`, object: 'dispute', amount: 10000, currency: 'usd', status, reason: 'fraudulent', charge: `ch_pa_${tag}`, payment_intent: `pi_pa_${tag}`,
        evidence_details: { due_by: Math.floor(Date.now() / 1000) + 7 * 86400, has_evidence: false, past_due: false, submission_count: 0 },
        is_charge_refundable: false, livemode: false, metadata: {},
      });
      let seq = 0;
      const deliver = (type: string, object: object) => request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json').set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify({ id: `evt_pa_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia', type, created: Math.floor(Date.now() / 1000), account, data: { object } })));
      expect((await deliver('charge.dispute.created', dispute('needs_response'))).status).toBe(200);
      const api = await (await viewer(org)).api();
      const open = await listOf(api);
      expect(open.items.map((i) => i.type)).toEqual(['dispute']);
      expect((await deliver('charge.dispute.updated', dispute('under_review'))).status).toBe(200);
      expect((await listOf(api)).items).toEqual([]);
      const resolved = await listOf(api, 'view=resolved');
      expect(resolved.items[0]).toMatchObject({ type: 'dispute', status: 'resolved', resolution: { text: 'Evidence submitted' }, actions: [] });
      await db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pa_${tag}_%'`).catch(() => undefined);
    });
  });

  describe('what the bodies never carry', () => {
    it('names no processor and shows no processor id in an error or a body', async () => {
      const { org, customer, admin } = await newOrg();
      await db.customer.update({ where: { id: customer }, data: { email: 'delivered@resend.dev' } });
      const ids = await oneOfEach(org, customer, admin.id);
      await db.payment.update({ where: { id: ids.failedPayment }, data: { stripe_charge_id: `ch_leaktest${randomUUID().slice(0, 8)}`, stripe_account_id: `acct_leaktest${randomUUID().slice(0, 8)}` } });
      await db.payout.update({ where: { id: ids.payout }, data: { failure_code: 'something_the_processor_invented' } });
      const api = await (await owner(org)).api();
      const bodies = [
        (await api.get(`${BASE}?view=open&limit=50`)).body,
        (await api.get(`${BASE}?view=sideways`)).body,
        (await api.get(`${BASE}?view=open&limit=50&page=99`)).body,
        (await api.post(`${BASE}/failed_payment:${ids.failedPayment}/contact-customer`, {})).body,
        (await api.post(`${BASE}/failed_payment:${ids.failedPayment}/contact-customer`, {})).body,
        (await api.post(`${BASE}/dispute:${ids.dispute}/resolve`, {})).body,
        (await api.post(`${BASE}/failed_refund:${randomUUID()}/resolve`, {})).body,
        (await api.post(`${BASE}/failed_payment:${ids.failedPayment}/resolve`, { note: 'x'.repeat(20_001) })).body,
      ];
      for (const body of bodies) expect(JSON.stringify(body)).not.toMatch(/stripe|leaktest|something_the_processor|\b(pi|po|dp|ch|acct|re)_[A-Za-z0-9]{6,}/i);
    });
  });

  describe('order and paging', () => {
    it('lists newest first by the date the problem arose, with the key as tiebreak, and caps the page size and depth', async () => {
      const { org } = await newOrg();
      const sameDay = ago(2);
      const a = await addPayout(org, { createdAt: sameDay });
      const b = await addPayout(org, { createdAt: sameDay });
      const newer = await addUnapplied(org, { createdAt: ago(1), onRecord: false });
      const api = await (await viewer(org)).api();
      const ordered = (await listOf(api)).items.map((i) => i.key);
      const tied = [`failed_payout:${a}`, `failed_payout:${b}`].sort().reverse();
      expect(ordered).toEqual([`unmatched_payment:${newer}`, ...tied]);
      const two = await listOf(api, 'view=open&limit=2');
      expect(two.items).toHaveLength(2);
      expect(two.pagination).toMatchObject({ limit: 2, total: 3 });
      expect((await listOf(api, 'view=open&limit=2&page=2')).items.map((i) => i.key)).toEqual([tied[1]]);
      expect((await listOf(api, 'view=open&limit=500')).pagination.limit).toBe(50);
      const deep = await api.get(`${BASE}?view=open&limit=50&page=22`);
      expect(deep.status).toBe(400);
      expect(deep.body.error).toBe('Narrow with search or a type filter');
      expect((await api.get(`${BASE}?view=open&limit=50&page=21`)).status).toBe(200);
    });
  });
});
