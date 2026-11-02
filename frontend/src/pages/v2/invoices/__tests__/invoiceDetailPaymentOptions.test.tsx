import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

import InvoiceDetailPage from '../InvoiceDetailPage';

/**
 * Payments go-live slice 21 - the invoice page carries "Payment options" for that invoice: what
 * it stores (its override, or none) against what the org offers by default. The card's own
 * behaviour is pinned in src/__tests__/invoice-payment-options.test.tsx; this file pins that the
 * page hands it the invoice's stored overrides and the org's defaults, and the edit gate.
 */

// floating-ui, under Radix's dropdown, does `new ResizeObserver(...)`.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const INVOICE_ID = 'i0000000-0000-0000-0000-000000000021';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: INVOICE_ID }) };
});

const mockApi = vi.mocked(api);

const ORG = {
  id: 'o1',
  accepted_payment_methods: ['CARD', 'ACH'],
  stripe_charges_enabled: true,
  card_offered_by_default: true,
  bank_offered_by_default: true,
};

function invoice(overrides: Record<string, unknown>) {
  return {
    id: INVOICE_ID,
    invoice_number: 'I00001',
    status: 'DRAFT',
    kind: 'STANDARD',
    subtotal: 100,
    discount_amount: 0,
    tax_rate: 0,
    tax_amount: 0,
    tip: 0,
    deposit_credit: 0,
    total_amount: 100,
    amount_due: 100,
    net_collected: 0,
    public_token: null,
    sent_at: null,
    paid_at: null,
    due_date: null,
    voided_at: null,
    voided_reason: null,
    refunded_at: null,
    total_refunded: null,
    refund_reason: null,
    refund_reason_category: null,
    created_at: '2026-01-15T00:00:00.000Z',
    updated_at: '2026-01-15T00:00:00.000Z',
    line_items: [],
    scopes: [],
    payments: [],
    refunds: [],
    credits: [],
    tags: [],
    job: null,
    estimate: null,
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      email: 'billing@example.test',
      phone: '5125550125',
      first_name: 'Pat',
      last_name: 'Payer',
    },
    // The server's answer for this invoice: every action the page can offer.
    actions: ['edit', 'send', 'delete', 'copy_payment_link', 'record_payment'],
    ...overrides,
  };
}

function mount(overrides: Record<string, unknown>, rules: Parameters<typeof buildAbility>[0]) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization') return { data: ORG };
    if (url.startsWith('/api/invoices/')) return { data: { invoice: invoice(overrides) } };
    return { data: {} };
  });
  renderWithProviders(<InvoiceDetailPage />, {
    initialEntries: [`/invoices/${INVOICE_ID}`],
    ability: buildAbility(rules),
  });
}

describe('invoice page: Payment options', () => {
  it("shows the invoice's own override against the org default", async () => {
    mount({ payment_methods_override: ['ACH'], allow_partial_payment: true }, [
      { action: 'read', subject: 'Invoice' },
      { action: 'update', subject: 'Invoice' },
      // Edit invoices needs See prices.
      { action: 'read', subject: 'Prices' },
    ]);
    const card = await screen.findByTestId('invoice-payment-options');
    expect(await within(card).findByText('Org default: Card and bank')).toBeInTheDocument();
    expect(within(card).getByRole('checkbox', { name: /^card$/i })).not.toBeChecked();
    expect(within(card).getByRole('checkbox', { name: /^bank$/i })).toBeChecked();
    expect(within(card).getByRole('switch', { name: /allow partial payments/i })).toBeChecked();
    expect(within(card).getByRole('button', { name: /use org default/i })).toBeEnabled();
  });

  it('is read-only when the answer for the invoice lists no edit', async () => {
    mount({ payment_methods_override: null, allow_partial_payment: null, actions: [] }, [{ action: 'read', subject: 'Invoice' }]);
    const card = await screen.findByTestId('invoice-payment-options');
    expect(await within(card).findByRole('checkbox', { name: /^card$/i })).toBeDisabled();
    expect(within(card).getByRole('switch', { name: /allow partial payments/i })).toBeDisabled();
  });
});
