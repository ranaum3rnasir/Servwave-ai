import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import InvoiceDetailPage from '../InvoiceDetailPage';

/**
 * Roles & Permissions alignment, AL-05 (P11): the invoice page for a person without See prices. The server leaves every price
 * out of the invoice it sends, and the page draws no total, balance, payment or priced grid, and no document to download.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const INVOICE_ID = 'i0000000-0000-0000-0000-000000000002';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: INVOICE_ID }) };
});

const mockApi = vi.mocked(api);

/** An invoice as the server sends it to a person without the switch: every price key is simply absent. */
const PRICE_BLIND_INVOICE = {
  id: INVOICE_ID, invoice_number: 'I00002', status: 'PARTIAL', kind: 'STANDARD', public_token: null, sent_at: null, paid_at: null,
  due_date: null, voided_at: null, voided_reason: null, created_at: '2026-01-15T00:00:00.000Z', updated_at: '2026-01-15T00:00:00.000Z',
  line_items: [{ id: 'li-1', invoice_id: INVOICE_ID, sequence: 1, description: 'Replace hinge', quantity: 2, is_taxable: true, item_type: 'MATERIAL' }],
  scopes: [{ id: 's-1', title: 'Fit the door', body: 'Square it up', is_taxable: true }],
  payments: [{ id: 'p-1', method: 'CARD', paid_at: '2026-07-02T12:00:00.000Z', state: 'SUCCEEDED', voided_at: null }],
  refunds: [], credits: [], tags: [], job: null, estimate: null,
  customer: { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', company_name: null, email: 'a@example.test', phone: '5125550125' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v2 invoice page without See prices', () => {
  it('shows what the work is and how many, with no figure, no Payments tab and no document actions', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/invoices/')) return { data: { invoice: PRICE_BLIND_INVOICE } };
      return { data: {} };
    });
    renderWithProviders(<InvoiceDetailPage />, {
      initialEntries: [`/invoices/${INVOICE_ID}`],
      ability: buildAbility([{ action: 'read', subject: 'Invoice' }] as never),
    });

    expect(await screen.findByText('Replace hinge')).toBeInTheDocument();
    expect(screen.getByText('Fit the door')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-amount-due')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Payments/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Preview PDF|Download PDF/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$|NaN/);
  });
});
