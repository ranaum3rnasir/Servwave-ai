/**
 * Roles & Permissions S04.27 - the invoice page draws send, resend, edit, delete a draft, copy payment link and record
 * payment from the server's answer for THIS invoice (`invoice.actions`), not from the person's role name or their
 * switches alone. A creator with View invoices off finishes their own invoice (their ability holds nothing on invoices
 * at all); a person whose answer for the invoice is empty gets none of the buttons, an Admin-named role included.
 * Renders the routed page (pages/v2/invoices/InvoiceDetailPage).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import InvoiceDetailPage from '@/pages/v2/invoices/InvoiceDetailPage';
import { useAuthStore } from '@/stores/auth.store';

const INVOICE_ID = 'inv-s0427-actions-id';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: INVOICE_ID }), useNavigate: () => vi.fn() };
});

// Heavy sub-surfaces with no bearing on the header's actions.
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
    invoice_number: 'I0427',
    status: 'DRAFT',
    subtotal: '100.00',
    discount_amount: '0.00',
    tax_rate: '0',
    tax_amount: '0.00',
    deposit_credit: '0.00',
    total_amount: '100.00',
    amount_due: '100.00',
    sent_at: null,
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
    public_token: null,
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

/** Sign in as a person with this base role name; the page must not read it to decide any action. */
function signedInWithRole(role: string) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u-s0427', email: 'p@test.com', first_name: 'Pat', last_name: 'Person', role },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })) as never);
}

/** A person whose switches grant nothing on invoices: they reach the page by the creator rule alone. */
const NO_INVOICE_SWITCHES = () => buildAbility([]);

async function openMenu() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'More actions' }));
  await screen.findByRole('menuitem', { name: /preview pdf/i });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InvoiceDetailPage - the buttons follow the answer for this invoice', () => {
  it('offers send, edit and delete on a draft the person made, with no View invoices and no Edit invoices', async () => {
    signedInWithRole('TECHNICIAN');
    setupMocks(baseInvoice({ actions: ['edit', 'send', 'delete'] }));

    renderWithProviders(<InvoiceDetailPage />, { ability: NO_INVOICE_SWITCHES() });

    expect(await screen.findByRole('button', { name: /send invoice/i })).toBeInTheDocument();
    await openMenu();
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    // The creator rule never opens the money actions.
    expect(screen.queryByRole('menuitem', { name: /payment link/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /record payment/i })).not.toBeInTheDocument();
  });

  it('offers none of them on an invoice whose answer is empty, to an admin-named role holding every switch', async () => {
    signedInWithRole('ADMIN');
    setupMocks(baseInvoice({ actions: [] }));

    renderWithProviders(<InvoiceDetailPage />, {
      ability: buildAbility([
        { action: 'read', subject: 'Invoice' }, { action: 'update', subject: 'Invoice' }, { action: 'send', subject: 'Invoice' },
        { action: 'delete', subject: 'Invoice' }, { action: 'record_payment', subject: 'Invoice' }, { action: 'send_payment_link', subject: 'Invoice' },
      ]),
    });

    await openMenu();
    expect(screen.queryByRole('button', { name: /send invoice/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /payment link/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /record payment/i })).not.toBeInTheDocument();
  });

  it('offers resend on a sent invoice when the answer lists send', async () => {
    signedInWithRole('TECHNICIAN');
    setupMocks(baseInvoice({ status: 'SENT', sent_at: '2026-06-01T00:00:00.000Z', actions: ['edit', 'send'] }));

    renderWithProviders(<InvoiceDetailPage />, { ability: NO_INVOICE_SWITCHES() });

    expect(await screen.findByRole('button', { name: /resend invoice/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^send invoice/i })).not.toBeInTheDocument();
  });

  it('offers copy payment link and record payment when the answer lists them, whatever the ability says', async () => {
    signedInWithRole('TECHNICIAN');
    setupMocks(baseInvoice({ status: 'SENT', sent_at: '2026-06-01T00:00:00.000Z', actions: ['copy_payment_link', 'record_payment'] }));

    renderWithProviders(<InvoiceDetailPage />, { ability: NO_INVOICE_SWITCHES() });

    expect((await screen.findAllByRole('button', { name: /record payment/i })).length).toBeGreaterThan(0);
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /copy payment link/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('asks no role name anywhere on the page', () => {
    const source = readFileSync('src/pages/v2/invoices/InvoiceDetailPage.tsx', 'utf8');
    expect(source).not.toMatch(/user\??\.role\b/);
    expect(source).not.toMatch(/['"](?:ADMIN|DISPATCHER|TECHNICIAN|SALES)['"]/);
  });
});
