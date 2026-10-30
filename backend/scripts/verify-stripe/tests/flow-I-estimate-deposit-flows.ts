import Stripe from 'stripe';
import { env } from '../../../src/config/env';
import { STRIPE_API_VERSION } from '../../../src/lib/stripe';
import type { SuiteContext } from '../context';
import { estimateDepositFlows } from '../estimate-deposit-flows';
import { API_URL } from '../sign';

// Flow I: the public estimate's deposit flows (payments go-live slice 27): deposit required by
// card and by bank (WON when the debit starts, the deposit reopens when it fails), and pay later.
export async function run(_ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  if (!env.STRIPE_SECRET_KEY) {
    console.log('  [SKIP] STRIPE_SECRET_KEY not set');
    return 0;
  }
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
  return estimateDepositFlows({ stripe, apiUrl: API_URL, verbose: opts.verbose });
}
