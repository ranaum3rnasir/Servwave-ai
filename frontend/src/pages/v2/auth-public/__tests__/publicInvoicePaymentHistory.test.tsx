/**
 * Payments go-live slice 28 (the MUST routed from the slice 25 review): the customer's payment
 * history reads each payment the way they paid, a bank payment still clearing reads Processing and
 * one that failed reads Failed (neither looks like money received), and refunds are listed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicInvoicePage from '../PublicInvoicePage';

const payment = (o: Record<string, unknown>) => ({
  id: 'p', amount: 100, method: 'CARD', paid_at: '2026-07-02T12:00:00.000Z', state: 'SUCCEEDED', ...o,
});

function payload(payments: unknown[], refunds: unknown[] = []) {
  return {
    invoice: {
      id: 'inv-hist-1', invoice_number: 'I00100', status: 'PARTIAL', kind: 'INVOICE', subtotal: 1000, discount_amount: 0,
      tax_amount: 0, deposit_credit: 0, total_amount: 1000, amount_due: 700, due_date: null,
      sent_at: '2026-03-01T00:00:00.000Z', paid_at: null, created_at: '2026-03-01T00:00:00.000Z', job: null,
      customer: { first_name: 'Pat', last_name: 'Payer' },
      line_items: [{ id: 'li-1', sequence: 1, description: 'Door repair', quantity: 1, unit_price: 1000, is_taxable: false, line_total: 1000 }],
      payments, refunds,
    },
    organization: { name: 'Acme Services' },
    available_payment_methods: ['CARD'],
    pay_state: 'PAYABLE',
    processing_amount: 0,
    payable_now: 700,
  };
}

async function history(payments: unknown[], refunds: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload(payments, refunds) }));
  renderWithProviders(<PublicInvoicePage />, { initialEntries: ['/p/invoices/inv-hist-1?token=tok-1'] });
  const heading = await screen.findByText('Payment History');
  return within(heading.parentElement as HTMLElement);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('public invoice payment history', () => {
  it('reads a card, a wallet, Link and a bank payment the way the customer paid, and never says ACH', async () => {
    const h = await history([
      payment({ id: 'a', card_brand: 'visa', card_last4: '4242' }),
      payment({ id: 'b', wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242' }),
      payment({ id: 'c', wallet: 'LINK' }),
      payment({ id: 'd', method: 'ACH', bank_name: 'Bank of Example', bank_last4: '6789' }),
      payment({ id: 'e', method: 'ACH' }),
    ]);

    expect(h.getByText(/^Visa •••• 4242 - /)).toBeInTheDocument();
    expect(h.getByText(/^Apple Pay \(Visa •••• 4242\) - /)).toBeInTheDocument();
    expect(h.getByText(/^Link - /)).toBeInTheDocument();
    expect(h.getByText(/^Bank of Example •••• 6789 - /)).toBeInTheDocument();
    expect(h.getByText(/^Bank payment - /)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ACH/);
  });

  it('a bank payment still clearing reads Processing, a failed one reads Failed, and neither looks like money received', async () => {
    const h = await history([
      payment({ id: 'ok', amount: 100, card_brand: 'visa', card_last4: '4242' }),
      payment({ id: 'wait', amount: 60, method: 'ACH', state: 'PROCESSING' }),
      payment({ id: 'bad', amount: 9, method: 'ACH', state: 'FAILED' }),
    ]);

    expect(h.getByText('Processing')).toBeInTheDocument();
    expect(h.getByText('Failed')).toBeInTheDocument();
    // Only the payment that went through is an unmarked, received amount.
    expect(h.queryAllByText('Processing')).toHaveLength(1);
  });

  it('lists refunds that were given back or are on their way', async () => {
    const h = await history(
      [payment({ id: 'ok', amount: 100, card_brand: 'visa', card_last4: '4242' })],
      [
        { id: 'r1', amount: 10, state: 'SUCCEEDED', created_at: '2026-07-03T12:00:00.000Z' },
        { id: 'r2', amount: 20, state: 'PENDING', created_at: '2026-07-04T12:00:00.000Z' },
      ],
    );

    expect(h.getAllByText(/^Refund - /)).toHaveLength(2);
    expect(h.getByText('-$10.00')).toBeInTheDocument();
    expect(h.getByText('-$20.00')).toBeInTheDocument();
    expect(h.getByText('Pending')).toBeInTheDocument();
  });
});
