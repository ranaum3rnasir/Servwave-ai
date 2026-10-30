/**
 * Payments go-live slice 13 - sandbox check of a bank (ACH) payment's lifecycle: PROCESSING while
 * the debit clears, then SUCCEEDED (the invoice PAID), or FAILED (the balance open again).
 *
 * Real money flow on the sandbox: a real bank debit with the processor's test bank account (the
 * success account, or the failure account), entered by hand and verified with the sandbox's
 * micro-deposit amounts so it starts processing. A checkout.session.completed event (payment_status
 * unpaid) naming that payment intent is posted signed to the running backend's webhook route. The
 * backend reads the charge back from the processor, so the bank name, last four and paid-at can
 * only be right if that read happened. One case follows the hosted checkout's real order for an
 * account entered by hand: the checkout completes BEFORE the micro-deposits are verified, so no
 * charge exists yet (the bank comes from the payment method), and the charge id and paid-at must be
 * filled in when the debit settles. The processor then settles the
 * debit on its own; once its payment intent shows the outcome, the matching async event is posted
 * (and posted again, to prove a duplicate changes nothing).
 *
 * Self-contained: it writes its own org, user, customer and invoices (tagged qa-39-VERIFY-BANK-) and
 * removes them again. Point DATABASE_URL at the same database the backend under test uses (never
 * production).
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

/** The processor's sandbox test bank accounts (routing 110000000). */
export const TEST_BANK = { routing: '110000000', succeeds: '000123456789', fails: '000111111116' } as const;
/** The sandbox's micro-deposit amounts that verify a test bank account. */
const MICRODEPOSIT_AMOUNTS = [32, 45];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A real bank debit on the sandbox, entered by hand, so it waits for micro-deposit verification
 * (requires_action, no charge yet): what the hosted checkout's manual bank entry leaves when the
 * checkout completes.
 */
export async function enterBankAccount(stripe: Stripe, amountCents: number, accountNumber: string, invoiceId: string): Promise<Stripe.PaymentIntent> {
  const created = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    payment_method_types: ['us_bank_account'],
    payment_method_data: {
      type: 'us_bank_account',
      us_bank_account: { account_holder_type: 'individual', routing_number: TEST_BANK.routing, account_number: accountNumber },
      billing_details: { name: 'Verify Customer' },
    },
    payment_method_options: { us_bank_account: { verification_method: 'microdeposits' } },
    mandate_data: { customer_acceptance: { type: 'offline' } },
    confirm: true,
    metadata: { invoiceId },
  });
  assert(created.status === 'requires_action', `the bank account waits for micro-deposits (got ${created.status})`);
  return created;
}

/** The customer verifies the micro-deposits: the debit's charge is created and it is PROCESSING. */
export async function verifyMicrodeposits(stripe: Stripe, paymentIntentId: string): Promise<Stripe.PaymentIntent> {
  const pi = await stripe.paymentIntents.verifyMicrodeposits(paymentIntentId, { amounts: MICRODEPOSIT_AMOUNTS });
  assert(pi.status === 'processing', `the bank debit is processing (got ${pi.status})`);
  return pi;
}

const chargeOf = async (stripe: Stripe, pi: Stripe.PaymentIntent): Promise<Stripe.Charge> => {
  const charge = typeof pi.latest_charge === 'string' ? await stripe.charges.retrieve(pi.latest_charge) : pi.latest_charge;
  assert(charge, 'the bank debit has a charge');
  return charge;
};

/** Wait for the processor to settle the debit: succeeded, or failed (back to requires_payment_method). */
export async function awaitOutcome(stripe: Stripe, paymentIntentId: string): Promise<'succeeded' | 'failed'> {
  for (let i = 0; i < 60; i++) {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status === 'succeeded') return 'succeeded';
    if (pi.status === 'requires_payment_method' || pi.status === 'canceled') return 'failed';
    await sleep(3000);
  }
  throw new Error(`the bank debit ${paymentIntentId} was still processing after 3 minutes`);
}

export async function bankPaymentLifecycle(input: { stripe: Stripe; verbose: boolean }): Promise<number> {
  const { stripe, verbose } = input;
  let count = 0;
  const tag = `qa-39-VERIFY-BANK-${Date.now()}`;
  const shortTag = `VB${Date.now() % 1e8}`;
  const orgId = randomUUID();
  const totalCents = 41275;
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

    // The hosted checkout's real order for an account entered by hand is completion first and the
    // micro-deposit verification later (the charge exists only then); the first two cases verify
    // first, the third completes first.
    const cases = [
      { outcome: 'succeeded', completedFirst: false },
      { outcome: 'failed', completedFirst: false },
      { outcome: 'succeeded', completedFirst: true },
    ] as const;
    for (const { outcome, completedFirst } of cases) {
      const key = `${outcome}${completedFirst ? '_completed_first' : ''}`;
      const invoiceId = randomUUID();
      await prisma.invoice.create({
        data: {
          id: invoiceId, organization_id: orgId, customer_id: customer.id, invoice_number: `I-${shortTag}-${key}`, status: 'SENT',
          subtotal: total, tax_amount: 0, total_amount: total, amount_due: total, created_by_source: 'SYSTEM',
        },
      });
      const entered = await enterBankAccount(stripe, totalCents, outcome === 'succeeded' ? TEST_BANK.succeeds : TEST_BANK.fails, invoiceId);
      const pi = completedFirst ? entered : await verifyMicrodeposits(stripe, entered.id);
      const earlyCharge = completedFirst ? null : await chargeOf(stripe, pi);
      count++;

      // The completed bank checkout, in the payload shape of the pinned version: unpaid, naming the
      // payment intent (not the charge).
      const sessionId = `cs_verify_bank_${shortTag}_${key}`;
      const session = (paymentStatus: 'paid' | 'unpaid') => ({
        id: sessionId, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: paymentStatus,
        payment_intent: pi.id, amount_total: totalCents, currency: 'usd', payment_method_types: ['us_bank_account'],
        metadata: { invoiceId, organizationId: orgId, kind: 'invoice', payableNowCents: String(totalCents) },
      });
      const completed = await postWebhook({
        id: `evt_verify_bank_${shortTag}_${key}_completed`, object: 'event', api_version: '2025-02-24.acacia',
        type: 'checkout.session.completed', created: earlyCharge ? earlyCharge.created + 60 : Math.floor(Date.now() / 1000),
        data: { object: session('unpaid') },
      });
      assert(completed.status === 200, `checkout.session.completed (unpaid) answered 200 (got ${completed.status})`);

      const [processing, ...extra] = await prisma.payment.findMany({ where: { invoice_id: invoiceId } });
      assert(processing && extra.length === 0, `exactly one payment booked (got ${extra.length + (processing ? 1 : 0)})`);
      assert(processing.method === 'ACH' && processing.state === 'PROCESSING', `a PROCESSING bank payment (got ${processing.state} ${processing.method})`);
      assert(processing.stripe_charge_id === (earlyCharge?.id ?? null), `charge id stored (got ${processing.stripe_charge_id})`);
      assert(processing.bank_last4 === accountLast4(outcome) && !!processing.bank_name,
        `bank name and last four read back from the processor (got ${processing.bank_name} ${processing.bank_last4})`);
      if (earlyCharge) {
        assert(processing.paid_at.getTime() === earlyCharge.created * 1000, `paid-at is the charge's created time (got ${processing.paid_at.toISOString()})`);
      }
      count++;
      const open = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      assert(open.status === 'SENT' && Number(open.amount_due) === total, `invoice not PAID while the debit clears (got ${open.status} ${open.amount_due})`);
      count++;

      // Completed first: the customer verifies the micro-deposits only now, and the charge is created.
      const charge = earlyCharge ?? await chargeOf(stripe, await verifyMicrodeposits(stripe, pi.id));
      const settled = await awaitOutcome(stripe, pi.id);
      assert(settled === outcome, `the processor settled the debit as ${outcome} (got ${settled})`);
      const outcomeEvent = {
        id: `evt_verify_bank_${shortTag}_${key}_async`, object: 'event', api_version: '2025-02-24.acacia',
        type: outcome === 'succeeded' ? 'checkout.session.async_payment_succeeded' : 'checkout.session.async_payment_failed',
        created: Math.floor(Date.now() / 1000), data: { object: session(outcome === 'succeeded' ? 'paid' : 'unpaid') },
      };
      const res = await postWebhook(outcomeEvent);
      assert(res.status === 200, `${outcomeEvent.type} answered 200 (got ${res.status})`);
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: processing.id } });
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      if (outcome === 'succeeded') {
        assert(after.state === 'SUCCEEDED', `the payment SUCCEEDED (got ${after.state})`);
        assert(after.paid_at.getTime() === charge.created * 1000, `paid-at is the charge time (got ${after.paid_at.toISOString()})`);
        assert(after.stripe_charge_id === charge.id && after.bank_last4 === accountLast4(outcome) && !!after.bank_name,
          `the settled payment carries the charge and the bank (got ${after.stripe_charge_id} ${after.bank_name} ${after.bank_last4})`);
        assert(invoice.status === 'PAID' && Number(invoice.amount_due) === 0, `invoice PAID with nothing due (got ${invoice.status} ${invoice.amount_due})`);
      } else {
        assert(after.state === 'FAILED', `the payment FAILED (got ${after.state})`);
        assert(invoice.status === 'SENT' && Number(invoice.amount_due) === total, `balance open again (got ${invoice.status} ${invoice.amount_due})`);
      }
      count++;

      const replay = await postWebhook(outcomeEvent);
      assert(replay.status === 200 && replay.body.duplicate === true, `replay answered 200 duplicate (got ${replay.status} ${JSON.stringify(replay.body)})`);
      const again = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      assert(again.status === invoice.status && Number(again.amount_due) === Number(invoice.amount_due), 'the replay changed nothing');
      count++;

      if (verbose) console.log(`  ${key}: ${pi.id} / ${charge.id} PROCESSING -> ${after.state}, invoice ${invoice.status} (${processing.bank_name} ${processing.bank_last4})`);
    }
    return count;
  } finally {
    await removeFixtures(`${tag} (org ${orgId})`, async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${orgId}')`).catch(() => undefined);
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      for (const table of ['customers', 'users']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${orgId}'`).catch(() => undefined);
      await prisma.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_verify_bank_${shortTag}%'`).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
    });
  }
}

const accountLast4 = (outcome: 'succeeded' | 'failed') => (outcome === 'succeeded' ? TEST_BANK.succeeds : TEST_BANK.fails).slice(-4);
