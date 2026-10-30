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
import { getStripeForOrg, retrieveCapturePayerDetail } from '../lib/stripe';
import { env } from '../config/env';

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
  const SEES_ALL = { view_payments: true, view_invoices: true, jobs_scope: 'all', leads_scope: 'all' } as const;
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
  async function addDispute(org: string, invoiceId: string, paymentId: string, o: { status?: 'NEEDS_RESPONSE' | 'UNDER_REVIEW' | 'WON' | 'LOST' | 'CLOSED'; bank?: boolean; due?: Date | null; createdAt?: Date; closedAt?: Date } = {}) {
    const d = await db.dispute.create({
      data: {
        organization_id: org, invoice_id: invoiceId, payment_id: paymentId, stripe_dispute_id: `dp_test_${randomUUID().slice(0, 12)}`,
        status: o.status ?? 'NEEDS_RESPONSE', reason: 'fraudulent', amount: 100, evidence_due_by: o.due === undefined ? days(7) : o.due, is_bank_return: o.bank ?? false,
        ...(o.createdAt ? { created_at: o.createdAt } : {}),
        ...(o.closedAt ? { closed_at: o.closedAt } : {}),
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
  async function addUnapplied(org: string, o: { invoiceId?: string | null; reason?: string; status?: 'OPEN' | 'REFUNDED' | 'RESOLVED'; createdAt?: Date; amount?: number; onRecord?: boolean; sourceKey?: string; resolution?: { note: string | null; by: string; at: Date } } = {}) {
    const id = randomUUID();
    const onRecord = o.onRecord ?? true;
    await db.unappliedCapture.create({
      data: {
        id, organization_id: org, invoice_id: o.invoiceId ?? null, reason: o.reason ?? 'OVERPAYMENT', amount: o.amount ?? 25, status: o.status ?? 'OPEN',
        source_key: o.sourceKey ?? `src-${id}`, created_at: o.createdAt ?? ago(3),
        ...(o.resolution ? { resolved_at: o.resolution.at, resolved_by_name: o.resolution.by, resolution_note: o.resolution.note } : {}),
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
      const off = await personWith(org, { view_payments: false, view_invoices: true, jobs_scope: 'all', leads_scope: 'all' });
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
        title: 'Refund failed', detail: 'The bank account is closed', amount: 20, actions: ['refund_again', 'mark_resolved'], payment_id: ids.refundedPayment,
        refund_again: { invoice_id: ids.invoice, payment_id: ids.refundedPayment, amount: 20, reason_category: 'CUSTOMER_REQUEST', reason: 'Customer asked' },
      });
      expect(by.dispute).toMatchObject({ title: 'Dispute needs a response', dispute_id: ids.dispute, actions: ['respond'] });
      expect(by.dispute.detail).toBe('The cardholder says they did not make this payment');
      expect(by.dispute.respond_by).toBeTruthy();
      expect(by.dispute.days_left).toBeGreaterThanOrEqual(6);
      expect(by.failed_payout).toMatchObject({ title: 'Payout failed', detail: 'The bank account is closed', payout_id: ids.payout, actions: ['update_bank_account'] });
      expect(by.unmatched_payment).toMatchObject({ title: 'Unapplied payment', detail: 'Paid more than was owed', actions: ['attach_to_invoice', 'create_invoice', 'refund', 'mark_resolved'], amount: 25 });
      expect(by.unmatched_refund.actions).toEqual(['attach_to_invoice', 'mark_resolved']);
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
      // Contact customer needs only a readable item (V7-13): it opens the contact dialog and sends nothing itself.
      expect(body.items.filter((i) => i.type !== 'failed_payment').every((i) => Array.isArray(i.actions) && i.actions.length === 0)).toBe(true);
      expect(body.items.find((i) => i.type === 'failed_payment')!.actions).toEqual(['contact_customer']);
    });

    it('offers refund actions to Refund payments and adds Contact customer with Send payment links', async () => {
      const { org, customer, admin } = await newOrg();
      await db.customer.update({ where: { id: customer }, data: { email: 'delivered@resend.dev' } });
      await oneOfEach(org, customer, admin.id);
      const actionsOf = async (p: Awaited<ReturnType<typeof refunder>>) => Object.fromEntries((await listOf(await p.api())).items.map((i) => [i.type, i.actions]));
      expect(await actionsOf(await refunder(org))).toMatchObject({
        failed_payment: ['contact_customer', 'mark_resolved'], failed_refund: ['refund_again', 'mark_resolved'], dispute: ['respond'], failed_payout: [], unmatched_payment: ['attach_to_invoice', 'create_invoice', 'refund', 'mark_resolved'],
      });
      expect(await actionsOf(await linker(org))).toMatchObject({ failed_payment: ['contact_customer', 'mark_resolved'], failed_payout: [] });
    });

    it('still offers Contact customer when the customer has no email on file (the dialog says "No email on file")', async () => {
      const { org, customer, admin } = await newOrg();
      await oneOfEach(org, customer, admin.id);
      const row = (await listOf(await (await linker(org)).api())).items.find((i) => i.type === 'failed_payment')!;
      expect(row.actions).toEqual(['contact_customer', 'mark_resolved']);
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
      const me = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached', refund_payments: true, send_payment_links: true });
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
      expect(byKey[`failed_payment:${myPayment}`]).toMatchObject({ restricted: false, customer: { name: 'Pat Payer' }, actions: ['contact_customer', 'mark_resolved'] });
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
      const me = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached', refund_payments: true });
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
      expect(first.body).toMatchObject({ key, resolution: { text: 'Customer paid by cheque', note: 'Customer paid by cheque' } });
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
      expect(resolved.items[0]).toMatchObject({ key, status: 'resolved', actions: [], resolved_by_name: row.resolved_by_name, resolution: { text: 'Customer paid by cheque', note: 'Customer paid by cheque' } });
      expect(resolved.items[0].resolved_at).toBeTruthy();
      expect(resolved.counts).toEqual({ open: 5, resolved: 1 });
      await new Promise((r) => setTimeout(r, 100));
      const audits = await db.auditLog.findMany({ where: { org_id: org, action: 'payments.attention_resolved' } });
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toMatchObject({ item_key: key });
    });

    it('words a failed refund closed with no reason "Marked resolved" (C-43: it still stores SETTLED), never "settled"', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const api = await (await refunder(org)).api();
      const key = `failed_refund:${ids.failedRefund}`;
      expect((await api.post(`${BASE}/${key}/resolve`, {})).status).toBe(200);
      const resolved = await listOf(api, 'view=resolved');
      expect(resolved.items[0]).toMatchObject({ key, resolution: { text: 'Marked resolved', note: null } });
      expect(JSON.stringify(resolved.items[0])).not.toMatch(/settled/i);
      expect((await db.paymentAttentionResolution.findFirstOrThrow({ where: { organization_id: org, item_key: key } })).resolution).toBe('SETTLED');
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
      expect(resolved.items[0]).toMatchObject({ key, resolution: { text: 'New bank added', note: 'New bank added' } });
    });

    it('is refused for an item on an invoice the caller cannot open', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached', refund_payments: true });
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
      expect(timeline[0].description).toBe('Customer emailed a link to pay again');
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
      const narrowed = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached', refund_payments: true });
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

  describe('V7-05b: Mark resolved with a reason, titles, reason texts', () => {
    const REFUND_REASONS = ['Returned the money another way', 'Handled outside ServWave'];
    const OTHER_REASONS = ['Handled outside ServWave', 'Duplicate entry', 'Not our payment'];

    it('accepts each allowed reason for its kind, stores it plain as the note, and words the resolved item with it (no prefix)', async () => {
      const { org, customer, admin } = await newOrg();
      const api = await (await owner(org)).api();
      for (const [type, reasons] of [['failed_refund', REFUND_REASONS], ['failed_payment', OTHER_REASONS], ['failed_payout', OTHER_REASONS]] as const) {
        for (const reason of reasons) {
          const ids = await oneOfEach(org, customer, admin.id);
          const id = type === 'failed_refund' ? ids.failedRefund : type === 'failed_payment' ? ids.failedPayment : ids.payout;
          const key = `${type}:${id}`;
          const res = await api.post(`${BASE}/${key}/resolve`, { reason });
          expect(res.status, `${type} ${reason}`).toBe(200);
          expect(res.body).toMatchObject({ key, status: 'resolved', resolution: { text: reason, note: reason } });
          expect(res.body.resolution.text).not.toMatch(/^Resolved: /);
          const row = await db.paymentAttentionResolution.findFirstOrThrow({ where: { organization_id: org, item_key: key } });
          expect(row.note).toBe(reason);
          // Today's mapping stays (C-43): a failed refund writes SETTLED, the rest RESOLVED.
          expect(row.resolution).toBe(type === 'failed_refund' ? 'SETTLED' : 'RESOLVED');
        }
      }
    });

    it('answers 400 "Choose a reason." for an unknown reason or one from the other kind\'s set, and writes nothing', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const api = await (await owner(org)).api();
      const bad = [
        [`failed_payment:${ids.failedPayment}`, 'Because'], [`failed_payment:${ids.failedPayment}`, 'Returned the money another way'],
        [`failed_refund:${ids.failedRefund}`, 'Duplicate entry'], [`failed_payout:${ids.payout}`, 'Returned the money another way'],
        [`failed_payment:${ids.failedPayment}`, ''], [`failed_payment:${ids.failedPayment}`, 5],
      ] as const;
      for (const [key, reason] of bad) {
        const res = await api.post(`${BASE}/${key}/resolve`, { reason });
        expect(res.status, `${key} ${String(reason)}`).toBe(400);
        expect(res.body.error).toBe('Choose a reason.');
      }
      expect(await db.paymentAttentionResolution.count({ where: { organization_id: org } })).toBe(0);
    });

    it('still accepts a missing reason and the old free-text note; the reason wins when both arrive', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const api = await (await owner(org)).api();
      expect((await api.post(`${BASE}/failed_refund:${ids.failedRefund}/resolve`, {})).status).toBe(200);
      const old = await api.post(`${BASE}/failed_payment:${ids.failedPayment}/resolve`, { note: 'Customer paid by cheque' });
      expect(old.status).toBe(200);
      expect(old.body.resolution.note).toBe('Customer paid by cheque');
      const both = await api.post(`${BASE}/failed_payout:${ids.payout}/resolve`, { reason: 'Duplicate entry', note: 'ignored' });
      expect(both.body.resolution).toEqual({ text: 'Duplicate entry', note: 'Duplicate entry' });
    });

    it('titles unapplied money "Unapplied payment" and "Unapplied refund", and the failed-refund action list says mark_resolved', async () => {
      const { org, customer, admin } = await newOrg();
      await oneOfEach(org, customer, admin.id);
      const body = await listOf(await (await owner(org)).api());
      const by = Object.fromEntries(body.items.map((i) => [i.type, i]));
      expect(by.unmatched_payment.title).toBe('Unapplied payment');
      expect(by.unmatched_refund.title).toBe('Unapplied refund');
      expect(by.failed_refund.actions).toEqual(['refund_again', 'mark_resolved']);
      expect(JSON.stringify(body)).not.toMatch(/mark_settled|not on an invoice|settled/i);
    });

    it('words every unapplied reason with the 7.15 short text, and tells paid twice from already paid', async () => {
      const { org, customer } = await newOrg();
      const open = await invoiceIn(org, customer);
      const paid = await invoiceIn(org, customer);
      await db.invoice.update({ where: { id: paid }, data: { status: 'PAID' } });
      const paidTwice = await invoiceIn(org, customer);
      await db.invoice.update({ where: { id: paidTwice }, data: { status: 'PAID' } });
      const voided = await invoiceIn(org, customer);
      await db.invoice.update({ where: { id: voided }, data: { status: 'VOIDED' } });
      // A succeeded payment of the same amount sits on `paidTwice`; `paid` has none.
      await addPayment(paidTwice, { state: 'SUCCEEDED', amount: 25, method: 'CARD' });
      const cases: Array<[string, Parameters<typeof addUnapplied>[1], string]> = [
        ['AMOUNT_MISMATCH', { invoiceId: open }, 'Amount did not match the invoice'],
        ['DEPOSIT_SUPERSEDED', { invoiceId: open }, 'Deposit no longer fits the estimate'],
        ['DEPOSIT_ON_HOLD', { invoiceId: open }, 'Deposit was on hold when it was paid'],
        ['INVOICE_NOT_PAYABLE', { invoiceId: paidTwice }, 'Invoice paid twice'],
        ['INVOICE_NOT_PAYABLE', { invoiceId: paid }, 'Invoice was already paid'],
        ['INVOICE_NOT_PAYABLE', { invoiceId: voided }, 'Invoice was voided'],
        ['INVOICE_NOT_PAYABLE', { invoiceId: open }, 'Paid while the invoice was not open for payment'],
        ['REFUND_UNMATCHED', {}, 'Refund has no invoice reference'],
        ['OVERPAYMENT', { invoiceId: open }, 'Paid more than was owed'],
        ['INVOICE_NOT_FOUND', {}, 'Payment is not tied to an invoice'],
        ['WRONG_ORG', {}, 'Payment is not tied to an invoice'],
        ['DOCUMENT_MISMATCH', { invoiceId: open }, 'Paid for a different document than the invoice'],
        ['SOMETHING_NEW', {}, 'Could not be applied to an invoice'],
      ];
      const made: Array<{ id: string; short: string }> = [];
      for (const [reason, opts, short] of cases) made.push({ id: await addUnapplied(org, { reason, amount: 25, ...opts }), short });
      const body = await listOf(await (await owner(org)).api());
      const detailOf = (id: string) => body.items.find((i) => i.key.endsWith(`:${id}`))!.detail;
      for (const { id, short } of made) expect(detailOf(id), short).toBe(short);
      expect(JSON.stringify(body)).not.toMatch(/stripe|pi_test|acct_test/i);
    });

    it('does not count the capture\'s own payment row as the twin of a paid invoice', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      await db.invoice.update({ where: { id: invoice }, data: { status: 'PAID' } });
      // The debit was booked: the capture's source key names this very payment, and it is the only one of that amount.
      const own = await addPayment(invoice, { state: 'SUCCEEDED', amount: 25, method: 'CARD' });
      const capture = await addUnapplied(org, { reason: 'INVOICE_NOT_PAYABLE', invoiceId: invoice, amount: 25, sourceKey: `payment:${own}` });
      const api = await (await owner(org)).api();
      const detail = async () => (await listOf(api)).items.find((i) => i.key.endsWith(`:${capture}`))!.detail;
      expect(await detail()).toBe('Invoice was already paid');
      // A genuine earlier payment of the same amount makes it "twice".
      await addPayment(invoice, { state: 'SUCCEEDED', amount: 25, method: 'CARD' });
      expect(await detail()).toBe('Invoice paid twice');
    });

    it('does not count a voided payment of the same amount as the twin', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      await db.invoice.update({ where: { id: invoice }, data: { status: 'PAID' } });
      const twin = await addPayment(invoice, { state: 'SUCCEEDED', amount: 25, method: 'CARD', voidedAt: ago(1) });
      const capture = await addUnapplied(org, { reason: 'INVOICE_NOT_PAYABLE', invoiceId: invoice, amount: 25 });
      const api = await (await owner(org)).api();
      const detail = async () => (await listOf(api)).items.find((i) => i.key.endsWith(`:${capture}`))!.detail;
      expect(await detail()).toBe('Invoice was already paid');
      await db.payment.update({ where: { id: twin }, data: { voided_at: null } });
      expect(await detail()).toBe('Invoice paid twice');
    });

    it('shows an unapplied item closed by a person with their name, date and plain reason; old rows fall back to "Marked resolved"', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const at = new Date('2026-10-12T15:30:00Z');
      const closed = await addUnapplied(org, { invoiceId: invoice, status: 'RESOLVED', resolution: { note: 'Duplicate entry', by: 'Pat Admin', at } });
      const old = await addUnapplied(org, { invoiceId: invoice, status: 'RESOLVED', createdAt: ago(9) });
      const items = (await listOf(await (await owner(org)).api(), 'view=resolved')).items;
      const mine = items.find((i) => i.key.endsWith(`:${closed}`))!;
      expect(mine).toMatchObject({ resolved_by_name: 'Pat Admin', resolved_at: at.toISOString(), resolution: { text: 'Duplicate entry', note: 'Duplicate entry' } });
      const theirs = items.find((i) => i.key.endsWith(`:${old}`))!;
      expect(theirs).toMatchObject({ resolved_by_name: null, resolution: { text: 'Marked resolved', note: null } });
      expect(theirs.resolved_at).toBeTruthy();
    });
  });

  describe('V7-05a: codes, customer number, dispute status, read by key', () => {
    const code = (prefix: string, id: string) => `${prefix}${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

    it('carries the customer number, the short codes and the dispute status, and never a processor id', async () => {
      const { org, customer, admin, tag } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const body = await listOf(await (await owner(org)).api());
      const by = Object.fromEntries(body.items.map((i) => [i.type, i]));
      for (const item of body.items) {
        if (item.customer) expect(item.customer.customer_number, item.type).toBe(`C-${tag}`);
      }
      expect(by.failed_payment).toMatchObject({ payment_reference: code('PMT-', ids.failedPayment), dispute_reference: null, reference: null, dispute_status: null });
      expect(by.failed_refund.payment_reference).toBe(code('PMT-', ids.refundedPayment));
      expect(by.dispute).toMatchObject({
        payment_reference: code('PMT-', ids.cardPayment), dispute_reference: code('DSP-', ids.dispute), dispute_status: 'NEEDS_RESPONSE', reference: null,
      });
      expect(by.unmatched_payment).toMatchObject({ reference: code('RCV-', ids.unmatched), payment_reference: null, dispute_reference: null });
      expect(by.unmatched_refund).toMatchObject({ reference: code('REF-', ids.unmatchedRefund) });
      expect(by.failed_payout).toMatchObject({ reference: null, payment_reference: null });
      expect(JSON.stringify(body)).not.toMatch(/stripe|pi_test|po_test|dp_test|acct_test/i);
    });

    it('reports each dispute status in its own words', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const statuses = ['UNDER_REVIEW', 'WON', 'LOST', 'CLOSED'] as const;
      for (const [n, status] of statuses.entries()) {
        const card = await addPayment(invoice, { method: 'CARD', state: 'SUCCEEDED', paidAt: ago(30 + n) });
        await addDispute(org, invoice, card, { status, createdAt: ago(3 + n) });
      }
      const api = await (await owner(org)).api();
      const all = [...(await listOf(api, 'view=open')).items, ...(await listOf(api, 'view=resolved')).items].filter((i) => i.type === 'dispute');
      expect(all.map((i) => i.dispute_status).sort()).toEqual([...statuses].sort());
    });

    it('gives a restricted item no codes, no customer number and no dispute status', async () => {
      const { org, customer } = await newOrg();
      const secret = randomUUID();
      await db.customer.create({ data: { id: secret, organization_id: org, customer_number: `C-${secret.slice(0, 8)}`, kind: 'COMPANY', segment: 'COMMERCIAL', company_name: 'Hidden Holdings' } });
      const me = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached', refund_payments: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      await invoiceIn(org, customer, { jobId: job.id });
      const theirs = await invoiceIn(org, secret);
      const theirPayment = await addPayment(theirs, { paidAt: ago(1) });
      const theirCard = await addPayment(theirs, { method: 'CARD', state: 'SUCCEEDED', paidAt: ago(30) });
      await addDispute(org, theirs, theirCard, { createdAt: ago(4) });
      await addUnapplied(org, { invoiceId: theirs, createdAt: ago(5) });
      const body = await listOf(await me.api());
      const restricted = body.items.filter((i) => i.restricted);
      expect(restricted.length).toBe(3);
      for (const i of restricted) {
        expect(i).toMatchObject({ payment_reference: null, dispute_reference: null, reference: null, dispute_status: null, customer: null });
      }
      expect(JSON.stringify(body)).not.toContain(code('PMT-', theirPayment));
    });

    it('reads one failed item by key in the list-row shape, for each failed kind', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const api = await (await owner(org)).api();
      const list = (await listOf(api)).items;
      for (const key of [`failed_payment:${ids.failedPayment}`, `failed_refund:${ids.failedRefund}`, `failed_payout:${ids.payout}`]) {
        const res = await api.get(`${BASE}/${key}`);
        expect(res.status, key).toBe(200);
        expect(res.body, key).toEqual(list.find((i) => i.key === key));
      }
    });

    it('reads a resolved failed item too', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const api = await (await owner(org)).api();
      expect((await api.post(`${BASE}/failed_payment:${ids.failedPayment}/resolve`, { note: 'Paid by cheque' })).status).toBe(200);
      const res = await api.get(`${BASE}/failed_payment:${ids.failedPayment}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'resolved', actions: [] });
    });

    it('lets a view-only caller read it, with only the actions they hold (none)', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const res = await (await (await viewer(org)).api()).get(`${BASE}/failed_refund:${ids.failedRefund}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ key: `failed_refund:${ids.failedRefund}`, actions: [] });
    });

    it('refuses a caller without View payments', async () => {
      const { org, customer, admin } = await newOrg();
      const ids = await oneOfEach(org, customer, admin.id);
      const off = await personWith(org, { view_payments: false, view_invoices: true, jobs_scope: 'all', leads_scope: 'all' });
      expect((await (await off.api()).get(`${BASE}/failed_payment:${ids.failedPayment}`)).status).toBe(403);
    });

    it('answers 404 for another company\'s key, an unknown key, a malformed key and a kind it does not open', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const theirs = await oneOfEach(b.org, b.customer, b.admin.id);
      const mine = await oneOfEach(a.org, a.customer, a.admin.id);
      // The same keys are real items for their own company, so the 404 below is tenancy, not a missing route.
      const theirApi = await (await owner(b.org)).api();
      for (const key of [`failed_payment:${theirs.failedPayment}`, `failed_refund:${theirs.failedRefund}`, `failed_payout:${theirs.payout}`, `unmatched_payment:${theirs.unmatched}`]) {
        expect((await theirApi.get(`${BASE}/${key}`)).status, key).toBe(200);
      }
      const api = await (await owner(a.org)).api();
      for (const key of [
        `failed_payment:${theirs.failedPayment}`, `failed_refund:${theirs.failedRefund}`, `failed_payout:${theirs.payout}`,
        `unmatched_payment:${theirs.unmatched}`, `failed_payment:${randomUUID()}`, 'failed_payment:not-an-id', 'nonsense', `dispute:${mine.dispute}`,
      ]) {
        expect((await api.get(`${BASE}/${key}`)).status, key).toBe(404);
      }
    });

    it('returns a restricted item restricted, exactly as the list does', async () => {
      const { org, customer, admin } = await newOrg();
      const secret = randomUUID();
      await db.customer.create({ data: { id: secret, organization_id: org, customer_number: `C-${secret.slice(0, 8)}`, kind: 'COMPANY', segment: 'COMMERCIAL', company_name: 'Hidden Holdings' } });
      const me = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached', refund_payments: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      await invoiceIn(org, customer, { jobId: job.id });
      const theirs = await invoiceIn(org, secret);
      const theirSettled = await addPayment(theirs, { state: 'SUCCEEDED', paidAt: ago(40) });
      const theirRefund = await addRefund(org, theirs, theirSettled, admin.id, 5, 'FAILED', ago(3));
      const res = await (await me.api()).get(`${BASE}/failed_refund:${theirRefund}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ restricted: true, customer: null, invoice: null, payment_id: null, payment_reference: null, actions: [], refund_again: null, detail: '' });
      expect(JSON.stringify(res.body)).not.toContain('Hidden Holdings');
    });
  });
  describe('V7-09a: unapplied item detail, payer read, suggested invoices, search, actions', () => {
    const DETAIL = '/api/payments-needing-attention';
    const code = (prefix: string, id: string) => `${prefix}${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    const payerRead = retrieveCapturePayerDetail as unknown as ReturnType<typeof vi.fn>;
    const CARD_READ = { method: 'card', brand: 'visa', last4: '4242', bank_name: null, description: 'Deck repair deposit' };
    beforeEach(() => {
      payerRead.mockReset().mockResolvedValue(null);
    });

    /** An office person: sees every invoice, may refund, create invoices (also standalone) and see the Invoices page. */
    const officer = (org: string, extra: Record<string, boolean | string | string[]> = {}) =>
      personWith(org, { ...SEES_ALL, refund_payments: true, edit_invoices: true, create_invoices: true, standalone_invoices: true, ...extra }, 'officer');

    /** An invoice of the customer with a chosen total, amount due, status, due date and kind. */
    async function invoiceOf(org: string, customer: string, o: {
      total?: number; due?: number; status?: 'DRAFT' | 'SENT' | 'PARTIAL' | 'PAID' | 'VOIDED'; kind?: 'STANDARD' | 'DEPOSIT'; dueDate?: Date | null; jobId?: string; jobType?: string;
    } = {}) {
      const id = await invoiceIn(org, customer, o.jobId ? { jobId: o.jobId } : {});
      await db.invoice.update({
        where: { id },
        data: {
          total_amount: o.total ?? 100, subtotal: o.total ?? 100, amount_due: o.due ?? o.total ?? 100, status: o.status ?? 'SENT', kind: o.kind ?? 'STANDARD',
          due_date: o.dueDate === undefined ? new Date('2026-10-20T12:00:00Z') : o.dueDate,
        },
      });
      return id;
    }
    const numberOf = async (id: string) => (await db.invoice.findUniqueOrThrow({ where: { id }, select: { invoice_number: true } })).invoice_number;
    const get = async (api: Api, id: string) => api.get(`${DETAIL}/${id}`);

    it('opens one unapplied payment per reason with the 7.15 words, the meant-for invoice and the customer block, and never a processor id', async () => {
      const { org, customer, tag } = await newOrg();
      const api = await (await officer(org)).api();
      const open = await invoiceOf(org, customer, { total: 600, status: 'SENT' });
      const paid = await invoiceOf(org, customer, { total: 80, due: 0, status: 'PAID' });
      const twice = await invoiceOf(org, customer, { total: 25, due: 0, status: 'PAID' });
      const voided = await invoiceOf(org, customer, { total: 80, status: 'VOIDED' });
      await addPayment(twice, { state: 'SUCCEEDED', amount: 25, method: 'CARD' });
      const cases: Array<{ reason: string; invoice?: string; short: string; long: (n: string) => string; hasInvoice: boolean; amount?: number }> = [
        { reason: 'AMOUNT_MISMATCH', invoice: open, short: 'Amount did not match the invoice', long: () => '$25.00 was paid against an invoice of $600.00.', hasInvoice: true },
        { reason: 'DEPOSIT_SUPERSEDED', invoice: open, short: 'Deposit no longer fits the estimate', long: () => 'The estimate changed after the deposit was requested, so this deposit no longer fits it.', hasInvoice: true },
        { reason: 'DEPOSIT_ON_HOLD', invoice: open, short: 'Deposit was on hold when it was paid', long: () => 'Deposit was on hold when it was paid.', hasInvoice: true },
        { reason: 'INVOICE_NOT_PAYABLE', invoice: twice, short: 'Invoice paid twice', long: (n) => `${n} was paid twice. It was already paid in full, and this is the second payment.`, hasInvoice: true },
        { reason: 'INVOICE_NOT_PAYABLE', invoice: paid, short: 'Invoice was already paid', long: (n) => `${n} was already paid in full, by another payment, when this one arrived.`, hasInvoice: true },
        { reason: 'INVOICE_NOT_PAYABLE', invoice: voided, short: 'Invoice was voided', long: (n) => `${n} was voided before this payment arrived.`, hasInvoice: true },
        { reason: 'INVOICE_NOT_PAYABLE', invoice: open, short: 'Paid while the invoice was not open for payment', long: () => 'Paid while the invoice was not open for payment.', hasInvoice: true },
        { reason: 'OVERPAYMENT', invoice: open, short: 'Paid more than was owed', long: () => 'Paid more than was owed.', hasInvoice: true },
        { reason: 'DOCUMENT_MISMATCH', invoice: open, short: 'Paid for a different document than the invoice', long: () => 'Paid for a different document than the invoice.', hasInvoice: true },
        { reason: 'INVOICE_NOT_FOUND', short: 'Payment is not tied to an invoice', long: () => 'Payment is not tied to an invoice.', hasInvoice: false },
        { reason: 'WRONG_ORG', short: 'Payment is not tied to an invoice', long: () => 'Payment is not tied to an invoice.', hasInvoice: false },
      ];
      for (const c of cases) {
        const id = await addUnapplied(org, { reason: c.reason, invoiceId: c.invoice ?? null, amount: 25, createdAt: new Date('2026-10-14T14:08:00Z') });
        const res = await get(api, id);
        expect(res.status, `${c.reason} ${c.short}`).toBe(200);
        const invoiceNumber = c.invoice ? await numberOf(c.invoice) : '';
        expect(res.body, c.short).toMatchObject({
          id, kind: 'PAYMENT', status: 'open', amount: 25, reference: code('RCV-', id), created_at: '2026-10-14T14:08:00.000Z',
          reason_short: c.short, reason_long: c.long(invoiceNumber),
        });
        if (c.hasInvoice) {
          const row = await db.invoice.findUniqueOrThrow({ where: { id: c.invoice! }, select: { status: true, total_amount: true } });
          expect(res.body.meant_for, c.short).toEqual({ invoice: { id: c.invoice, number: invoiceNumber, status: row.status, total: Number(row.total_amount) } });
          expect(res.body.customer_block, c.short).toMatchObject({ restricted: false, name: 'Pat Payer', customer_number: `C-${tag}`, invoice: { id: c.invoice, number: invoiceNumber } });
        } else {
          expect(res.body.meant_for, c.short).toEqual({ invoice: null });
          expect(res.body.customer_block, c.short).toBeNull();
        }
        expect(JSON.stringify(res.body), c.short).not.toMatch(/stripe|pi_test|acct_test|src-/i);
      }
    });

    it('opens an unapplied refund with and without an invoice: REF- reference, kind REFUND, no suggestions', async () => {
      const { org, customer } = await newOrg();
      const api = await (await officer(org)).api();
      const invoice = await invoiceOf(org, customer, { total: 90 });
      const withInvoice = await addUnapplied(org, { reason: 'REFUND_UNMATCHED', invoiceId: invoice, amount: 30 });
      const without = await addUnapplied(org, { reason: 'REFUND_UNMATCHED', amount: 30 });
      const a = await get(api, withInvoice);
      expect(a.body).toMatchObject({
        kind: 'REFUND', reference: code('REF-', withInvoice), reason_short: 'Refund has no invoice reference',
        reason_long: `The refund was sent without an invoice reference, so ${await numberOf(invoice)} does not show it.`, suggested_invoices: [],
      });
      expect(a.body.meant_for.invoice).toMatchObject({ id: invoice, total: 90 });
      const b = await get(api, without);
      expect(b.body).toMatchObject({ kind: 'REFUND', reason_long: 'The refund was sent without an invoice reference.', meant_for: { invoice: null }, customer_block: null, suggested_invoices: [] });
    });

    it('answers the same body through the attention key, and 404 for a wrong kind in the key', async () => {
      const { org, customer } = await newOrg();
      const api = await (await officer(org)).api();
      const invoice = await invoiceOf(org, customer);
      const payment = await addUnapplied(org, { reason: 'AMOUNT_MISMATCH', invoiceId: invoice, amount: 40 });
      const refund = await addUnapplied(org, { reason: 'REFUND_UNMATCHED', amount: 12 });
      const direct = await get(api, payment);
      const byKey = await api.get(`${BASE}/unmatched_payment:${payment}`);
      expect(byKey.status).toBe(200);
      expect(byKey.body).toEqual(direct.body);
      expect((await api.get(`${BASE}/unmatched_refund:${refund}`)).body).toEqual((await get(api, refund)).body);
      // A refund id under the payment kind (and the reverse) is not an item of that kind.
      expect((await api.get(`${BASE}/unmatched_payment:${refund}`)).status).toBe(404);
      expect((await api.get(`${BASE}/unmatched_refund:${payment}`)).status).toBe(404);
    });

    it('reads who and when for a resolved item, and gives it no actions or suggestions', async () => {
      const { org, customer } = await newOrg();
      const api = await (await officer(org)).api();
      const invoice = await invoiceOf(org, customer, { total: 50 });
      const at = new Date('2026-10-12T15:30:00Z');
      const id = await addUnapplied(org, { invoiceId: invoice, status: 'RESOLVED', amount: 50, resolution: { note: 'Duplicate entry', by: 'Pat Admin', at } });
      const res = await get(api, id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'resolved', resolved_at: at.toISOString(), resolved_by_name: 'Pat Admin', resolution: { text: 'Duplicate entry', note: 'Duplicate entry' }, actions: [], suggested_invoices: [],
      });
    });

    it('reads the payer from the processor on demand, pinned to the row\'s account, and adds only words to the answer', async () => {
      const { org, customer } = await newOrg();
      const api = await (await officer(org)).api();
      const invoice = await invoiceOf(org, customer, { total: 60 });
      const id = await addUnapplied(org, { invoiceId: invoice, reason: 'AMOUNT_MISMATCH', amount: 25, createdAt: new Date('2026-10-14T14:08:00Z') });
      payerRead.mockResolvedValue(CARD_READ);
      const res = await get(api, id);
      expect(res.body.payer).toEqual({
        method_label: 'Card', detail: 'Visa •••• 4242', description: 'Deck repair deposit', received_at: '2026-10-14T14:08:00.000Z', reference: code('RCV-', id),
      });
      const row = await db.unappliedCapture.findUniqueOrThrow({ where: { id } });
      expect(payerRead).toHaveBeenCalledTimes(1);
      expect(payerRead).toHaveBeenCalledWith(row.stripe_account_id, row.stripe_payment_intent_id);
      // Nothing stored, nothing leaked: reading it again leaves the row exactly as it was, and the body has no processor id.
      await get(api, id);
      expect(await db.unappliedCapture.findUniqueOrThrow({ where: { id } })).toEqual(row);
      expect(JSON.stringify(res.body)).not.toMatch(/stripe|pi_test|acct_test/i);
    });

    it('makes no payer read for a resolved item', async () => {
      const { org, customer } = await newOrg();
      const api = await (await officer(org)).api();
      const id = await addUnapplied(org, { invoiceId: await invoiceOf(org, customer), status: 'RESOLVED', amount: 25, createdAt: new Date('2026-10-14T14:08:00Z') });
      payerRead.mockResolvedValue(CARD_READ);
      const res = await get(api, id);
      expect(payerRead).not.toHaveBeenCalled();
      expect(res.body.payer).toEqual({ received_at: '2026-10-14T14:08:00.000Z', reference: code('RCV-', id) });
    });

    it('words a bank payer from the bank name and last four', async () => {
      const { org, customer } = await newOrg();
      const api = await (await officer(org)).api();
      const id = await addUnapplied(org, { invoiceId: await invoiceOf(org, customer), amount: 25 });
      payerRead.mockResolvedValue({ method: 'bank', brand: null, last4: '6789', bank_name: 'First Test Bank', description: null });
      expect((await get(api, id)).body.payer).toMatchObject({ method_label: 'Bank', detail: 'First Test Bank •••• 6789' });
    });

    it('leaves the payer with only the received time and reference when the read is empty, fails, or the row holds no intent or account', async () => {
      const { org, customer } = await newOrg();
      const api = await (await officer(org)).api();
      const at = new Date('2026-10-14T14:08:00Z');
      const noRead = await addUnapplied(org, { invoiceId: await invoiceOf(org, customer), amount: 25, createdAt: at });
      const noIds = await addUnapplied(org, { invoiceId: await invoiceOf(org, customer), amount: 25, createdAt: at, onRecord: false });
      for (const [id, why] of [[noRead, 'read returns nothing'], [noIds, 'no ids on the row']] as const) {
        const res = await get(api, id);
        expect(res.status, why).toBe(200);
        expect(res.body.payer, why).toEqual({ received_at: at.toISOString(), reference: code('RCV-', id) });
      }
      expect(payerRead).toHaveBeenCalledTimes(1);
      // A read that THROWS (it should not) still never fails the drawer.
      payerRead.mockRejectedValue(new Error('No such payment_intent: pi_secret'));
      const res = await get(api, noRead);
      expect(res.status).toBe(200);
      expect(res.body.payer).toEqual({ received_at: at.toISOString(), reference: code('RCV-', noRead) });
      expect(JSON.stringify(res.body)).not.toMatch(/pi_secret|No such/);
    });

    it('lets a View-payments-only caller read the detail and the invoice search, with no actions', async () => {
      const { org, customer } = await newOrg();
      const invoice = await invoiceOf(org, customer, { total: 25 });
      const id = await addUnapplied(org, { invoiceId: invoice, amount: 25 });
      const api = await (await viewer(org)).api();
      const res = await get(api, id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ actions: [], meant_for: { invoice: { id: invoice } } });
      expect(res.body.suggested_invoices.length).toBeGreaterThan(0);
      expect((await api.get(`${DETAIL}/${id}/invoices?q=`)).status).toBe(200);
      // The doors still need their own switch.
      expect((await api.post(`${DETAIL}/${id}/resolve`, { reason: 'Duplicate entry' })).status).toBe(403);
      expect((await api.post(`${DETAIL}/${id}/refund`, {})).status).toBe(403);
    });

    it('refuses a caller without View payments, on the detail and on the search', async () => {
      const { org, customer } = await newOrg();
      const id = await addUnapplied(org, { invoiceId: await invoiceOf(org, customer), amount: 25 });
      const off = await personWith(org, { view_payments: false, view_invoices: true, jobs_scope: 'all', leads_scope: 'all' }, 'noview');
      const api = await off.api();
      expect((await get(api, id)).status).toBe(403);
      expect((await api.get(`${DETAIL}/${id}/invoices?q=`)).status).toBe(403);
    });

    it('answers 404 for another company\'s item and a malformed id, on the detail and on the search', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const theirs = await addUnapplied(b.org, { invoiceId: await invoiceOf(b.org, b.customer), amount: 25 });
      const mine = await addUnapplied(a.org, { invoiceId: await invoiceOf(a.org, a.customer), amount: 25 });
      const theirApi = await (await officer(b.org)).api();
      expect((await get(theirApi, theirs)).status).toBe(200);
      const api = await (await officer(a.org)).api();
      for (const id of [theirs, randomUUID(), 'not-an-id']) {
        expect((await get(api, id)).status, id).toBe(404);
        expect((await api.get(`${DETAIL}/${id}/invoices?q=`)).status, id).toBe(404);
      }
      expect((await get(api, mine)).status).toBe(200);
    });

    it('returns an item on an invoice the caller cannot open restricted: no names, no payer read, no suggestions, no actions', async () => {
      const { org, customer } = await newOrg();
      const secret = randomUUID();
      await db.customer.create({ data: { id: secret, organization_id: org, customer_number: `C-${secret.slice(0, 8)}`, kind: 'COMPANY', segment: 'COMMERCIAL', company_name: 'Hidden Holdings' } });
      const me = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached', refund_payments: true, edit_invoices: true, create_invoices: true, standalone_invoices: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      await invoiceOf(org, customer, { jobId: job.id, total: 25 });
      const theirs = await invoiceOf(org, secret, { total: 25 });
      const id = await addUnapplied(org, { invoiceId: theirs, reason: 'INVOICE_NOT_PAYABLE', amount: 25 });
      payerRead.mockResolvedValue(CARD_READ);
      const api = await me.api();
      const res = await get(api, id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        restricted: true, customer_block: { customer: null, restricted: true }, meant_for: { invoice: null }, payer: null, suggested_invoices: [], actions: [], reference: null,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/Hidden Holdings|INV-/);
      expect(payerRead).not.toHaveBeenCalled();
      expect((await api.get(`${DETAIL}/${id}/invoices?q=`)).status).toBe(403);
    });

    it('hides an item with no invoice from a caller whose invoice scope is narrowed, as the list does', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached', refund_payments: true });
      const id = await addUnapplied(org, { reason: 'WRONG_ORG', amount: 25 });
      expect((await get(await me.api(), id)).status).toBe(404);
    });

    describe('suggested invoices', () => {
      it('lists the meant-for invoice first, then the open invoices that owe exactly the payment, and disables a meant-for invoice that owes less', async () => {
        const { org, customer } = await newOrg();
        const api = await (await officer(org)).api();
        const meant = await invoiceOf(org, customer, { total: 600, due: 25, status: 'PARTIAL' });
        const same1 = await invoiceOf(org, customer, { total: 25, due: 25, status: 'SENT', dueDate: new Date('2026-10-22T12:00:00Z') });
        const same2 = await invoiceOf(org, customer, { total: 40, due: 25, status: 'PARTIAL', dueDate: new Date('2026-10-21T12:00:00Z') });
        await invoiceOf(org, customer, { total: 80, due: 80, status: 'SENT' });
        const id = await addUnapplied(org, { invoiceId: meant, reason: 'AMOUNT_MISMATCH', amount: 25 });
        const rows = (await get(api, id)).body.suggested_invoices as Item[];
        expect(rows.map((r) => r.id)).toEqual([meant, same2, same1]);
        expect(rows[0]).toMatchObject({ id: meant, number: await numberOf(meant), customer: 'Pat Payer', amount: 600, balance: 25, meant: true, can_attach: true });
        expect(rows[1]).toMatchObject({ meant: false, can_attach: true, balance: 25, amount: 40 });
        expect(typeof rows[1].due_date).toBe('string');
        // A later payment lowers the meant-for balance below the money: shown, but it cannot take it.
        await db.invoice.update({ where: { id: meant }, data: { amount_due: 10 } });
        const after = (await get(api, id)).body.suggested_invoices as Item[];
        expect(after[0]).toMatchObject({ id: meant, meant: true, can_attach: false, balance: 10 });
        expect(after.slice(1).every((r) => r.can_attach)).toBe(true);
      });

      // Spec 7.16 + the booking rule (bookCaptureOnInvoice): what is payable now is the balance less a bank debit still clearing.
      // The dialog says what the invoice will show afterwards from `balance`; that must stay the real amount due.
      it('a clearing debit that still leaves room: balance stays the amount due (220), payable_now is the room (120), can_attach true', async () => {
        const { org, customer } = await newOrg();
        const api = await (await officer(org)).api();
        const meant = await invoiceOf(org, customer, { total: 220, due: 220 });
        await addPayment(meant, { state: 'PROCESSING', amount: 100, method: 'ACH' });
        const id = await addUnapplied(org, { invoiceId: meant, reason: 'AMOUNT_MISMATCH', amount: 120 });
        const row = ((await get(api, id)).body.suggested_invoices as Item[])[0];
        expect(row).toMatchObject({ id: meant, balance: 220, payable_now: 120, can_attach: true });
      });

      it('an invoice whose clearing bank debit leaves less room than the payment reads can_attach false and a lower payable_now (balance stays the amount due), in the suggestions and the search', async () => {
        const { org, customer } = await newOrg();
        const api = await (await officer(org)).api();
        const meant = await invoiceOf(org, customer, { total: 150, due: 150 });
        const clearing = await invoiceOf(org, customer, { total: 120, due: 120 });
        const roomy = await invoiceOf(org, customer, { total: 120, due: 120 });
        await addPayment(meant, { state: 'PROCESSING', amount: 100, method: 'ACH' });
        await addPayment(clearing, { state: 'PROCESSING', amount: 100, method: 'ACH' });
        const id = await addUnapplied(org, { invoiceId: meant, reason: 'AMOUNT_MISMATCH', amount: 120 });
        const suggested = (await get(api, id)).body.suggested_invoices as Item[];
        expect(suggested.find((r) => r.id === meant)).toMatchObject({ meant: true, can_attach: false, balance: 150, payable_now: 50 });
        expect(suggested.find((r) => r.id === clearing)).toMatchObject({ can_attach: false, balance: 120, payable_now: 20 });
        expect(suggested.find((r) => r.id === roomy)).toMatchObject({ can_attach: true, balance: 120, payable_now: 120 });
        const found = (await api.get(`${DETAIL}/${id}/invoices?q=`)).body.items as Item[];
        expect(found.find((r) => r.id === meant)).toMatchObject({ can_attach: false, balance: 150, payable_now: 50 });
        expect(found.find((r) => r.id === clearing)).toMatchObject({ can_attach: false, balance: 120, payable_now: 20, same_amount: true });
        expect(found.find((r) => r.id === roomy)).toMatchObject({ can_attach: true, balance: 120, payable_now: 120, same_amount: true });
      });

      it('leaves out deposit invoices, voided and paid ones, another company\'s, and invoices the caller cannot open; caps the list at 10', async () => {
        const { org, customer } = await newOrg();
        const other = await newOrg();
        const secret = randomUUID();
        await db.customer.create({ data: { id: secret, organization_id: org, customer_number: `C-${secret.slice(0, 8)}`, kind: 'COMPANY', segment: 'COMMERCIAL', company_name: 'Hidden Holdings' } });
        const me = await officer(org, { jobs_scope: 'attached', leads_scope: 'attached' });
        const job = await fx.addJob(org, customer, { crew: [me.id] });
        const ok = await invoiceOf(org, customer, { jobId: job.id, total: 25 });
        const deposit = await invoiceOf(org, customer, { jobId: job.id, total: 25, kind: 'DEPOSIT' });
        const voided = await invoiceOf(org, customer, { jobId: job.id, total: 25, status: 'VOIDED' });
        const paid = await invoiceOf(org, customer, { jobId: job.id, total: 25, due: 0, status: 'PAID' });
        const hidden = await invoiceOf(org, secret, { total: 25 });
        const foreign = await invoiceOf(other.org, other.customer, { total: 25 });
        const id = await addUnapplied(org, { reason: 'AMOUNT_MISMATCH', invoiceId: ok, amount: 25 });
        const ids = ((await get(await me.api(), id)).body.suggested_invoices as Item[]).map((r) => r.id);
        expect(ids).toEqual([ok]);
        for (const bad of [deposit, voided, paid, hidden, foreign]) expect(ids).not.toContain(bad);
        // Cap: a dozen invoices owing exactly the payment still give ten rows.
        const org2 = await newOrg();
        for (let n = 0; n < 12; n += 1) await invoiceOf(org2.org, org2.customer, { total: 25 });
        const id2 = await addUnapplied(org2.org, { reason: 'INVOICE_NOT_FOUND', amount: 25 });
        expect(((await get(await (await officer(org2.org)).api(), id2)).body.suggested_invoices as Item[]).length).toBe(10);
      });

      it('leaves out a deposit invoice even when it is the meant-for invoice, and offers nothing for money already on a payment row', async () => {
        const { org, customer } = await newOrg();
        const api = await (await officer(org)).api();
        const deposit = await invoiceOf(org, customer, { total: 25, kind: 'DEPOSIT' });
        await invoiceOf(org, customer, { total: 25 });
        const onDeposit = await addUnapplied(org, { invoiceId: deposit, reason: 'DEPOSIT_SUPERSEDED', amount: 25 });
        expect(((await get(api, onDeposit)).body.suggested_invoices as Item[]).map((r) => r.id)).not.toContain(deposit);
        const bank = await invoiceOf(org, customer, { total: 25, due: 0, status: 'PAID' });
        const payment = await addPayment(bank, { state: 'SUCCEEDED', amount: 25, method: 'ACH' });
        const onRow = await addUnapplied(org, { invoiceId: bank, reason: 'INVOICE_NOT_PAYABLE', amount: 25, sourceKey: `payment:${payment}` });
        expect((await get(api, onRow)).body.suggested_invoices).toEqual([]);
      });
    });

    describe('GET /:id/invoices (the Attach dialog search)', () => {
      const search = async (api: Api, id: string, q = '') => (await api.get(`${DETAIL}/${id}/invoices?q=${encodeURIComponent(q)}`));

      it('orders meant-for, same amount, the rest that can take the payment, then the ones that cannot, with can_attach and balance on every row', async () => {
        const { org, customer } = await newOrg();
        const api = await (await officer(org)).api();
        const meant = await invoiceOf(org, customer, { total: 500, due: 500 });
        const same = await invoiceOf(org, customer, { total: 30, due: 25 });
        const bigger = await invoiceOf(org, customer, { total: 900, due: 300 });
        const lower = await invoiceOf(org, customer, { total: 100, due: 10, status: 'PARTIAL' });
        const id = await addUnapplied(org, { invoiceId: meant, reason: 'AMOUNT_MISMATCH', amount: 25 });
        const res = await search(api, id);
        expect(res.status).toBe(200);
        const rows = res.body.items as Item[];
        expect(rows.map((r) => r.id)).toEqual([meant, same, bigger, lower]);
        expect(rows.map((r) => r.can_attach)).toEqual([true, true, true, false]);
        expect(rows.map((r) => r.balance)).toEqual([500, 25, 300, 10]);
        expect(rows[0]).toMatchObject({ meant: true, same_amount: false, customer: 'Pat Payer', amount: 500 });
        expect(rows[1]).toMatchObject({ meant: false, same_amount: true });
        for (const r of rows) {
          expect(Object.keys(r).sort()).toEqual(['amount', 'balance', 'can_attach', 'customer', 'due_date', 'id', 'job_type', 'meant', 'number', 'payable_now', 'same_amount', 'status']);
        }
      });

      // V7 review: a caller with View payments only (no refund switch) and a narrowed invoice reach must not learn
      // names of invoices outside that reach through the search, whatever they type.
      it('a View-payments-only caller whose invoice reach excludes the matching invoices gets no rows or names for them', async () => {
        const { org, customer } = await newOrg();
        const secret = randomUUID();
        await db.customer.create({ data: { id: secret, organization_id: org, customer_number: `C-${secret.slice(0, 8)}`, kind: 'COMPANY', segment: 'COMMERCIAL', company_name: 'Hidden Holdings' } });
        const me = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached', refund_payments: false }, 'viewer');
        const api = await me.api();
        const job = await fx.addJob(org, customer, { crew: [me.id] });
        const mine = await invoiceOf(org, customer, { jobId: job.id, total: 25 });
        const hidden = await invoiceOf(org, secret, { total: 25 });
        const hiddenOnOtherJob = await invoiceOf(org, customer, { total: 25 });
        const id = await addUnapplied(org, { invoiceId: mine, reason: 'AMOUNT_MISMATCH', amount: 25 });
        for (const q of ['', 'Hidden', 'Holdings', await numberOf(hidden), await numberOf(hiddenOnOtherJob)]) {
          const res = await search(api, id, q);
          expect(res.status, q).toBe(200);
          const ids = (res.body.items as Item[]).map((r) => r.id);
          expect(ids, q).not.toContain(hidden);
          expect(ids, q).not.toContain(hiddenOnOtherJob);
          expect(JSON.stringify(res.body), q).not.toContain('Hidden Holdings');
        }
        expect(((await search(api, id)).body.items as Item[]).map((r) => r.id)).toEqual([mine]);
        // The item itself sits on an invoice outside the caller's reach: restricted on the detail, refused (not read) on the search.
        const outside = await addUnapplied(org, { invoiceId: hidden, reason: 'AMOUNT_MISMATCH', amount: 25 });
        const outsideSearch = await search(api, outside);
        expect([403, 404]).toContain(outsideSearch.status);
        expect(JSON.stringify(outsideSearch.body)).not.toMatch(/Hidden|Holdings/);
      });

      it('matches the invoice number, the customer\'s first, last and company name, and nothing else', async () => {
        const { org, customer } = await newOrg();
        const api = await (await officer(org)).api();
        const company = randomUUID();
        await db.customer.create({ data: { id: company, organization_id: org, customer_number: `C-${company.slice(0, 8)}`, kind: 'COMPANY', segment: 'COMMERCIAL', company_name: 'Acme Roofing' } });
        const mine = await invoiceOf(org, customer, { total: 60 });
        const theirs = await invoiceOf(org, company, { total: 60 });
        const id = await addUnapplied(org, { reason: 'INVOICE_NOT_FOUND', amount: 25 });
        const ids = async (q: string) => ((await search(api, id, q)).body.items as Item[]).map((r) => r.id).sort();
        expect(await ids(await numberOf(mine))).toEqual([mine]);
        expect(await ids('pat')).toEqual([mine]);
        expect(await ids('Payer')).toEqual([mine]);
        expect(await ids('acme')).toEqual([theirs]);
        expect(await ids('zzz-nothing')).toEqual([]);
        expect((await ids('')).sort()).toEqual([mine, theirs].sort());
      });

      it('leaves out deposit invoices, voided and paid ones, other companies\' invoices and invoices the caller cannot open, and returns at most 25', async () => {
        const { org, customer } = await newOrg();
        const other = await newOrg();
        const me = await officer(org, { jobs_scope: 'attached', leads_scope: 'attached' });
        const job = await fx.addJob(org, customer, { crew: [me.id] });
        const secret = randomUUID();
        await db.customer.create({ data: { id: secret, organization_id: org, customer_number: `C-${secret.slice(0, 8)}`, kind: 'COMPANY', segment: 'COMMERCIAL', company_name: 'Hidden Holdings' } });
        const ok = await invoiceOf(org, customer, { jobId: job.id, total: 25 });
        const bad = [
          await invoiceOf(org, customer, { jobId: job.id, total: 25, kind: 'DEPOSIT' }),
          await invoiceOf(org, customer, { jobId: job.id, total: 25, status: 'VOIDED' }),
          await invoiceOf(org, customer, { jobId: job.id, total: 25, due: 0, status: 'PAID' }),
          await invoiceOf(org, secret, { total: 25 }),
          await invoiceOf(other.org, other.customer, { total: 25 }),
        ];
        const id = await addUnapplied(org, { reason: 'AMOUNT_MISMATCH', invoiceId: ok, amount: 25 });
        const ids = ((await search(await me.api(), id)).body.items as Item[]).map((r) => r.id);
        expect(ids).toEqual([ok]);
        for (const b of bad) expect(ids).not.toContain(b);
        const big = await newOrg();
        for (let n = 0; n < 30; n += 1) await invoiceOf(big.org, big.customer, { total: 25 });
        const bigId = await addUnapplied(big.org, { reason: 'INVOICE_NOT_FOUND', amount: 25 });
        expect(((await search(await (await officer(big.org)).api(), bigId)).body.items as Item[]).length).toBe(25);
      });

      it('lists, for a refund, only non-voided invoices holding a succeeded payment with enough left to refund', async () => {
        const { org, customer, admin } = await newOrg();
        const api = await (await officer(org)).api();
        const enough = await invoiceOf(org, customer, { total: 100, due: 0, status: 'PAID' });
        await addPayment(enough, { state: 'SUCCEEDED', amount: 100, method: 'CARD' });
        const exact = await invoiceOf(org, customer, { total: 30, due: 0, status: 'PAID' });
        await addPayment(exact, { state: 'SUCCEEDED', amount: 30, method: 'CARD' });
        const spent = await invoiceOf(org, customer, { total: 100, due: 0, status: 'PAID' });
        const spentPayment = await addPayment(spent, { state: 'SUCCEEDED', amount: 100, method: 'CARD' });
        await addRefund(org, spent, spentPayment, admin.id, 80, 'SUCCEEDED', ago(2));
        const small = await invoiceOf(org, customer, { total: 20, due: 0, status: 'PAID' });
        await addPayment(small, { state: 'SUCCEEDED', amount: 20, method: 'CARD' });
        const voided = await invoiceOf(org, customer, { total: 100, due: 0, status: 'VOIDED' });
        await addPayment(voided, { state: 'SUCCEEDED', amount: 100, method: 'CARD' });
        await invoiceOf(org, customer, { total: 100, status: 'SENT' });
        const id = await addUnapplied(org, { reason: 'REFUND_UNMATCHED', invoiceId: enough, amount: 30 });
        const res = await search(api, id);
        const rows = res.body.items as Item[];
        expect(rows.map((r) => r.id)).toEqual([enough, exact]);
        expect(rows.every((r) => r.can_attach)).toBe(true);
        expect(rows[0].meant).toBe(true);
      });

      it('keeps the meant-for invoice first for a refund even when more than 25 invoices match and it is the oldest', async () => {
        const { org, customer } = await newOrg();
        const api = await (await officer(org)).api();
        const meant = await invoiceOf(org, customer, { total: 100, due: 0, status: 'PAID' });
        await addPayment(meant, { state: 'SUCCEEDED', amount: 100, method: 'CARD' });
        await db.invoice.update({ where: { id: meant }, data: { created_at: ago(400) } });
        for (let n = 0; n < 27; n += 1) {
          const inv = await invoiceOf(org, customer, { total: 100, due: 0, status: 'PAID' });
          await addPayment(inv, { state: 'SUCCEEDED', amount: 100, method: 'CARD' });
        }
        const id = await addUnapplied(org, { reason: 'REFUND_UNMATCHED', invoiceId: meant, amount: 30 });
        const rows = (await search(api, id)).body.items as Item[];
        expect(rows.length).toBe(25);
        expect(rows[0]).toMatchObject({ id: meant, meant: true });
      });

      it('returns nothing for a resolved item', async () => {
        const { org, customer } = await newOrg();
        await invoiceOf(org, customer, { total: 25 });
        const id = await addUnapplied(org, { status: 'RESOLVED', amount: 25 });
        expect((await search(await (await officer(org)).api(), id)).body).toEqual({ items: [] });
      });
    });

    describe('actions', () => {
      const actionsOf = async (api: Api, id: string) => (await get(api, id)).body.actions as string[];

      it('offers attach, create invoice, refund and mark resolved on an unapplied payment, and attach and mark resolved on a refund', async () => {
        const { org, customer } = await newOrg();
        const api = await (await officer(org)).api();
        const payment = await addUnapplied(org, { invoiceId: await invoiceOf(org, customer), amount: 25 });
        const refund = await addUnapplied(org, { reason: 'REFUND_UNMATCHED', amount: 25, onRecord: false });
        expect(await actionsOf(api, payment)).toEqual(['attach_to_invoice', 'create_invoice', 'refund', 'mark_resolved']);
        expect(await actionsOf(api, refund)).toEqual(['attach_to_invoice', 'mark_resolved']);
        const listed = Object.fromEntries((await listOf(api)).items.filter((i) => i.type.startsWith('unmatched')).map((i) => [i.type, i.actions]));
        expect(listed).toEqual({ unmatched_payment: ['attach_to_invoice', 'create_invoice', 'refund', 'mark_resolved'], unmatched_refund: ['attach_to_invoice', 'mark_resolved'] });
      });

      it('withholds Create invoice from someone who cannot create a standalone invoice but keeps their other buttons', async () => {
        const { org, customer } = await newOrg();
        const id = await addUnapplied(org, { invoiceId: await invoiceOf(org, customer), amount: 25 });
        const noStandalone = await officer(org, { standalone_invoices: false });
        const noCreate = await officer(org, { create_invoices: false, standalone_invoices: false });
        for (const [who, why] of [[noStandalone, 'no standalone'], [noCreate, 'no create']] as const) {
          expect(await actionsOf(await who.api(), id), why).toEqual(['attach_to_invoice', 'refund', 'mark_resolved']);
        }
      });

      it('offers neither attach nor create invoice for money that already sits on a payment row (a payment: source key)', async () => {
        const { org, customer } = await newOrg();
        const api = await (await officer(org)).api();
        const invoice = await invoiceOf(org, customer, { total: 25, due: 0, status: 'PAID' });
        const payment = await addPayment(invoice, { state: 'SUCCEEDED', amount: 25, method: 'ACH' });
        const id = await addUnapplied(org, { invoiceId: invoice, reason: 'INVOICE_NOT_PAYABLE', amount: 25, sourceKey: `payment:${payment}` });
        expect(await actionsOf(api, id)).toEqual(['refund', 'mark_resolved']);
        expect(((await listOf(api)).items.find((i) => i.key.endsWith(`:${id}`))!.actions)).toEqual(['refund', 'mark_resolved']);
      });

      it('gives a caller without Refund payments none of them', async () => {
        const { org, customer } = await newOrg();
        const id = await addUnapplied(org, { invoiceId: await invoiceOf(org, customer), amount: 25 });
        const api = await (await personWith(org, { ...SEES_ALL, refund_payments: false, edit_invoices: true, create_invoices: true, standalone_invoices: true }, 'nopay')).api();
        expect(await actionsOf(api, id)).toEqual([]);
      });
    });
  });
  describe('V7-13 part 1: a bank return is an item, with words and a prefilled email', () => {
    /** An invoice with a public link, and a customer with an email. */
    const setup = async (o: { email?: string | null } = {}) => {
      const ctx = await newOrg();
      await db.customer.update({ where: { id: ctx.customer }, data: { email: o.email === undefined ? 'delivered@resend.dev' : o.email, company_name: 'Payer Holdings' } });
      const invoice = await invoiceIn(ctx.org, ctx.customer);
      const token = `tok-${invoice.slice(0, 12)}`;
      await db.invoice.update({ where: { id: invoice }, data: { public_token: token, status: 'SENT' } });
      const num = (await db.invoice.findUniqueOrThrow({ where: { id: invoice } })).invoice_number;
      return { ...ctx, invoice, token, num };
    };
    /** A bank debit that cleared, then came back: voided, with the bank-return dispute LOST. */
    const lateReturn = async (c: { org: string; invoice: string }, returnedAt = ago(1)) => {
      const pay = await addPayment(c.invoice, { amount: 75, state: 'SUCCEEDED', paidAt: ago(6), voidedAt: returnedAt });
      const dispute = await addDispute(c.org, c.invoice, pay, { bank: true, status: 'LOST', createdAt: ago(2), closedAt: returnedAt });
      return { pay, dispute, key: `failed_payment:${pay}` };
    };
    const itemOf = async (api: Api, key: string, view = 'view=open') => (await listOf(api, view)).items.find((i) => i.key === key);

    it('lists a late bank return as Bank payment failed, dated the day the bank returned it, with the returned words and both actions', async () => {
      const c = await setup();
      const returnedAt = ago(1);
      const r = await lateReturn(c, returnedAt);
      const body = await listOf(await (await linker(c.org)).api());
      expect(body.counts.open).toBe(1);
      const item = body.items.find((i) => i.key === r.key)!;
      expect(item).toMatchObject({
        type: 'failed_payment', status: 'open', title: 'Bank payment failed', detail: 'The bank returned this payment after it had cleared.',
        amount: 75, actions: ['contact_customer', 'mark_resolved'], payment_id: r.pay, restricted: false,
      });
      // The item is dated the return (the dispute's close time), not the day the money was paid (6 days ago).
      expect(Math.abs(new Date(item.date).getTime() - returnedAt.getTime())).toBeLessThan(5);
    });

    it('lists an early return (the debit never cleared) with the failure words, not "after it had cleared"', async () => {
      const c = await setup();
      const returnedAt = ago(1);
      const pay = await addPayment(c.invoice, { amount: 75, state: 'FAILED', paidAt: ago(6), failureCode: 'insufficient_funds' });
      await addDispute(c.org, c.invoice, pay, { bank: true, status: 'LOST', createdAt: ago(2), closedAt: returnedAt });
      const item = (await itemOf(await (await linker(c.org)).api(), `failed_payment:${pay}`))!;
      expect(item).toMatchObject({ title: 'Bank payment failed', detail: 'Insufficient funds', actions: ['contact_customer', 'mark_resolved'] });
      expect(Math.abs(new Date(item.date).getTime() - returnedAt.getTime())).toBeLessThan(5);
    });

    it('counts it in the open count, the by-type summary and the type filter', async () => {
      const c = await setup();
      await lateReturn(c);
      const api = await (await viewer(c.org)).api();
      expect((await api.get(`${BASE}/summary`)).body).toMatchObject({ open: 1, by_type: { failed_payment: 1 } });
      expect((await listOf(api, 'view=open&type[]=failed_payment')).items).toHaveLength(1);
    });

    it('keeps the lost bank-return dispute in the Resolved view as its own item, "Bank payment returned"', async () => {
      const c = await setup();
      const r = await lateReturn(c);
      const resolved = (await listOf(await (await viewer(c.org)).api(), 'view=resolved')).items;
      expect(resolved.find((i) => i.key === `dispute:${r.dispute}`)).toMatchObject({ title: 'Bank payment returned', status: 'resolved' });
      expect(resolved.find((i) => i.key === r.key)).toBeUndefined();
    });

    it('leaves the Open view when the invoice is paid again, voided, marked resolved, or later money covers it', async () => {
      const c = await setup();
      const api = await (await owner(c.org)).api();
      const paid = await lateReturn(c);
      const other = async () => { const inv = await invoiceIn(c.org, c.customer); await db.invoice.update({ where: { id: inv }, data: { status: 'SENT' } }); return { org: c.org, invoice: inv }; };
      const voided = await lateReturn(await other());
      const resolved = await lateReturn(await other());
      const covered = await other();
      const coveredReturn = await lateReturn(covered);
      expect((await listOf(api)).items).toHaveLength(4);
      await db.invoice.update({ where: { id: c.invoice }, data: { status: 'PAID' } });
      await db.invoice.update({ where: { id: (await db.payment.findUniqueOrThrow({ where: { id: voided.pay } })).invoice_id }, data: { status: 'VOIDED' } });
      expect((await api.post(`${BASE}/${resolved.key}/resolve`).send({ note: 'Called them' })).status).toBe(200);
      await addPayment(covered.invoice, { amount: 75, state: 'SUCCEEDED', method: 'CARD', paidAt: ago(0.5) });
      const open = (await listOf(api)).items.map((i) => i.key);
      expect(open).toEqual([]);
      const done = (await listOf(api, 'view=resolved')).items.map((i) => i.key);
      for (const r of [paid, voided, resolved, coveredReturn]) expect(done).toContain(r.key);
    });

    it('lists no item for a payment whose bank-return dispute is not LOST, or a lost dispute that is not a bank return', async () => {
      const c = await setup();
      const stillOpen = await addPayment(c.invoice, { state: 'FAILED', paidAt: ago(5) });
      await addDispute(c.org, c.invoice, stillOpen, { bank: true, status: 'NEEDS_RESPONSE' });
      const won = await addPayment(c.invoice, { state: 'SUCCEEDED', paidAt: ago(5), voidedAt: ago(1) });
      await addDispute(c.org, c.invoice, won, { bank: true, status: 'WON', closedAt: ago(1) });
      const cardLike = await addPayment(c.invoice, { state: 'FAILED', paidAt: ago(5) });
      await addDispute(c.org, c.invoice, cardLike, { bank: false, status: 'LOST', closedAt: ago(1) });
      expect((await listOf(await (await viewer(c.org)).api())).items.filter((i) => i.type === 'failed_payment')).toEqual([]);
    });

    it('does not turn a lost bank return on a card payment into a failed bank payment', async () => {
      const c = await setup();
      const card = await addPayment(c.invoice, { method: 'CARD', state: 'SUCCEEDED', paidAt: ago(5), voidedAt: ago(1) });
      await addDispute(c.org, c.invoice, card, { bank: true, status: 'LOST', closedAt: ago(1) });
      expect((await listOf(await (await viewer(c.org)).api())).items.filter((i) => i.type === 'failed_payment')).toEqual([]);
    });

    it('offers Contact customer to a viewer with no Send payment links and to a customer with no email', async () => {
      const c = await setup({ email: null });
      const r = await lateReturn(c);
      for (const who of [await viewer(c.org), await linker(c.org)]) {
        expect((await itemOf(await who.api(), r.key))!.actions).toContain('contact_customer');
      }
    });

    it('prefills the compose window: the sentence and the pay link for a holder of Send payment links, the greeting from the first and last name', async () => {
      const c = await setup();
      const r = await lateReturn(c);
      const item = (await itemOf(await (await linker(c.org)).api(), r.key))!;
      expect(item.compose).toEqual({
        subject: `Bank payment failed - Invoice ${c.num}`,
        body: `Hi Pat Payer, your bank payment of $75.00 for invoice ${c.num} didn't go through. Pay again here: ${env.FRONTEND_URL || ''}/p/invoices/${c.invoice}?token=${c.token}`,
      });
    });

    it('leaves the pay link out of the body for a caller without Send payment links, and never puts the token anywhere else', async () => {
      const c = await setup();
      const r = await lateReturn(c);
      const withoutLink = await (await refunder(c.org)).api();
      const res = await listOf(withoutLink);
      expect(res.items[0].compose).toEqual({ subject: `Bank payment failed - Invoice ${c.num}`, body: `Hi Pat Payer, your bank payment of $75.00 for invoice ${c.num} didn't go through.` });
      expect(JSON.stringify(res)).not.toContain(c.token);
      const withLink = await listOf(await (await linker(c.org)).api());
      const { compose, ...rest } = withLink.items[0];
      expect(JSON.stringify(rest)).not.toContain(c.token);
      expect(compose.body).toContain(c.token);
      expect(r.key).toBe(withLink.items[0].key);
    });

    it('leaves the pay link out when the invoice cannot be paid online (disputed, or no public link)', async () => {
      const c = await setup();
      await lateReturn(c);
      const api = await (await linker(c.org)).api();
      await db.invoice.update({ where: { id: c.invoice }, data: { status: 'DISPUTED' } });
      expect((await listOf(api)).items[0].compose.body).not.toContain('Pay again here');
      await db.invoice.update({ where: { id: c.invoice }, data: { status: 'SENT', public_token: null } });
      expect((await listOf(api)).items[0].compose.body).not.toContain('Pay again here');
    });

    it('sends a deposit invoice to its estimate page', async () => {
      const c = await setup();
      const estimate = await fx.addEstimate(c.org, c.customer, c.admin.id);
      await db.estimate.update({ where: { id: estimate.id }, data: { public_token: 'est-tok-1' } });
      await db.invoice.update({ where: { id: c.invoice }, data: { kind: 'DEPOSIT', estimate_id: estimate.id } });
      await lateReturn(c);
      const body = (await listOf(await (await linker(c.org)).api())).items[0].compose.body as string;
      expect(body).toContain(`/p/estimates/${estimate.id}?token=est-tok-1`);
    });

    it('carries no compose on a restricted item or on any other kind of item, and returns it on the read-by-key route', async () => {
      const c = await setup();
      const r = await lateReturn(c);
      const refundedPayment = await addPayment(c.invoice, { state: 'SUCCEEDED', paidAt: ago(30) });
      await addRefund(c.org, c.invoice, refundedPayment, c.admin.id, 20, 'FAILED', ago(2));
      const api = await (await linker(c.org)).api();
      const items = (await listOf(api)).items;
      expect(items.filter((i) => i.type !== 'failed_payment').every((i) => i.compose === null)).toBe(true);
      const byKey = (await api.get(`${BASE}/${r.key}`)).body;
      expect(byKey.compose.subject).toBe(`Bank payment failed - Invoice ${c.num}`);
      expect(byKey.compose.body).toContain('Pay again here');
      // restricted: a caller whose scope does not reach the invoice
      const me = await personWith(c.org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached', refund_payments: true, send_payment_links: true }, 'scoped');
      const hidden = (await listOf(await me.api())).items.find((i) => i.key === r.key)!;
      expect(hidden).toMatchObject({ restricted: true, actions: [], compose: null });
      expect(JSON.stringify(hidden)).not.toContain(c.token);
    });

    it('still answers the old contact-customer route for an early failed payment', async () => {
      const c = await setup();
      const failed = await addPayment(c.invoice, { amount: 75 });
      const res = await (await (await linker(c.org)).api()).post(`${BASE}/failed_payment:${failed}/contact-customer`).send({});
      expect(res.status).toBe(200);
    });
  });
});
