/**
 * EstimateWorkspacePage -> DuplicateEstimateDialog: the customer must resolve on a lead-less
 * estimate, so its other leads are offered as duplicate targets.
 *
 * The same accessor that broke the send recipient (#1019) also fed this dialog's `customerId`:
 * the page read `estimate.lead?.customer?.id` alone, which is null on every SERV10X-61
 * customer-anchored estimate. That left DuplicateEstimateDialog's leads query disabled
 * (`enabled: open && Boolean(customerId) && ...`), so the picker fell through to its
 * "No leads found for this customer" state and silently pinned the copy to the original anchor -
 * indistinguishable, in the UI, from a customer who genuinely has no other leads.
 *
 * PR #1062 fixed the accessor but shipped no coverage for this half of it. This suite closes that
 * gap: it drives the REAL dialog (deliberately unstubbed, unlike the sibling page suites) and
 * asserts on the rendered target list, and the /api/leads mock answers only when the request
 * actually carries the customer's id - so a null or wrong `customerId` reddens it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

const ESTIMATE_ID = 'est-duplicate-anchor-id';
const CUSTOMER_ID = 'cust-anchor-1';
/** A second lead on the same customer - the alternate target the picker should offer. */
const OTHER_LEAD_REQUEST = 'Furnace replacement quote';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: ESTIMATE_ID }), useNavigate: () => vi.fn() };
});

// Heavy sub-surfaces with no bearing on the duplicate dialog - same stub set as the sibling page
// suites, minus DuplicateEstimateDialog, which is what this suite asserts on.
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
vi.mock('@/components/estimates/SendEstimateDialog', () => ({ SendEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const CUSTOMER = {
  id: CUSTOMER_ID,
  first_name: 'Art',
  last_name: 'Nakamura',
  company_name: null,
  email: 'ran@customer.test',
  phone: '5550001234',
  billing_address_line1: null,
  billing_city: null,
  billing_state: null,
  billing_zip: null,
};

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
  customer_id: CUSTOMER_ID,
  customer: CUSTOMER,
};

/**
 * Answers /api/leads with the customer's other lead ONLY when the request carries
 * `customer_id === CUSTOMER_ID`. Any other id - and the disabled-query case, which never asks -
 * leaves the picker empty.
 */
function setupMocks(fixture: Record<string, unknown>) {
  vi.mocked(api.get).mockImplementation(
    async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url.includes('/state-tax-rates')) return { data: { data: [] } };
      if (url === '/api/leads') {
        if (config?.params?.customer_id !== CUSTOMER_ID) return { data: { leads: [] } };
        return {
          data: {
            leads: [
              {
                id: 'lead-other',
                status: 'NEW',
                service_request: OTHER_LEAD_REQUEST,
                created_at: '2026-07-02T00:00:00.000Z',
              },
            ],
          },
        };
      }
      if (url.includes('/api/estimates/')) return { data: { estimate: fixture } };
      if (url === '/api/organization') {
        return { data: { accepted_payment_methods: ['CARD'], deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50 } };
      }
      return { data: {} };
    },
  );
}

/** Open the Duplicate dialog from the Actions dropdown. */
async function openDuplicateDialog() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Actions' }));
  await user.click(await screen.findByRole('menuitem', { name: /Duplicate/i }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage - Duplicate target leads on a lead-less estimate', () => {
  it("offers the customer's other leads when the estimate is customer-anchored", async () => {
    setupMocks(CUSTOMER_ANCHORED);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await openDuplicateDialog();

    expect(await screen.findByText(OTHER_LEAD_REQUEST)).toBeInTheDocument();
    expect(screen.queryByText(/No leads found for this customer/i)).toBeNull();
  });

  it("asks /api/leads for the estimate's own customer, not the (absent) lead's", async () => {
    setupMocks(CUSTOMER_ANCHORED);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await openDuplicateDialog();
    await screen.findByText(OTHER_LEAD_REQUEST);

    expect(api.get).toHaveBeenCalledWith(
      '/api/leads',
      expect.objectContaining({ params: expect.objectContaining({ customer_id: CUSTOMER_ID }) }),
    );
  });

  it('still shows the empty state when the customer has no other leads', async () => {
    setupMocks({ ...CUSTOMER_ANCHORED, customer_id: 'cust-with-no-leads', customer: { ...CUSTOMER, id: 'cust-with-no-leads' } });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await openDuplicateDialog();

    expect(await screen.findByText(/No leads found for this customer/i)).toBeInTheDocument();
  });
});
