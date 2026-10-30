/**
 * Payments go-live slice 07 - sandbox check that a refund is recorded ONCE, keyed on its refund id.
 *
 * Real money flow on the sandbox: a real charge, real refunds through the processor API, and the
 * processor's OWN refund.* and charge.refunded events (fetched back from the events API, so the
 * payload shape is whatever the processor really sends) posted signed to the running backend's
 * webhook route, one of them twice. Then the ledger must hold exactly one Refund row per refund
 * id, and the invoice's refunded total must be the sum of the refunds, not of the charge's
 * running total.
 *
 * Self-contained: it writes its own org, user, customer, invoice and payment (prefixed
 * qa-39-VERIFY-REFUND-) and removes them again. Point DATABASE_URL at the same database the backend
 * under test uses (never production).
 */
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { prisma } from '../../src/lib/prisma';
import { seedStarterTaskCategories } from '../../src/lib/tasks/categories';
import { postWebhook } from './sign';
import { removeFixtures } from './harness';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

export interface RefundFlowInput {
  stripe: Stripe;
  kind: 'STANDARD' | 'DEPOSIT';
  /** The charge, in cents. */
  chargeCents: number;
  /** Each refund, in cents, made in this order. */
  refundsCents: number[];
  verbose: boolean;
}

export async function refundsRecordedOnceByRefundId(input: RefundFlowInput): Promise<number> {
  const { stripe, kind, chargeCents, refundsCents, verbose } = input;
  let count = 0;
  const startedAt = Math.floor(Date.now() / 1000) - 5;
  const tag = `qa-39-VERIFY-REFUND-${Date.now()}`;
  const shortTag = `VR${Date.now() % 1e8}`;
  const orgId = randomUUID();
  const invoiceId = randomUUID();
  const total = chargeCents / 100;

  await prisma.organization.create({
    data: { is_demo: true,
      id: orgId, name: `${tag}-Org`, email: `${tag}-org@test.invalid`,
      address_line1: '1 Harness St', city: 'Testville', state: 'CA', postal_code: '90001',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', accepted_payment_methods: ['CARD'],
    },
  });
  try {
    // The starter task categories every new org gets. Removed with the org (ON DELETE CASCADE).
    await seedStarterTaskCategories(prisma, orgId);
    await prisma.user.create({
      data: { organization_id: orgId, email: `${tag}-admin@test.invalid`, first_name: 'Verify', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    const customer = await prisma.customer.create({
      data: { organization_id: orgId, customer_number: `C-${shortTag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Verify', last_name: 'Customer', created_by_source: 'SYSTEM' },
    });

    // A real, succeeded charge on the sandbox.
    const pi = await stripe.paymentIntents.create({
      amount: chargeCents, currency: 'usd', payment_method_types: ['card'], payment_method: 'pm_card_visa',
      confirm: true, metadata: { invoiceId },
    });
    assert(pi.status === 'succeeded', `charge succeeded (got ${pi.status})`);
    count++;

    await prisma.invoice.create({
      data: {
        id: invoiceId, organization_id: orgId, customer_id: customer.id, kind, invoice_number: `I-${shortTag}`, status: 'PAID',
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: 0, paid_at: new Date(), created_by_source: 'SYSTEM',
      },
    });
    await prisma.payment.create({
      data: {
        invoice_id: invoiceId, amount: total, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date(),
        stripe_payment_intent_id: pi.id, created_by_source: 'CLIENT',
      },
    });

    // Real refunds, made outside ServWave (no in-app row exists for them yet).
    const refundIds: string[] = [];
    for (const cents of refundsCents) {
      const r = await stripe.refunds.create({ payment_intent: pi.id, amount: cents });
      assert(r.status === 'succeeded', `refund ${r.id} succeeded (got ${r.status})`);
      refundIds.push(r.id);
    }
    count++;

    // The processor's own events for them: one refund.created per refund, and the charge events.
    const created = await waitForEvents(stripe, 'refund.created', startedAt, (o) => refundIds.includes((o as Stripe.Refund).id), refundIds.length);
    const chargeRefunded = await waitForEvents(stripe, 'charge.refunded', startedAt, (o) => (o as Stripe.Charge).payment_intent === pi.id, refundIds.length);
    if (verbose) console.log(`  ${kind}: ${created.length} refund.created + ${chargeRefunded.length} charge.refunded events fetched`);
    assert(chargeRefunded.every((e) => !(e.data.object as { refunds?: unknown }).refunds), 'charge events at the pinned version carry no refunds list');
    count++;

    for (const e of [...chargeRefunded, ...created]) {
      const res = await postWebhook(e);
      assert(res.status === 200, `${e.type} ${e.id} answered 200 (got ${res.status})`);
    }
    // A redelivery of one refund event changes nothing.
    const replay = await postWebhook(created[0]);
    assert(replay.status === 200, `replayed ${created[0].id} answered 200 (got ${replay.status})`);
    count++;

    const rows = await prisma.refund.findMany({ where: { invoice_id: invoiceId } });
    for (const id of refundIds) {
      assert(rows.filter((r) => r.stripe_refund_id === id).length === 1, `exactly one Refund row for ${id}`);
    }
    assert(rows.length === refundIds.length, `one row per refund, no extra rows (got ${rows.length} for ${refundIds.length})`);
    count++;

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const expectedRefunded = refundsCents.reduce((s, c) => s + c, 0) / 100;
    assert(Number(invoice.total_refunded) === expectedRefunded, `total refunded is ${expectedRefunded} (got ${invoice.total_refunded})`);
    count++;
    return count;
  } finally {
    await removeFixtures(`${tag} (org ${orgId})`, async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${orgId}'`);
      await prisma.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id = '${invoiceId}'`);
      for (const table of ['timeline_events', 'notifications', 'invoices', 'customers', 'users']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      // audit_logs is append-only (the database refuses a delete) and has no foreign key to the company: its rows stay.
      await prisma.organization.deleteMany({ where: { id: orgId } });
    });
  }
}

/** Poll the events API until `want` matching events of `type` exist (events land within seconds). */
export async function waitForEvents(
  stripe: Stripe, type: string, since: number, match: (obj: unknown) => boolean, want: number,
): Promise<Stripe.Event[]> {
  for (let i = 0; i < 30; i++) {
    const page = await stripe.events.list({ type, created: { gte: since }, limit: 100 });
    const found = page.data.filter((e) => match(e.data.object)).reverse();
    if (found.length >= want) return found;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${want} ${type} event(s)`);
}
