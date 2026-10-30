import { randomUUID } from 'crypto';
import type { SuiteContext } from '../context';
import { acaciaEvent } from '../events';
import { postWebhook } from '../sign';
import {
  QA_TAG, assert, chargingOrgId, deleteSeeded, label, paymentsOf, removeFixtures, seedInvoice, withOrgSettings,
} from '../harness';
import { prisma } from '../../../src/lib/prisma';

// A direct-charge event carries `account`, and the org is found THROUGH the account. The payment
// intent here was made seconds ago, so no ServWave row names it: only the account can say whose
// money it is (the payment-intent fallback has nothing to find). Two cases on real charges made on
// the connected account:
//   - the amount matches: one SUCCEEDED payment on that account, invoice PAID;
//   - the event's total is wrong: nothing is booked, the invoice is untouched, and the money is
//     written down for the owner's "Payments needing attention" list instead of being lost;
//   - the event names no invoice that exists: only the account says whose money it is, so it is
//     written down on THAT org (an invoice-based lookup would find no org and drop it).
export async function run(ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  let count = 0;
  const orgId = await chargingOrgId(ctx);
  const account = ctx.chargingAccount!;
  const charge = (cents: number, invoiceId: string) => ctx.stripe.paymentIntents.create({
    amount: cents, currency: 'usd', payment_method_types: ['card'], payment_method: 'pm_card_visa', confirm: true,
    metadata: { invoiceId },
  }, { stripeAccount: account });
  const session = (id: string, pi: string, invoiceId: string, total: number, kind = 'invoice') => acaciaEvent('checkout.session.completed', {
    id, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', payment_intent: pi,
    amount_total: total, currency: 'usd',
    metadata: { invoiceId, organizationId: orgId, kind, payableNowCents: '12500' },
  }, { account });

  return withOrgSettings(orgId, { stripe_charges_enabled: true, accepted_payment_methods: ['CARD', 'ACH'] }, async () => {
    const good = await seedInvoice(orgId, { kind: 'STANDARD', totalCents: 12500 });
    const bad = await seedInvoice(orgId, { kind: 'STANDARD', totalCents: 12500 });
    const capturedIntents: string[] = [];
    try {
      const pi = await charge(12500, good.id);
      assert(pi.status === 'succeeded', `the charge on the connected account succeeded (got ${pi.status})`);
      const known = await prisma.payment.count({ where: { stripe_payment_intent_id: pi.id } });
      assert(known === 0, 'no ServWave row names the payment intent yet, so only the account can resolve the org');
      count++;
      const ok = await postWebhook(session(`cs_qa39_${pi.id.slice(-8)}`, pi.id, good.id, 12500));
      assert(ok.status === 200, `the connected-account event answered 200 (got ${ok.status})`);
      const [payment, ...others] = await paymentsOf(good.id);
      assert(payment && others.length === 0, 'exactly one payment was booked');
      assert(payment.state === 'SUCCEEDED' && payment.stripe_account_id === account && payment.stripe_payment_intent_id === pi.id,
        `a SUCCEEDED payment on the connected account (got ${payment?.state} ${payment?.stripe_account_id})`);
      count++;
      assert((await prisma.invoice.findUniqueOrThrow({ where: { id: good.id } })).status === 'PAID', 'the invoice is PAID');
      count++;
      ctx.booked.push({ flow: 'flow-L', orgId, paymentId: payment.id, chargeId: payment.stripe_charge_id, intentId: pi.id });

      const pi2 = await charge(12500, bad.id);
      const wrong = await postWebhook(session(`cs_qa39_${pi2.id.slice(-8)}`, pi2.id, bad.id, 99999));
      assert(wrong.status === 200, `the wrong-amount event still answers 200 so the processor stops retrying (got ${wrong.status})`);
      assert((await paymentsOf(bad.id)).length === 0, 'a wrong-amount event books no payment');
      assert((await prisma.invoice.findUniqueOrThrow({ where: { id: bad.id } })).status === 'SENT', 'and leaves the invoice as it was');
      count++;
      const written = await prisma.unappliedCapture.findMany({ where: { organization_id: orgId, stripe_payment_intent_id: pi2.id } });
      assert(written.length === 1 && written[0].reason === 'AMOUNT_MISMATCH' && written[0].status === 'OPEN',
        `the money is written down for review (got ${JSON.stringify(written.map((w) => [w.reason, w.status]))})`);
      count++;

      const pi3 = await charge(12500, 'none');
      const orphan = await postWebhook(session(`cs_qa39_${pi3.id.slice(-8)}`, pi3.id, randomUUID(), 12500));
      assert(orphan.status === 200, `an event naming no known invoice answers 200 (got ${orphan.status})`);
      const orphaned = await prisma.unappliedCapture.findMany({ where: { organization_id: orgId, stripe_payment_intent_id: pi3.id } });
      assert(orphaned.length === 1 && orphaned[0].reason === 'INVOICE_NOT_FOUND',
        `resolved through the account, the money is written down on the owning org (got ${JSON.stringify(orphaned.map((w) => w.reason))})`);
      count++;
      capturedIntents.push(pi2.id, pi3.id);
      if (opts.verbose) console.log(`  booked ${pi.id} through the account; ${pi2.id} AMOUNT_MISMATCH and ${pi3.id} INVOICE_NOT_FOUND written down`);
      return count;
    } finally {
      await removeFixtures(label(good, orgId), () => deleteSeeded(orgId, good));
      await removeFixtures(label(bad, orgId), () => deleteSeeded(orgId, bad));
      if (capturedIntents.length) {
        await removeFixtures(`${QA_TAG} unapplied captures ${capturedIntents.join(', ')} (org ${orgId})`, async () => {
          await prisma.unappliedCapture.deleteMany({ where: { organization_id: orgId, stripe_payment_intent_id: { in: capturedIntents } } });
        });
      }
    }
  });
}
