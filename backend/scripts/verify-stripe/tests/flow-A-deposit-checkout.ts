import Stripe from 'stripe';
import { env } from '../../../src/config/env';
import { STRIPE_API_VERSION } from '../../../src/lib/stripe';
import type { SuiteContext } from '../context';
import { completedCheckoutBooksTheCharge, partlyPaidDepositChargesTheRest } from '../checkout-events';
import { API_URL } from '../sign';

// Flow A: a deposit paid by card on the hosted checkout. Payments go-live slice 08: a real sandbox
// charge, its completed-checkout event posted signed (then replayed); one SUCCEEDED payment paid at
// the charge's time with its card details, the deposit invoice PAID, the estimate approved and the
// lead won. Builds its own fixtures (the shared ones predate the deposit-invoice model).
// Slice 15 extends it with the partial manual payment case: $200 of a $500 deposit recorded by
// hand, then the approve checkout and the deposit link both ask for $300, and paying it settles.
export async function run(_ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  if (!env.STRIPE_SECRET_KEY) {
    console.log('  [SKIP] STRIPE_SECRET_KEY not set');
    return 0;
  }
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
  const whole = await completedCheckoutBooksTheCharge({ stripe, kind: 'DEPOSIT', amountCents: 50000, verbose: opts.verbose });
  const partlyPaid = await partlyPaidDepositChargesTheRest({ stripe, apiUrl: API_URL, verbose: opts.verbose });
  return whole + partlyPaid;
}
