/* =============================================================================
   Payments go-live P4 - the Needs attention list stays cheap on the hosted database.

   The hosted database gives the service ONE connection, so a request's cost is its NUMBER of queries and the rows each
   one loads. Everything here runs on a client created with connection_limit=1 that logs the queries it sends.

   Seam: GET /api/payments-page/attention and /summary, with 120 open and 300 resolved items across the five sources.
   Real migrated database (TEST_DATABASE_URL); skips when unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient, sent } = vi.hoisted(() => {
  const sent: Array<{ query: string; params: string }> = [];
  const dbUrl = process.env.TEST_DATABASE_URL;
  let client: unknown;
  if (dbUrl) {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(dbUrl);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '30');
    const made = new PrismaClient({ datasources: { db: { url: pooled.toString() } }, log: [{ emit: 'event', level: 'query' }] });
    (made as unknown as { $on: (e: string, f: (q: { query: string; params: string }) => void) => void }).$on('query', (q) => sent.push({ query: q.query, params: q.params }));
    client = made;
  }
  return { realClient: client as PrismaClient | undefined, sent };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('Needs attention at scale on a pool of one connection (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  let org = '';
  let api: Awaited<ReturnType<typeof fx.signedInAs>>;
  /** Every seeded item: key, date and whether it is open. */
  const seeded: Array<{ key: string; at: number; open: boolean }> = [];

  const OPEN_PER_KIND = 24;
  const RESOLVED_PER_KIND = 60;
  const BASE = Date.now() - 30 * 86_400_000;
  let tick = 0;
  /** A distinct minute for every item, so the expected order is unambiguous, with the kinds interleaved. */
  const nextDate = () => new Date(BASE + ++tick * 61_000);

  beforeAll(async () => {
    await import('../app.js');
    const made = await fx.newOrg();
    org = made.org;
    const role = await fx.addCustomRole(org, 'load-role', 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: 'load-role', actorId: null, reason: 'manual',
      values: { view_payments: true, view_invoices: true, jobs_scope: 'all', leads_scope: 'all', refund_payments: false, send_payment_links: false, manage_payout_account: false },
    });
    const person = await fx.addUser(org, 'loader', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: 'load-role' });
    api = await fx.signedInAs(person);

    const openInvoice = (await fx.addInvoice(org, made.customer)).id;
    const paidInvoice = (await fx.addInvoice(org, made.customer)).id;
    await db.invoice.update({ where: { id: paidInvoice }, data: { status: 'PAID' } });
    const settled = randomUUID();
    await db.payment.create({
      data: { id: settled, invoice_id: openInvoice, amount: 100000, method: 'ACH', state: 'SUCCEEDED', paid_at: new Date(BASE - 86_400_000), stripe_payment_intent_id: 'pi_load_1' },
    });
    const add = (type: string, id: string, at: Date, open: boolean) => seeded.push({ key: `${type}:${id}`, at: at.getTime(), open });
    const resolutions: Array<{ organization_id: string; item_key: string; resolution: string; resolved_by_name: string }> = [];

    const payments: Array<Record<string, unknown>> = [];
    const refunds: Array<Record<string, unknown>> = [];
    const disputes: Array<Record<string, unknown>> = [];
    const payouts: Array<Record<string, unknown>> = [];
    const unapplied: Array<Record<string, unknown>> = [];
    const cardPayment = randomUUID();
    await db.payment.create({ data: { id: cardPayment, invoice_id: openInvoice, amount: 100, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date(BASE - 86_400_000) } });

    for (let i = 0; i < OPEN_PER_KIND + RESOLVED_PER_KIND; i++) {
      const open = i < OPEN_PER_KIND;
      let id = randomUUID();
      let at = nextDate();
      // failed payment: open on the open invoice, resolved by the paid invoice
      payments.push({ id, invoice_id: open ? openInvoice : paidInvoice, amount: 10, method: 'ACH', state: 'FAILED', paid_at: at, stripe_payment_intent_id: `pi_load_${id.slice(0, 8)}` });
      add('failed_payment', id, at, open);
      // failed refund: resolved by a person
      id = randomUUID(); at = nextDate();
      refunds.push({ id, organization_id: org, invoice_id: openInvoice, payment_id: settled, amount: 5, method: 'ACH', reason_category: 'OTHER', refunded_by: made.admin.id, state: 'FAILED', created_at: at });
      if (!open) resolutions.push({ organization_id: org, item_key: `failed_refund:${id}`, resolution: 'SETTLED', resolved_by_name: 'Loader' });
      add('failed_refund', id, at, open);
      // dispute
      id = randomUUID(); at = nextDate();
      disputes.push({ id, organization_id: org, invoice_id: openInvoice, payment_id: cardPayment, stripe_dispute_id: `dp_load_${id.slice(0, 12)}`, status: open ? 'NEEDS_RESPONSE' : 'WON', amount: 10, created_at: at });
      add('dispute', id, at, open);
      // failed payout (the later payout that would resolve one is never seeded: a person closes them)
      id = randomUUID(); at = nextDate();
      payouts.push({ id, organization_id: org, stripe_payout_id: `po_load_${id.slice(0, 12)}`, status: 'FAILED', amount: 50, processor_created_at: at });
      if (!open) resolutions.push({ organization_id: org, item_key: `failed_payout:${id}`, resolution: 'RESOLVED', resolved_by_name: 'Loader' });
      add('failed_payout', id, at, open);
      // unmatched money, half of it refunds
      id = randomUUID(); at = nextDate();
      const refund = i % 2 === 1;
      unapplied.push({ id, organization_id: org, invoice_id: openInvoice, reason: refund ? 'REFUND_UNMATCHED' : 'OVERPAYMENT', amount: 5, status: open ? 'OPEN' : 'RESOLVED', source_key: `load-${id}`, created_at: at });
      add(refund ? 'unmatched_refund' : 'unmatched_payment', id, at, open);
    }
    await db.payment.createMany({ data: payments as never });
    await db.refund.createMany({ data: refunds as never });
    await db.dispute.createMany({ data: disputes as never });
    await db.payout.createMany({ data: payouts as never });
    await db.unappliedCapture.createMany({ data: unapplied as never });
    await db.paymentAttentionResolution.createMany({ data: resolutions });
  }, 180_000);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    if (org) {
      for (const table of ['payment_attention_resolutions', 'unapplied_captures', 'disputes', 'payouts']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  const expectedOrder = (open: boolean) =>
    seeded.filter((s) => s.open === open).sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)).map((s) => s.key);

  async function pageThrough(view: 'open' | 'resolved') {
    const keys: string[] = [];
    for (let page = 1; ; page++) {
      const res = await api.get(`/api/payments-page/attention?view=${view}&limit=50&page=${page}`);
      expect(res.status).toBe(200);
      if (res.body.items.length === 0) break;
      keys.push(...res.body.items.map((i: { key: string }) => i.key));
      if (page > 10) throw new Error('paging did not end');
    }
    return keys;
  }

  it('pages the 120 open items in 3 pages of 50, 50 and 20, in order, once each', async () => {
    const first = await api.get('/api/payments-page/attention?view=open&limit=50&page=1');
    expect(first.body.pagination).toMatchObject({ total: 120, totalPages: 3 });
    expect(first.body.counts).toEqual({ open: 120, resolved: 300 });
    const keys = await pageThrough('open');
    expect(keys).toHaveLength(120);
    expect(new Set(keys).size).toBe(120);
    expect(keys).toEqual(expectedOrder(true));
  });

  it('pages the 300 resolved items in order, once each, and refuses a page deeper than 1,000 rows', async () => {
    const keys = await pageThrough('resolved');
    expect(keys).toHaveLength(300);
    expect(new Set(keys).size).toBe(300);
    expect(keys).toEqual(expectedOrder(false));
    expect((await api.get('/api/payments-page/attention?view=resolved&limit=50&page=22')).status).toBe(400);
    expect((await api.get('/api/payments-page/attention?view=resolved&limit=50&page=21')).status).toBe(200);
  });

  it('answers the summary with the same open count as the list', async () => {
    const summary = (await api.get('/api/payments-page/attention/summary')).body;
    expect(summary.open).toBe(120);
    expect(Object.values(summary.by_type as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(120);
    expect(summary.by_type).toMatchObject({ failed_payment: 24, failed_refund: 24, dispute: 24, failed_payout: 24, unmatched_payment: 12, unmatched_refund: 12 });
  });

  it('sends a small constant number of queries, and never asks a source for more than offset + limit rows', async () => {
    await api.get('/api/payments-page/attention/summary'); // warm up: the sign-in is not counted
    sent.length = 0;
    const res = await api.get('/api/payments-page/attention?view=open&limit=50&page=3');
    expect(res.status).toBe(200);
    // the counts (twice at most), the page, and the one question about the page's invoices: no query per item
    expect(sent.length).toBeLessThanOrEqual(5);
    const merge = sent.filter((q) => q.query.includes(') merged '));
    expect(merge).toHaveLength(1);
    // five sources each cut to offset + limit = 150, then the page (50 after 100)
    const params = JSON.parse(merge[0].params) as unknown[];
    expect(params.filter((p) => p === 150)).toHaveLength(5);
    expect(params).toContain(100);
    expect(res.body.items).toHaveLength(20);

    sent.length = 0;
    expect((await api.get('/api/payments-page/attention/summary')).status).toBe(200);
    expect(sent.length).toBeLessThanOrEqual(3);
    sent.length = 0;
    expect((await api.get('/api/payments-page/attention?view=resolved&type[]=dispute&q=payer&limit=50')).status).toBe(200);
    expect(sent.length).toBeLessThanOrEqual(6);
  });
});
