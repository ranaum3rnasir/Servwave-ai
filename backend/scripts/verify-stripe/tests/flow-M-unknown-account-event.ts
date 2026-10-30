import type { SuiteContext } from '../context';
import { acaciaEvent } from '../events';
import { postWebhook } from '../sign';
import { assert, chargingOrgId, deleteSeeded, label, paymentsOf, removeFixtures, seedInvoice } from '../harness';
import { prisma } from '../../../src/lib/prisma';

// One processor sandbox serves staging and prod, so every environment hears about accounts it does
// not know. An event for an unknown account is answered 200 (the processor stops retrying), is
// recorded once, and touches nothing - even when its metadata names a real invoice here.
export async function run(ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  let count = 0;
  const orgId = await chargingOrgId(ctx);
  const stranger = `acct_qa39_unknown_${Date.now()}`;
  const inv = await seedInvoice(orgId, { kind: 'STANDARD', totalCents: 12500 });
  const events = [
    acaciaEvent('checkout.session.completed', {
      id: 'cs_qa39_stranger', object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
      payment_intent: 'pi_qa39_stranger', amount_total: 12500, currency: 'usd',
      metadata: { invoiceId: inv.id, organizationId: orgId, kind: 'invoice', payableNowCents: '12500' },
    }, { account: stranger }),
    acaciaEvent('charge.refunded', { id: 'ch_qa39_stranger', object: 'charge', payment_intent: 'pi_qa39_stranger', amount_refunded: 12500 }, { account: stranger }),
  ];
  try {
    for (const e of events) {
      const res = await postWebhook(e);
      assert(res.status === 200, `${e.type} for an unknown account answered 200 (got ${res.status})`);
      count++;
    }
    assert((await paymentsOf(inv.id)).length === 0, 'no payment was booked');
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    assert(invoice.status === 'SENT' && Number(invoice.amount_due) === 125, `the invoice is untouched (got ${invoice.status} ${invoice.amount_due})`);
    assert((await prisma.refund.count({ where: { invoice_id: inv.id } })) === 0, 'no refund row appeared');
    count++;
    for (const e of events) {
      assert((await prisma.stripeEvent.count({ where: { stripe_event_id: e.id } })) === 1, `${e.type} is recorded once so it is not retried`);
    }
    count++;
    const again = await postWebhook(events[0]);
    assert(again.body.duplicate === true, `the same event again is a duplicate (got ${JSON.stringify(again.body)})`);
    count++;
    if (opts.verbose) console.log(`  events for ${stranger} acknowledged, nothing touched`);
    return count;
  } finally {
    await removeFixtures(label(inv, orgId), async () => {
      await deleteSeeded(orgId, inv);
      await prisma.stripeEvent.deleteMany({ where: { stripe_event_id: { in: events.map((e) => e.id) } } });
    });
  }
}
