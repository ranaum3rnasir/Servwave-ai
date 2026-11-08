/**
 * Slice 8 (customer-facing tipping, D10/D11) — md_files/plans/payments/2026-08-03-card-service-fee-workiz-parity.md
 *
 * Tip selector inside the "Pay by card" panel of PublicInvoicePage.tsx. Nothing preselected, no
 * "No tip" chip, percentage is an input affordance only (the dollar figure is what is sent). The
 * service fee stays fixed while the tip changes; the pay button is the live total.
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
    useParams: () => ({ id: 'dep-inv-tip-1' }),
    useSearchParams: () => [new URLSearchParams('token=tok-tip-123'), vi.fn()],
  };
});

const TIP_RESPONSE = {
  invoice: {
    id: 'dep-inv-tip-1',
    invoice_number: 'I00098',
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
    customer: { first_name: 'Tip', last_name: 'Payer' },
    line_items: [
      { id: 'li-tip-1', sequence: 1, description: 'Project deposit', quantity: 1, unit_price: 1000, is_taxable: false, line_total: 1000 },
    ],
    payments: [],
  },
  organization: { name: 'Acme Services' },
  available_payment_methods: ['CARD'],
  payment_instructions: {},
  service_fee_bps: 350,
  service_fee_preview: 35,
  tip_preset_bps: [1000, 1500, 2000],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => TIP_RESPONSE,
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openCardPanel() {
  const revealButton = await screen.findByRole('button', { name: /Pay .* by Card/i });
  await userEvent.click(revealButton);
}

describe('PublicInvoicePage — tip selector (Slice 8)', () => {
  it('preselects nothing and charges amount_due + service fee only by default', async () => {
    renderWithProviders(<PublicInvoicePage />);
    await openCardPanel();

    expect(await screen.findByText('Add a tip? (optional)')).toBeInTheDocument();
    const chip10 = screen.getByRole('radio', { name: /10%/ });
    expect(chip10).toHaveAttribute('aria-checked', 'false');

    // $1,000.00 amount due + $35.00 fee = $1,035.00, no tip.
    expect(screen.getAllByText('$1,035.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Tip')).not.toBeInTheDocument();
  });

  it('selecting a preset chip updates the pay button total and shows the Tip line, fee unchanged', async () => {
    renderWithProviders(<PublicInvoicePage />);
    await openCardPanel();

    const chip15 = await screen.findByRole('radio', { name: /15%/ });
    await userEvent.click(chip15);

    // 15% of $1,000 = $150 tip. Total = 1000 + 35 (fee) + 150 (tip) = 1185.
    await waitFor(() => {
      expect(screen.getByText('Tip')).toBeInTheDocument();
    });
    expect(screen.getAllByText('$150.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$1,185.00').length).toBeGreaterThanOrEqual(1);
    // The service fee figure is unchanged by the tip.
    expect(screen.getAllByText('$35.00').length).toBeGreaterThanOrEqual(1);
  });

  it('clicking the same chip again deselects it, dropping the tip back to zero', async () => {
    renderWithProviders(<PublicInvoicePage />);
    await openCardPanel();

    const chip10 = await screen.findByRole('radio', { name: /10%/ });
    await userEvent.click(chip10);
    await waitFor(() => expect(screen.getByText('Tip')).toBeInTheDocument());

    await userEvent.click(chip10);
    await waitFor(() => expect(screen.queryByText('Tip')).not.toBeInTheDocument());
    expect(screen.getAllByText('$1,035.00').length).toBeGreaterThanOrEqual(1);
  });

  it('"Other" reveals a labeled dollar input; typing an amount updates the total', async () => {
    renderWithProviders(<PublicInvoicePage />);
    await openCardPanel();

    const otherChip = await screen.findByRole('radio', { name: /Other/ });
    await userEvent.click(otherChip);

    const input = await screen.findByRole('spinbutton', { name: 'Tip amount' });
    await userEvent.type(input, '75');

    await waitFor(() => {
      expect(screen.getAllByText('$1,110.00').length).toBeGreaterThanOrEqual(1); // 1000 + 35 + 75
    });
  });

  it('rejects a negative "Other" amount — the total never drops below amount_due + fee', async () => {
    renderWithProviders(<PublicInvoicePage />);
    await openCardPanel();

    const otherChip = await screen.findByRole('radio', { name: /Other/ });
    await userEvent.click(otherChip);
    const input = await screen.findByRole('spinbutton', { name: 'Tip amount' });
    await userEvent.type(input, '-20');

    // Clamped to zero — same total as no tip at all.
    await waitFor(() => {
      expect(screen.getAllByText('$1,035.00').length).toBeGreaterThanOrEqual(1);
    });
  });
});
