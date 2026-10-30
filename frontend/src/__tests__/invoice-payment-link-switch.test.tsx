/**
 * Roles & Permissions S01.17 - the invoice page's payment-link action follows the "Send payment links" switch, not
 * the person's role name. The routed page (pages/v2/invoices/InvoiceDetailPage) offers "Copy payment link" to a
 * person whose ability holds `send_payment_link` on invoices whatever their role is called (a technician on their own
 * invoice), and offers it to nobody whose ability lacks it, an Admin-named role included.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import InvoiceDetailPage from '@/pages/v2/invoices/InvoiceDetailPage';
import { useAuthStore } from '@/stores/auth.store';

const INVOICE_ID = 'inv-s0117-paylink-id';

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
    invoice_number: 'I0117',
    status: 'SENT',
    subtotal: '100.00',
    discount_amount: '0.00',
    tax_rate: '0',
    tax_amount: '0.00',
    deposit_credit: '0.00',
    total_amount: '100.00',
    amount_due: '100.00',
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
    payments: [],
    tags: [],
    actions: [],
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
      user: { id: 'u-s0117', email: 'p@test.com', first_name: 'Pat', last_name: 'Person', role },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InvoiceDetailPage - the payment-link action follows the Send payment links switch', () => {
  it('offers Copy payment link to a technician-role person whose answer for the invoice lists it', async () => {
    signedInWithRole('TECHNICIAN');
    setupMocks(baseInvoice({ status: 'DRAFT', sent_at: null, public_token: null, actions: ['copy_payment_link'] }));
    const user = userEvent.setup();

    renderWithProviders(<InvoiceDetailPage />, {
      // The link opens the customer's priced page, so the copy needs See prices too (H6, ticket 34).
      ability: buildAbility([
        { action: 'read', subject: 'Invoice' }, { action: 'send_payment_link', subject: 'Invoice' }, { action: 'read', subject: 'Prices' },
      ]),
    });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /copy payment link/i })).toBeInTheDocument();
  });

  it('offers no payment link to an admin-role person whose answer for the invoice leaves it out', async () => {
    signedInWithRole('ADMIN');
    setupMocks(baseInvoice({ status: 'DRAFT', sent_at: null, public_token: null, actions: ['edit', 'send'] }));
    const user = userEvent.setup();

    renderWithProviders(<InvoiceDetailPage />, {
      ability: buildAbility([
        { action: 'read', subject: 'Invoice' }, { action: 'send', subject: 'Invoice' }, { action: 'update', subject: 'Invoice' },
        { action: 'read', subject: 'Prices' },
      ]),
    });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await screen.findByRole('menuitem', { name: /preview pdf/i });
    expect(screen.queryByRole('menuitem', { name: /payment link/i })).not.toBeInTheDocument();
  });
});
