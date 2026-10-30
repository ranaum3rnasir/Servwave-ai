/**
 * Email slice 5 — the Estimate workspace's hard-bounce banner.
 *
 * "Delivered and Bounced are shown as FACT... a hard bounce on an Estimate's
 * send specifically should surface something ACTIONABLE on that estimate's
 * own page - not just sit as a quiet pill in a list."
 *
 * Correlation under test: Email carries no estimate_id column, so the page
 * reads the lead's comm timeline (GET /api/leads/:id/communications) and
 * picks out THIS estimate's own send by its deterministic subject prefix
 * (`Estimate ${estimate_number} ...`) — see findTransactionalEmail's doc
 * comment in lib/api/jobCommunications.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';
import type { CommItem } from '@/lib/api/jobCommunications';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-cues-test-id' }),
  };
});

// Same stub set as estimate-detail-deposit.test.tsx — nothing under test here
// needs these heavy sub-surfaces real.
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({
  EstimateTabs: () => null,
}));
vi.mock('@/components/estimates/EstimateLineItemsEditor', () => ({
  EstimateLineItemsEditor: () => null,
  EstimateScopeOfWorkCard: () => null,
  estimateLinesToInvoiceShape: (lines: unknown) => lines,
}));
vi.mock('@/features/estimate-workspace/components/SignatureCard', () => ({
  SignatureCard: () => null,
}));
vi.mock('@/features/estimate-workspace/components/NotesCard', () => ({
  NotesCard: () => null,
}));
vi.mock('@/features/estimate-workspace/components/HistoryPanel', () => ({
  HistoryPanel: () => null,
}));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({
  JobLeadTasksTab: () => null,
}));
vi.mock('@/components/estimates/PdfPreviewDialog', () => ({ PdfPreviewDialog: () => null }));
vi.mock('@/components/estimates/CancelEstimateDialog', () => ({ CancelEstimateDialog: () => null }));
vi.mock('@/components/estimates/SendEstimateDialog', () => ({ SendEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));


const mockApi = vi.mocked(api);

const BASE = {
  id: 'est-cues-test-id',
  lead_id: 'lead-bounce-1',
  estimate_number: 'E00777',
  name: null,
  status: 'SENT',
  sent_at: '2026-08-01T00:00:00.000Z',
  approved_at: null,
  declined_at: null,
  cancelled_at: null,
  scope_notes: null,
  tax_rate: '0.0625',
  subtotal: '1000.00',
  tax_amount: '62.50',
  total_amount: '1062.50',
  discount_type: null,
  discount_value: null,
  discount_name: null,
  discount_amount: '0.00',
  signature_data: null,
  signature_at: null,
  public_token: 'tok-777',
  version: 1,
  modified_after_send: false,
  superseded_by_id: null,
  created_by: 'user-1',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  send_config: { id: 'sc-777', deposit_required: false, deposit_percentage: null, deposit_amount: null, payment_methods: [], message_body: null },
  invoices: [],
  // The server's answer for this estimate: every action the page can offer.
  actions: ['edit', 'send', 'delete', 'cancel', 'record_payment'],
  lead: {
    id: 'lead-bounce-1',
    status: 'ESTIMATED',
    service_request: 'HVAC repair',
    service_address_line1: '100 Test St',
    service_city: 'Boston',
    service_state: 'MA',
    service_zip: '02101',
    customer: {
      id: 'cust-777',
      first_name: 'Bea',
      last_name: 'Bounce',
      company_name: null,
      email: 'bea@example.com',
      phone: '5550009999',
      billing_address_line1: null,
      billing_city: null,
      billing_state: null,
      billing_zip: null,
    },
  },
  creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
  line_items: [],
  scopes: [],
  job: null,
};

function deposit(over: Record<string, unknown> = {}) {
  return {
    id: 'dep-1', invoice_number: 'I00050', kind: 'DEPOSIT', status: 'SENT',
    total_amount: '500.00', amount_due: '500.00', total_refunded: '0', payments: [], ...over,
  };
}

function load(over: Record<string, unknown>) {
  const estimate = { ...BASE, ...over };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url.includes('/api/estimates/')) return { data: { estimate } };
    if (url.includes('/communications')) return { data: { items: [] } };
    return { data: {} };
  });
  mockApi.post.mockResolvedValue({ data: {} });
}

const sentConfig = { ...BASE.send_config, deposit_required: true, deposit_percentage: 50, deposit_amount: '500.00', payment_methods: ['CARD'] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('staff deposit box after a part payment (slice 15 acceptance 4)', () => {
  it('shows what is left to pay, not only the original deposit', async () => {
    load({ status: 'SENT', send_config: sentConfig, invoices: [deposit({ status: 'PARTIAL', amount_due: '300.00', payments: [{ id: 'p1', amount: '200.00', method: 'CASH' }] })] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await screen.findByText('Left to pay')).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
  });

  it('shows one figure: the part left to pay is the headline, not a second line under the full deposit', async () => {
    load({ status: 'SENT', send_config: sentConfig, invoices: [deposit({ status: 'PARTIAL', amount_due: '300.00', payments: [{ id: 'p1', amount: '200.00', method: 'CASH', state: 'SUCCEEDED' }] })] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await screen.findByText('Left to pay');
    expect(screen.queryByText('Deposit due now')).toBeNull();
    expect(screen.getAllByText('$300.00')).toHaveLength(1);
    expect(screen.getByText('Of the $500.00 deposit')).toBeInTheDocument();
  });

  it('shows a bank payment in flight on the deposit', async () => {
    load({ status: 'SENT', send_config: sentConfig, invoices: [deposit({ payments: [{ id: 'p2', amount: '500.00', method: 'ACH', state: 'PROCESSING', voided_at: null }] })] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await screen.findByTestId('processing-badge')).toHaveTextContent('Processing $500.00');
  });

  it('shows no processing badge when the bank payment was voided or has cleared', async () => {
    load({ status: 'SENT', send_config: sentConfig, invoices: [deposit({ payments: [
      { id: 'p3', amount: '500.00', method: 'ACH', state: 'SUCCEEDED', voided_at: null },
      { id: 'p4', amount: '500.00', method: 'ACH', state: 'PROCESSING', voided_at: '2026-10-02T00:00:00Z' },
    ] })] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await screen.findByText('Deposit due now');
    expect(screen.queryByTestId('processing-badge')).toBeNull();
  });

  it('shows no "left to pay" line while nothing has been paid', async () => {
    load({ status: 'SENT', send_config: sentConfig, invoices: [deposit()] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await screen.findByText('Deposit due now');
    expect(screen.queryByText('Left to pay')).toBeNull();
  });
});

describe('a voided deposit that leaves the estimate SENT (slice 15 acceptance 5)', () => {
  it('tells staff the customer has nothing to pay and what to do next', async () => {
    load({ status: 'SENT', send_config: sentConfig, invoices: [deposit({ status: 'VOIDED' })] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await screen.findByText(/The deposit was voided, so the customer has nothing to pay/i)).toBeInTheDocument();
    expect(screen.getByText(/mark the estimate Approved from its status menu, or recall it to Draft and send it again/i)).toBeInTheDocument();
  });

  it('says nothing when the deposit is open', async () => {
    load({ status: 'SENT', send_config: sentConfig, invoices: [deposit()] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await screen.findByText('Deposit due now');
    expect(screen.queryByText(/The deposit was voided/i)).toBeNull();
  });

  it('says nothing once the estimate is approved (a waived deposit approves it)', async () => {
    load({ status: 'WON', send_config: sentConfig, invoices: [deposit({ status: 'VOIDED' })] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await waitFor(() => expect(screen.getAllByText('E00777').length).toBeGreaterThan(0));
    expect(screen.queryByText(/The deposit was voided/i)).toBeNull();
  });
});

describe('a pay-later estimate: WON with its deposit still open (slice 27)', () => {
  it('offers Waive deposit and Record Payment on the WON estimate', async () => {
    load({ status: 'WON', deposit_policy: 'PAY_LATER', send_config: sentConfig, invoices: [deposit()] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: 'Waive deposit' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /record payment/i }).length).toBeGreaterThan(0);
  });

  it('offers no Record Payment on a WON estimate whose deposit is paid', async () => {
    load({ status: 'WON', send_config: sentConfig, invoices: [deposit({ status: 'PAID', amount_due: '0.00', payments: [{ id: 'p1', amount: '500.00', method: 'CASH' }] })] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await waitFor(() => expect(screen.getAllByText('E00777').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /record payment/i })).toBeNull();
  });

  it('offers no Record Payment on a WON estimate that never had a deposit', async () => {
    load({ status: 'WON', invoices: [] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await waitFor(() => expect(screen.getAllByText('E00777').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /record payment/i })).toBeNull();
  });

  it('the waive dialog on a WON estimate says the estimate stays approved and offers no cancel choice', async () => {
    const user = userEvent.setup();
    load({ status: 'WON', deposit_policy: 'PAY_LATER', send_config: sentConfig, invoices: [deposit()] });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: 'Waive deposit' }));

    expect(await screen.findByText(/The estimate stays approved/i)).toBeInTheDocument();
    expect(screen.queryByText('Cancel estimate')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/estimates/est-cues-test-id/waive-deposit', { action: 'waive' }));
  });
});
