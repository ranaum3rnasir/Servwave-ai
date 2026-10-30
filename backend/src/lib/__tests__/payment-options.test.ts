/**
 * Payments go-live slice 19 - the payment options resolver (PRD Module 6).
 *
 * One pure function decides a document's effective options from the org's defaults, the
 * document's overrides and what the org's payout account can take. Every expected value below is
 * written out from the slice's rules, never recomputed the way the resolver computes it.
 */
import { describe, it, expect } from 'vitest';
import { paymentOptionsFor, resolvePaymentOptions, tipPresetAmountsCents } from '../payment-options';

const ORG = {
  methods: ['CARD', 'CHECK', 'CASH'] as const,
  tips_enabled: false,
  tip_presets: [10, 15, 20],
  deposit_policy: 'REQUIRED_BEFORE_APPROVAL' as const,
  bank_transfer_instructions: null,
};

describe('resolvePaymentOptions: org defaults alone', () => {
  it('offers the org default methods, no tips, no partial payment, and the org deposit policy', () => {
    const options = resolvePaymentOptions({
      org: { ...ORG, methods: [...ORG.methods] },
      capabilities: { card: true, ach: false },
    });

    expect(options.methods).toEqual(['CARD', 'CHECK', 'CASH']);
    expect(options.online_methods).toEqual(['CARD']);
    expect(options.tips).toEqual({ enabled: false, presets: [] });
    expect(options.allow_partial).toBe(false);
    expect(options.deposit_policy).toBe('REQUIRED_BEFORE_APPROVAL');
  });
});

describe('resolvePaymentOptions: an online method needs the account capability', () => {
  const cases: Array<{
    name: string;
    methods: string[];
    capabilities: { card: boolean; ach: boolean };
    methodsOut: string[];
    onlineOut: string[];
  }> = [
    {
      name: 'ACH listed, no ACH capability: not offered',
      methods: ['CARD', 'ACH', 'CHECK'],
      capabilities: { card: true, ach: false },
      methodsOut: ['CARD', 'CHECK'],
      onlineOut: ['CARD'],
    },
    {
      name: 'ACH listed, ACH capability active: offered',
      methods: ['CARD', 'ACH', 'CHECK'],
      capabilities: { card: true, ach: true },
      methodsOut: ['CARD', 'ACH', 'CHECK'],
      onlineOut: ['CARD', 'ACH'],
    },
    {
      name: 'CARD listed, no card capability: not offered, manual methods stay',
      methods: ['CARD', 'EXTERNAL_CARD', 'CASH'],
      capabilities: { card: false, ach: false },
      methodsOut: ['EXTERNAL_CARD', 'CASH'],
      onlineOut: [],
    },
    {
      name: 'both capabilities but neither listed: nothing online is added',
      methods: ['CHECK'],
      capabilities: { card: true, ach: true },
      methodsOut: ['CHECK'],
      onlineOut: [],
    },
  ];

  it.each(cases)('$name', ({ methods, capabilities, methodsOut, onlineOut }) => {
    const options = resolvePaymentOptions({
      org: { ...ORG, methods: methods as never },
      capabilities,
    });
    expect(options.methods).toEqual(methodsOut);
    expect(options.online_methods).toEqual(onlineOut);
  });
});

describe('resolvePaymentOptions: tips are org-level only', () => {
  it('offers the org presets when the org switched tips on', () => {
    const options = resolvePaymentOptions({
      org: { ...ORG, methods: ['CARD'], tips_enabled: true, tip_presets: [5, 12, 18] },
      capabilities: { card: true, ach: false },
    });
    expect(options.tips).toEqual({ enabled: true, presets: [5, 12, 18] });
  });
});

describe('resolvePaymentOptions: org defaults x document overrides x capabilities', () => {
  const cases: Array<{
    name: string;
    orgMethods: string[];
    orgPolicy?: 'REQUIRED_BEFORE_APPROVAL' | 'PAY_LATER';
    document: Record<string, unknown>;
    capabilities: { card: boolean; ach: boolean };
    methodsOut: string[];
    partialOut: boolean;
    policyOut: 'REQUIRED_BEFORE_APPROVAL' | 'PAY_LATER';
  }> = [
    {
      name: 'invoice with no override: org default methods, partial off',
      orgMethods: ['CARD', 'CHECK'],
      document: { methods: null, allow_partial: null },
      capabilities: { card: true, ach: true },
      methodsOut: ['CARD', 'CHECK'],
      partialOut: false,
      policyOut: 'REQUIRED_BEFORE_APPROVAL',
    },
    {
      name: 'invoice made bank-only: the override replaces the org default',
      orgMethods: ['CARD', 'CHECK'],
      document: { methods: ['ACH'], allow_partial: true },
      capabilities: { card: true, ach: true },
      methodsOut: ['ACH'],
      partialOut: true,
      policyOut: 'REQUIRED_BEFORE_APPROVAL',
    },
    {
      name: 'invoice override lists ACH but the account has no ACH capability',
      orgMethods: ['CARD'],
      document: { methods: ['ACH', 'CHECK'], allow_partial: false },
      capabilities: { card: true, ach: false },
      methodsOut: ['CHECK'],
      partialOut: false,
      policyOut: 'REQUIRED_BEFORE_APPROVAL',
    },
    {
      name: 'estimate with no deposit-policy override: the org policy',
      orgMethods: ['CARD'],
      orgPolicy: 'PAY_LATER',
      document: { methods: ['CARD', 'CASH'], deposit_policy: null },
      capabilities: { card: true, ach: false },
      methodsOut: ['CARD', 'CASH'],
      partialOut: false,
      policyOut: 'PAY_LATER',
    },
    {
      name: 'estimate overriding the deposit policy for one trusted customer',
      orgMethods: ['CARD'],
      document: { methods: ['CARD'], deposit_policy: 'PAY_LATER' },
      capabilities: { card: false, ach: false },
      methodsOut: [],
      partialOut: false,
      policyOut: 'PAY_LATER',
    },
    {
      name: 'estimate sent with ACH while the account has no ACH capability',
      orgMethods: ['CARD', 'ACH'],
      document: { methods: ['CARD', 'ACH'], deposit_policy: 'REQUIRED_BEFORE_APPROVAL' },
      capabilities: { card: true, ach: false },
      methodsOut: ['CARD'],
      partialOut: false,
      policyOut: 'REQUIRED_BEFORE_APPROVAL',
    },
  ];

  it.each(cases)('$name', ({ orgMethods, orgPolicy, document, capabilities, methodsOut, partialOut, policyOut }) => {
    const options = resolvePaymentOptions({
      org: { ...ORG, methods: orgMethods as never, deposit_policy: orgPolicy ?? 'REQUIRED_BEFORE_APPROVAL' },
      document: document as never,
      capabilities,
    });
    expect(options.methods).toEqual(methodsOut);
    expect(options.allow_partial).toBe(partialOut);
    expect(options.deposit_policy).toBe(policyOut);
  });
});

describe('tipPresetAmountsCents: presets are percentages of the pre-tax amount being paid', () => {
  // An invoice of $1,087.50: $1,000.00 of work plus $87.50 tax.
  const invoice = { totalCents: 108750, taxCents: 8750 };

  it('paying the whole invoice: 10/15/20% of the $1,000.00 before tax', () => {
    expect(tipPresetAmountsCents({ presets: [10, 15, 20], payingCents: 108750, ...invoice })).toEqual([10000, 15000, 20000]);
  });

  it('paying half: the tip base is the pre-tax half, $500.00', () => {
    expect(tipPresetAmountsCents({ presets: [10, 15, 20], payingCents: 54375, ...invoice })).toEqual([5000, 7500, 10000]);
  });

  it('paying $100.00: 10% of the $91.95 pre-tax portion rounds to $9.20', () => {
    expect(tipPresetAmountsCents({ presets: [10], payingCents: 10000, ...invoice })).toEqual([920]);
  });

  it('an untaxed invoice tips on the full amount being paid', () => {
    expect(tipPresetAmountsCents({ presets: [15], payingCents: 20000, totalCents: 40000, taxCents: 0 })).toEqual([3000]);
  });

  it('a zero-total invoice has no tip base', () => {
    expect(tipPresetAmountsCents({ presets: [10, 15, 20], payingCents: 0, totalCents: 0, taxCents: 0 })).toEqual([0, 0, 0]);
  });
});

describe('resolvePaymentOptions: bank-transfer instructions ride with the method', () => {
  const instructions = 'Wire to account 000123, routing 000000. Put the invoice number in the memo.';

  it('carries the org instructions when bank transfer is offered', () => {
    const options = resolvePaymentOptions({
      org: { ...ORG, methods: ['BANK_TRANSFER', 'CHECK'], bank_transfer_instructions: instructions },
      capabilities: { card: false, ach: false },
    });
    expect(options.bank_transfer_instructions).toBe(instructions);
  });

  it('carries none when this document does not offer bank transfer', () => {
    const options = resolvePaymentOptions({
      org: { ...ORG, methods: ['BANK_TRANSFER', 'CHECK'], bank_transfer_instructions: instructions },
      document: { methods: ['CHECK'] },
      capabilities: { card: false, ach: false },
    });
    expect(options.bank_transfer_instructions).toBeNull();
  });
});

/** An org row's plan fields (ORG_PLAN_SELECT), on a plan that includes online payments. */
const PLAN_WITH_ONLINE_PAYMENTS = { plan: 'STARTER', trial_ends_at: null, feature_overrides: {} };

describe('paymentOptionsFor: the owner can switch Card off as a default (story 24)', () => {
  const row = {
    accepted_payment_methods: ['CHECK', 'CARD'],
    stripe_charges_enabled: true,
    ...PLAN_WITH_ONLINE_PAYMENTS,
  };

  it('offers card by default when the org row says nothing (existing orgs)', () => {
    expect(paymentOptionsFor(row).methods).toEqual(['CHECK', 'CARD']);
  });

  it('leaves card out of the default list once the owner switches it off', () => {
    const options = paymentOptionsFor({ ...row, card_offered_by_default: false });
    expect(options.methods).toEqual(['CHECK']);
    expect(options.online_methods).toEqual([]);
  });

  it('still offers card on a document that lists it, because the account can take cards', () => {
    const options = paymentOptionsFor({ ...row, card_offered_by_default: false }, { methods: ['CARD', 'CASH'] });
    expect(options.online_methods).toEqual(['CARD']);
  });
});

describe('paymentOptionsFor: CARD and ACH capabilities come from the accepted methods, the default offer from two switches', () => {
  // Conductor decision 2026-10-06: CARD / ACH in accepted_payment_methods are capability facts;
  // card_offered_by_default and bank_offered_by_default are the owner's default offer.
  const row = {
    accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
    stripe_charges_enabled: true,
    ...PLAN_WITH_ONLINE_PAYMENTS,
  };

  it('offers bank payment by default when ACH is listed and the org row says nothing (existing orgs)', () => {
    expect(paymentOptionsFor(row).online_methods).toEqual(['CARD', 'ACH']);
  });

  it('leaves bank payment out of the default list once the owner switches it off', () => {
    const options = paymentOptionsFor({ ...row, bank_offered_by_default: false });
    expect(options.methods).toEqual(['CHECK', 'CARD']);
  });

  it('still offers bank payment on a document that lists it, because the account can take it', () => {
    const options = paymentOptionsFor({ ...row, bank_offered_by_default: false }, { methods: ['ACH', 'CHECK'] });
    expect(options.methods).toEqual(['ACH', 'CHECK']);
  });

  it('offers no bank payment while ACH is not listed, even on a document that asks for it', () => {
    const options = paymentOptionsFor({ ...row, accepted_payment_methods: ['CHECK', 'CARD'] }, { methods: ['ACH', 'CHECK'] });
    expect(options.methods).toEqual(['CHECK']);
  });

  it('offers no bank payment while the account cannot take money at all, even with ACH listed', () => {
    const options = paymentOptionsFor({ ...row, stripe_charges_enabled: false }, { methods: ['ACH', 'CARD', 'CHECK'] });
    expect(options.methods).toEqual(['CHECK']);
  });

  it('switching both online methods off by default leaves the manual methods', () => {
    const options = paymentOptionsFor({ ...row, card_offered_by_default: false, bank_offered_by_default: false });
    expect(options.methods).toEqual(['CHECK']);
    expect(options.online_methods).toEqual([]);
  });
});
