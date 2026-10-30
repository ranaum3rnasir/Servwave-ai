/**
 * W5 - the invoice page's "Copy payment link" never changes the status. On a DRAFT, once the link is copied a small
 * dialog offers "Mark this invoice as sent?"; "Not now" does nothing more, "Mark as sent" calls the mark-sent door.
 * A separate "Mark as sent" menu item (DRAFT + the server's send answer only) opens its own confirm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import InvoiceDetailPage from '@/pages/v2/invoices/InvoiceDetailPage';

const INVOICE_ID = 'inv-w5-id';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: INVOICE_ID }), useNavigate: () => vi.fn() };
});

// Heavy sub-surfaces with no bearing on the Actions menu — none of these render anything the
// "Copy Link" control depends on.
const toastSpy = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock('@/ui-kit/components/ui/sonner', () => ({ toast: toastSpy, Toaster: () => null }));
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
    // The server's answer for this invoice: every action the page can offer.
    actions: ['edit', 'send', 'delete', 'copy_payment_link', 'record_payment'],
    ...overrides,
  };
}

function setupMocks(invoice: Record<string, unknown>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/invoices/')) return { data: { invoice } };
    return { data: {} };
  });
}

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const draft = (o: Record<string, unknown> = {}) =>
  baseInvoice({ status: 'DRAFT', sent_at: null, public_token: null, due_date: '2099-01-01T00:00:00.000Z', ...o });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) }, writable: true, configurable: true,
  });
});

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'More actions' }));
}

describe('InvoiceDetailPage - Copy payment link on a DRAFT', () => {
  async function copyOnDraft() {
    const inv = draft();
    setupMocks(inv);
    mockApi.post.mockImplementation(async (url: string) => {
      if (url.includes('/payment-link')) return { data: { invoice: { ...inv, public_token: 't' }, url: 'https://example.test/p/invoices/x?token=t' } };
      return { data: { invoice: { ...inv, status: 'SENT' } } };
    });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Copy payment link' }));
    return { user, writeText };
  }

  it('copies the link, toasts "Payment link copied", leaves the status Draft and asks to mark as sent', async () => {
    const { writeText } = await copyOnDraft();
    expect(await screen.findByText('Mark this invoice as sent?')).toBeInTheDocument();
    // Ran, 14 Oct: the copy-link prompt carries no "No email is sent." sentence (the menu's confirm still does).
    expect(screen.queryByText('No email is sent.')).not.toBeInTheDocument();
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('token=t'));
    expect(toastSpy).toHaveBeenCalledWith('Payment link copied');
    expect(toastSpy.mock.calls.flat().join(' ')).not.toMatch(/marked as Sent/i);
    expect(mockApi.post).not.toHaveBeenCalledWith(expect.stringContaining('/mark-sent'), expect.anything());
  });

  it('"Not now" calls nothing more', async () => {
    const { user } = await copyOnDraft();
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByText('Mark this invoice as sent?')).not.toBeInTheDocument();
    expect(mockApi.post.mock.calls.filter(([u]) => String(u).includes('/mark-sent'))).toHaveLength(0);
  });

  it('"Mark as sent" calls the mark-sent door', async () => {
    const { user } = await copyOnDraft();
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: 'Mark as sent' }));
    await vi.waitFor(() =>
      expect(mockApi.post.mock.calls.some(([u]) => String(u).endsWith(`/api/invoices/${INVOICE_ID}/mark-sent`))).toBe(true));
  });

  it('shows no prompt when copying the link of an invoice that is already Sent', async () => {
    setupMocks(baseInvoice({ public_token: 'tok' }));
    const user = userEvent.setup();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Copy payment link' }));
    expect(toastSpy).toHaveBeenCalledWith('Payment link copied');
    expect(screen.queryByText('Mark this invoice as sent?')).not.toBeInTheDocument();
  });

  it('labels the menu item "Copy payment link" before any link exists', async () => {
    setupMocks(draft());
    const user = userEvent.setup();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: 'Copy payment link' })).toBeInTheDocument();
  });
});

describe('InvoiceDetailPage - the Mark as sent menu item', () => {
  it('is hidden on a non-draft', async () => {
    setupMocks(baseInvoice());
    const user = userEvent.setup();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });
    await openMenu(user);
    await screen.findByRole('menuitem', { name: /preview pdf/i });
    expect(screen.queryByRole('menuitem', { name: 'Mark as sent' })).not.toBeInTheDocument();
  });

  it('is hidden on a draft when the server does not list send for this person', async () => {
    setupMocks(draft({ actions: ['copy_payment_link'] }));
    const user = userEvent.setup();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });
    await openMenu(user);
    await screen.findByRole('menuitem', { name: /preview pdf/i });
    expect(screen.queryByRole('menuitem', { name: 'Mark as sent' })).not.toBeInTheDocument();
  });

  it('confirms with the number and "No email is sent.", then marks the invoice and updates the badge', async () => {
    let status = 'DRAFT';
    mockApi.get.mockImplementation(async (url: string) =>
      url.includes('/api/invoices/') ? { data: { invoice: draft({ status, sent_at: status === 'SENT' ? '2026-06-01T00:00:00.000Z' : null }) } } : { data: {} });
    mockApi.post.mockImplementation(async () => { status = 'SENT'; return { data: { invoice: draft({ status: 'SENT' }) } }; });
    const user = userEvent.setup();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Mark as sent' }));
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
    expect(await screen.findByText('Mark I0117 as sent?')).toBeInTheDocument();
    expect(screen.getByText('No email is sent.')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Mark as sent' }));
    await vi.waitFor(() =>
      expect(mockApi.post.mock.calls.some(([u]) => String(u).endsWith(`/api/invoices/${INVOICE_ID}/mark-sent`))).toBe(true));
    await vi.waitFor(() => expect(screen.queryByText('Mark I0117 as sent?')).not.toBeInTheDocument());
    expect((await screen.findAllByText('Sent')).length).toBeGreaterThan(0);
  });

  it('shows the server message when the door refuses', async () => {
    setupMocks(draft());
    mockApi.post.mockRejectedValue({ response: { data: { error: 'Only a draft invoice can be marked as sent.' } } });
    const user = userEvent.setup();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Mark as sent' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Mark as sent' }));
    await vi.waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    expect(JSON.stringify(toastSpy.error.mock.calls)).toContain('Only a draft invoice can be marked as sent.');
  });
});
