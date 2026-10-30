import Stripe from 'stripe';
import { env } from '../../../src/config/env';
import { STRIPE_API_VERSION } from '../../../src/lib/stripe';
import type { SuiteContext } from '../context';
import { disputeBeforeTheBookingIsPickedUp, disputesRecordedOnceAndSettled } from '../dispute-events';

// Payments go-live slice 09: a real charge with the processor's dispute test card. The dispute is
// recorded once and the invoice reads DISPUTED; closed won restores it, closed lost voids the payment
// and reopens the balance. And the processor's real ordering: the dispute event before the completed
// checkout; the booking picks the dispute up.
export async function run(_ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  if (!env.STRIPE_SECRET_KEY) {
    console.log('  [SKIP] STRIPE_SECRET_KEY not set');
    return 0;
  }
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
  const settled = await disputesRecordedOnceAndSettled({ stripe, verbose: opts.verbose });
  return settled + await disputeBeforeTheBookingIsPickedUp({ stripe, verbose: opts.verbose });
}
