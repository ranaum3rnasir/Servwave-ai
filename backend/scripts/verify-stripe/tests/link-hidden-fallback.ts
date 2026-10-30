import type Stripe from 'stripe';
import { env } from '../../../src/config/env';
import { prisma } from '../../../src/lib/prisma';
import { LINK_HIDING_API_VERSION, createCheckoutSession, getStripeForOrg } from '../../../src/lib/stripe';
import { priceCheckout } from '../../../src/lib/checkout-pricing';
import type { SuiteContext } from '../context';
import {
  assert, chargingOrgId, deleteSeeded, deliverAsAccount, label, payByCard, paymentsOf, realEvents, removeFixtures, seedInvoice,
  sinceNow, waitFor, withOrgSettings,
} from '../harness';

// Payments go-live slice 38 (D19), the Link-hiding fallback with PAYMENTS_HIDE_LINK_ON_CARD on.
// On the charging account (a demo org's onboarded sandbox account), opens a card session through
// the app's own builder and checks that (1) the processor accepts the call at the basil version,
// (2) the session reads back with Link hidden, and (3) a card payment on that session (the
// tok_visa recipe through the payment_pages confirm, nothing typed anywhere), booked from the
// processor's own completed-session event, still lands exactly one Payment, so the event shape the
// handlers read is unchanged.
export async function run(ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  assert(env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'STRIPE_SECRET_KEY is a sandbox (sk_test_) key');
  let count = 0;
  const orgId = await chargingOrgId(ctx);
  const account = ctx.chargingAccount!;
  const previous = env.PAYMENTS_HIDE_LINK_ON_CARD;
  (env as unknown as Record<string, unknown>).PAYMENTS_HIDE_LINK_ON_CARD = true;
  const amountCents = 12500;
  const stripeCtx = getStripeForOrg({ stripe_account_id: account });
  let sessionId: string | undefined;

  try {
    return await withOrgSettings(orgId, { stripe_charges_enabled: true, accepted_payment_methods: ['CARD', 'ACH'] }, async () => {
      const inv = await seedInvoice(orgId, { kind: 'STANDARD', totalCents: amountCents });
      try {
        const pricing = priceCheckout({ invoiceTotalCents: amountCents, amountDueCents: amountCents, method: 'card', description: `qa-39 ${inv.number}` });
        if (!pricing.ok) throw new Error(`pricing refused: ${pricing.error}`);
        const since = sinceNow();
        const session = await createCheckoutSession({
          pricing, method: 'card',
          document: { organizationId: orgId, invoiceId: inv.id, kind: 'invoice' },
          successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel',
        }, stripeCtx);
        sessionId = session.id;
        count++; // the processor accepted the call (the option and the version)

        const stored = await ctx.stripe.checkout.sessions.retrieve(session.id, {}, {
          stripeAccount: account, apiVersion: LINK_HIDING_API_VERSION as Stripe.LatestApiVersion,
        }) as unknown as { payment_method_types: string[]; wallet_options?: { link?: { display?: string } } };
        if (opts.verbose) console.log(`  session ${session.id}: types=${stored.payment_method_types.join(',')} wallet_options=${JSON.stringify(stored.wallet_options)}`);
        assert(JSON.stringify(stored.payment_method_types) === JSON.stringify(['card']), `session is card only (got ${stored.payment_method_types.join(',')})`);
        count++;
        assert(stored.wallet_options?.link?.display === 'never', `session reads back with Link hidden (got ${JSON.stringify(stored.wallet_options)})`);
        count++;

        await payByCard(ctx, session.id, amountCents);
        const events = await realEvents(ctx, { type: 'checkout.session.completed', since, match: (o) => o.id === session.id });
        await deliverAsAccount(events, account);
        count++;

        const [payment, ...others] = await waitFor('the payment', async () => {
          const rows = await paymentsOf(inv.id);
          return rows.length > 0 ? rows : null;
        });
        assert(others.length === 0, `exactly one payment booked (got ${others.length + 1})`);
        assert(payment.state === 'SUCCEEDED' && payment.method === 'CARD', `a SUCCEEDED card payment (got ${payment.state} ${payment.method})`);
        assert(payment.stripe_checkout_session_id === session.id, 'the payment names the Link-hidden session');
        assert(payment.card_brand === 'visa' && payment.card_last4 === '4242', `card details filled (got ${payment.card_brand} ${payment.card_last4})`);
        count++;
        const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
        assert(invoice.status === 'PAID', `invoice PAID (got ${invoice.status})`);
        count++;
        ctx.booked.push({ flow: 'link-hidden-fallback', orgId, paymentId: payment.id, chargeId: payment.stripe_charge_id, intentId: payment.stripe_payment_intent_id });
        return count;
      } finally {
        await removeFixtures(label(inv, orgId), () => deleteSeeded(orgId, inv));
      }
    });
  } finally {
    (env as unknown as Record<string, unknown>).PAYMENTS_HIDE_LINK_ON_CARD = previous;
    if (sessionId) {
      try {
        await stripeCtx.stripe.checkout.sessions.expire(sessionId, {}, { stripeAccount: account });
      } catch { /* already complete after the payment step */ }
    }
  }
}
