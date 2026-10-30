/* Payouts slice P2 - failure reasons in ServWave's words. Pure module, no processor wording ever reaches a response. */
import { describe, it, expect } from 'vitest';
import { describeFailure } from '../lib/payment-failure-reasons';

describe('describeFailure', () => {
  it.each([
    ['insufficient_funds', 'Insufficient funds'],
    ['account_closed', 'The bank account is closed'],
    ['debit_not_authorized', 'The bank did not accept the payment'],
    ['no_account', 'The bank did not accept the payment'],
    ['could_not_process', 'The bank did not accept the payment'],
  ])('%s reads %s', (code, words) => {
    expect(describeFailure(code)).toBe(words);
  });

  it('gives an unknown, empty or missing code the fallback', () => {
    expect(describeFailure('some_new_code')).toBe('The payment did not go through');
    expect(describeFailure('')).toBe('The payment did not go through');
    expect(describeFailure(null)).toBe('The payment did not go through');
    expect(describeFailure(undefined)).toBe('The payment did not go through');
  });

  it('never carries a vendor or processor word, for any code it knows or does not', () => {
    const codes = [
      'insufficient_funds', 'account_closed', 'debit_not_authorized', 'no_account', 'could_not_process', 'bank_account_restricted',
      'invalid_account_number', 'refer_to_customer', 'declined', 'lost_or_stolen_card', 'expired_or_canceled_card', 'unknown', 'stripe_error',
      'unknown_stripe_code', 'insufficient_funds_stripe', 'debit_not_authorized', 'amount_too_large', 'invalid_currency',
      'bank_ownership_changed', 'authorization_revoked_by_customer', 'payment_method_not_available',
      'declined_by_stripe', 'stripe', 'Stripe', 'acct_123', 'pm_card_chargeDeclined',
    ];
    for (const code of codes) {
      expect(describeFailure(code)).not.toMatch(/stripe|supabase|render|connect|acct_|pm_|ctm/i);
    }
  });
});
