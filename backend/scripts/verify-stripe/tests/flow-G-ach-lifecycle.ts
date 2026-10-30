import Stripe from 'stripe';
import { env } from '../../../src/config/env';
import { STRIPE_API_VERSION } from '../../../src/lib/stripe';
import type { SuiteContext } from '../context';
import { bankPaymentLifecycle } from '../bank-events';

// Payments go-live slice 13: real bank debits with the processor's success and failure test bank
// accounts. Completed unpaid -> PROCESSING (invoice not PAID); cleared -> SUCCEEDED and PAID;
// failed -> FAILED and the balance open again. Each outcome event delivered twice. A third debit
// completes before its micro-deposits are verified (no charge yet), as the hosted checkout does.
export async function run(_ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  if (!env.STRIPE_SECRET_KEY) {
    console.log('  [SKIP] STRIPE_SECRET_KEY not set');
    return 0;
  }
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
  return bankPaymentLifecycle({ stripe, verbose: opts.verbose });
}
