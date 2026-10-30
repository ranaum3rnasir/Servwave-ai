import type { SuiteContext } from '../context';
import {
  assert, bookCardPayment, chargingOrgId, deleteSeeded, deliverAsAccount, label, paymentsOf, removeFixtures, seedInvoice,
  waitFor, withOrgSettings,
} from '../harness';
import { prisma } from '../../../src/lib/prisma';

// A part payment with a tip, paid by card on the connected account. $200 of a $500 invoice plus a
// $30 tip is one $230 charge. The event is delivered three times at once (a double-fire of real
// money): exactly one payment is booked, for $200 with the $30 tip beside it, and the invoice is
// PARTIAL with $300 still owing. Nothing is typed into any page: the checkout is opened through the
// app's public door and paid with the processor's test token.
export async function run(ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  let count = 0;
  const orgId = await chargingOrgId(ctx);
  const account = ctx.chargingAccount!;
  return withOrgSettings(orgId, { stripe_charges_enabled: true, tips_enabled: true, accepted_payment_methods: ['CARD', 'ACH'] }, async () => {
    const inv = await seedInvoice(orgId, { kind: 'STANDARD', totalCents: 50000, allowPartial: true, methods: ['CARD'] });
    try {
      const { sessionId, events } = await bookCardPayment(ctx, inv, { amount: 200, tip: 30 }, 23000);
      await Promise.all([1, 2, 3].map(() => deliverAsAccount(events, account)));

      const [payment, ...others] = await waitFor('the payment', async () => {
        const rows = await paymentsOf(inv.id);
        return rows.length > 0 ? rows : null;
      });
      assert(others.length === 0, `three simultaneous deliveries booked exactly one payment (got ${others.length + 1})`);
      count++;
      assert(payment.state === 'SUCCEEDED' && payment.method === 'CARD', `a SUCCEEDED card payment (got ${payment.state} ${payment.method})`);
      assert(Number(payment.amount) === 200, `the payment is the $200 part payment (got ${payment.amount})`);
      count++;
      assert(Number(payment.tip_amount) === 30, `the $30 tip rides beside it (got ${payment.tip_amount})`);
      count++;
      assert(payment.stripe_account_id === account && payment.stripe_checkout_session_id === sessionId, 'booked on the connected account, naming the session');
      assert(payment.card_brand === 'visa' && payment.card_last4 === '4242', `card details filled (got ${payment.card_brand} ${payment.card_last4})`);
      count++;
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      assert(invoice.status === 'PARTIAL', `the invoice is PARTIAL (got ${invoice.status})`);
      assert(Number(invoice.amount_due) === 300, `$300 is still owing (got ${invoice.amount_due})`);
      count++;
      ctx.booked.push({ flow: 'flow-J', orgId, paymentId: payment.id, chargeId: payment.stripe_charge_id, intentId: payment.stripe_payment_intent_id });
      if (opts.verbose) console.log(`  ${inv.number}: ${payment.id} $200 + $30 tip, PARTIAL, $300 owing`);
      return count;
    } finally {
      await removeFixtures(label(inv, orgId), () => deleteSeeded(orgId, inv));
    }
  });
}
