import type { SuiteContext } from '../context';
import { acaciaEvent } from '../events';
import { postWebhook } from '../sign';
import { prisma } from '../../../src/lib/prisma';
import { assert, removeFixtures } from '../harness';

// Fires the same event five times at once, then a sixth time after they settled. Whatever order the
// five land in: every answer is a 200 (never a 500 from the unique-id race), exactly one StripeEvent
// row exists for the event id, and the late sixth delivery is answered as a duplicate. The event is
// one the backend cannot attribute to an org, so no booking is involved; the double-fire of a real
// payment is in flow J.
export async function run(_ctx: SuiteContext, _opts: { verbose: boolean }): Promise<number> {
  let count = 0;
  const event = acaciaEvent('checkout.session.completed', {
    id: 'cs_qa39_idem', object: 'checkout.session', payment_intent: 'pi_qa39_idem', amount_total: 50000, metadata: {},
  });
  try {
    const burst = await Promise.all(Array.from({ length: 5 }, () => postWebhook(event)));
    assert(burst.every((r) => r.status === 200), `all 5 simultaneous deliveries answered 200 (got ${burst.map((r) => r.status).join(',')})`);
    count++;
    const rows = await prisma.stripeEvent.findMany({ where: { stripe_event_id: event.id } });
    assert(rows.length === 1, `exactly one StripeEvent row for the event id (got ${rows.length})`);
    count++;
    const late = await postWebhook(event);
    assert(late.status === 200 && late.body.duplicate === true, `a delivery after they settled is a duplicate (got ${late.status} ${JSON.stringify(late.body)})`);
    count++;
  } finally {
    await removeFixtures(`stripe_events row ${event.id}`, async () => {
      await prisma.stripeEvent.deleteMany({ where: { stripe_event_id: event.id } });
    });
  }
  return count;
}
