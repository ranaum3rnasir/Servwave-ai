import { describe, it, expect } from 'vitest';
import { feeReversalOption } from '../lib/refund-rules';

// Payments go-live D1: a refund reverses an application fee only when the payment carried one.
describe('feeReversalOption', () => {
  it('reverses the fee for a connected-account payment that recorded one', () => {
    expect(feeReversalOption({ stripe_account_id: 'acct_1', platform_fee_amount: 0.5 })).toEqual({ reverseApplicationFee: true });
    expect(feeReversalOption({ stripe_account_id: 'acct_1', platform_fee_amount: '1.25' })).toEqual({ reverseApplicationFee: true });
  });
  it('does not ask for a reversal when the payment carried no fee', () => {
    expect(feeReversalOption({ stripe_account_id: 'acct_1', platform_fee_amount: 0 })).toEqual({});
    expect(feeReversalOption({ stripe_account_id: 'acct_1', platform_fee_amount: null })).toEqual({});
    expect(feeReversalOption({ stripe_account_id: 'acct_1' })).toEqual({});
  });
  it('never reverses for a platform-account payment or no payment', () => {
    expect(feeReversalOption({ stripe_account_id: null, platform_fee_amount: 2 })).toEqual({});
    expect(feeReversalOption(null)).toEqual({});
  });
});
