import { describe, it, expect, vi, afterEach } from 'vitest';
import type Stripe from 'stripe';
import { priceCheckout } from '../lib/checkout-pricing';
import { env } from '../config/env';

// The shared setup stubs the Stripe wrapper; this test needs the real session builder.
const realStripeLib = () => vi.importActual<typeof import('../lib/stripe')>('../lib/stripe');

// Payments go-live slice 38 (D19): until the Klarna-inside-Link gate fails, a card session is
// plain card, never names Klarna, and never carries the Link-hiding wallet option or a per-call
// API version (the basil pin is the fallback, used only if the gate fails).
function capture() {
  const calls: { params: any; options: any }[] = [];
  const stripe = {
    checkout: { sessions: { create: async (params: any, options: any) => { calls.push({ params, options }); return { id: 'cs_test_x' }; } } },
  } as unknown as Stripe;
  return { calls, stripe };
}

describe('card checkout session and the Klarna-in-Link gate', () => {
  it('sends card only, with no Klarna, no Link-hiding option and no per-call API version', async () => {
    const { createCheckoutSession } = await realStripeLib();
    const { calls, stripe } = capture();
    const pricing = priceCheckout({ invoiceTotalCents: 12500, amountDueCents: 12500, method: 'card', description: 'Invoice' });
    if (!pricing.ok) throw new Error('pricing refused');
    await createCheckoutSession({
      pricing, method: 'card',
      document: { organizationId: 'org-1', invoiceId: 'inv-1', kind: 'invoice' },
      successUrl: 'https://example.test/s', cancelUrl: 'https://example.test/c',
    }, { stripe, stripeAccount: 'acct_1' });

    expect(calls).toHaveLength(1);
    const { params, options } = calls[0];
    expect(params.payment_method_types).toEqual(['card']);
    expect(JSON.stringify(params)).not.toMatch(/klarna/i);
    expect(params.wallet_options).toBeUndefined();
    expect(options).toEqual({ stripeAccount: 'acct_1' });
    expect(options.apiVersion).toBeUndefined();
  });

  it('keeps the platform on the pinned API version', async () => {
    const { STRIPE_API_VERSION } = await realStripeLib();
    expect(STRIPE_API_VERSION).toBe('2025-02-24.acacia');
  });
});

// The fallback: PAYMENTS_HIDE_LINK_ON_CARD (default off). On, the card session call and only that
// call hides Link, with the basil API version pinned on that one call.
describe('Link-hiding fallback (PAYMENTS_HIDE_LINK_ON_CARD)', () => {
  const setSwitch = (v: boolean | undefined) => { (env as unknown as Record<string, unknown>).PAYMENTS_HIDE_LINK_ON_CARD = v; };
  const doc = { organizationId: 'org-1', invoiceId: 'inv-1', kind: 'invoice' as const };
  const urls = { successUrl: 'https://example.test/s', cancelUrl: 'https://example.test/c' };
  afterEach(() => setSwitch(undefined));

  async function open(method: 'card' | 'bank') {
    const { createCheckoutSession } = await realStripeLib();
    const { calls, stripe } = capture();
    const pricing = priceCheckout({ invoiceTotalCents: 12500, amountDueCents: 12500, method, description: 'Invoice' });
    if (!pricing.ok) throw new Error('pricing refused');
    await createCheckoutSession({ pricing, method, document: doc, ...urls }, { stripe, stripeAccount: 'acct_1' });
    return calls[0];
  }

  it('switch on: the card session hides Link and pins the basil version on that call', async () => {
    setSwitch(true);
    const { params, options } = await open('card');
    expect(params.wallet_options).toEqual({ link: { display: 'never' } });
    expect(params.payment_method_types).toEqual(['card']);
    expect(options).toEqual({ stripeAccount: 'acct_1', apiVersion: '2025-04-30.basil' });
  });

  it('switch on: the bank session is untouched and stays on the platform version', async () => {
    setSwitch(true);
    const { params, options } = await open('bank');
    expect(params.wallet_options).toBeUndefined();
    expect(options).toEqual({ stripeAccount: 'acct_1' });
  });

  it('switch off: no wallet option and no per-call version', async () => {
    setSwitch(false);
    const { params, options } = await open('card');
    expect(params.wallet_options).toBeUndefined();
    expect(options).toEqual({ stripeAccount: 'acct_1' });
  });
});
