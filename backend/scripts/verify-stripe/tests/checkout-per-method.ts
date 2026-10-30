import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { env } from '../../../src/config/env';
import { STRIPE_API_VERSION, createCheckoutSession, createConnectedAccount, getStripeForOrg } from '../../../src/lib/stripe';
import { priceCheckout, type CheckoutMethod } from '../../../src/lib/checkout-pricing';
import type { SuiteContext } from '../context';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Payments go-live slice 12 (PRD Module 3, D19). Opens a real sandbox checkout of each kind on a
// fresh no-dashboard connected account, through the app's own session builder, and reads back what
// the processor stored: the card session offers card only (the hosted page adds Apple Pay, Google
// Pay and Link on a supported browser), the bank session offers ACH only, verified instantly with
// micro-deposits as the fallback. Both are expired, and the account deleted, afterwards.
// Needs only STRIPE_SECRET_KEY (a sk_test_ key, enforced by preflight); touches no database.
export async function run(_ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  assert(env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'STRIPE_SECRET_KEY is a sandbox (sk_test_) key');
  let count = 0;

  const prefix = `qa-39-VERIFY-METHOD-${Date.now()}`;
  const orgId = randomUUID();
  const account = await createConnectedAccount({
    orgId,
    email: `${prefix.toLowerCase()}-owner@test.invalid`,
    businessName: `${prefix} Verify Org`,
    mcc: '1731',
  });
  const ctx = getStripeForOrg({ stripe_account_id: account.id });
  const opened: string[] = [];

  async function open(method: CheckoutMethod): Promise<Stripe.Checkout.Session> {
    const pricing = priceCheckout({
      invoiceTotalCents: 12500,
      amountDueCents: 12500,
      method,
      description: `${prefix} Invoice`,
    });
    if (!pricing.ok) throw new Error(`pricing refused: ${pricing.error}`);
    const session = await createCheckoutSession({
      pricing,
      method,
      document: { organizationId: orgId, invoiceId: randomUUID(), kind: 'invoice' },
      successUrl: 'https://example.test/success',
      cancelUrl: 'https://example.test/cancel',
    }, ctx);
    opened.push(session.id);
    // Read back what the processor stored, not what we sent.
    return ctx.stripe.checkout.sessions.retrieve(session.id, {}, { stripeAccount: account.id });
  }

  try {
    const card = await open('card');
    if (opts.verbose) console.log(`  card session ${card.id}: types=${card.payment_method_types.join(',')} url=${card.url}`);
    assert(JSON.stringify(card.payment_method_types) === JSON.stringify(['card']), `card session offers card only (got ${card.payment_method_types.join(',')})`);
    count++;
    assert(card.amount_total === 12500, `card session total is $125.00 (got ${card.amount_total})`);
    count++;
    assert(card.metadata?.kind === 'invoice' && card.metadata?.payableNowCents === '12500', 'card session metadata names kind and payable-now');
    count++;

    const bank = await open('bank');
    if (opts.verbose) console.log(`  bank session ${bank.id}: types=${bank.payment_method_types.join(',')} options=${JSON.stringify(bank.payment_method_options)} url=${bank.url}`);
    assert(JSON.stringify(bank.payment_method_types) === JSON.stringify(['us_bank_account']), `bank session offers bank only (got ${bank.payment_method_types.join(',')})`);
    count++;
    const achOptions = bank.payment_method_options?.us_bank_account;
    assert(achOptions?.verification_method === 'automatic', `bank session verifies automatically, micro-deposits as fallback (got ${achOptions?.verification_method})`);
    count++;
    assert(JSON.stringify(achOptions?.financial_connections?.permissions) === JSON.stringify(['payment_method']), 'bank session asks only for the payment_method permission');
    count++;
    assert(bank.amount_total === 12500, `bank session total is $125.00 (got ${bank.amount_total})`);
    count++;
  } finally {
    for (const id of opened) {
      try {
        await ctx.stripe.checkout.sessions.expire(id, {}, { stripeAccount: account.id });
      } catch (err: any) {
        console.log(`  [WARN] could not expire sandbox session ${id}: ${err.message}`);
      }
    }
    const stripe = new Stripe(env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
    try {
      await stripe.accounts.del(account.id);
    } catch (err: any) {
      console.log(`  [WARN] could not delete sandbox account ${account.id}: ${err.message}`);
    }
  }

  return count;
}
