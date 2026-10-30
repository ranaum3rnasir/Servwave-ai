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
  updateAccountBranding,
  createCheckoutSession,
  createRefund,
  CARD_TIP_PRESET_BPS,
} from '../lib/stripe';
import { priceCheckout, type PricedCheckout } from '../lib/checkout-pricing';
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
      businessName: 'Test Doors Co',
      mcc: '1731',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [params, options] = spy.mock.calls[0] as unknown as [any, any];

    // D13 (payments go-live, 2026-10-05): the no-dashboard ("fully embedded") model. The contractor
    // never gets a processor login; it still pays the processor and the processor carries losses
    // and collects requirements. The account type is fixed at creation, so this block is pinned.
    expect(params.controller).toEqual({
      stripe_dashboard: { type: 'none' },
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
  it('requests card_payments, transfers and ACH bank debit capabilities so the account can charge, debit a bank and pay out', async () => {
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
      us_bank_account_ach_payments: { requested: true },
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

// --- Checkout session builder ---------------------------------------------------------------
// Payments go-live slice 02: the builder charges exactly the lines the pricing module priced and
// never sends an application fee (D9). The route-level twin is checkout-pricing-routes.test.ts.

// Slice 7 (customer-facing tipping, D10/D11) — md_files/plans/payments/2026-08-03-card-service-fee-workiz-parity.md
describe('CARD_TIP_PRESET_BPS', () => {
  it('is the three Jobber-style presets: 10%, 15%, 20%', () => {
    expect(CARD_TIP_PRESET_BPS).toEqual([1000, 1500, 2000]);
  });
});

describe('createCheckoutSession — charges the priced lines, never an application fee', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function priced(tipCents: number): PricedCheckout {
    const result = priceCheckout({ invoiceTotalCents: 100000, amountDueCents: 100000, tipCents, method: 'card', description: 'Payment for Invoice I00001' });
    if (!result.ok) throw new Error(`unexpected pricing refusal: ${result.error}`);
    return result;
  }

  it('sends one line per priced line, in order, on the connected account, with no application fee', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_connected_1' });
    const spy = vi
      .spyOn(ctx.stripe.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_connected_1', url: 'https://checkout.stripe.com/connected' } as any);

    await createCheckoutSession({
      pricing: priced(15000),
      method: 'card',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      document: { organizationId: 'org_1', invoiceId: 'inv_1', kind: 'invoice' },
    }, ctx);

    const [params, options] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.line_items).toEqual([
      { price_data: { currency: 'usd', unit_amount: 100000, product_data: { name: 'Payment for Invoice I00001' } }, quantity: 1 },
      { price_data: { currency: 'usd', unit_amount: 15000, product_data: { name: 'Tip' } }, quantity: 1 },
    ]);
    expect(params).not.toHaveProperty('payment_intent_data');
    expect(params.metadata).toEqual({ organizationId: 'org_1', invoiceId: 'inv_1', kind: 'invoice', payableNowCents: '100000', tipCents: '15000' });
    expect(options).toEqual({ stripeAccount: 'acct_connected_1' });
  });

  it('carries no tipCents metadata when there is no tip, and no request options on a platform-account session', async () => {
    const ctx = getStripeForOrg({ stripe_account_id: null });
    const spy = vi
      .spyOn(ctx.stripe.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_platform_1', url: 'https://checkout.stripe.com/platform' } as any);

    await createCheckoutSession({
      pricing: priced(0),
      method: 'card',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      document: { organizationId: 'org_1', invoiceId: 'inv_1', kind: 'invoice' },
    }, ctx);

    const [params, options] = spy.mock.calls[0] as unknown as [any, any];
    expect(params.line_items).toHaveLength(1);
    expect(params).not.toHaveProperty('payment_intent_data');
    expect(params.metadata).toEqual({ organizationId: 'org_1', invoiceId: 'inv_1', kind: 'invoice', payableNowCents: '100000' });
    expect(options).toBeUndefined();
  });
});


// Payments go-live slice 36: the contractor's name, colour and logo live on the connected account's
// branding settings; the hosted checkout reads them from there.
describe('updateAccountBranding', () => {
  it('writes the colour to the account branding settings only, and uploads no file when there is no logo', async () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    const create = vi.spyOn(stripe.files, 'create');
    const update = vi.spyOn(stripe.accounts, 'update').mockResolvedValue({ id: 'acct_b1' } as any);

    await updateAccountBranding('acct_b1', { primaryColor: '#0C2D3A' });

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('acct_b1', { settings: { branding: { primary_color: '#0C2D3A' } } });
  });

  it('uploads the logo as a business logo and points the account at the file', async () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    const create = vi.spyOn(stripe.files, 'create').mockResolvedValue({ id: 'file_logo_1' } as any);
    const update = vi.spyOn(stripe.accounts, 'update').mockResolvedValue({ id: 'acct_b2' } as any);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await updateAccountBranding('acct_b2', { primaryColor: '#0C2D3A', logo: { data: png, mime: 'image/png' } });

    const [fileParams] = create.mock.calls[0] as unknown as [any];
    expect(fileParams.purpose).toBe('business_logo');
    expect(fileParams.file.data).toBe(png);
    expect(update).toHaveBeenCalledWith('acct_b2', {
      settings: { branding: { primary_color: '#0C2D3A', logo: 'file_logo_1' } },
    });
  });

  it('sends only what it was given', async () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    const update = vi.spyOn(stripe.accounts, 'update').mockResolvedValue({ id: 'acct_b3' } as any);

    await updateAccountBranding('acct_b3', { primaryColor: '#112233' });

    expect(update).toHaveBeenCalledWith('acct_b3', { settings: { branding: { primary_color: '#112233' } } });
  });
});

// D1 (staging acceptance): on a platform-controlled account the processor refuses business_profile, so the
// whole update failed and nothing was applied. The branding call carries settings.branding and nothing else.
describe('updateAccountBranding on a platform-controlled account', () => {
  it('never sends business_profile or any top-level parameter besides settings, even if handed a name', async () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    vi.spyOn(stripe.files, 'create').mockResolvedValue({ id: 'file_logo_9' } as any);
    const update = vi.spyOn(stripe.accounts, 'update').mockResolvedValue({ id: 'acct_b9' } as any);
    update.mockClear();

    await updateAccountBranding('acct_b9', {
      name: 'Harbor Locksmiths', primaryColor: '#0C2D3A', logo: { data: Buffer.from([1]), mime: 'image/png' },
    } as any);

    const [, params] = update.mock.calls[0] as unknown as [string, any];
    expect(Object.keys(params)).toEqual(['settings']);
    expect(Object.keys(params.settings)).toEqual(['branding']);
    expect(params).not.toHaveProperty('business_profile');
  });

  it('applies colour and logo on an account that refuses business_profile', async () => {
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    vi.spyOn(stripe.files, 'create').mockResolvedValue({ id: 'file_logo_8' } as any);
    const applied: any[] = [];
    vi.spyOn(stripe.accounts, 'update').mockImplementation((async (_id: string, params: any) => {
      if ('business_profile' in params) throw new Error("This application does not have the required permissions for the parameter 'business_profile'");
      applied.push(params);
      return { id: 'acct_b8' };
    }) as any);

    await updateAccountBranding('acct_b8', {
      name: 'Harbor Locksmiths', primaryColor: '#1E8449', logo: { data: Buffer.from([1]), mime: 'image/png' },
    } as any);

    expect(applied).toEqual([{ settings: { branding: { primary_color: '#1E8449', logo: 'file_logo_8' } } }]);
  });
});

describe('hosted checkout branding', () => {
  it('is never set per session: the account settings carry it', async () => {
    const src = (await import('fs')).readFileSync((await import('path')).join(__dirname, '../lib/stripe.ts'), 'utf8');
    expect(src).not.toMatch(/branding_settings/);
  });
});
