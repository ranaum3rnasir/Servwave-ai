/**
 * Payments go-live slice 22 - every Refund action follows the "Refund payments" permission
 * (`refund Invoice`), and only it: a person who may record payments, edit invoices and run the
 * estimate is still not offered Refund without it. The server refuses the call as well
 * (backend refund-permission-switch-db.test.ts); this file covers what the screens offer.
 *
 * Both pages are the ROUTED v2 ones (`pages/v2/routes/*.routes.tsx`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import InvoiceDetailPage from '@/pages/v2/invoices/InvoiceDetailPage';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

const INVOICE_ID = 'inv-pay22-paid';
const ESTIMATE_ID = 'est-pay22-deposit';
let routeId = INVOICE_ID;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: routeId }), useNavigate: () => vi.fn() };
});

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
vi.mock('@/components/invoices/CreditInvoiceDialog', () => ({ CreditInvoiceDialog: () => null }));
vi.mock('@/components/invoices/VoidPaymentDialog', () => ({ VoidPaymentDialog: () => null }));
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

const mockApi = vi.mocked(api);

/** An office user who runs invoices and estimates and records payments - everything but refunds. */
const officeGrants = [
  { action: 'read', subject: 'Invoice' },
  { action: 'update', subject: 'Invoice' },
  { action: 'send', subject: 'Invoice' },
  { action: 'record_payment', subject: 'Invoice' },
  { action: 'read', subject: 'Estimate' },
  { action: 'update', subject: 'Estimate' },
  { action: 'send', subject: 'Estimate' },
  { action: 'record_payment', subject: 'Estimate' },
  { action: 'read', subject: 'Pricing' },
] as const;
const withoutRefund = buildAbility([...officeGrants]);
const withRefund = buildAbility([...officeGrants, { action: 'refund', subject: 'Invoice' }]);

function cashPayment(invoiceId: string, amount: string) {
  return {
    id: `pay-${invoiceId}`,
    invoice_id: invoiceId,
    amount,
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
  };
}

const PAID_INVOICE = {
  id: INVOICE_ID,
  invoice_number: 'I02201',
  status: 'PAID',
  subtotal: '200.00',
  discount_amount: '0.00',
  tax_rate: '0',
  tax_amount: '0.00',
  deposit_credit: '0.00',
  total_amount: '200.00',
  amount_due: '0.00',
  net_collected: '200.00',
  public_token: 'tok-pay22',
  sent_at: '2026-10-01T00:00:00.000Z',
  paid_at: '2026-10-01T15:00:00.000Z',
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
  customer: { id: 'cust-pay22', first_name: 'Pat', last_name: 'Payer', company_name: null },
  job: null,
  line_items: [],
  scopes: [],
  refunds: [],
  credits: [],
  payments: [cashPayment(INVOICE_ID, '200.00')],
  tags: [],
};

const CUSTOMER = {
  id: 'cust-pay22',
  first_name: 'Pat',
  last_name: 'Payer',
  company_name: null,
  email: 'pat-pay22@example.com',
  phone: '5550002222',
  billing_address_line1: null,
  billing_city: null,
  billing_state: null,
  billing_zip: null,
};

/** An approved estimate whose deposit invoice has been paid. */
const ESTIMATE_WITH_PAID_DEPOSIT = {
  id: ESTIMATE_ID,
  lead_id: null,
  lead: null,
  customer_id: CUSTOMER.id,
  customer: CUSTOMER,
  estimate_number: 'C02201-1',
  name: null,
  status: 'WON',
  sent_at: '2026-10-01T00:00:00.000Z',
  approved_at: '2026-10-02T00:00:00.000Z',
  declined_at: null,
  cancelled_at: null,
  scope_notes: null,
  tax_rate: '0',
  subtotal: '1000.00',
  tax_amount: '0.00',
  total_amount: '1000.00',
  discount_type: null,
  discount_value: null,
  discount_name: null,
  discount_amount: '0.00',
  signature_data: null,
  signature_at: null,
  public_token: null,
  version: 1,
  modified_after_send: false,
  superseded_by_id: null,
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
  creator: { id: 'user-1', first_name: 'Test', last_name: 'Office' },
  line_items: [],
  scopes: [],
  job: null,
  job_id: null,
  send_config: null,
  deposit_type: null,
  deposit_value: null,
  invoices: [
    {
      id: 'inv-pay22-deposit',
      invoice_number: 'D02201',
      kind: 'DEPOSIT',
      status: 'PAID',
      total_amount: '300.00',
      amount_due: '0.00',
      payments: [cashPayment('inv-pay22-deposit', '300.00')],
    },
  ],
};

function serve() {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/invoices/')) return { data: { invoice: PAID_INVOICE } };
    if (url.includes('/api/estimates/')) return { data: { estimate: ESTIMATE_WITH_PAID_DEPOSIT } };
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url === '/api/organization') return { data: { accepted_payment_methods: ['CASH'] } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  serve();
});

describe('invoice: Refund follows the refund permission', () => {
  beforeEach(() => {
    routeId = INVOICE_ID;
  });

  it('a paid invoice offers no Refund, in the header or the More actions menu, without the permission', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InvoiceDetailPage />, { ability: withoutRefund });

    expect(await screen.findAllByText('I02201')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Refund$/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /^Refund$/ })).not.toBeInTheDocument();
  });

  it('the same invoice offers Refund to a person with the permission', async () => {
    renderWithProviders(<InvoiceDetailPage />, { ability: withRefund });

    expect(await screen.findAllByRole('button', { name: /^Refund$/ })).not.toHaveLength(0);
  });
});

describe('estimate: Refund deposit follows the refund permission', () => {
  beforeEach(() => {
    routeId = ESTIMATE_ID;
  });

  it('a paid deposit offers no Refund deposit without the permission', async () => {
    renderWithProviders(<EstimateWorkspacePage />, { ability: withoutRefund });

    expect(await screen.findAllByText('C02201-1')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Refund deposit' })).not.toBeInTheDocument();
  });

  it('the same deposit offers Refund deposit to a person with the permission', async () => {
    renderWithProviders(<EstimateWorkspacePage />, { ability: withRefund });

    expect(await screen.findByRole('button', { name: 'Refund deposit' })).toBeInTheDocument();
  });
});
