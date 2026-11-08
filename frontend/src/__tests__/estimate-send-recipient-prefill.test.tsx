/**
 * EstimateWorkspacePage -> SendEstimateDialog: the "To" field must arrive pre-filled with the
 * customer's email.
 *
 * SERV10X-61 gave estimates three anchors (lead / customer / job), so a customer-anchored estimate
 * has NO `lead` and reaches its customer through the estimate's own `customer` relation instead.
 * The page kept reading `estimate.lead?.customer?.email` alone, so every lead-less estimate opened
 * the dialog with an empty "To" and an immediate "Enter a valid email address" error - even though
 * the header right above it rendered that same customer's email as a mailto link (CustomerHeader
 * already reads `lead.customer ?? customer`, as does the backend's send()).
 *
 * The dialog itself was never at fault: it seeds `recipientEmail` from the `customerEmail` prop
 * exactly like SendInvoiceDialog does. These tests therefore drive the real dialog through the
 * page, so they fail on the wiring rather than on the dialog's internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

const ESTIMATE_ID = 'est-send-prefill-id';
const CUSTOMER_EMAIL = 'ran@customer.test';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: ESTIMATE_ID }), useNavigate: () => vi.fn() };
});

// Heavy sub-surfaces with no bearing on the send dialog - same stub set as the sibling page suites
// (estimate-create-job-gate / estimate-copy-to-invoice). SendEstimateDialog is deliberately NOT
// stubbed here: its "To" input is what this suite asserts on.
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({ EstimateTabs: () => null }));
vi.mock('@/components/estimates/EstimateLineItemsEditor', () => ({
  EstimateLineItemsEditor: () => null,
  EstimateScopeOfWorkCard: () => null,
  estimateLinesToInvoiceShape: (lines: unknown) => lines,
}));
vi.mock('@/features/estimate-workspace/components/SignatureCard', () => ({
  SignatureCard: () => null,
}));
vi.mock('@/features/estimate-workspace/components/NotesCard', () => ({ NotesCard: () => null }));
vi.mock('@/features/estimate-workspace/components/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/estimates/PdfPreviewDialog', () => ({ PdfPreviewDialog: () => null }));
vi.mock('@/components/estimates/CancelEstimateDialog', () => ({ CancelEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const CUSTOMER = {
  id: 'cust-1',
  first_name: 'Art',
  last_name: 'Nakamura',
  company_name: null,
  email: CUSTOMER_EMAIL,
  phone: '5550001234',
  billing_address_line1: null,
  billing_city: null,
  billing_state: null,
  billing_zip: null,
};

/** DRAFT, so the hero offers "Send" rather than "Resend". */
const BASE_ESTIMATE = {
  id: ESTIMATE_ID,
  estimate_number: 'C00002-1',
  name: null,
  status: 'DRAFT',
  approved_at: null,
  sent_at: null,
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
  public_token: null,
  version: 1,
  modified_after_send: false,
  superseded_by_id: null,
  created_by: 'user-1',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  send_config: null,
  creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
  line_items: [],
  scopes: [],
  job: null,
  job_id: null,
  invoices: [],
};

/** Customer-anchored: no lead at all, customer hangs directly off the estimate. */
const CUSTOMER_ANCHORED = {
  ...BASE_ESTIMATE,
  lead_id: null,
  lead: null,
  customer_id: CUSTOMER.id,
  customer: CUSTOMER,
};

/** Lead-anchored: the pre-SERV10X-61 shape, customer reached through the lead. */
const LEAD_ANCHORED = {
  ...BASE_ESTIMATE,
  lead_id: 'lead-1',
  lead: {
    id: 'lead-1',
    status: 'NEW',
    service_request: 'HVAC repair',
    service_address_line1: '100 Test St',
    service_city: 'Boston',
    service_state: 'MA',
    service_zip: '02101',
    customer: CUSTOMER,
  },
  customer_id: null,
  customer: null,
};

function setupMocks(fixture: Record<string, unknown>) {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url.includes('/api/estimates/')) return { data: { estimate: fixture } };
    if (url === '/api/organization') {
      return { data: { accepted_payment_methods: ['CARD'], deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50 } };
    }
    return { data: {} };
  });
}

/** Open the send dialog from the hero and hand back its "To" input. */
async function openSendDialog() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^Send$/i }));
  return screen.findByLabelText('To');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage - Send Estimate recipient pre-fill', () => {
  it('pre-fills "To" from the direct customer on a lead-less (customer-anchored) estimate', async () => {
    setupMocks(CUSTOMER_ANCHORED);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await openSendDialog()).toHaveValue(CUSTOMER_EMAIL);
    // The empty field tripped the dialog's own validator on open; a pre-filled one must not.
    expect(screen.queryByText('Enter a valid email address')).toBeNull();
  });

  it('still pre-fills "To" through the lead on a lead-anchored estimate', async () => {
    setupMocks(LEAD_ANCHORED);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await openSendDialog()).toHaveValue(CUSTOMER_EMAIL);
    expect(screen.queryByText('Enter a valid email address')).toBeNull();
  });

  it('leaves "To" empty and flags it when the customer genuinely has no email on file', async () => {
    setupMocks({ ...CUSTOMER_ANCHORED, customer: { ...CUSTOMER, email: null } });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await openSendDialog()).toHaveValue('');
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
  });

  // #1997 — the requester's Customer read scope can redact the email key ENTIRELY (absent, not
  // null). The payload carries no `email` key at all — the only signal any component may branch
  // on — and the dialog must degrade to a read-only placeholder instead of an editable blank.
  it('renders a read-only placeholder and keeps Send enabled when the customer email key is entirely absent (#1997)', async () => {
    const { email: _email, ...customerWithoutEmail } = CUSTOMER;
    setupMocks({ ...CUSTOMER_ANCHORED, customer: customerWithoutEmail });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    const to = await openSendDialog();
    expect(to).toHaveValue('');
    expect(to).toHaveAttribute('readonly');
    expect(to).toHaveAttribute('placeholder', "Sent to the customer's saved email address");
    expect(screen.queryByText('Enter a valid email address')).toBeNull();
    expect(screen.getByRole('button', { name: /^Send/ })).toBeEnabled();
  });
});
