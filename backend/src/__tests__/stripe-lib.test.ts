import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The global setup.ts mocks ../lib/stripe wholesale; this test must exercise
// the REAL module to verify the new getStripeForOrg seam.
vi.unmock('../lib/stripe');

vi.mock('../config/env', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    STRIPE_WEBHOOK_SECRET_CONNECT: 'whsec_connect_dummy',
    NODE_ENV: 'test',
  },
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    deposit: { findUnique: vi.fn(), findFirst: vi.fn() },
    invoice: { findUnique: vi.fn() },
    payment: { findFirst: vi.fn() },
    organization: { findFirst: vi.fn() },
  },
}));

vi.mock('../lib/email', () => ({
  sendDepositPaymentConfirmation: vi.fn(),
  sendDepositPaidAlert: vi.fn(),
  sendPaymentReceivedEmail: vi.fn(),
  sendEstimateApprovedNotification: vi.fn(),
}));

import {
  getStripeForOrg,
  constructWebhookEvent,
  createConnectedAccount,
  createCheckoutSession,
  createRefund,
  CARD_SERVICE_FEE_BPS,
  computeServiceFee,
  estimateStripeFee,
  deriveServiceFeeApplicationFee,
  resolveCheckoutFees,
  CARD_TIP_PRESET_BPS,
} from '../lib/stripe';
import { prisma } from '../lib/prisma';
import { resolveOrgFromEvent } from '../controllers/webhook.controller';

describe('getStripeForOrg', () => {
  it('returns the platform Stripe singleton with stripeAccount=undefined when org.stripe_account_id is null', () => {
    const ctx = getStripeForOrg({ stripe_account_id: null });
    expect(ctx.stripe).toBeDefined();
    expect(ctx.stripeAccount).toBeUndefined();
  });

  it('forwards stripe_account_id to ctx.stripeAccount when set (9C2-ready)', () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_test_connect_123' });
    expect(ctx.stripeAccount).toBe('acct_test_connect_123');
  });

  it('returns the same Stripe singleton across calls', () => {
    const a = getStripeForOrg({ stripe_account_id: null });
    const b = getStripeForOrg({ stripe_account_id: null });
    expect(a.stripe).toBe(b.stripe);
  });
});

describe('resolveOrgFromEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves org via invoiceId metadata (deposit checkout now carries invoiceId)', async () => {
    const mockInvoice = { organization: { id: 'org_2', stripe_account_id: null } };
    (prisma.invoice.findUnique as any).mockResolvedValue(mockInvoice);

    const event = {
      id: 'evt_2',
      type: 'checkout.session.completed',
      account: undefined,
      data: { object: { metadata: { invoiceId: 'inv_1' } } },
    } as any;

    const org = await resolveOrgFromEvent(event);
    expect(org?.id).toBe('org_2');
  });

  it('resolves org via payment_intent for charge.refunded (invoice path)', async () => {
    (prisma.payment.findFirst as any).mockResolvedValue({
      invoice: { organization: { id: 'org_3', stripe_account_id: null } },
    });

    const event = {
      id: 'evt_3',
      type: 'charge.refunded',
      account: undefined,
      data: { object: { payment_intent: 'pi_1' } },
    } as any;

    const org = await resolveOrgFromEvent(event);
    expect(org?.id).toBe('org_3');
  });

  it('returns null when payment lookup misses (no legacy deposit fallback)', async () => {
    (prisma.payment.findFirst as any).mockResolvedValue(null);

    const event = {
      id: 'evt_4',
      type: 'charge.refunded',
      account: undefined,
      data: { object: { payment_intent: 'pi_unknown' } },
    } as any;

    const org = await resolveOrgFromEvent(event);
    expect(org).toBeNull();
  });

  it('uses event.account first when present (9C2 Direct charges)', async () => {
    (prisma.organization.findFirst as any).mockResolvedValue({
      id: 'org_connect',
      stripe_account_id: 'acct_x',
      accepted_payment_methods: ['CARD', 'CHECK'],
    });

    const event = {
      id: 'evt_5',
      type: 'checkout.session.completed',
      account: 'acct_x',
      data: { object: { metadata: { invoiceId: 'inv_should_be_ignored' } } },
    } as any;

    const org = await resolveOrgFromEvent(event);
    expect(org?.id).toBe('org_connect');
    expect(prisma.organization.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { stripe_account_id: 'acct_x' },
    }));
    expect(prisma.invoice.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when no resolution path matches', async () => {
    const event = {
      id: 'evt_6',
      type: 'unknown.event',
      account: undefined,
      data: { object: {} },
    } as any;

    expect(await resolveOrgFromEvent(event)).toBeNull();
  });
});

describe('constructWebhookEvent', () => {
  // restoreAllMocks (not just clearAllMocks) so a spy left mid-queue by a
  // failing assertion can't leak a stale mockImplementationOnce into the next test.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to the Connect secret when the platform secret fails verification', () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    const spy = vi
      .spyOn(stripe.webhooks, 'constructEvent')
      .mockImplementationOnce(() => {
        throw new Error('bad sig');
      })
      .mockImplementationOnce(() => ({ id: 'evt_1', type: 'account.updated' }) as any);

    const ev = constructWebhookEvent(Buffer.from('{}'), 'sig');

    expect(ev.id).toBe('evt_1');
    expect(spy).toHaveBeenCalledTimes(2);
    // Pin the order, not just the count: platform secret first, Connect secret second.
    expect(spy.mock.calls[0][2]).toBe('whsec_dummy');
    expect(spy.mock.calls[1][2]).toBe('whsec_connect_dummy');
  });

  it('does not fall back when the platform secret succeeds (single-secret behavior unchanged)', () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    const spy = vi
      .spyOn(stripe.webhooks, 'constructEvent')
      .mockImplementationOnce(() => ({ id: 'evt_7', type: 'account.updated' }) as any);

    const ev = constructWebhookEvent(Buffer.from('{}'), 'sig');

    expect(ev.id).toBe('evt_7');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toBe('whsec_dummy');
  });
});

describe('createConnectedAccount', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the raw controller-property shape (no deprecated top-level type) and a params-scoped acct-create idempotency key', async () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    const spy = vi.spyOn(stripe.accounts, 'create').mockResolvedValue({ id: 'acct_test_1' } as any);

    await createConnectedAccount({
      orgId: 'org_1',
      email: 'owner@example.com',
      businessName: 'Northwind Services',
      mcc: '1731',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [params, options] = spy.mock.calls[0] as unknown as [any, any];

    expect(params.controller).toEqual({
      // Full (Standard-equivalent) dashboard is REQUIRED with losses.payments:'stripe' — Stripe
      // rejects express+losses:stripe ("platform must be liable"). See the 2026-07-22 decision doc.
      stripe_dashboard: { type: 'full' },
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      requirement_collection: 'stripe',
    });
    expect(params).not.toHaveProperty('type');
    // Params-scoped idempotency key (acct-create:<orgId>:<hash>), NOT a static acct-create:<orgId> —
    // see the stability/uniqueness test below for why. A static key locks to the first attempt's
    // params for 24h and blocks a corrected retry.
    expect(options.idempotencyKey).toMatch(/^acct-create:org_1:[0-9a-f]{16}$/);
  });

  it('derives a params-scoped idempotency key: identical for identical prefill, distinct when any field changes (corrected retry is not locked out for 24h)', async () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    const spy = vi.spyOn(stripe.accounts, 'create').mockResolvedValue({ id: 'acct_idem' } as any);

    const base = { orgId: 'org_9', email: 'owner@example.com', businessName: 'Idem Co', mcc: '1731' } as const;
    await createConnectedAccount({ ...base });
    await createConnectedAccount({ ...base });                               // true retry: identical params
    await createConnectedAccount({ ...base, supportPhone: '+15551234567' }); // corrected data

    const keyOf = (i: number) => (spy.mock.calls[i] as unknown as [any, any])[1].idempotencyKey as string;
    expect(keyOf(0)).toBe(keyOf(1));      // identical params → same key → Stripe dedups (no duplicate account)
    expect(keyOf(2)).not.toBe(keyOf(0));  // any changed field → fresh key → corrected retry proceeds
    expect(keyOf(2)).toMatch(/^acct-create:org_9:[0-9a-f]{16}$/);
  });

  // Real bug caught live in the §13.1 sandbox validation: an account created without
  // requesting any capability sits in `capabilities: {}` forever — Stripe's embedded
  // onboarding component has no capability-driven requirements to walk the contractor
  // through, so "Add information" renders but never advances, and even a fully-KYC'd
  // account could never actually process a card charge or receive a payout.
  it('requests card_payments and transfers capabilities so the account can charge and pay out', async () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    const spy = vi.spyOn(stripe.accounts, 'create').mockResolvedValue({ id: 'acct_caps_1' } as any);

    await createConnectedAccount({
      orgId: 'org_caps',
      email: 'owner@example.com',
      businessName: 'Capabilities Co',
      mcc: '1731',
    });

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.capabilities).toEqual({
      card_payments: { requested: true },
      transfers: { requested: true },
    });
  });

  it('omits business_type and leaves settings empty when no statementDescriptor/brandColorHex/businessType/address are given', async () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    const spy = vi.spyOn(stripe.accounts, 'create').mockResolvedValue({ id: 'acct_test_2' } as any);

    await createConnectedAccount({
      orgId: 'org_2',
      email: null,
      businessName: 'Bare Bones Plumbing',
      mcc: '1711',
    });

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params).not.toHaveProperty('business_type');
    expect(params.settings).toEqual({});
    expect(params.business_profile).not.toHaveProperty('support_address');
  });

  it('includes business_type, statement_descriptor, primary_color, and support_address when provided', async () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    const spy = vi.spyOn(stripe.accounts, 'create').mockResolvedValue({ id: 'acct_test_3' } as any);

    await createConnectedAccount({
      orgId: 'org_3',
      email: 'owner@example.com',
      businessName: 'Full Prefill Co',
      mcc: '1731',
      statementDescriptor: 'FULL PREFILL CO',
      brandColorHex: '#0C2D3A',
      businessType: 'company',
      address: { line1: '123 Main St', city: 'Richmond', state: 'VA', postal_code: '23219' },
    });

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.business_type).toBe('company');
    expect(params.settings).toEqual({
      payments: { statement_descriptor: 'FULL PREFILL CO' },
      branding: { primary_color: '#0C2D3A' },
    });
    expect(params.business_profile.support_address).toEqual({
      line1: '123 Main St',
      city: 'Richmond',
      state: 'VA',
      postal_code: '23219',
      country: 'US',
    });
  });

  // Real bug caught by the §13.1 sandbox gate: orgs backfilled before these
  // columns existed have '' (not null) in phone/address_line2. Stripe rejects
  // an empty string as "an attempt to unset a parameter that cannot be unset" —
  // only omitting the key (or sending undefined) is accepted.
  it('treats empty-string optional fields as absent rather than passing "" through to Stripe', async () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    const spy = vi.spyOn(stripe.accounts, 'create').mockResolvedValue({ id: 'acct_test_4' } as any);

    await createConnectedAccount({
      orgId: 'org_4',
      email: 'owner@example.com',
      businessName: 'Empty String Fields Co',
      mcc: '1731',
      url: '',
      supportEmail: '',
      supportPhone: '',
      address: { line1: '1001 Willow Avenue', line2: '', city: 'Hoboken', state: 'NJ', postal_code: '07030' },
    });

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.business_profile.url).toBeUndefined();
    expect(params.business_profile.support_email).toBeUndefined();
    expect(params.business_profile.support_phone).toBeUndefined();
    expect(params.business_profile.support_address).toEqual({
      line1: '1001 Willow Avenue',
      line2: undefined,
      city: 'Hoboken',
      state: 'NJ',
      postal_code: '07030',
      country: 'US',
    });
  });
});

// Task 3.2 — in-app refund door: createRefund passes refund_application_fee: true when the
// caller asks (direct-charge Payments only; callers decide, this just wires the flag through).
describe('createRefund — reverseApplicationFee (Task 3.2, in-app door)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets refund_application_fee: true when options.reverseApplicationFee is true', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_direct_1' });
    const spy = vi.spyOn(ctx.stripe.refunds, 'create').mockResolvedValue({ id: 're_fee_1' } as any);

    await createRefund('pi_1', ctx, 5000, { metadata: { source: 'in_app' }, reverseApplicationFee: true });

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.refund_application_fee).toBe(true);
    expect(params.amount).toBe(5000);
    expect(params.metadata).toEqual({ source: 'in_app' });
  });

  it('omits refund_application_fee entirely when reverseApplicationFee is false/absent (legacy platform-account payment)', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: null });
    const spy = vi.spyOn(ctx.stripe.refunds, 'create').mockResolvedValue({ id: 're_fee_2' } as any);

    await createRefund('pi_2', ctx, 5000, { metadata: { source: 'in_app' } });

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params).not.toHaveProperty('refund_application_fee');
  });

  it('omits refund_application_fee when explicitly false', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: null });
    const spy = vi.spyOn(ctx.stripe.refunds, 'create').mockResolvedValue({ id: 're_fee_3' } as any);

    await createRefund('pi_3', ctx, undefined, { reverseApplicationFee: false });

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params).not.toHaveProperty('refund_application_fee');
  });
});

// --- Card service fee (Slice 1) -------------------------------------------------------------
// Plan: md_files/plans/payments/2026-08-03-card-service-fee-workiz-parity.md
// The customer funds the whole card-fee stack so the org lands on face value. All three
// functions are pure so the money math is testable without touching Stripe.

describe('CARD_SERVICE_FEE_BPS', () => {
  // D4: a platform constant, deliberately not a column and not org-settable. Pinned because a
  // silent change here re-prices every card payment in the product.
  it('is 350 bps (3.5%)', () => {
    expect(CARD_SERVICE_FEE_BPS).toBe(350);
  });
});

describe('computeServiceFee', () => {
  it('is 3.5% of the base, rounded to the nearest cent', () => {
    expect(computeServiceFee(100000, CARD_SERVICE_FEE_BPS)).toBe(3500);  // $1,000.00 → $35.00
    expect(computeServiceFee(200000, CARD_SERVICE_FEE_BPS)).toBe(7000);  // $2,000.00 → $70.00
    expect(computeServiceFee(4500, CARD_SERVICE_FEE_BPS)).toBe(158);     // $45.00 → $1.58 (rounds up from 157.5)
  });

  // Arithmetic fixture taken from the Workiz totals panel Ran supplied 2026-08-03. Their basis
  // included a tip and ours does not (D7 amendment), so this pins the rounding, NOT parity.
  it('matches the reference figure at cent-boundary rounding', () => {
    expect(computeServiceFee(517653, CARD_SERVICE_FEE_BPS)).toBe(18118); // 18117.855 → 18118
  });

  it('is zero at zero bps and zero base', () => {
    expect(computeServiceFee(100000, 0)).toBe(0);
    expect(computeServiceFee(0, CARD_SERVICE_FEE_BPS)).toBe(0);
  });
});

describe('estimateStripeFee', () => {
  // 2.9% + $0.30 on the GROSS the customer is charged (base + service fee), which is what
  // Stripe actually takes its percentage of.
  it('is 2.9% of gross plus 30 cents', () => {
    expect(estimateStripeFee(103500)).toBe(3032);  // $1,035.00 → $30.32
    expect(estimateStripeFee(207000)).toBe(6033);  // $2,070.00 → $60.33
    expect(estimateStripeFee(4658)).toBe(165);     // $46.58 → $1.65
  });

  it('still charges the fixed 30 cents on a zero-amount gross', () => {
    expect(estimateStripeFee(0)).toBe(30);
  });
});

describe('deriveServiceFeeApplicationFee', () => {
  // D2: the service fee REPLACES the platform fee on card payments. ServWave keeps whatever is
  // left after Stripe, so the org receives face value. These are the worked rows from the plan.
  it('leaves the org whole and hands ServWave the remainder', () => {
    expect(deriveServiceFeeApplicationFee(100000)).toBe(468);  // $1,000 job → ServWave $4.68
    expect(deriveServiceFeeApplicationFee(200000)).toBe(967);  // $2,000 deposit → ServWave $9.67
    expect(deriveServiceFeeApplicationFee(120000)).toBe(568);  // $1,200 balance → ServWave $5.68
  });

  // D2 consequence 1. Below a base of ~$60.18 Stripe's fixed 30c outruns the 3.5%, so the
  // derived fee goes negative. Stripe rejects a negative application fee, and we must never
  // bill the org for the gap, so it clamps to zero and ServWave simply earns nothing.
  it('clamps to zero below the break-even base instead of going negative', () => {
    expect(deriveServiceFeeApplicationFee(4500)).toBe(0);   // $45.00: raw would be -7
    expect(deriveServiceFeeApplicationFee(1000)).toBe(0);   // $10.00
    expect(deriveServiceFeeApplicationFee(0)).toBe(0);
  });

  it('is zero at the break-even base and positive just above it', () => {
    expect(deriveServiceFeeApplicationFee(6018)).toBe(0);   // $60.18, the documented break-even
    expect(deriveServiceFeeApplicationFee(6100)).toBeGreaterThan(0);
  });

  // The fee is computed on what is being paid NOW, so a customer settling half an invoice is
  // charged 3.5% of that half. Guards against anyone re-pointing this at Invoice.total_amount.
  it('scales with the amount passed, not with any invoice total', () => {
    expect(deriveServiceFeeApplicationFee(120000)).toBeLessThan(deriveServiceFeeApplicationFee(200000));
  });
});

// Task 3.1 — the double guard: application_fee_amount must be a positive integer AND the
// session must be running against a connected account (ctx.stripeAccount set). Getting this
// wrong in either direction either 400s every legacy platform-account checkout or silently
// drops ServWave's fee on connected-account checkouts, so all three combinations are pinned here.
describe('createCheckoutSession — platform fee double guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits application_fee_amount on a platform-account session (ctx.stripeAccount undefined) even when a fee is passed', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: null });
    const spy = vi
      .spyOn(ctx.stripe.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_platform_1', url: 'https://checkout.stripe.com/platform' } as any);

    await createCheckoutSession({
      depositAmount: 100,
      description: 'Platform-account checkout',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: {},
      applicationFeeAmount: 2500,
    }, ctx);

    const [params, options] = spy.mock.calls[0] as unknown as [any, any];
    // Face-value charge to the homeowner is untouched — the fee is a separate field, not
    // folded into what the customer pays.
    expect(params.line_items[0].price_data.unit_amount).toBe(10000);
    expect(params).not.toHaveProperty('payment_intent_data');
    expect(options).toBeUndefined();
  });

  it('includes application_fee_amount only when positive AND stripeAccount is set (connected account)', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_connected_1' });
    const spy = vi
      .spyOn(ctx.stripe.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_connected_1', url: 'https://checkout.stripe.com/connected' } as any);

    await createCheckoutSession({
      depositAmount: 100,
      description: 'Connected-account checkout',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: {},
      applicationFeeAmount: 2500,
    }, ctx);

    const [params, options] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.line_items[0].price_data.unit_amount).toBe(10000); // homeowner still pays face value
    expect(params.payment_intent_data).toEqual({ application_fee_amount: 2500 });
    expect(options).toEqual({ stripeAccount: 'acct_connected_1' });
  });

  it('omits application_fee_amount when stripeAccount is set but the fee is zero (bps=0)', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_connected_2' });
    const spy = vi
      .spyOn(ctx.stripe.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_connected_2', url: 'https://checkout.stripe.com/connected2' } as any);

    await createCheckoutSession({
      depositAmount: 100,
      description: 'Zero-fee connected-account checkout',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: {},
      applicationFeeAmount: 0,
    }, ctx);

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params).not.toHaveProperty('payment_intent_data');
  });
});

// Slice 2 (checkout wiring) — md_files/plans/payments/2026-08-03-card-service-fee-workiz-parity.md
describe('createCheckoutSession — service fee line item', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds a second "Service fee" line item and carries serviceFeeCents in metadata when serviceFeeAmount is positive', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_connected_fee' });
    const spy = vi
      .spyOn(ctx.stripe.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_fee_1', url: 'https://checkout.stripe.com/fee' } as any);

    await createCheckoutSession({
      depositAmount: 1000,
      description: 'Payment for Invoice I00001',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: { invoiceId: 'inv_1' },
      applicationFeeAmount: 468,
      serviceFeeAmount: 3500,
    }, ctx);

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.line_items).toHaveLength(2);
    expect(params.line_items[0].price_data.unit_amount).toBe(100000);
    expect(params.line_items[1]).toEqual({
      price_data: {
        currency: 'usd',
        unit_amount: 3500,
        product_data: { name: 'Service fee' },
      },
      quantity: 1,
    });
    expect(params.metadata).toEqual({ invoiceId: 'inv_1', serviceFeeCents: '3500' });
  });

  it('emits a single line item and no serviceFeeCents metadata when serviceFeeAmount is absent', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_connected_no_fee' });
    const spy = vi
      .spyOn(ctx.stripe.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_no_fee', url: 'https://checkout.stripe.com/no-fee' } as any);

    await createCheckoutSession({
      depositAmount: 1000,
      description: 'Payment for Invoice I00001',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: { invoiceId: 'inv_1' },
    }, ctx);

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.line_items).toHaveLength(1);
    expect(params.metadata).toEqual({ invoiceId: 'inv_1' });
  });

  it('emits a single line item and no serviceFeeCents metadata when serviceFeeAmount is zero', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_connected_zero_fee' });
    const spy = vi
      .spyOn(ctx.stripe.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_zero_fee', url: 'https://checkout.stripe.com/zero-fee' } as any);

    await createCheckoutSession({
      depositAmount: 1000,
      description: 'Payment for Invoice I00001',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: { invoiceId: 'inv_1' },
      serviceFeeAmount: 0,
    }, ctx);

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.line_items).toHaveLength(1);
    expect(params.metadata).toEqual({ invoiceId: 'inv_1' });
  });
});

// D2 — the service fee REPLACES the platform fee on card payments; it does not stack. It is
// UNCONDITIONAL: a card payment always carries it, so there is no org input to this at all.
describe('resolveCheckoutFees', () => {
  it('returns the derived service fee + application fee for any card checkout', () => {
    expect(resolveCheckoutFees(100000)).toEqual({ serviceFeeAmount: 3500, applicationFeeAmount: 468 });
  });

  it('takes the amount alone - no org argument, so no org can opt out', () => {
    expect(resolveCheckoutFees.length).toBe(1);
  });

  // Below the ~$60.18 break-even Stripe's fixed 30c outruns the 3.5%: the customer still pays the
  // fee, ServWave just earns nothing on it. The fee itself is never suppressed.
  it('still charges the service fee on a small ticket where our application fee clamps to zero', () => {
    expect(resolveCheckoutFees(1000)).toEqual({ serviceFeeAmount: 35, applicationFeeAmount: 0 });
  });
});

// Slice 7 (customer-facing tipping, D10/D11) — md_files/plans/payments/2026-08-03-card-service-fee-workiz-parity.md
describe('CARD_TIP_PRESET_BPS', () => {
  it('is the three Jobber-style presets: 10%, 15%, 20%', () => {
    expect(CARD_TIP_PRESET_BPS).toEqual([1000, 1500, 2000]);
  });
});

describe('createCheckoutSession — tip line item (Slice 7)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds a third "Tip" line item and carries tipCents in metadata when tipAmount is positive', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_connected_tip' });
    const spy = vi
      .spyOn(ctx.stripe.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_tip_1', url: 'https://checkout.stripe.com/tip' } as any);

    await createCheckoutSession({
      depositAmount: 1000,
      description: 'Payment for Invoice I00001',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: { invoiceId: 'inv_1' },
      applicationFeeAmount: 468,
      serviceFeeAmount: 3500,
      tipAmount: 15000,
    }, ctx);

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.line_items).toHaveLength(3);
    expect(params.line_items[2]).toEqual({
      price_data: {
        currency: 'usd',
        unit_amount: 15000,
        product_data: { name: 'Tip' },
      },
      quantity: 1,
    });
    expect(params.metadata).toEqual({ invoiceId: 'inv_1', serviceFeeCents: '3500', tipCents: '15000' });
  });

  it('emits no third line item and no tipCents metadata when tipAmount is absent or zero', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_connected_no_tip' });
    const spy = vi
      .spyOn(ctx.stripe.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_no_tip', url: 'https://checkout.stripe.com/no-tip' } as any);

    await createCheckoutSession({
      depositAmount: 1000,
      description: 'Payment for Invoice I00001',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: { invoiceId: 'inv_1' },
      tipAmount: 0,
    }, ctx);

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.line_items).toHaveLength(1);
    expect(params.metadata).toEqual({ invoiceId: 'inv_1' });
  });

  it('can carry a tip with no service fee (org disabled, tip still allowed)', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_connected_tip_only' });
    const spy = vi
      .spyOn(ctx.stripe.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_tip_only', url: 'https://checkout.stripe.com/tip-only' } as any);

    await createCheckoutSession({
      depositAmount: 1000,
      description: 'Payment for Invoice I00001',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: { invoiceId: 'inv_1' },
      tipAmount: 10000,
    }, ctx);

    const [params] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.line_items).toHaveLength(2);
    expect(params.line_items[1].price_data.product_data.name).toBe('Tip');
    expect(params.metadata).toEqual({ invoiceId: 'inv_1', tipCents: '10000' });
  });
});
