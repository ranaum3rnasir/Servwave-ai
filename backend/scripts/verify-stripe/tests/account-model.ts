import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { env } from '../../../src/config/env';
import { STRIPE_API_VERSION, createConnectedAccount, retrieveAccount } from '../../../src/lib/stripe';
import type { SuiteContext } from '../context';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Payments go-live slice 01 (PRD Module 1, D13). Creates a real sandbox connected account through
// the ONE creation path the app uses (createConnectedAccount), reads it back from the processor,
// and checks what the processor actually stored: the no-dashboard controller block and the three
// requested capabilities. The account is deleted afterwards (sandbox accounts can be).
// Needs only STRIPE_SECRET_KEY (a sk_test_ key, enforced by preflight); touches no database.
export async function run(_ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  assert(env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'STRIPE_SECRET_KEY is a sandbox (sk_test_) key');
  let count = 0;

  const prefix = `qa-39-VERIFY-ACCT-${Date.now()}`;
  const created = await createConnectedAccount({
    orgId: randomUUID(),
    email: `${prefix.toLowerCase()}-owner@test.invalid`,
    businessName: `${prefix} Verify Org`,
    mcc: '1731',
  });

  try {
    const account = await retrieveAccount(created.id);
    const controller = account.controller as Record<string, any> | undefined;
    if (opts.verbose) console.log(`  account ${account.id} controller=${JSON.stringify(controller)}`);

    assert(controller?.stripe_dashboard?.type === 'none', `controller.stripe_dashboard.type is none (got ${controller?.stripe_dashboard?.type})`);
    count++;
    assert(controller?.fees?.payer === 'account', `controller.fees.payer is account (got ${controller?.fees?.payer})`);
    count++;
    assert(controller?.losses?.payments === 'stripe', `controller.losses.payments is stripe (got ${controller?.losses?.payments})`);
    count++;
    assert(controller?.requirement_collection === 'stripe', `controller.requirement_collection is stripe (got ${controller?.requirement_collection})`);
    count++;

    // A capability appears on the account (with any status) only once it has been requested.
    const requested = Object.keys(account.capabilities ?? {}).sort();
    if (opts.verbose) console.log(`  requested capabilities: ${requested.join(', ')}`);
    for (const cap of ['card_payments', 'transfers', 'us_bank_account_ach_payments']) {
      assert(requested.includes(cap), `capability ${cap} is requested (got ${requested.join(', ') || 'none'})`);
      count++;
    }
  } finally {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
    try {
      await stripe.accounts.del(created.id);
    } catch (err: any) {
      console.log(`  [WARN] could not delete sandbox account ${created.id}: ${err.message}`);
    }
  }

  return count;
}
