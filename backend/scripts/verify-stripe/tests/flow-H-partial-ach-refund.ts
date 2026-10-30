import Stripe from 'stripe';
import { env } from '../../../src/config/env';
import { STRIPE_API_VERSION } from '../../../src/lib/stripe';
import type { SuiteContext } from '../context';
import { partialBankRefund } from '../ach-refund-events';

// Payments go-live slice 29 (D17): a partial refund of a cleared bank payment is accepted by the
// sandbox, and its refund events record it once: PENDING, then SUCCEEDED.
export async function run(_ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  if (!env.STRIPE_SECRET_KEY) {
    console.log('  [SKIP] STRIPE_SECRET_KEY not set');
    return 0;
  }
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
  return partialBankRefund({ stripe, verbose: opts.verbose });
}
