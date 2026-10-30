/**
 * Roles & Permissions security review, CR-12 - a person without See prices still sees the lines of an invoice that has none
 * of its own: the page borrows the estimate's lines for it, exactly as the priced view does, and shows them with no figure.
 * Renders the routed page (pages/v2/invoices/InvoiceDetailPage).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import InvoiceDetailPage from '@/pages/v2/invoices/InvoiceDetailPage';
import { useAuthStore } from '@/stores/auth.store';

const INVOICE_ID = 'inv-cr12-id';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: INVOICE_ID }), useNavigate: () => vi.fn() };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// Heavy sub-surfaces with no bearing on the line and price controls.
vi.mock('@/components/crm/IconRail', () => ({ IconRail: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/crm/InternalCostsCard', () => ({ InternalCostsCard: () => null }));
vi.mock('@/components/leads/TagInput', () => ({ TagInput: () => null }));
vi.mock('@/components/estimates/PdfPreviewDialog', () => ({ PdfPreviewDialog: () => null }));
vi.mock('@/components/invoices/SendInvoiceDialog', () => ({ SendInvoiceDialog: () => null }));
vi.mock('@/components/invoices/RecordPaymentDialog', () => ({ RecordPaymentDialog: () => null }));
vi.mock('@/components/invoices/VoidInvoiceDialog', () => ({ VoidInvoiceDialog: () => null }));
vi.mock('@/components/invoices/DeleteInvoiceDialog', () => ({ DeleteInvoiceDialog: () => null }));
vi.mock('@/components/invoices/RefundInvoiceDialog', () => ({ RefundInvoiceDialog: () => null }));
vi.mock('@/components/invoices/CreditInvoiceDialog', () => ({ CreditInvoiceDialog: () => null }));
vi.mock('@/components/invoices/VoidPaymentDialog', () => ({ VoidPaymentDialog: () => null }));
vi.mock('@/components/crm/RecordNumberEditor', () => ({ RecordNumberEditor: ({ number }: { number: string }) => <span>{number}</span> }));
// The receipt card is replaced by a probe of which money handlers the page hands it.
vi.mock('@/components/invoices/InvoiceReceiptCard', () => ({
  InvoiceReceiptCard: (p: { onDiscountChange?: unknown; onTipChange?: unknown; onTaxRateChange?: unknown }) => (
    <div
      data-testid="receipt"
      data-discount={p.onDiscountChange ? 'editable' : 'fixed'}
      data-tip={p.onTipChange ? 'editable' : 'fixed'}
      data-tax={p.onTaxRateChange ? 'editable' : 'fixed'}
    />
  ),
}));

const mockApi = vi.mocked(api);

const ESTIMATE_LINE = { id: 'est-line-1', sequence: 1, description: 'Replace garage door spring', quantity: '2.00' };

function invoiceWithoutOwnLines() {
  return {
    id: INVOICE_ID, invoice_number: 'I0012', status: 'SENT', kind: 'STANDARD', sent_at: '2026-10-04T00:00:00.000Z', paid_at: null,
    due_date: '2026-11-15T00:00:00.000Z', voided_at: null, voided_reason: null, refunded_at: null, total_refunded: null,
    refund_reason: null, refund_reason_category: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'cust-1', first_name: 'Jane', last_name: 'Doe', company_name: null },
    job: { id: 'job-1', estimate: { id: 'est-1', line_items: [ESTIMATE_LINE] } },
    line_items: [], scopes: [], refunds: [], credits: [], payments: [], tags: [], public_token: 'tok', actions: [],
  };
}

function mount(ability: ReturnType<typeof buildAbility>) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u-cr12', email: 'p@test.com', first_name: 'Pat', last_name: 'Person', role: 'ADMIN' },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never);
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/invoices/')) return { data: { invoice: invoiceWithoutOwnLines() } };
    if (url.includes('/api/organization')) return { data: {} };
    if (url.includes('/api/state-tax-rates')) return { data: [] };
    return { data: {} };
  });
  renderWithProviders(<InvoiceDetailPage />, { ability });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the invoice page for a person without See prices', () => {
  it('lists the estimate lines of an invoice that has none of its own, with no figure', async () => {
    mount(buildAbility([{ action: 'read', subject: 'Invoice' }] as never));
    expect(await screen.findByText('Replace garage door spring')).toBeInTheDocument();
    expect(screen.getByText('× 2')).toBeInTheDocument();
    expect(screen.queryByLabelText('Line items')?.textContent ?? '').not.toMatch(/\$|NaN/);
  });
});
