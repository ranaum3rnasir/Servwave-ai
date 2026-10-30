import Stripe from 'stripe';
import { env } from '../../../src/config/env';
import { STRIPE_API_VERSION } from '../../../src/lib/stripe';
import type { SuiteContext } from '../context';
import { completedCheckoutBooksTheCharge } from '../checkout-events';

// Flow B: an invoice paid by card on the hosted checkout. Payments go-live slice 08: a real sandbox
// charge, its completed-checkout event posted signed (then replayed); one SUCCEEDED payment paid at
// the charge's time with its charge id, session id, brand and last four, and the invoice PAID.
// Builds its own fixtures.
export async function run(_ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  if (!env.STRIPE_SECRET_KEY) {
    console.log('  [SKIP] STRIPE_SECRET_KEY not set');
    return 0;
  }
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
  return completedCheckoutBooksTheCharge({ stripe, kind: 'STANDARD', amountCents: 54375, verbose: opts.verbose });
}
