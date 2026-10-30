import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';
import { decideAccountStatus } from '../lib/account-status';

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
