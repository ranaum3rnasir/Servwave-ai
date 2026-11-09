/**
 * Payments go-live slice 29 - the invoice page offers only the money actions the server takes:
 *   - a bank payment still processing reads "Cancel payment" (not Refund) for a person holding the
 *     refund permission, and cancelling it goes through its own dialog;
 *   - a REFUNDED invoice is final: no Void Invoice, Refund or Credit, and no Void on its payment
 *     rows (the server refuses them all).
 *
 * The page is the ROUTED v2 one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildAbility } from '@/lib/ability';
import { renderInvoiceDetail, serveInvoiceDetail } from '@/__tests__/harness/invoiceDetailPage';

const INVOICE_ID = 'inv-pay29';
vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/invoiceDetailRouter')).invoiceDetailRouter({ navigate: true }));

// Heavy sub-surfaces with no bearing on which actions are offered.
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
vi.mock('@/components/invoices/VoidPaymentDialog', () => ({ VoidPaymentDialog: () => null }));
vi.mock('@/components/invoices/CreditInvoiceDialog', () => ({ CreditInvoiceDialog: () => null }));
vi.mock('@/components/crm/RecordNumberEditor', () => ({ RecordNumberEditor: ({ number }: { number: string }) => <span>{number}</span> }));
vi.mock('@/components/payments/PaymentsSetupBanner', () => ({ PaymentsSetupBanner: () => null }));
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({ EstimateTabs: () => null }));
vi.mock('@/components/estimates/EstimateLineItemsEditor', () => ({
  EstimateLineItemsEditor: () => null,
  EstimateScopeOfWorkCard: () => null,
  estimateLinesToInvoiceShape: (lines: unknown) => lines,
}));
vi.mock('@/features/estimate-workspace/components/SignatureCard', () => ({ SignatureCard: () => null }));
vi.mock('@/features/estimate-workspace/components/NotesCard', () => ({ NotesCard: () => null }));
vi.mock('@/features/estimate-workspace/components/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/estimates/CancelEstimateDialog', () => ({ CancelEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));


// The payments and balance on the page are prices, so an office person holds See prices (P11).
const officeGrants = [
  { action: 'read', subject: 'Invoice' },
  { action: 'update', subject: 'Invoice' },
  { action: 'send', subject: 'Invoice' },
  { action: 'record_payment', subject: 'Invoice' },
  { action: 'credit', subject: 'Invoice' },
  { action: 'void_payment', subject: 'Invoice' },
  { action: 'void', subject: 'Invoice' },
  { action: 'read', subject: 'Pricing' },
  { action: 'read', subject: 'Prices' },
] as const;
const withoutRefund = buildAbility([...officeGrants]);
// Refund payments needs View payments and payouts.
const withRefund = buildAbility([
  ...officeGrants,
  { action: 'refund', subject: 'Invoice' },
  { action: 'view_payments', subject: 'Organization' },
]);

function payment(over: Record<string, unknown>) {
  return {
    id: 'pay-29',
    invoice_id: INVOICE_ID,
    amount: '300.00',
    method: 'CASH',
    state: 'SUCCEEDED',
    paid_at: '2026-10-01T15:00:00.000Z',
    collector: null,
    reference_number: null,
    voided_at: null,
    paid_through_processor: false,
    stripe_fee_amount: null,
    platform_fee_amount: null,
    net_amount: null,
    ...over,
  };
}

function invoice(over: Record<string, unknown>) {
  return {
    id: INVOICE_ID,
    invoice_number: 'I02901',
    status: 'SENT',
    subtotal: '300.00',
    discount_amount: '0.00',
    tax_rate: '0',
    tax_amount: '0.00',
    deposit_credit: '0.00',
    total_amount: '300.00',
    amount_due: '300.00',
    net_collected: '0.00',
    public_token: 'tok-pay29',
    sent_at: '2026-10-01T00:00:00.000Z',
    paid_at: null,
    due_date: '2026-10-31T00:00:00.000Z',
    voided_at: null,
    voided_reason: null,
    refunded_at: null,
    total_refunded: '0.00',
    refund_reason: null,
    refund_reason_category: null,
    kind: 'STANDARD',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'cust-pay29', first_name: 'Pat', last_name: 'Payer', company_name: null },
    job: null,
    line_items: [],
    scopes: [],
    refunds: [],
    credits: [],
    payments: [],
    tags: [],
    ...over,
  };
}

function serve(inv: Record<string, unknown>) {
  serveInvoiceDetail({ invoice: inv, stateTaxRates: { data: [] }, organization: { accepted_payment_methods: ['CASH'] } });
}

const PROCESSING_BANK = invoice({
  payments: [payment({ method: 'ACH', state: 'PROCESSING', paid_through_processor: true })],
});

const REFUNDED = invoice({
  status: 'REFUNDED',
  amount_due: '0.00',
  paid_at: '2026-10-01T15:00:00.000Z',
  total_refunded: '300.00',
  payments: [payment({})],
  refunds: [{ id: 'ref-29', invoice_id: INVOICE_ID, amount: '300.00', method: 'CASH', payment_id: 'pay-29', state: 'SUCCEEDED', reason_category: 'CUSTOMER_REQUEST', created_at: '2026-10-02T00:00:00.000Z' }],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a bank payment still processing', () => {
  it('reads "Cancel payment" for a person who may refund, and opens the cancel dialog; no Refund is offered', async () => {
    serve(PROCESSING_BANK);
    const user = userEvent.setup();
    renderInvoiceDetail({ id: INVOICE_ID, ability: withRefund });

    expect(await screen.findAllByText('I02901')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Refund$/ })).not.toBeInTheDocument();

    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));
    await user.click(await screen.findByRole('button', { name: 'Cancel payment' }));

    const dialog = await screen.findByTestId('cancel-bank-payment-dialog');
    expect(within(dialog).getByText(/This bank payment of \$300\.00 has not cleared yet\./)).toBeInTheDocument();
  });

  it('offers no "Cancel payment" without the refund permission', async () => {
    serve(PROCESSING_BANK);
    const user = userEvent.setup();
    renderInvoiceDetail({ id: INVOICE_ID, ability: withoutRefund });

    expect(await screen.findAllByText('I02901')).not.toHaveLength(0);
    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));
    expect(screen.getAllByText('processing')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Cancel payment' })).not.toBeInTheDocument();
  });
});

describe('a REFUNDED invoice', () => {
  it('is final: no Void Invoice, Refund or Credit, and no Void on its payment row (the server refuses them all)', async () => {
    serve(REFUNDED);
    const user = userEvent.setup();
    renderInvoiceDetail({ id: INVOICE_ID, ability: withRefund });

    expect(await screen.findAllByText('I02901')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Credit$/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));
    expect(screen.getAllByText('Cash')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Void$/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /^Credit$/ })).not.toBeInTheDocument();
    // A REFUNDED invoice is final: it is never voided, and nothing more goes back.
    expect(within(menu).queryByRole('menuitem', { name: /Void Invoice/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /^Refund$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Refund$/ })).not.toBeInTheDocument();
  });

  it('an open invoice still offers Void Invoice to the same person (control)', async () => {
    serve(invoice({}));
    const user = userEvent.setup();
    renderInvoiceDetail({ id: INVOICE_ID, ability: withRefund });

    expect(await screen.findAllByText('I02901')).not.toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Void Invoice/ })).toBeInTheDocument();
  });

  it('the same payment row on a PAID invoice still offers Void (control)', async () => {
    serve(invoice({ status: 'PAID', amount_due: '0.00', net_collected: '300.00', payments: [payment({})] }));
    const user = userEvent.setup();
    renderInvoiceDetail({ id: INVOICE_ID, ability: withRefund });

    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));
    expect(await screen.findByRole('button', { name: /^Void$/ })).toBeInTheDocument();
  });
});
