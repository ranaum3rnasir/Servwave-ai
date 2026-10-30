/* The one-line payment description and the bank-name filter: the processor's sandbox bank never shows. */
import { describe, it, expect } from 'vitest';
import { describePaymentDetail, publicBankName } from '../lib/payment-display';

describe('publicBankName', () => {
  it.each(['STRIPE TEST BANK', 'Stripe Test Bank', 'stripe', 'Test Bank', ' TEST BANK '])('drops %j', (name) => {
    expect(publicBankName(name)).toBeNull();
  });
  it.each(['Chase', 'First Test Bank', 'Bank of America'])('keeps the real bank %j', (name) => {
    expect(publicBankName(name)).toBe(name);
  });
  it('treats empty and missing as no bank', () => {
    expect(publicBankName(null)).toBeNull();
    expect(publicBankName(undefined)).toBeNull();
    expect(publicBankName('  ')).toBeNull();
  });
});

describe('describePaymentDetail for a bank payment', () => {
  it('reads "Bank •••• 1116" when the bank name is the processor sandbox', () => {
    expect(describePaymentDetail({ method: 'ACH', bankName: 'STRIPE TEST BANK', bankLast4: '1116' })).toBe('Bank •••• 1116');
  });
  it('keeps a real bank name', () => {
    expect(describePaymentDetail({ method: 'ACH', bankName: 'Chase', bankLast4: '1116' })).toBe('Chase •••• 1116');
  });
  it('reads empty for a processor-named bank with no last four', () => {
    expect(describePaymentDetail({ method: 'ACH', bankName: 'STRIPE TEST BANK' })).toBe('');
  });
});
