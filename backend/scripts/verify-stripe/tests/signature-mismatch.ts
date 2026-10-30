import type { SuiteContext } from '../context';
import { acaciaEvent } from '../events';
import { API_URL } from '../sign';
import { assert } from '../harness';
import { prisma } from '../../../src/lib/prisma';

// A webhook with a signature that does not match is refused with 400 and recorded nowhere.
export async function run(_ctx: SuiteContext, _opts: { verbose: boolean }): Promise<number> {
  let count = 0;
  const event = acaciaEvent('checkout.session.completed', { id: 'cs_qa39_badsig', metadata: {} });

  const res = await fetch(`${API_URL}/api/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=9999999999,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    },
    body: JSON.stringify(event),
  });
  const body = await res.json();

  assert(res.status === 400, `bad signature should return 400 (got ${res.status})`);
  count++;
  assert(
    typeof body.error === 'string' && body.error.toLowerCase().includes('signature'),
    `error message should mention signature (got "${body.error}")`,
  );
  count++;
  const rows = await prisma.stripeEvent.count({ where: { stripe_event_id: event.id } });
  assert(rows === 0, `a refused delivery leaves no StripeEvent row (got ${rows})`);
  count++;

  return count;
}
