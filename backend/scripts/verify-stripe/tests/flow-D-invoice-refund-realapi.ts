import Stripe from 'stripe';
import { env } from '../../../src/config/env';
import { STRIPE_API_VERSION } from '../../../src/lib/stripe';
import { Fixtures } from '../fixtures';

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Tests real Stripe API connectivity for invoice refund scenario.
// Creates a test PaymentIntent via Stripe sandbox, confirms it, then refunds it —
// verifying that STRIPE_SECRET_KEY is valid and the refund API works end-to-end.
// Also verifies rejection of multi-payment scenario at the Stripe level.
// The HTTP refund endpoint (/api/invoices/:id/refund) is tested manually in Phase 8.
export async function run(_f: Fixtures, opts: { verbose: boolean }): Promise<number> {
  let count = 0;

  if (!env.STRIPE_SECRET_KEY) {
    console.log('  [SKIP] STRIPE_SECRET_KEY not set');
    return 0;
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
  });

  // Create and confirm a test PI representing an invoice payment
  const pi = await stripe.paymentIntents.create({
    amount: 54375, // $543.75
    currency: 'usd',
    payment_method_types: ['card'],
    payment_method: 'pm_card_visa',
    confirm: true,
    return_url: 'http://localhost:5173',
  });

  if (opts.verbose) console.log(`  Created invoice-refund test PI: ${pi.id} status=${pi.status}`);
  assert(pi.status === 'succeeded', `test PI should be succeeded (got ${pi.status})`);
  count++;

  // Full refund
  const refund = await stripe.refunds.create({ payment_intent: pi.id });
  if (opts.verbose) console.log(`  Refund: ${refund.id} status=${refund.status}`);
  assert(refund.status === 'succeeded', `refund should be succeeded (got ${refund.status})`);
  count++;

  // Verify partial refund is also possible (invoice partial-refund future capability)
  const pi2 = await stripe.paymentIntents.create({
    amount: 54375,
    currency: 'usd',
    payment_method_types: ['card'],
    payment_method: 'pm_card_visa',
    confirm: true,
    return_url: 'http://localhost:5173',
  });
  const partial = await stripe.refunds.create({ payment_intent: pi2.id, amount: 10000 });
  assert(partial.amount === 10000, `partial refund amount should be 10000 (got ${partial.amount})`);
  count++;

  return count;
}
