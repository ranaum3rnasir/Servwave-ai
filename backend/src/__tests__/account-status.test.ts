import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';
import { decideAccountStatus, verificationOf, verificationAreaOf, RESTRICTED_VERIFICATION } from '../lib/account-status';

// Real SDK error classes, built the way the SDK builds them from a response body, so the
// fixtures carry the shape the processor actually sends (measured in the sandbox 2026-10-06:
// a bogus account id answers 403 `account_invalid`, not 404 `resource_missing`).
function accountInvalid(): Error {
  return new Stripe.errors.StripePermissionError({
    type: 'invalid_request_error',
    code: 'account_invalid',
    message: "The provided key does not have access to account 'acct_bogus' (or that account does not exist).",
  });
}

function resourceMissing(): Error {
  return new Stripe.errors.StripeInvalidRequestError({
    type: 'invalid_request_error',
    code: 'resource_missing',
    message: "No such account: 'acct_gone'",
  });
}

describe('decideAccountStatus (pure)', () => {
  it('a processor error leaves "can take cards" false', () => {
    const d = decideAccountStatus({ error: accountInvalid() }, { testMode: true });
    expect(d).toEqual({
      kind: 'write',
      outcome: 'failed_closed',
      flags: { stripe_charges_enabled: false, stripe_payouts_enabled: false },
    });
  });

  it('a successful lookup with charges enabled reports "can take cards" true and mirrors the account', () => {
    const account = {
      id: 'acct_ok',
      object: 'account',
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      requirements: { currently_due: ['external_account'], disabled_reason: null },
    } as unknown as Stripe.Account;
    const d = decideAccountStatus({ account }, { testMode: false });
    expect(d).toEqual({
      kind: 'write',
      outcome: 'refreshed',
      flags: {
        stripe_charges_enabled: true,
        stripe_payouts_enabled: false,
        stripe_details_submitted: true,
        stripe_requirements_due: ['external_account'],
        stripe_disabled_reason: null,
      },
      // No capabilities listed: neither the card nor the bank-debit capability is active.
      cardActive: false,
      achActive: false,
    });
  });

  // Payments go-live slice 10: CARD sits in the org's accepted methods while the card capability is
  // active, the same way ACH follows the bank-debit capability.
  it.each([
    ['active', true],
    ['pending', false],
    ['inactive', false],
    [undefined, false],
  ])('the card capability %s reads as "card capability active" %s', (state, expected) => {
    const account = {
      id: 'acct_card', object: 'account', charges_enabled: true, payouts_enabled: true, details_submitted: true,
      capabilities: state ? { card_payments: state } : {},
      requirements: { currently_due: [], disabled_reason: null },
    } as unknown as Stripe.Account;
    const d = decideAccountStatus({ account }, { testMode: false });
    expect(d.kind === 'write' && d.outcome === 'refreshed' ? d.cardActive : 'not refreshed').toBe(expected);
  });

  // Payments go-live slice 19: the ACH capability decides whether ACH sits in the org's accepted
  // methods (its only mirror), so bank payments are offered only once the account can take them.
  it.each([
    ['active', true],
    ['pending', false],
    ['inactive', false],
    [undefined, false],
  ])('the ACH capability %s reads as "can take bank payments" %s', (state, expected) => {
    const account = {
      id: 'acct_ach',
      object: 'account',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      capabilities: state ? { card_payments: 'active', us_bank_account_ach_payments: state } : { card_payments: 'active' },
      requirements: { currently_due: [], disabled_reason: null },
    } as unknown as Stripe.Account;
    const d = decideAccountStatus({ account }, { testMode: false });
    expect(d.kind === 'write' && d.outcome === 'refreshed' ? d.achActive : 'not refreshed').toBe(expected);
  });

  it('a missing resource on a test-mode key keeps the stored flags (fixture accounts in the sandbox)', () => {
    expect(decideAccountStatus({ error: resourceMissing() }, { testMode: true })).toEqual({
      kind: 'keep',
      outcome: 'kept_test_mode_missing',
    });
  });

  it('a missing resource on a live key still fails closed', () => {
    expect(decideAccountStatus({ error: resourceMissing() }, { testMode: false })).toEqual({
      kind: 'write',
      outcome: 'failed_closed',
      flags: { stripe_charges_enabled: false, stripe_payouts_enabled: false },
    });
  });

  // A transient processor failure says nothing about the account, so it must not flip a
  // working org to "cannot take cards" fleet-wide: the stored flags are kept and the next
  // refresh (or the account-updated event) settles it.
  it.each([
    ['rate limited (429)', () => new Stripe.errors.StripeRateLimitError({ type: 'invalid_request_error', code: 'rate_limit', message: 'Too many requests', statusCode: 429 } as never)],
    ['a connection failure', () => new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'An error occurred with our connection to Stripe.' } as never)],
    ['a processor 5xx', () => new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'Internal error', statusCode: 500 } as never)],
  ])('a transient processor error (%s) keeps the stored flags, live key or not', (_label, make) => {
    for (const testMode of [true, false]) {
      expect(decideAccountStatus({ error: make() }, { testMode })).toEqual({
        kind: 'keep',
        outcome: 'kept_platform_error',
      });
    }
  });

  // Conductor decision 2026-10-06: a bad or revoked PLATFORM key says nothing about whether
  // the account can take cards. Failing closed on it would mark every org unable to take
  // cards in one nightly run, so it keeps the stored flags like an outage does.
  it('an authentication error on the platform key (401) keeps the stored flags, live key or not', () => {
    for (const testMode of [true, false]) {
      const err = new Stripe.errors.StripeAuthenticationError({ type: 'invalid_request_error', message: 'Invalid API Key provided', statusCode: 401 } as never);
      expect(decideAccountStatus({ error: err }, { testMode })).toEqual({
        kind: 'keep',
        outcome: 'kept_platform_error',
      });
    }
  });

  // A restricted platform key missing a permission answers 403 like account_invalid does, but
  // with no account code: it is about the platform key, so it keeps the flags.
  it('a permission error on the platform key (403, no account code) keeps the stored flags, live key or not', () => {
    for (const testMode of [true, false]) {
      const err = new Stripe.errors.StripePermissionError({
        type: 'invalid_request_error',
        message: "The provided key 'rk_live_***' does not have the required permissions for this endpoint.",
        statusCode: 403,
      } as never);
      expect(decideAccountStatus({ error: err }, { testMode })).toEqual({
        kind: 'keep',
        outcome: 'kept_platform_error',
      });
    }
  });

  it('account_invalid (403) is an answer about the account and fails closed on a live key too', () => {
    expect(decideAccountStatus({ error: accountInvalid() }, { testMode: false })).toEqual({
      kind: 'write',
      outcome: 'failed_closed',
      flags: { stripe_charges_enabled: false, stripe_payouts_enabled: false },
    });
  });

  it('a non-processor error (a bug) also fails closed, even in test mode', () => {
    expect(decideAccountStatus({ error: new TypeError('fetch failed') }, { testMode: true })).toMatchObject({
      kind: 'write',
      outcome: 'failed_closed',
      flags: { stripe_charges_enabled: false },
    });
  });
});

// BE-3 (V7-02a): the four verification rows, computed from the requirement lists of the account read.
describe('verificationAreaOf (the key -> row mapping)', () => {
  it.each([
    ['external_account', 'bank_account'],
    // The two tax keys sit under `individual.` but belong to Tax ID: the order of the checks matters.
    ['individual.id_number', 'tax_id'],
    ['individual.ssn_last_4', 'tax_id'],
    ['company.tax_id', 'tax_id'],
    ['individual.first_name', 'owner_identity'],
    ['individual.dob.day', 'owner_identity'],
    ['person_abc123.address.line1', 'owner_identity'],
    ['representative.email', 'owner_identity'],
    ['relationship.owner', 'owner_identity'],
    ['company.owners_provided', 'owner_identity'],
    ['company.directors_provided', 'owner_identity'],
    ['company.executives_provided', 'owner_identity'],
    ['company.verification.document', 'owner_identity'],
    ['business_profile.url', 'business_details'],
    ['business_profile.mcc', 'business_details'],
    ['company.name', 'business_details'],
    ['company.address.city', 'business_details'],
    ['tos_acceptance.date', 'business_details'],
  ] as const)('%s -> %s', (key, area) => {
    expect(verificationAreaOf(key)).toBe(area);
  });
});

describe('verificationOf (pure)', () => {
  const bank = { object: 'list', data: [{ object: 'bank_account', bank_name: 'Test Bank', last4: '6789' }] };
  const acct = (over: {
    submitted?: boolean; charges?: boolean; disabled?: string | null; due?: string[]; past?: string[]; pending?: string[];
    eventually?: string[]; bank?: boolean;
  } = {}) => ({
    id: 'acct_fixture', object: 'account',
    details_submitted: over.submitted ?? true, charges_enabled: over.charges ?? true, payouts_enabled: true,
    external_accounts: over.bank === false ? { object: 'list', data: [] } : bank,
    requirements: {
      currently_due: over.due ?? [], past_due: over.past ?? [], pending_verification: over.pending ?? [],
      eventually_due: over.eventually ?? [], disabled_reason: over.disabled ?? null,
    },
  }) as unknown as Stripe.Account;

  it('state 2: setup in progress', () => {
    expect(verificationOf(acct({
      submitted: false, charges: false, bank: false,
      pending: ['individual.verification.document'], eventually: ['external_account', 'individual.id_number'],
    }))).toEqual({ business_details: 'verified', owner_identity: 'pending', bank_account: 'not_started', tax_id: 'not_started' });
  });

  it('state 3: details submitted, charges off, nothing due -> all four pending', () => {
    expect(verificationOf(acct({ charges: false, pending: ['business_profile.url'] })))
      .toEqual({ business_details: 'pending', owner_identity: 'pending', bank_account: 'pending', tax_id: 'pending' });
    expect(verificationOf(acct({ charges: false })))
      .toEqual({ business_details: 'pending', owner_identity: 'pending', bank_account: 'pending', tax_id: 'pending' });
  });

  it('state 4: charges on, no bank on file and no bank key due now -> bank pending, the rest verified', () => {
    expect(verificationOf(acct({ bank: false, eventually: ['external_account'] })))
      .toEqual({ business_details: 'verified', owner_identity: 'verified', bank_account: 'pending', tax_id: 'verified' });
  });

  it('state 5: everything on file and clear -> all verified', () => {
    expect(verificationOf(acct())).toEqual({ business_details: 'verified', owner_identity: 'verified', bank_account: 'verified', tax_id: 'verified' });
  });

  it('state 6: an identity document is due -> owner identity action_needed', () => {
    expect(verificationOf(acct({ due: ['individual.verification.document'] })))
      .toEqual({ business_details: 'verified', owner_identity: 'action_needed', bank_account: 'verified', tax_id: 'verified' });
  });

  it('state 7: the bank key is past due and no bank on file -> bank action_needed', () => {
    expect(verificationOf(acct({ bank: false, charges: true, past: ['external_account'] })))
      .toEqual({ business_details: 'verified', owner_identity: 'verified', bank_account: 'action_needed', tax_id: 'verified' });
  });

  it('state 8: rejected or deauthorized -> all four restricted', () => {
    const restricted = { business_details: 'restricted', owner_identity: 'restricted', bank_account: 'restricted', tax_id: 'restricted' };
    expect(verificationOf(acct({ disabled: 'rejected.fraud', charges: false }))).toEqual(restricted);
    expect(verificationOf(acct({ disabled: 'rejected.terms_of_service' }))).toEqual(restricted);
    expect(verificationOf(acct({ disabled: 'deauthorized' }))).toEqual(restricted);
    expect(RESTRICTED_VERIFICATION).toEqual(restricted);
  });

  // C-6: without a bank account on file the bank row is never verified.
  it('bank row (C-6): no bank on file never reads verified', () => {
    expect(verificationOf(acct({ bank: false })).bank_account).toBe('pending');
    expect(verificationOf(acct({ bank: false, due: ['external_account'] })).bank_account).toBe('action_needed');
    expect(verificationOf(acct({ bank: false, past: ['external_account'] })).bank_account).toBe('action_needed');
    expect(verificationOf(acct({ bank: false, pending: [] })).bank_account).not.toBe('verified');
  });

  it('a bank on file with nothing due reads verified', () => {
    expect(verificationOf(acct()).bank_account).toBe('verified');
  });

  it('due now beats pending beats not started, per row', () => {
    const v = verificationOf(acct({
      submitted: false, charges: false,
      due: ['business_profile.url'], pending: ['business_profile.mcc', 'individual.verification.document'],
      eventually: ['individual.id_number'],
    }));
    expect(v.business_details).toBe('action_needed');
    expect(v.owner_identity).toBe('pending');
    expect(v.tax_id).toBe('not_started');
  });

  it('an eventually-due key only means not_started before details are submitted', () => {
    expect(verificationOf(acct({ eventually: ['individual.id_number'] })).tax_id).toBe('verified');
  });

  it('returns exactly the four values and no requirement key or account id', () => {
    const v = verificationOf(acct({ due: ['individual.verification.document', 'external_account'] }));
    expect(Object.keys(v).sort()).toEqual(['bank_account', 'business_details', 'owner_identity', 'tax_id']);
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/acct_|individual\.|external_account/);
  });
});
