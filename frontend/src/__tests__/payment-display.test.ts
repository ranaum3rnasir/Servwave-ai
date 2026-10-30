import { describe, it, expect } from 'vitest';
import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';
import {
  describePayment,
  paymentStateLabel,
  refundStateLabel,
  refundReasonLabel,
  processingBadgeText,
} from '@/lib/payment-display';

/**
 * Payments go-live slice 28: how a payment reads in the history. Office users answer "how did I
 * pay?" from this line, so each way of paying has one reading, and none of them names the
 * processor.
 */
describe('describePayment', () => {
  it('a plain card reads brand and last four', () => {
    expect(describePayment({ method: 'CARD', card_brand: 'visa', card_last4: '4242' })).toBe('Visa •••• 4242');
  });

  it('a card through Apple Pay reads the wallet, then the card in brackets', () => {
    expect(describePayment({ method: 'CARD', wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242' })).toBe(
      'Apple Pay (Visa •••• 4242)',
    );
  });

  it('Google Pay reads the same way, and by itself when the card is not known', () => {
    expect(describePayment({ method: 'CARD', wallet: 'GOOGLE_PAY', card_brand: 'mastercard', card_last4: '4444' })).toBe(
      'Google Pay (Mastercard •••• 4444)',
    );
    expect(describePayment({ method: 'CARD', wallet: 'GOOGLE_PAY' })).toBe('Google Pay');
  });

  it('Link reads "Link": never a placeholder card or an expiry', () => {
    const text = describePayment({ method: 'CARD', wallet: 'LINK', card_brand: 'visa', card_last4: '0000' });
    expect(text).toBe('Link');
    expect(text).not.toMatch(/0000|expires|\d{2}\/\d{4}/);
  });

  it('an online bank payment reads the bank name and last four', () => {
    expect(describePayment({ method: 'ACH', bank_name: 'Bank of Example', bank_last4: '6789' })).toBe('Bank of Example •••• 6789');
  });

  it('an online bank payment with no bank name reads "Bank (ACH)", with the last four when known', () => {
    expect(describePayment({ method: 'ACH' })).toBe('Bank (ACH)');
    expect(describePayment({ method: 'ACH', bank_last4: '6789' })).toBe('Bank •••• 6789');
  });

  it('a card with no details falls back to the method label', () => {
    expect(describePayment({ method: 'CARD' })).toBe(PAYMENT_METHOD_LABELS.CARD);
  });

  it('knows the brands a customer sees on their card', () => {
    const brand = (b: string) => describePayment({ method: 'CARD', card_brand: b, card_last4: '1111' });
    expect(brand('amex')).toBe('American Express •••• 1111');
    expect(brand('discover')).toBe('Discover •••• 1111');
    expect(brand('diners')).toBe('Diners Club •••• 1111');
    expect(brand('jcb')).toBe('JCB •••• 1111');
    expect(brand('unionpay')).toBe('UnionPay •••• 1111');
  });

  it('a hand-recorded payment reads its method label; a hand-recorded transfer never says ACH', () => {
    expect(describePayment({ method: 'CASH' })).toBe('Cash');
    expect(describePayment({ method: 'CHECK' })).toBe('Check');
    expect(describePayment({ method: 'BANK_TRANSFER' })).toBe('Bank transfer');
    expect(PAYMENT_METHOD_LABELS.BANK_TRANSFER).not.toMatch(/ACH/);
  });

  // The customer's own page never says ACH (slice 25): a bank payment with no bank on record reads
  // "Bank payment" there.
  it('reads "Bank payment" to the customer when the bank is not on record, and never ACH', () => {
    expect(describePayment({ method: 'ACH' }, { forCustomer: true })).toBe('Bank payment');
    expect(describePayment({ method: 'ACH', bank_name: 'Bank of Example', bank_last4: '6789' }, { forCustomer: true })).toBe(
      'Bank of Example •••• 6789',
    );
    expect(describePayment({ method: 'ACH', bank_last4: '6789' }, { forCustomer: true })).toBe('Bank •••• 6789');
  });

  it('never carries a processor name', () => {
    const all = [
      describePayment({ method: 'CARD', wallet: 'LINK' }),
      describePayment({ method: 'CARD', wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242' }),
      describePayment({ method: 'ACH', bank_name: 'Bank of Example', bank_last4: '6789' }),
    ].join(' ');
    expect(all).not.toMatch(/stripe/i);
  });
});

describe('paymentStateLabel', () => {
  it('a payment still clearing reads Processing and one that did not go through reads Failed', () => {
    expect(paymentStateLabel('PROCESSING')).toBe('Processing');
    expect(paymentStateLabel('FAILED')).toBe('Failed');
  });

  it('a payment that went through, or a row from before the state existed, carries no label', () => {
    expect(paymentStateLabel('SUCCEEDED')).toBeNull();
    expect(paymentStateLabel(undefined)).toBeNull();
  });
});

describe('refundStateLabel', () => {
  it('a refund on its way reads Pending and one that did not go through reads Failed', () => {
    expect(refundStateLabel('PENDING')).toBe('Pending');
    expect(refundStateLabel('FAILED')).toBe('Failed');
    expect(refundStateLabel('SUCCEEDED')).toBeNull();
    expect(refundStateLabel(undefined)).toBeNull();
  });
});

describe('refundReasonLabel', () => {
  it('reads a human label, never the raw code', () => {
    expect(refundReasonLabel('CUSTOMER_REQUEST')).toBe('Customer request');
    expect(refundReasonLabel('ERROR')).toBe('Billing error');
    expect(refundReasonLabel('CHARGEBACK')).toBe('Chargeback');
  });

  it('an unknown code is tidied rather than shown raw, and none reads as nothing', () => {
    expect(refundReasonLabel('SOMETHING_NEW')).toBe('Something new');
    expect(refundReasonLabel(null)).toBe('');
  });
});

describe('processingBadgeText', () => {
  it('names the amount in flight', () => {
    expect(processingBadgeText(60)).toBe('Processing $60.00');
    expect(processingBadgeText('1250.5')).toBe('Processing $1,250.50');
  });

  it('is nothing when nothing is in flight', () => {
    expect(processingBadgeText(0)).toBeNull();
    expect(processingBadgeText(undefined)).toBeNull();
    expect(processingBadgeText(null)).toBeNull();
  });
});

describe('describePayment never shows the processor sandbox bank', () => {
  it('drops a processor-named bank and keeps a real one', () => {
    expect(describePayment({ method: 'ACH', bank_name: 'STRIPE TEST BANK', bank_last4: '1116' })).toBe('Bank •••• 1116');
    expect(describePayment({ method: 'ACH', bank_name: 'Chase', bank_last4: '1116' })).toBe('Chase •••• 1116');
  });
});
