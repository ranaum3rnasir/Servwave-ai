/**
 * Payments go-live P9: where a payment notice sends the owner. The bell and the email button both open the
 * Payments page (the attention chip, or the disputed chip for a dispute), never the old Settings pages. The
 * old addresses still resolve through the page's redirects, so notices already sent keep working.
 */
import { describe, it, expect } from 'vitest';
import { PAYMENTS_ATTENTION_PATH, DISPUTES_PATH, PAYOUT_ACCOUNT_PATH, noticePath } from '../lib/owner-payment-notices';

describe('owner payment notice paths', () => {
  it('sends an unplaced-money or account notice to the attention chip of the Payments page', () => {
    expect(PAYMENTS_ATTENTION_PATH).toBe('/payments?tab=payments&chip=attention');
    expect(noticePath({ object: { type: 'ORGANIZATION', id: 'o', label: 'x' }, data: {} })).toBe('/payments?tab=payments&chip=attention');
  });

  it('sends a dispute notice to the disputed chip', () => {
    expect(DISPUTES_PATH).toBe('/payments?tab=payments&chip=disputed');
  });

  it('still sends an invoice notice to the invoice and honours a notice\'s own link', () => {
    expect(noticePath({ object: { type: 'INVOICE', id: 'inv-1', label: 'x' }, data: {} })).toBe('/invoices/inv-1');
    expect(noticePath({ object: { type: 'ORGANIZATION', id: 'o', label: 'x' }, data: { link_path: '/somewhere' } })).toBe('/somewhere');
  });

  it('leaves the payout account page where bank details are edited', () => {
    expect(PAYOUT_ACCOUNT_PATH).toBe('/settings/payout-account');
  });
});
