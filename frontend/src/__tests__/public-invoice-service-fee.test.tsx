/**
 * Slice 4 (card service fee) — md_files/plans/payments/2026-08-03-card-service-fee-workiz-parity.md
 *
 * The Service Fee row in renderTotals() is always present but only carries an amount once the
 * customer has chosen to pay by card (Ran's explicit framing). "Choosing card" reveals a fee
 * breakdown panel before checkout; choosing any other method leaves the row empty.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import PublicInvoicePage from '@/pages/PublicInvoicePage';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'dep-inv-fee-1' }),
    useSearchParams: () => [new URLSearchParams('token=tok-fee-123'), vi.fn()],
  };
});

const FEE_RESPONSE = {
  invoice: {
    id: 'dep-inv-fee-1',
    invoice_number: 'I00099',
    status: 'SENT',
    kind: 'DEPOSIT',
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
    customer: { first_name: 'Fee', last_name: 'Payer' },
    line_items: [
      { id: 'li-fee-1', sequence: 1, description: 'Project deposit', quantity: 1, unit_price: 1000, is_taxable: false, line_total: 1000 },
    ],
    payments: [],
  },
  organization: { name: 'Acme Services' },
  available_payment_methods: ['CARD', 'CHECK'],
  payment_instructions: { check: 'Mail a check to our office.' },
  service_fee_bps: 350,
  service_fee_preview: 35,
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => FEE_RESPONSE,
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PublicInvoicePage — Service Fee row (Slice 4)', () => {
  it('is present but empty before any payment method is chosen', async () => {
    renderWithProviders(<PublicInvoicePage />);

    await waitFor(() => {
      expect(screen.getByText('Service fee')).toBeInTheDocument();
    });
    // Present, no dollar amount yet.
    expect(screen.queryByText('$35.00')).not.toBeInTheDocument();
  });

  it('reveals the fee amount and a fee-inclusive total once the customer chooses to pay by card', async () => {
    renderWithProviders(<PublicInvoicePage />);

    const revealButton = await screen.findByRole('button', { name: /Pay .* by Card/i });
    await userEvent.click(revealButton);

    // Two occurrences: once in the totals block, once in the revealed fee-breakdown panel.
    await waitFor(() => {
      expect(screen.getAllByText('$35.00').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText('Total due by card')).toBeInTheDocument();
    // $1,000.00 amount due + $35.00 fee = $1,035.00 (renders in the totals block, the
    // breakdown panel, and the pay button — assert presence, not a single occurrence).
    expect(screen.getAllByText('$1,035.00').length).toBeGreaterThanOrEqual(2);
  });

  it('leaves the Service Fee row empty when a non-card method is chosen', async () => {
    renderWithProviders(<PublicInvoicePage />);

    const checkButton = await screen.findByRole('button', { name: /Pay by Check/i });
    await userEvent.click(checkButton);

    expect(screen.getByText('Service fee')).toBeInTheDocument();
    expect(screen.queryByText('$35.00')).not.toBeInTheDocument();
    expect(screen.queryByText('Total due by card')).not.toBeInTheDocument();
  });
});
