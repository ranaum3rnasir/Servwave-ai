/**
 * Payments go-live slice 29 (D17) - sandbox check of a PARTIAL refund of a cleared bank (ACH)
 * payment, the one rule the processor's own docs disagree on (the ACH page grid says "no partial
 * refunds"; its support article says they work under PaymentIntents).
 *
 * Real money flow on the sandbox: a real bank debit with the processor's success test bank account,
 * verified with the micro-deposit amounts, left to clear. A partial refund of it is created through
 * the processor API (D17: if the sandbox refused it, ServWave would ship full-only bank refunds).
 * The processor's OWN refund events (fetched back from the events API, so the payload shape is what
 * it really sends) are posted signed to the running backend's webhook route: the refund is recorded
 * once, PENDING while the processor reports it pending, and counts only once it has SUCCEEDED.
 *
 * Self-contained: it writes its own org, user, customer, invoice and payment (prefixed
 * qa-39-VERIFY-ACHREFUND-) and removes them again. Point DATABASE_URL at the same database the backend
 * under test uses (never production).
 */
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { prisma } from '../../src/lib/prisma';
import { seedStarterTaskCategories } from '../../src/lib/tasks/categories';
import { postWebhook } from './sign';
import { removeFixtures } from './harness';
import { TEST_BANK, awaitOutcome, enterBankAccount, verifyMicrodeposits } from './bank-events';
import { waitForEvents } from './refund-events';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function partialBankRefund(input: { stripe: Stripe; verbose: boolean }): Promise<number> {
  const { stripe, verbose } = input;
  let count = 0;
  const startedAt = Math.floor(Date.now() / 1000) - 5;
  const tag = `qa-39-VERIFY-ACHREFUND-${Date.now()}`;
  const shortTag = `VA${Date.now() % 1e8}`;
  const orgId = randomUUID();
  const invoiceId = randomUUID();
  const totalCents = 20000;
  const refundCents = 5000;
  const total = totalCents / 100;

  await prisma.organization.create({
    data: { is_demo: true,
      id: orgId, name: `${tag}-Org`, email: `${tag}-org@test.invalid`,
      address_line1: '1 Harness St', city: 'Testville', state: 'CA', postal_code: '90001',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', accepted_payment_methods: ['CARD', 'ACH'],
    },
  });
  try {
    await seedStarterTaskCategories(prisma, orgId);
    await prisma.user.create({
      data: { organization_id: orgId, email: `${tag}-admin@test.invalid`, first_name: 'Verify', last_name: 'Admin', role: 'ADMIN' },
    });
    const customer = await prisma.customer.create({
      data: { organization_id: orgId, customer_number: `C-${shortTag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Verify', last_name: 'Customer', created_by_source: 'SYSTEM' },
    });

    // A real bank debit that clears on the sandbox.
    const entered = await enterBankAccount(stripe, totalCents, TEST_BANK.succeeds, invoiceId);
    await verifyMicrodeposits(stripe, entered.id);
    const settled = await awaitOutcome(stripe, entered.id);
    assert(settled === 'succeeded', `the bank debit cleared (got ${settled})`);
    count++;

    await prisma.invoice.create({
      data: {
        id: invoiceId, organization_id: orgId, customer_id: customer.id, invoice_number: `I-${shortTag}`, status: 'PAID',
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: 0, net_collected: total, paid_at: new Date(), created_by_source: 'SYSTEM',
      },
    });
    const payment = await prisma.payment.create({
      data: {
        invoice_id: invoiceId, amount: total, method: 'ACH', state: 'SUCCEEDED', paid_at: new Date(),
        stripe_payment_intent_id: entered.id, created_by_source: 'CLIENT',
      },
    });

    // D17: a PARTIAL refund of the cleared bank payment. The sandbox takes it (pending at first).
    let refund: Stripe.Refund;
    try {
      refund = await stripe.refunds.create({ payment_intent: entered.id, amount: refundCents });
    } catch (err) {
      throw new Error(`D17: the sandbox refused a partial bank refund (${(err as Error).message}); ship full-only bank refunds`);
    }
    assert(refund.amount === refundCents, `partial refund of ${refundCents} (got ${refund.amount})`);
    if (verbose) console.log(`  D17: partial bank refund ${refund.id} accepted, status ${refund.status}`);
    count++;

    // The processor's own refund.created event: a refund ServWave had no row for is recorded once.
    const [createdEvent] = await waitForEvents(stripe, 'refund.created', startedAt, (o) => (o as Stripe.Refund).id === refund.id, 1);
    const res = await postWebhook(createdEvent);
    assert(res.status === 200, `refund.created answered 200 (got ${res.status})`);
    const rowAfterCreated = await prisma.refund.findFirstOrThrow({ where: { stripe_refund_id: refund.id } });
    assert(rowAfterCreated.payment_id === payment.id && Number(rowAfterCreated.amount) === refundCents / 100,
      `one refund row on the bank payment for ${refundCents / 100} (got ${rowAfterCreated.payment_id} ${rowAfterCreated.amount})`);
    const createdState = (createdEvent.data.object as Stripe.Refund).status;
    if (createdState === 'pending') {
      assert(rowAfterCreated.state === 'PENDING', `a pending bank refund is PENDING (got ${rowAfterCreated.state})`);
      const pendingInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      assert(pendingInvoice.status === 'PAID' && Number(pendingInvoice.total_refunded ?? 0) === 0,
        `nothing counts as refunded while it is pending (got ${pendingInvoice.status} ${pendingInvoice.total_refunded})`);
    }
    count++;

    // The processor settles the refund; its refund.updated event moves the row to SUCCEEDED.
    for (let i = 0; i < 60; i++) {
      if ((await stripe.refunds.retrieve(refund.id)).status !== 'pending') break;
      await sleep(3000);
    }
    const final = await stripe.refunds.retrieve(refund.id);
    assert(final.status === 'succeeded', `the partial bank refund succeeded on the sandbox (got ${final.status})`);
    if (createdState === 'pending') {
      const [updatedEvent] = await waitForEvents(
        stripe, 'refund.updated', startedAt, (o) => (o as Stripe.Refund).id === refund.id && (o as Stripe.Refund).status === 'succeeded', 1,
      );
      const upd = await postWebhook(updatedEvent);
      assert(upd.status === 200, `refund.updated answered 200 (got ${upd.status})`);
    }
    const rows = await prisma.refund.findMany({ where: { invoice_id: invoiceId } });
    assert(rows.length === 1 && rows[0].state === 'SUCCEEDED', `one SUCCEEDED refund row (got ${rows.map((r) => r.state).join(',')})`);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    assert(invoice.status === 'PARTIALLY_REFUNDED' && Number(invoice.total_refunded) === refundCents / 100,
      `invoice PARTIALLY_REFUNDED with ${refundCents / 100} refunded (got ${invoice.status} ${invoice.total_refunded})`);
    count++;
    if (verbose) console.log(`  ${entered.id}: partial bank refund ${refund.id} ${createdState} -> ${final.status}; invoice ${invoice.status}`);
    return count;
  } finally {
    await removeFixtures(`${tag} (org ${orgId})`, async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${orgId}'`).catch(() => undefined);
      await prisma.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id = '${invoiceId}'`).catch(() => undefined);
      for (const table of ['unapplied_captures', 'timeline_events', 'notifications', 'invoices', 'customers', 'users']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${orgId}'`).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
    });
  }
}
