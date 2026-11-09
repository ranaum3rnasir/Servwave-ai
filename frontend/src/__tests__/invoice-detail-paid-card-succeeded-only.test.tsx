/**
 * Payments go-live slice 05 (fix round 1): the routed invoice detail page's PAYMENTS "Paid" stat
 * card, and the net-paid figure that decides whether Refund is offered, count only payments that
 * have SUCCEEDED. A bank payment that is still PROCESSING has not landed, and a FAILED one never
 * will; both stay in the payment history but never in "Paid". Otherwise Paid + Balance adds up to
 * more than the invoice total.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildAbility } from '@/lib/ability';
import { renderInvoiceDetail, serveInvoiceDetail } from '@/__tests__/harness/invoiceDetailPage';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const INVOICE_ID = 'inv-pay05-paid-card';

vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/invoiceDetailRouter')).invoiceDetailRouter({ navigate: true }));

// Heavy sub-surfaces with no bearing on the PAYMENTS stat cards or the header actions.
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
vi.mock('@/components/invoices/CreditInvoiceDialog', () => ({ CreditInvoiceDialog: () => null }));
vi.mock('@/components/invoices/VoidPaymentDialog', () => ({ VoidPaymentDialog: () => null }));
vi.mock('@/components/crm/RecordNumberEditor', () => ({ RecordNumberEditor: ({ number }: { number: string }) => <span>{number}</span> }));


function refund(id: string, amount: string, state: string) {
  return {
    id,
    invoice_id: INVOICE_ID,
    amount,
    method: 'ACH',
    payment_id: null,
    reason: 'test',
    reason_category: 'CUSTOMER_REQUEST',
    created_at: '2026-10-02T15:00:00.000Z',
    state,
  };
}

function payment(id: string, amount: string, method: string, state: string) {
  return {
    id,
    amount,
    method,
    state,
    paid_at: '2026-10-01T15:00:00.000Z',
    collector: null,
    reference_number: null,
    voided_at: null,
    paid_through_processor: false,
    stripe_fee_amount: null,
    platform_fee_amount: null,
    net_amount: null,
  };
}

function invoiceWith(overrides: Record<string, unknown>) {
  return {
    id: INVOICE_ID,
    invoice_number: 'I05150',
    status: 'PARTIAL',
    subtotal: '150.00',
    discount_amount: '0.00',
    tax_rate: '0',
    tax_amount: '0.00',
    deposit_credit: '0.00',
    total_amount: '150.00',
    amount_due: '50.00',
    net_collected: '100.00',
    public_token: 'tok-pay05',
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
    customer: { id: 'cust-pay05', first_name: 'Jane', last_name: 'Doe', company_name: null },
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

function serve(invoice: Record<string, unknown>) {
  serveInvoiceDetail({ invoice });
}

/** The PAYMENTS group's stat card carrying `label`, read as one string ("Paid$100.00"). */
async function statCard(label: string): Promise<string> {
  const labels = await screen.findAllByText(label, { exact: true });
  const card = labels.map((el) => el.closest('[data-slot="stat-card"]')).find((c): c is Element => c != null);
  if (!card) throw new Error(`no stat card labelled ${label}`);
  return card.textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InvoiceDetailPage PAYMENTS card: only payments that landed count as Paid', () => {
  it('$100 SUCCEEDED + $50 PROCESSING on $150 reads Paid $100.00, Balance $50.00', async () => {
    serve(
      invoiceWith({
        payments: [payment('p-cash', '100.00', 'CASH', 'SUCCEEDED'), payment('p-ach', '50.00', 'ACH', 'PROCESSING')],
      }),
    );
    renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

    expect(await statCard('Paid')).toBe('Paid$100.00');
    expect(await statCard('Balance')).toBe('Balance$50.00');
  });

  it('a FAILED payment adds nothing to Paid', async () => {
    serve(
      invoiceWith({
        payments: [payment('p-cash', '100.00', 'CASH', 'SUCCEEDED'), payment('p-ach', '50.00', 'ACH', 'FAILED')],
      }),
    );
    renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

    expect(await statCard('Paid')).toBe('Paid$100.00');
  });

  it('a legacy row with no net_collected offers no Refund when nothing it was paid has landed', async () => {
    // net_collected reads 0 on legacy rows, so the page falls back to summing payments. A FAILED
    // payment is not money that can be refunded.
    serve(
      invoiceWith({
        net_collected: '0.00',
        payments: [payment('p-ach', '50.00', 'ACH', 'FAILED')],
      }),
    );
    const user = userEvent.setup();
    renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

    expect(await statCard('Paid')).toBe('Paid$0.00');
    expect(screen.queryByRole('button', { name: /^Refund$/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /^Refund$/ })).not.toBeInTheDocument();
  });

  it('the same legacy row DOES offer Refund once a payment has landed (the fallback still works)', async () => {
    serve(
      invoiceWith({
        net_collected: '0.00',
        payments: [payment('p-cash', '100.00', 'CASH', 'SUCCEEDED'), payment('p-ach', '50.00', 'ACH', 'FAILED')],
      }),
    );
    renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

    expect(await statCard('Paid')).toBe('Paid$100.00');
    expect(await screen.findAllByRole('button', { name: /^Refund$/ })).not.toHaveLength(0);
  });
});

/** The Payments-tab table row whose cells read `needle` (e.g. the method badge "ACH"). */
async function historyRow(needle: RegExp): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: /^Payments/ }));
  const rows = await screen.findAllByRole('row');
  const row = rows.find((r) => needle.test(r.textContent ?? ''));
  if (!row) throw new Error(`no payment-history row matching ${needle}`);
  return row;
}

describe('InvoiceDetailPage payment history: a row that does not count says why', () => {
  it('a PROCESSING bank payment on a standard invoice reads "processing", not "on deposit invoice"', async () => {
    serve(
      invoiceWith({
        payments: [payment('p-cash', '100.00', 'CASH', 'SUCCEEDED'), payment('p-ach', '50.00', 'ACH', 'PROCESSING')],
      }),
    );
    renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

    const row = await historyRow(/ACH/);
    expect(row.textContent).toMatch(/processing/i);
    expect(row.textContent).not.toMatch(/on deposit invoice/i);
  });

  it('a FAILED bank payment reads "failed", not "on deposit invoice"', async () => {
    serve(
      invoiceWith({
        payments: [payment('p-cash', '100.00', 'CASH', 'SUCCEEDED'), payment('p-ach', '50.00', 'ACH', 'FAILED')],
      }),
    );
    renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

    const row = await historyRow(/ACH/);
    expect(row.textContent).toMatch(/failed/i);
    expect(row.textContent).not.toMatch(/on deposit invoice/i);
  });

  it('a PENDING refund reads "pending" and a FAILED refund reads "failed", neither as deposit money', async () => {
    serve(
      invoiceWith({
        status: 'PAID',
        amount_due: '0.00',
        net_collected: '150.00',
        payments: [payment('p-cash', '150.00', 'CASH', 'SUCCEEDED')],
        refunds: [refund('r-pending', '20.00', 'PENDING'), { ...refund('r-failed', '30.00', 'FAILED'), method: 'CHECK' }],
      }),
    );
    renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

    const pending = await historyRow(/\$20\.00/);
    expect(pending.textContent).toMatch(/pending/i);
    expect(pending.textContent).not.toMatch(/on deposit invoice/i);
    const failed = (await screen.findAllByRole('row')).find((r) => /\$30\.00/.test(r.textContent ?? ''));
    expect(failed?.textContent).toMatch(/failed/i);
    expect(failed?.textContent).not.toMatch(/on deposit invoice/i);
  });

  it('offers Void only on a manual payment that went through, never on a PROCESSING or FAILED one', async () => {
    serve(
      invoiceWith({
        total_amount: '200.00',
        amount_due: '100.00',
        payments: [
          payment('p-cash', '100.00', 'CASH', 'SUCCEEDED'),
          payment('p-ach', '50.00', 'ACH', 'PROCESSING'),
          payment('p-check', '50.00', 'CHECK', 'FAILED'),
        ],
      }),
    );
    renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

    const cash = await historyRow(/Cash/);
    expect(within(cash).queryByRole('button', { name: 'Void' })).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    const ach = rows.find((r) => /ACH/.test(r.textContent ?? ''))!;
    const check = rows.find((r) => /Check/.test(r.textContent ?? ''))!;
    expect(within(ach).queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
    expect(within(check).queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });
});

describe('InvoiceDetailPage Refund dialog: only money that landed can be reversed', () => {
  async function openRefund() {
    const user = userEvent.setup();
    const [refundButton] = await screen.findAllByRole('button', { name: /^Refund$/ });
    await user.click(refundButton);
    return { user, dialog: await screen.findByTestId('refund-invoice-dialog') };
  }

  it('"Reverse a specific payment" lists only payments that went through', async () => {
    serve(
      invoiceWith({
        total_amount: '200.00',
        amount_due: '100.00',
        payments: [
          payment('p-cash', '100.00', 'CASH', 'SUCCEEDED'),
          payment('p-ach', '50.00', 'ACH', 'PROCESSING'),
          payment('p-check', '50.00', 'CHECK', 'FAILED'),
        ],
      }),
    );
    renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });
    const { user, dialog } = await openRefund();

    await user.click(within(dialog).getByRole('combobox', { name: 'Reverse a specific payment' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    // The options read the method in words (Cash, Bank (ACH), Check), not the raw enum.
    expect(options.some((o) => /· Cash ·/.test(o))).toBe(true);
    expect(options.some((o) => /Bank \(ACH\)/.test(o))).toBe(false);
    expect(options.some((o) => /· Check ·/.test(o))).toBe(false);
  });

  it('a PENDING refund already holds its share of the cap, as the server counts it', async () => {
    // $150 paid, $30 refund still PENDING: net_collected reads 150 (only SUCCEEDED refunds are
    // subtracted from it), but the server refuses anything over 150 - 30 = 120.
    serve(
      invoiceWith({
        status: 'PAID',
        amount_due: '0.00',
        net_collected: '150.00',
        payments: [payment('p-cash', '150.00', 'CASH', 'SUCCEEDED')],
        refunds: [refund('r-pending', '30.00', 'PENDING')],
      }),
    );
    renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });
    const { user, dialog } = await openRefund();

    expect(within(dialog).getByText(/Net paid:/).textContent).toBe('Net paid: $120.00');
    await user.type(within(dialog).getByTestId('refund-amount-input'), '130');
    expect(within(dialog).getByText(/Amount must be between/)).toBeInTheDocument();
  });
});
