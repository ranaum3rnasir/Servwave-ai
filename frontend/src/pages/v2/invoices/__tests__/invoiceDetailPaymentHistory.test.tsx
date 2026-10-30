import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';

import InvoiceDetailPage from '../InvoiceDetailPage';

/**
 * Payments go-live slice 28: the payment history on the v2 invoice page says how each payment was
 * made, labels a payment that has not cleared or did not go through, names who sent a refund back,
 * and the Processing badge shows while bank money is clearing.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const INVOICE_ID = 'i0000000-0000-0000-0000-000000000001';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: INVOICE_ID }) };
});

const mockApi = vi.mocked(api);

const pay = (o: Record<string, unknown>) => ({
  amount: 100, method: 'CARD', paid_at: '2026-07-02T12:00:00.000Z', collected_by: null, paid_through_processor: true,
  reference_number: null, notes: null, created_at: '2026-07-02T12:00:00.000Z', collector: null, voided_at: null,
  state: 'SUCCEEDED', ...o,
});

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID, invoice_number: 'I00001', status: 'PARTIAL', kind: 'STANDARD', subtotal: 500, discount_amount: 0,
    tax_rate: 0, tax_amount: 0, tip: 0, deposit_credit: 0, total_amount: 500, amount_due: 300, net_collected: 200,
    public_token: null, sent_at: null, paid_at: null, due_date: null, voided_at: null, voided_reason: null,
    refunded_at: null, total_refunded: null, refund_reason: null, refund_reason_category: null,
    created_at: '2026-01-15T00:00:00.000Z', updated_at: '2026-01-15T00:00:00.000Z',
    line_items: [], scopes: [], payments: [], refunds: [], credits: [], tags: [], job: null, estimate: null,
    customer: { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', company_name: null, email: 'a@example.test', phone: '5125550125' },
    ...over,
  };
}

async function openPayments(inv: ReturnType<typeof invoice>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/invoices/')) return { data: { invoice: inv } };
    return { data: {} };
  });
  renderWithProviders(<InvoiceDetailPage />, { initialEntries: [`/invoices/${INVOICE_ID}`] });
  await userEvent.click(await screen.findByRole('tab', { name: /^Payments \(/ }));
  return screen.getByTestId('invoice-ledger');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v2 invoice payment history', () => {
  it('reads a card, a wallet, Link and a bank payment each the way the customer paid', async () => {
    const ledger = await openPayments(invoice({
      payments: [
        pay({ id: 'a', card_brand: 'visa', card_last4: '4242' }),
        pay({ id: 'b', wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242' }),
        pay({ id: 'c', wallet: 'LINK', card_brand: 'visa', card_last4: '0000' }),
        pay({ id: 'd', method: 'ACH', bank_name: 'Bank of Example', bank_last4: '6789' }),
      ],
    }));

    expect(within(ledger).getByText('Visa •••• 4242')).toBeInTheDocument();
    expect(within(ledger).getByText('Apple Pay (Visa •••• 4242)')).toBeInTheDocument();
    expect(within(ledger).getByText('Link')).toBeInTheDocument();
    expect(within(ledger).getByText('Bank of Example •••• 6789')).toBeInTheDocument();
    // Link never shows a placeholder card.
    expect(within(ledger).queryByText(/0000/)).not.toBeInTheDocument();
    // An online bank payment is a payment, not a hand-recorded one.
    expect(within(ledger).queryByText('Manual Payment')).not.toBeInTheDocument();
  });

  it('a refund row names the person who sent the money back', async () => {
    const ledger = await openPayments(invoice({
      payments: [pay({ id: 'a', card_brand: 'visa', card_last4: '4242' })],
      refunds: [{
        id: 'r1', invoice_id: INVOICE_ID, amount: 10, method: 'CARD', created_at: '2026-07-03T00:00:00.000Z', state: 'SUCCEEDED',
        refunded_by_user: { id: 'u1', first_name: 'Rita', last_name: 'Refunder' },
      }],
    }));

    expect(within(ledger).getByText('Rita Refunder')).toBeInTheDocument();
  });

  it('a deposit invoice with one payment reads "Payments (1)"', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/invoices/')) {
        return {
          data: {
            invoice: invoice({
              kind: 'DEPOSIT', status: 'PAID', amount_due: 0,
              payments: [pay({ id: 'a', amount: 200, card_brand: 'visa', card_last4: '4242' })],
              estimate: {
                id: 'est-1', estimate_number: 'E1',
                invoices: [{ id: INVOICE_ID, status: 'PAID', total_refunded: 0, refunded_at: null, payments: [{ amount: 200, method: 'CARD', paid_at: '2026-07-02T12:00:00.000Z', reference_number: null }] }],
              },
            }),
          },
        };
      }
      return { data: {} };
    });
    renderWithProviders(<InvoiceDetailPage />, { initialEntries: [`/invoices/${INVOICE_ID}`] });

    expect(await screen.findByRole('tab', { name: 'Payments (1)' })).toBeInTheDocument();
  });
});

describe('v2 invoice Processing badge', () => {
  it('shows "Processing $X" in the header while bank money is clearing', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/invoices/')) return { data: { invoice: invoice({ processing_amount: 60, payments: [pay({ id: 'd', amount: 60, method: 'ACH', state: 'PROCESSING' })] }) } };
      return { data: {} };
    });
    renderWithProviders(<InvoiceDetailPage />, { initialEntries: [`/invoices/${INVOICE_ID}`] });

    expect((await screen.findAllByText('Processing $60.00')).length).toBeGreaterThan(0);
  });

  it('shows no badge when no payment is processing', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/invoices/')) return { data: { invoice: invoice({ processing_amount: 0 }) } };
      return { data: {} };
    });
    renderWithProviders(<InvoiceDetailPage />, { initialEntries: [`/invoices/${INVOICE_ID}`] });

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/Processing \$/)).not.toBeInTheDocument();
  });
});
