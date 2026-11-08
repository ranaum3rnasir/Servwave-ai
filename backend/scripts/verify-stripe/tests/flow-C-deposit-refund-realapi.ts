import Stripe from 'stripe';
import { env } from '../../../src/config/env';
import { STRIPE_API_VERSION } from '../../../src/lib/stripe';
import { Fixtures } from '../fixtures';

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Tests real Stripe API connectivity for deposit refund scenario.
// Creates a test PaymentIntent via Stripe sandbox, confirms it, then refunds it —
// verifying that STRIPE_SECRET_KEY is valid and the refund API works end-to-end.
// The HTTP refund endpoint (/api/deposits/:id/refund) is tested manually in Phase 8.
export async function run(_f: Fixtures, opts: { verbose: boolean }): Promise<number> {
  let count = 0;

  if (!env.STRIPE_SECRET_KEY) {
    console.log('  [SKIP] STRIPE_SECRET_KEY not set');
    return 0;
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
  });

  // Create and confirm a test PI representing a deposit charge
  const pi = await stripe.paymentIntents.create({
    amount: 50000, // $500.00
    currency: 'usd',
    payment_method_types: ['card'],
    payment_method: 'pm_card_visa',
    confirm: true,
    return_url: 'http://localhost:5173',
  });

  if (opts.verbose) console.log(`  Created deposit-refund test PI: ${pi.id} status=${pi.status}`);
  assert(pi.status === 'succeeded', `test PI should be succeeded (got ${pi.status})`);
  count++;

  // Refund the PI via Stripe API
  const refund = await stripe.refunds.create({ payment_intent: pi.id });
  if (opts.verbose) console.log(`  Refund: ${refund.id} status=${refund.status}`);
  assert(refund.status === 'succeeded', `refund should be succeeded (got ${refund.status})`);
  count++;
  assert(refund.payment_intent === pi.id, 'refund references the correct payment intent');
  count++;

  return count;
}
