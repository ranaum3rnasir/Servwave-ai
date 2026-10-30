import type { SuiteContext } from '../context';
import { acaciaEvent } from '../events';
import { postWebhook } from '../sign';
import { assert, removeFixtures } from '../harness';
import { prisma } from '../../../src/lib/prisma';

// A completed checkout with no invoice named in its metadata touches nothing and answers 200, so
// the processor stops retrying it. The event is still recorded once.
export async function run(_ctx: SuiteContext, _opts: { verbose: boolean }): Promise<number> {
  let count = 0;
  const event = acaciaEvent('checkout.session.completed', {
    id: 'cs_qa39_nometa', object: 'checkout.session', payment_intent: `pi_qa39_nometa_${Date.now()}`, amount_total: 50000, metadata: {},
  });
  try {
    const res = await postWebhook(event);
    assert(res.status === 200, `missing-metadata should return 200 (got ${res.status})`);
    count++;
    assert(!res.body.error, `no error in response (got ${res.body.error})`);
    count++;
    const payments = await prisma.payment.count({ where: { stripe_checkout_session_id: 'cs_qa39_nometa' } });
    assert(payments === 0, `no payment was booked off an event that names no invoice (got ${payments})`);
    count++;
    const again = await postWebhook(event);
    assert(again.status === 200 && again.body.duplicate === true, `the same event again is a duplicate (got ${again.status} ${JSON.stringify(again.body)})`);
    count++;
  } finally {
    await removeFixtures(`stripe_events row ${event.id}`, async () => {
      await prisma.stripeEvent.deleteMany({ where: { stripe_event_id: event.id } });
    });
  }
  return count;
}
