/**
 * A6 (#2090, ruling 18) - the workspace's "Send a copy" on a SUPERSEDED estimate.
 *
 * The backend now refuses `POST /:id/send` on SUPERSEDED, so leaving the control on screen is a
 * dead end the rep only discovers by clicking. The repo's convention for a control with no meaning
 * in the current state is ABSENT, not disabled (see `ScopeOfWorkCard`'s note), so this asserts
 * absence - `queryByRole` returning nothing, not a disabled button.
 *
 * The other four terminal statuses are the control group: they keep their own live token and are
 * still perfectly sendable, so the button has to still be there AND still open the send dialog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';

const ESTIMATE_ID = 'est-superseded-send-id';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: ESTIMATE_ID }), useNavigate: () => vi.fn() };
});

// Same stub set as the sibling workspace-page suites - none of these surfaces bear on the button.
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
vi.mock('@/components/estimates/PdfPreviewDialog', () => ({ PdfPreviewDialog: () => null }));
// Not stubbed to null: "still works" means the click actually opens the send door.
vi.mock('@/components/estimates/SendEstimateDialog', () => ({
  SendEstimateDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="send-dialog" /> : null),
}));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const BASE_ESTIMATE = {
  id: ESTIMATE_ID,
  lead_id: 'lead-1',
  estimate_number: 'L00042-1',
  name: null,
  status: ESTIMATE_STATUS.WON,
  approved_at: null,
  sent_at: '2026-07-28T00:00:00.000Z',
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
  public_token: 'live-token',
  version: 1,
  modified_after_send: false,
  superseded_by_id: null,
  created_by: 'user-1',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  send_config: null,
  lead: {
    id: 'lead-1',
    status: 'ESTIMATED',
    service_request: 'HVAC repair',
    service_address_line1: '100 Test St',
    service_city: 'Boston',
    service_state: 'MA',
    service_zip: '02101',
    customer: {
      id: 'cust-1', first_name: 'Alice', last_name: 'Test', company_name: null,
      email: 'alice@test.com', phone: '5550001234',
      billing_address_line1: null, billing_city: null, billing_state: null, billing_zip: null,
    },
  },
  creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
  line_items: [],
  scopes: [],
  job: null,
  job_id: null,
  invoices: [],
};

function renderAt(status: string, overrides: Record<string, unknown> = {}) {
  const estimate = { ...BASE_ESTIMATE, status, ...overrides };
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url.includes('/api/estimates/')) return { data: { estimate } };
    return { data: {} };
  });
  return renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });
}

const sendACopy = () => screen.queryByRole('button', { name: /send a copy/i });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage - "Send a copy" on a terminal estimate', () => {
  it('is ABSENT on a SUPERSEDED estimate - not merely disabled', async () => {
    renderAt('SUPERSEDED', { superseded_by_id: 'est-current-revision', public_token: null });

    // Wait for the loaded page, then assert the control never appears.
    expect(await screen.findByRole('button', { name: /Status: SUPERSEDED/i })).toBeInTheDocument();
    expect(sendACopy()).not.toBeInTheDocument();
  });

  it.each([ESTIMATE_STATUS.WON, ESTIMATE_STATUS.DECLINED, ESTIMATE_STATUS.ARCHIVED, 'EXPIRED'])(
    'still renders, and still opens the send dialog, on a %s estimate',
    async (status) => {
      const user = userEvent.setup();
      renderAt(status);

      const button = await screen.findByRole('button', { name: /send a copy/i });
      await user.click(button);

      expect(await screen.findByTestId('send-dialog')).toBeInTheDocument();
    },
  );
});
