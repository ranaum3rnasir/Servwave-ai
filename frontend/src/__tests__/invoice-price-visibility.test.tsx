import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { renderInvoiceDetail, serveInvoiceDetail, mountInvoiceDetail } from '@/__tests__/harness/invoiceDetailPage';

vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/invoiceDetailRouter')).invoiceDetailRouter({ navigate: true }));
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

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('invoice-done-prices', () => {
  /**
   * Roles & Permissions, PRD 6, S06.19 - the routed invoice page of a Done job offers no line, scope, discount or tax edit.
   *
   * GET /api/invoices/:id answers `price_edit_closed_reason` (the Done sentence) for an invoice the Done job holds. The page
   * says it where the edit would be, draws Add item and Add scope of work disabled with it, leaves the per-row controls off,
   * and hands the receipt card no discount or tax handler, whoever the person is. The tip is not a price and stays editable;
   * sending and recording a payment stay on the header. An invoice whose answer carries no reason keeps every control.
   * Renders the routed page (pages/v2/invoices/InvoiceDetailPage).
   */

  const INVOICE_ID = 'inv-s0619-done-id';
  const DONE_REASON = 'This job is Done. Reopen it to change its lines or prices.';

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

  // Heavy sub-surfaces with no bearing on the line and price controls.
  // The receipt card is replaced by a probe of which money handlers the page hands it.


  const LINE = {
    id: 'line-1', sequence: 1, description: 'Compressor swap', quantity: 1, unit_price: 300, unit_cost: 200, is_taxable: true,
    line_total: 300, discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE', price_book_item_id: null,
  };
  const SCOPE = { id: 'scope-1', title: 'Haul away', body: '', flat_price: 50, is_taxable: true, internal_cost: null };

  function invoiceWith(overrides: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID, invoice_number: 'I0619', status: 'SENT', subtotal: '350.00', discount_amount: '0.00', tax_rate: '0',
      tax_amount: '0.00', tip: '0.00', deposit_credit: '0.00', total_amount: '350.00', amount_due: '350.00', sent_at: '2026-10-04T00:00:00.000Z',
      paid_at: null, due_date: '2026-11-15T00:00:00.000Z', voided_at: null, voided_reason: null, refunded_at: null, total_refunded: null,
      refund_reason: null, refund_reason_category: null, kind: 'STANDARD', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
      customer: { id: 'cust-1', first_name: 'Jane', last_name: 'Doe', company_name: null },
      job: null, line_items: [LINE], scopes: [SCOPE], refunds: [], credits: [], payments: [], tags: [], public_token: 'tok',
      // Everything the person's switches allow on this invoice; the Done sentence is a separate field.
      actions: ['edit', 'send', 'record_payment'],
      price_edit_closed_reason: DONE_REASON,
      ...overrides,
    };
  }

  function mount(invoice: Record<string, unknown>) {
    vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        user: { id: 'u-s0619', email: 'p@test.com', first_name: 'Pat', last_name: 'Person', role: 'ADMIN' },
        isAuthenticated: true, isLoading: false, error: null,
      })) as never);
    serveInvoiceDetail({ invoice });
    // Everything is allowed to this person by role: only the invoice's own answer decides what the page draws.
    renderInvoiceDetail({ id: INVOICE_ID, ability: buildAbility([{ action: 'manage', subject: 'all' }]) });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('the invoice page of a Done job', () => {
    it('says the Done sentence, draws Add item and Add scope of work disabled with it, and leaves no per-row controls', async () => {
      mount(invoiceWith());

      expect(await screen.findByTestId('invoice-done-prices-notice')).toHaveTextContent(DONE_REASON);
      const addItem = await screen.findByRole('button', { name: /add item/i });
      expect(addItem).toBeDisabled();
      expect(addItem).toHaveAccessibleDescription(DONE_REASON);
      const addScope = screen.getByRole('button', { name: /add scope of work/i });
      expect(addScope).toBeDisabled();
      expect(addScope).toHaveAccessibleDescription(DONE_REASON);
      expect(screen.queryByRole('button', { name: /price book/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /remove compressor swap/i })).toBeNull();
    });

    it('hands the receipt card no discount and no tax handler, and keeps the tip', async () => {
      mount(invoiceWith());
      const receipt = await screen.findByTestId('receipt');
      expect(receipt).toHaveAttribute('data-discount', 'fixed');
      expect(receipt).toHaveAttribute('data-tax', 'fixed');
      expect(receipt).toHaveAttribute('data-tip', 'editable');
    });

    it('keeps sending and recording a payment on the header', async () => {
      mount(invoiceWith());
      await screen.findByTestId('invoice-done-prices-notice');
      const record = screen.getAllByRole('button', { name: /record payment/i });
      expect(record.length).toBeGreaterThan(0);
      for (const button of record) expect(button).toBeEnabled();
    });

    it('keeps every line and price control on an invoice whose answer carries no reason', async () => {
      mount(invoiceWith({ price_edit_closed_reason: null, status: 'DRAFT' }));
      const addItem = await screen.findByRole('button', { name: /add item/i });
      expect(addItem).toBeEnabled();
      expect(screen.getByRole('button', { name: /add scope of work/i })).toBeEnabled();
      expect(screen.queryByTestId('invoice-done-prices-notice')).toBeNull();
      const receipt = screen.getByTestId('receipt');
      expect(receipt).toHaveAttribute('data-discount', 'editable');
      expect(receipt).toHaveAttribute('data-tax', 'editable');
    });
  });
});

describe('invoice-price-free-lines', () => {
  /**
   * Roles & Permissions security review, CR-12 - a person without See prices still sees the lines of an invoice that has none
   * of its own: the page borrows the estimate's lines for it, exactly as the priced view does, and shows them with no figure.
   * Renders the routed page (pages/v2/invoices/InvoiceDetailPage).
   */

  const INVOICE_ID = 'inv-cr12-id';

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

  // Heavy sub-surfaces with no bearing on the line and price controls.
  // The receipt card is replaced by a probe of which money handlers the page hands it.


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
    mountInvoiceDetail({ id: INVOICE_ID, invoice: () => invoiceWithoutOwnLines(), ability });
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
});
