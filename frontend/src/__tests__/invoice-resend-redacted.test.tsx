/**
 * #1997 follow-on — `getAvailableActions`'s `canResend` (invoiceMoney.ts) used
 * `!!invoice.public_token` as a "has this invoice ever been sent" proxy. Since round 3's fix
 * (see `handoffs/security-fix-2.md`), `public_token` is entirely ABSENT on a document whose
 * anchored customer the requester cannot read — so a requester with `resend Invoice` but a
 * narrowed `read Customer` lost the Resend button on an already-SENT invoice, even though the
 * backend still allows the resend (it resolves the recipient from the DB row, not the redacted
 * response).
 *
 * The real "was this sent" signal is `status` (SENT/PARTIAL) plus `sent_at`, exactly the pair the
 * backend's own `isSentInvoice()` (backend/src/lib/invoice-editable.ts) uses. Both are always
 * projected in `invoiceDetailSelect` and neither is touched by the customer-contact redaction, so
 * the Resend button must key off those, not off `public_token`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import InvoiceDetailPage from '@/pages/v2/invoices/InvoiceDetailPage';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const INVOICE_ID = 'inv-1997-resend-id';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: INVOICE_ID }), useNavigate: () => vi.fn() };
});

// Heavy sub-surfaces with no bearing on the Resend button.
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
    invoice_number: 'I01997',
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

describe('InvoiceDetailPage — Resend button when public_token is redacted', () => {
  it('still offers Resend on a SENT invoice when public_token is entirely ABSENT (redacted requester)', async () => {
    const invoice = baseInvoice();
    delete (invoice as { public_token?: string }).public_token; // key absent, not null
    setupMocks(invoice);

    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: /resend invoice/i })).toBeInTheDocument();
  });

  it('offers Resend on a SENT invoice when public_token is present (unchanged)', async () => {
    const invoice = baseInvoice({ public_token: 'tok-1997' });
    setupMocks(invoice);

    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: /resend invoice/i })).toBeInTheDocument();
  });

  it('never offers Resend on a DRAFT invoice, token or not', async () => {
    const invoice = baseInvoice({ status: 'DRAFT', sent_at: null, public_token: null });
    setupMocks(invoice);

    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await screen.findByText('I01997');
    expect(screen.queryByRole('button', { name: /resend invoice/i })).not.toBeInTheDocument();
  });
});
