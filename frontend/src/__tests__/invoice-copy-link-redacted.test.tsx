/**
 * #1997 round 3 (HIGH) — the backend now deletes `public_token` from the invoice detail response
 * entirely (not just nulls it) when the requester cannot read the anchored customer, because an
 * unauthenticated public PDF route accepts that token with no read-Customer check at all.
 *
 * The invoice detail page's "Copy Link" control does double duty (unlike the estimate side's):
 * `handleCopyLink` copies the existing link when `invoice.public_token` is present, and otherwise
 * calls `createInvoicePaymentLink` — a live, authenticated, unrelated-to-Customer-read backend
 * action that mints (or, for an ALREADY-sent invoice, simply returns) the real token in its `url`
 * response field. Treating "key absent because redacted" the same as "key null because never
 * sent" would turn that fallback into a side door: a requester denied the customer's contact block
 * could still fetch the very link the read response just withheld. The control must therefore
 * disable itself (neutral copy, no crash, no `token=undefined`) when the key is absent, and must
 * NOT invoke the payment-link mutation in that state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import InvoiceDetailPage from '@/pages/v2/invoices/InvoiceDetailPage';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const INVOICE_ID = 'inv-1997-copylink-id';

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

describe('InvoiceDetailPage — Copy Link control when public_token is redacted', () => {
  it('disables Copy Link with neutral copy when public_token is entirely ABSENT (redacted requester), and does not mint a payment link', async () => {
    const invoice = baseInvoice();
    delete (invoice as { public_token?: string }).public_token; // key absent, not null
    setupMocks(invoice);
    const user = userEvent.setup();

    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    const item = await screen.findByRole('menuitem', { name: /not available/i });
    expect(item).toHaveAttribute('aria-disabled', 'true');

    await user.click(item);
    expect(mockApi.post).not.toHaveBeenCalledWith(expect.stringContaining('/payment-link'));
  });

  it('copies the existing link (no mutation call) when public_token is present', async () => {
    const invoice = baseInvoice({ public_token: 'tok-1997' });
    setupMocks(invoice);
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });

    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    const item = await screen.findByRole('menuitem', { name: /copy payment link/i });
    await user.click(item);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('token=tok-1997'));
    expect(mockApi.post).not.toHaveBeenCalledWith(expect.stringContaining('/payment-link'), undefined);
  });

  it('still offers "Create Payment Link" (mints one) when public_token is null (genuinely never sent) — unchanged pre-existing behavior', async () => {
    const invoice = baseInvoice({ status: 'DRAFT', sent_at: null, public_token: null });
    setupMocks(invoice);
    mockApi.post.mockResolvedValue({ data: { invoice, url: 'https://app.example.test/p/invoices/x?token=fresh' } });
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });

    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    const item = await screen.findByRole('menuitem', { name: /create payment link/i });
    await user.click(item);

    expect(mockApi.post).toHaveBeenCalledWith(expect.stringContaining('/payment-link'));
  });
});
