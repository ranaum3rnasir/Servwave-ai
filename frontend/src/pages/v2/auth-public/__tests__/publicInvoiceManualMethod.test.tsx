/**
 * The routed public invoice page (`/p/invoices/:id`) when the customer chooses a manual method.
 *
 * Rewritten from the deleted v1 suite's "a non-card method is chosen" case (payments go-live slice
 * 23). The v1 assertions were about a card service fee the routed page has never shown; what the
 * routed page does do is reveal the business's own instructions for that method, and offer no card
 * checkout while a manual method is open.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicInvoicePage from '../PublicInvoicePage';

const PAYLOAD = {
  invoice: {
    id: 'inv-manual-1',
    invoice_number: 'I00099',
    status: 'SENT',
    kind: 'INVOICE',
    subtotal: 1000,
    discount_amount: 0,
    tax_amount: 0,
    deposit_credit: 0,
    total_amount: 1000,
    amount_due: 1000,
    due_date: null,
    sent_at: '2026-03-01T00:00:00.000Z',
    paid_at: null,
    created_at: '2026-03-01T00:00:00.000Z',
    job: null,
    customer: { first_name: 'Check', last_name: 'Payer' },
    line_items: [
      { id: 'li-1', sequence: 1, description: 'Door repair', quantity: 1, unit_price: 1000, is_taxable: false, line_total: 1000 },
    ],
    payments: [],
  },
  organization: { name: 'Acme Services' },
  available_payment_methods: ['CARD', 'CHECK'],
  payment_instructions: { check: 'Mail a check to our office.' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('public invoice - paying by a manual method', () => {
  it("shows the business's check instructions and no card checkout once Check is chosen", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => PAYLOAD }));
    renderWithProviders(<PublicInvoicePage />, { initialEntries: ['/p/invoices/inv-manual-1?token=tok-1'] });

    // Before choosing, the instructions stay hidden behind the method picker.
    const checkButton = await screen.findByRole('button', { name: /Pay by Check/i });
    expect(screen.queryByText('Mail a check to our office.')).not.toBeInTheDocument();
    await userEvent.click(checkButton);

    expect(screen.getByText('Pay by Check - $1,000.00')).toBeInTheDocument();
    expect(screen.getByText('Mail a check to our office.')).toBeInTheDocument();
    expect(screen.getByText(/your invoice will be updated automatically/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay by card' })).not.toBeInTheDocument();
  });

  it('returns to the method picker from the instructions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => PAYLOAD }));
    renderWithProviders(<PublicInvoicePage />, { initialEntries: ['/p/invoices/inv-manual-1?token=tok-1'] });

    await userEvent.click(await screen.findByRole('button', { name: /Pay by Check/i }));
    await userEvent.click(screen.getByRole('button', { name: /Back to payment methods/i }));

    expect(screen.queryByText('Mail a check to our office.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeInTheDocument();
  });
});

// Payments go-live slice 25 - the online bank debit (ACH) is "Pay by bank", opening the hosted
// checkout; the manual bank transfer stays its own row with the business's instructions. Neither
// shows the word ACH to the homeowner.
describe('public invoice - an online bank debit beside a manual bank transfer', () => {
  it('offers Pay by bank and the manual bank transfer, and never says ACH', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...PAYLOAD,
        available_payment_methods: ['BANK_TRANSFER', 'ACH'],
        payment_instructions: { bank_transfer: 'Routing 000, account 111.' },
      }),
    }));
    renderWithProviders(<PublicInvoicePage />, { initialEntries: ['/p/invoices/inv-manual-1?token=tok-1'] });

    expect(await screen.findByRole('button', { name: /Pay by Bank Transfer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay by bank' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ACH/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/ACH/)).not.toBeInTheDocument();
  });
});
