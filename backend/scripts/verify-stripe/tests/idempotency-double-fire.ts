import { Fixtures } from '../fixtures';
import { postWebhook } from '../sign';
import { prisma } from '../../../src/lib/prisma';

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Fires the same checkout.session.completed event 5 times simultaneously.
// Verifies P2002 idempotency: exactly one is processed, four return duplicate:true,
// all five return HTTP 200 (no 500s).
export async function run(f: Fixtures, _opts: { verbose: boolean }): Promise<number> {
  let count = 0;

  const eventId = `evt_idempotent_${Date.now()}`;
  const event = {
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_idempotent_1',
        payment_intent: 'pi_idempotent_1',
        amount_total: Math.round(f.depositAmount * 100),
        metadata: { depositId: f.depositId },
      },
    },
  };

  // Fire 5 simultaneous deliveries of the SAME event ID
  const results = await Promise.all([
    postWebhook(event),
    postWebhook(event),
    postWebhook(event),
    postWebhook(event),
    postWebhook(event),
  ]);

  const fresh = results.filter((r) => r.body.duplicate !== true);
  const duplicates = results.filter((r) => r.body.duplicate === true);

  assert(fresh.length === 1, `exactly one delivery processed as fresh (got ${fresh.length})`);
  count++;
  assert(duplicates.length === 4, `four deliveries returned duplicate:true (got ${duplicates.length})`);
  count++;
  assert(results.every((r) => r.status === 200), 'all 5 deliveries returned HTTP 200 (no 500s)');
  count++;

  // Exactly one StripeEvent row
  const evRows = await prisma.stripeEvent.findMany({ where: { stripe_event_id: eventId } });
  assert(evRows.length === 1, `exactly one StripeEvent row exists for the event ID (got ${evRows.length})`);
  count++;

  return count;
}
