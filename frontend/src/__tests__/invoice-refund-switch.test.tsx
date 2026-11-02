/**
 * Roles & Permissions S04.26 - the invoice page's Refund action follows the "Refund payments" switch, not the person's
 * role name or their other money switches. The routed page (pages/v2/invoices/InvoiceDetailPage) offers Refund on a
 * paid invoice to a person whose ability holds `refund` on invoices whatever their role is called, and to nobody whose
 * ability lacks it - an Admin-named role, and a person who holds Record payments, void and credit, included.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import InvoiceDetailPage from '@/pages/v2/invoices/InvoiceDetailPage';
import { useAuthStore } from '@/stores/auth.store';

const INVOICE_ID = 'inv-s0426-refund-id';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: INVOICE_ID }), useNavigate: () => vi.fn() };
});

// Heavy sub-surfaces with no bearing on the Actions menu — none of these render anything the
// "Copy Link" control depends on.
vi.mock('@/components/crm/IconRail', () => ({ IconRail: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/crm/InternalCostsCard', () => ({ InternalCostsCard: () => null }));
vi.mock('@/components/leads/TagInput', () => ({ TagInput: () => null }));
vi.mock('@/components/estimates/PdfPreviewDialog', () => ({ PdfPreviewDialog: () => null }));
vi.mock('@/components/invoices/InvoiceReceiptCard', () => ({ InvoiceReceiptCard: () => null }));
vi.mock('@/components/invoices/InvoiceLineItemsEditor', () => ({
  InvoiceLineItemsEditor: () => null,
  InvoiceScopeOfWorkCard: () => null,
}));
vi.mock('@/components/invoices/SendInvoiceDialog', () => ({ SendInvoiceDialog: () => null }));
vi.mock('@/components/invoices/RecordPaymentDialog', () => ({ RecordPaymentDialog: () => null }));
vi.mock('@/components/invoices/VoidInvoiceDialog', () => ({ VoidInvoiceDialog: () => null }));
vi.mock('@/components/invoices/DeleteInvoiceDialog', () => ({ DeleteInvoiceDialog: () => null }));
vi.mock('@/components/invoices/RefundInvoiceDialog', () => ({ RefundInvoiceDialog: () => null }));
vi.mock('@/components/invoices/CreditInvoiceDialog', () => ({ CreditInvoiceDialog: () => null }));
vi.mock('@/components/invoices/VoidPaymentDialog', () => ({ VoidPaymentDialog: () => null }));
vi.mock('@/components/crm/RecordNumberEditor', () => ({ RecordNumberEditor: ({ number }: { number: string }) => <span>{number}</span> }));

const mockApi = vi.mocked(api);

function baseInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: 'I0426',
    status: 'PAID',
    subtotal: '100.00',
    discount_amount: '0.00',
    tax_rate: '0',
    tax_amount: '0.00',
    deposit_credit: '0.00',
    total_amount: '100.00',
    amount_due: '0.00',
    net_collected: '100.00',
    sent_at: '2026-06-01T00:00:00.000Z',
    paid_at: null,
    due_date: '2026-06-15T00:00:00.000Z',
    voided_at: null,
    voided_reason: null,
    refunded_at: null,
    total_refunded: null,
    refund_reason: null,
    refund_reason_category: null,
    kind: 'STANDARD',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    customer: { id: 'cust-1997', first_name: 'Jane', last_name: 'Doe', company_name: null },
    job: null,
    line_items: [],
    scopes: [],
    refunds: [],
    credits: [],
    payments: [{ id: 'pay-1', amount: '100.00', method: 'CASH', paid_at: '2026-06-02T00:00:00.000Z', state: 'SUCCEEDED', voided_at: null, reference_number: null }],
    tags: [],
    ...overrides,
  };
}

function setupMocks(invoice: Record<string, unknown>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/invoices/')) return { data: { invoice } };
    if (url.includes('/api/organization')) return { data: {} };
    if (url.includes('/api/state-tax-rates')) return { data: [] };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});


/** Sign in as a person with this base role name; the page must not read it to decide the link action. */
function signedInWithRole(role: string) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u-s0426', email: 'p@test.com', first_name: 'Pat', last_name: 'Person', role },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InvoiceDetailPage - the Refund action follows the Refund payments switch', () => {
  it('offers Refund on a paid invoice to a technician-role person who holds the switch', async () => {
    signedInWithRole('TECHNICIAN');
    setupMocks(baseInvoice());

    renderWithProviders(<InvoiceDetailPage />, {
      // Refund payments needs View invoices and View payments and payouts.
      ability: buildAbility([
        { action: 'read', subject: 'Invoice' }, { action: 'refund', subject: 'Invoice' },
        { action: 'view_payments', subject: 'Organization' },
      ]),
    });

    expect((await screen.findAllByRole('button', { name: 'Refund' })).length).toBeGreaterThan(0);
  });

  it('offers no Refund to an admin-role person who holds every other money switch but not this one', async () => {
    signedInWithRole('ADMIN');
    setupMocks(baseInvoice());

    renderWithProviders(<InvoiceDetailPage />, {
      ability: buildAbility([
        { action: 'read', subject: 'Invoice' }, { action: 'record_payment', subject: 'Invoice' },
        { action: 'credit', subject: 'Invoice' }, { action: 'void', subject: 'Invoice' }, { action: 'send_payment_link', subject: 'Invoice' },
        // Record payments needs See prices.
        { action: 'read', subject: 'Prices' },
      ]),
    });

    await screen.findAllByRole('button', { name: 'Credit' });
    expect(screen.queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
  });
});
