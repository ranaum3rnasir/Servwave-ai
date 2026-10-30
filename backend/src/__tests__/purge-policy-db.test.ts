/* =============================================================================
   Payments go-live F1: the force-purge policy, against a real migrated database
   (TEST_DATABASE_URL; skipped when unset). The window edges use FIXED dates passed in as `now`,
   never the wall clock. The policy takes the two windows as parameters, so the 400-day card
   dispute rule is tested with a 1-year money window.
   ========================================================================== */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { assessPurge, PURGE_RETENTION_YEARS, PURGE_DISPUTE_WINDOW_DAYS } from '../lib/purge-policy';

const suite = realClient ? describe : describe.skip;

const NOW = new Date('2026-10-14T12:00:00Z');
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
// 7 calendar years before NOW is 2019-10-14T12:00Z.
const SEVEN_YEARS_AGO = new Date('2019-10-14T12:00:00Z');
const dayAfter = (d: Date) => new Date(d.getTime() + 86_400_000);
const dayBefore = (d: Date) => new Date(d.getTime() - 86_400_000);

suite('purge policy (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());

  async function world() {
    const { org, customer, admin } = await fx.newOrg();
    let n = 0;
    async function invoice(status: 'DRAFT' | 'SENT' | 'PAID' | 'VOIDED', at: Date) {
      const id = randomUUID();
      n += 1;
      await db.invoice.create({
        data: {
          id, organization_id: org, customer_id: customer, invoice_number: `INV-${id.slice(0, 8)}-${n}`,
          subtotal: 100, tax_amount: 0, total_amount: 100, amount_due: 100, status, created_at: at,
        },
      });
      return id;
    }
    async function payment(invoiceId: string, at: Date, method: 'CARD' | 'CASH' | 'ACH' = 'CASH', amount = 100) {
      const id = randomUUID();
      await db.payment.create({
        data: { id, invoice_id: invoiceId, amount, method, paid_at: at, created_at: at, ...(method === 'CASH' ? {} : { stripe_payment_intent_id: `pi_${id.slice(0, 8)}` }) },
      });
      return id;
    }
    async function credit(invoiceId: string, at: Date) {
      await db.credit.create({ data: { invoice_id: invoiceId, organization_id: org, amount: 5, created_by: admin.id, created_at: at } });
    }
    async function refund(invoiceId: string, paymentId: string, at: Date) {
      await db.refund.create({
        data: { invoice_id: invoiceId, payment_id: paymentId, organization_id: org, amount: 5, method: 'CASH', reason_category: 'OTHER', refunded_by: admin.id, created_at: at },
      });
    }
    async function dispute(invoiceId: string, paymentId: string, status: 'NEEDS_RESPONSE' | 'UNDER_REVIEW' | 'WON' | 'LOST' | 'CLOSED', at: Date) {
      await db.dispute.create({
        data: { organization_id: org, invoice_id: invoiceId, payment_id: paymentId, stripe_dispute_id: `dp_${randomUUID()}`, status, amount: 100, created_at: at },
      });
    }
    const assess = (opts: Parameters<typeof assessPurge>[3] = {}) => assessPurge(db, customer, org, { now: NOW, ...opts });
    return { org, customer, invoice, payment, credit, refund, dispute, assess };
  }

  it('keeps the two windows in one place with the researched values', () => {
    expect(PURGE_RETENTION_YEARS).toBe(7);
    expect(PURGE_DISPUTE_WINDOW_DAYS).toBe(400);
  });

  it('allows a customer that has only drafts and a voided invoice', async () => {
    const w = await world();
    await w.invoice('DRAFT', daysBefore(10));
    await w.invoice('VOIDED', daysBefore(10));
    const a = await w.assess();
    expect(a.allowed).toBe(true);
    expect(a.blockers).toEqual([]);
    expect(a.invoice_count).toBe(0);
    expect(a.payment_count).toBe(0);
    expect(a.draft_invoice_count).toBe(1);
  });

  it('blocks on a sent invoice inside the window', async () => {
    const w = await world();
    await w.invoice('SENT', daysBefore(30));
    const a = await w.assess();
    expect(a.allowed).toBe(false);
    expect(a.blockers).toEqual(['INVOICES_IN_RETENTION_WINDOW']);
    expect(a.invoice_count).toBe(1);
  });

  it('blocks on a payment, a refund and a credit each on its own', async () => {
    const pay = await world();
    const i1 = await pay.invoice('DRAFT', daysBefore(5));
    await pay.payment(i1, daysBefore(5));
    expect((await pay.assess()).blockers).toEqual(['PAYMENTS_IN_RETENTION_WINDOW']);

    const cr = await world();
    const i2 = await cr.invoice('DRAFT', daysBefore(5));
    await cr.credit(i2, daysBefore(5));
    expect((await cr.assess()).blockers).toEqual(['PAYMENTS_IN_RETENTION_WINDOW']);

    const rf = await world();
    const i3 = await rf.invoice('VOIDED', daysBefore(9000));
    const p3 = await rf.payment(i3, daysBefore(9000));
    await rf.refund(i3, p3, daysBefore(5));
    expect((await rf.assess()).blockers).toEqual(['PAYMENTS_IN_RETENTION_WINDOW']);
  });

  it('blocks on an open dispute however old it is, and not on a closed one', async () => {
    for (const status of ['NEEDS_RESPONSE', 'UNDER_REVIEW'] as const) {
      const w = await world();
      const inv = await w.invoice('VOIDED', daysBefore(4000));
      const pay = await w.payment(inv, daysBefore(4000), 'CASH');
      await w.dispute(inv, pay, status, daysBefore(4000));
      const a = await w.assess();
      expect(a.allowed).toBe(false);
      expect(a.blockers).toEqual(['OPEN_DISPUTES']);
      expect(a.open_disputes).toBe(1);
    }
    for (const status of ['WON', 'LOST', 'CLOSED'] as const) {
      const w = await world();
      const inv = await w.invoice('VOIDED', daysBefore(4000));
      const pay = await w.payment(inv, daysBefore(4000), 'CASH');
      await w.dispute(inv, pay, status, daysBefore(4000));
      expect((await w.assess()).allowed).toBe(true);
    }
  });

  it('window edge: a payment one day inside the 7-year window blocks, one day outside does not', async () => {
    const inside = await world();
    const i1 = await inside.invoice('DRAFT', daysBefore(9000));
    await inside.payment(i1, dayAfter(SEVEN_YEARS_AGO));
    expect((await inside.assess()).blockers).toEqual(['PAYMENTS_IN_RETENTION_WINDOW']);

    const outside = await world();
    const i2 = await outside.invoice('DRAFT', daysBefore(9000));
    await outside.payment(i2, dayBefore(SEVEN_YEARS_AGO));
    expect((await outside.assess()).allowed).toBe(true);
  });

  it('window edge: an invoice one day inside the window blocks, one day outside does not', async () => {
    const inside = await world();
    await inside.invoice('PAID', dayAfter(SEVEN_YEARS_AGO));
    expect((await inside.assess()).blockers).toEqual(['INVOICES_IN_RETENTION_WINDOW']);
    const outside = await world();
    await outside.invoice('PAID', dayBefore(SEVEN_YEARS_AGO));
    expect((await outside.assess()).allowed).toBe(true);
  });

  it('card dispute window with a 1-year money window: a card payment 399 days old blocks, 401 days old does not', async () => {
    const young = await world();
    const i1 = await young.invoice('VOIDED', daysBefore(2000));
    await young.payment(i1, daysBefore(399), 'CARD');
    const a = await young.assess({ retentionYears: 1 });
    expect(a.blockers).toEqual(['CARD_PAYMENTS_IN_DISPUTE_WINDOW']);
    expect(a.has_card_payments).toBe(true);

    const old = await world();
    const i2 = await old.invoice('VOIDED', daysBefore(2000));
    await old.payment(i2, daysBefore(401), 'CARD');
    expect((await old.assess({ retentionYears: 1 })).allowed).toBe(true);
  });

  it('a cash payment is not a card payment for the dispute window', async () => {
    const w = await world();
    const i = await w.invoice('VOIDED', daysBefore(2000));
    await w.payment(i, daysBefore(399), 'CASH');
    expect((await w.assess({ retentionYears: 1 })).allowed).toBe(true);
  });

  it('reports every blocker together, with the counts and the newest record date', async () => {
    const w = await world();
    const inv = await w.invoice('SENT', daysBefore(20));
    const pay = await w.payment(inv, daysBefore(10), 'CARD', 40);
    await w.payment(inv, daysBefore(15), 'CASH', 60);
    await w.dispute(inv, pay, 'NEEDS_RESPONSE', daysBefore(8));
    const a = await w.assess();
    expect(a.allowed).toBe(false);
    expect(a.blockers).toEqual([
      'INVOICES_IN_RETENTION_WINDOW', 'PAYMENTS_IN_RETENTION_WINDOW', 'OPEN_DISPUTES', 'CARD_PAYMENTS_IN_DISPUTE_WINDOW',
    ]);
    expect(a.invoice_count).toBe(1);
    expect(a.payment_count).toBe(2);
    expect(a.payment_total).toBe(100);
    expect(a.open_disputes).toBe(1);
    expect(a.newest_financial_date).toBe(daysBefore(10).toISOString());
  });

  it('never looks at another organisation\'s records', async () => {
    const mine = await world();
    const other = await world();
    await other.invoice('SENT', daysBefore(1));
    expect((await mine.assess()).allowed).toBe(true);
  });
});
