import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { env } from '../../../src/config/env';
import { STRIPE_API_VERSION, createCheckoutSession, createConnectedAccount, getStripeForOrg } from '../../../src/lib/stripe';
import { priceCheckout } from '../../../src/lib/checkout-pricing';
import type { SuiteContext } from '../context';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Payments go-live slice 38 (D19). Klarna-inside-Link launch gate, the part the API can prove.
// On a fresh no-dashboard connected account, opens a card session through the app's own builder
// and reads back what the processor stored:
//   - Klarna is not offered as a method on the session (card only);
//   - Link is still offered: the platform's payment method configuration has Link available, and
//     the session was NOT built with the Link-hiding fallback (this flow stays on the pinned API
//     version, so a session read back at that version carries no wallet option to hide Link);
//   - the platform's default payment method configuration exposes no Klarna-through-Link switch
//     in the API (it is a dashboard setting), so whether a Link user sees "Pay later" is recorded
//     from the browser check in the go-live runbook, not asserted here.
// Needs only STRIPE_SECRET_KEY (sk_test_); touches no database.
export async function run(_ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  assert(env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'STRIPE_SECRET_KEY is a sandbox (sk_test_) key');
  let count = 0;

  const prefix = `qa-39-VERIFY-LINK-${Date.now()}`;
  const orgId = randomUUID();
  const platform = new Stripe(env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
  const account = await createConnectedAccount({
    orgId,
    email: `${prefix.toLowerCase()}-owner@test.invalid`,
    businessName: `${prefix} Verify Org`,
    mcc: '1731',
  });
  const ctx = getStripeForOrg({ stripe_account_id: account.id });
  let sessionId: string | undefined;

  try {
    const pricing = priceCheckout({ invoiceTotalCents: 12500, amountDueCents: 12500, method: 'card', description: `${prefix} Invoice` });
    if (!pricing.ok) throw new Error(`pricing refused: ${pricing.error}`);
    const session = await createCheckoutSession({
      pricing,
      method: 'card',
      document: { organizationId: orgId, invoiceId: randomUUID(), kind: 'invoice' },
      successUrl: 'https://example.test/success',
      cancelUrl: 'https://example.test/cancel',
    }, ctx);
    sessionId = session.id;
    const stored = await ctx.stripe.checkout.sessions.retrieve(session.id, {}, { stripeAccount: account.id });
    if (opts.verbose) console.log(`  card session ${stored.id}: types=${stored.payment_method_types.join(',')}`);

    assert(JSON.stringify(stored.payment_method_types) === JSON.stringify(['card']), `card session offers card only (got ${stored.payment_method_types.join(',')})`);
    count++;
    assert(!stored.payment_method_types.includes('klarna'), 'card session does not offer Klarna as a method');
    count++;
    assert(!JSON.stringify(stored).includes('"display":"never"'), 'card session is not built with the Link-hiding option while the gate has not failed');
    count++;

    const configs = await platform.paymentMethodConfigurations.list({ limit: 10 });
    const platformDefault = configs.data.find((c) => c.is_default) ?? configs.data[0];
    assert(platformDefault, 'the platform has a payment method configuration');
    count++;
    assert(platformDefault.link?.available === true, 'Link is available on the platform configuration, so card sessions still show it');
    count++;
  } finally {
    if (sessionId) {
      try {
        await ctx.stripe.checkout.sessions.expire(sessionId, {}, { stripeAccount: account.id });
      } catch (err: any) {
        console.log(`  [WARN] could not expire sandbox session ${sessionId}: ${err.message}`);
      }
    }
    try {
      await platform.accounts.del(account.id);
    } catch (err: any) {
      console.log(`  [WARN] could not delete sandbox account ${account.id}: ${err.message}`);
    }
  }
  return count;
}
