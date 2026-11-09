import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderEstimateWorkspace, serveEstimateWorkspace } from '@/__tests__/harness/estimateWorkspacePage';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: __route.id }), useNavigate: () => vi.fn() };
});
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
vi.mock('@/components/estimates/CancelEstimateDialog', () => ({ CancelEstimateDialog: () => null }));
vi.mock('@/components/estimates/SendEstimateDialog', () => ({ SendEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const __route = vi.hoisted(() => ({ id: '' }));

// Each test starts from the setup file's signed-in user and bare client calls: reset them here, so a test states its own user
// and answers in its own `beforeEach` (`clearAllMocks` keeps implementations).
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

// The router mock reads the id this block's file used to fix.
beforeEach(() => { __route.id = ESTIMATE_ID; });
/**
 * Roles & Permissions S04.27 - the estimate page draws send, edit, delete, archive and record payment from the server's
 * answer for THIS estimate (`estimate.actions`), not from the person's switches alone. A creator with View estimates
 * off finishes the estimate they made (their ability holds nothing on estimates at all); a person whose answer for the
 * estimate is empty gets none of the buttons, an everything-granted ability included. Renders the routed page
 * (pages/v2/estimates/EstimateWorkspacePage).
 */

const ESTIMATE_ID = 'est-s0427-actions-id';

// Heavy sub-surfaces with no bearing on the hero buttons - stubbed out (same set as
// estimate-copy-to-invoice.test.tsx, the sibling suite exercising this same page).

/** A draft estimate: send, record payment, archive and delete all fit its status. */
const DRAFT_ESTIMATE = {
  id: ESTIMATE_ID,
  lead_id: 'lead-1',
  estimate_number: 'L00005-1',
  name: null,
  status: ESTIMATE_STATUS.DRAFT,
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
  lead: {
    id: 'lead-1',
    status: 'ESTIMATED',
    service_request: 'HVAC repair',
    service_address_line1: '100 Test St',
    service_city: 'Boston',
    service_state: 'MA',
    service_zip: '02101',
    customer: {
      id: 'cust-1',
      first_name: 'Alice',
      last_name: 'Test',
      company_name: null,
      email: 'alice@test.com',
      phone: '5550001234',
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
  job_id: null,
  invoices: [],
  actions: [] as string[],
};

function setupMocks(fixture: Record<string, unknown>) {
  serveEstimateWorkspace({ estimate: fixture });
}

/** A person whose switches grant nothing on estimates: they reach the page by the creator rule alone. */
const noEstimateSwitches = () => buildAbility([]);
const everythingGranted = () => buildAbility([{ action: 'manage', subject: 'all' }]);

async function openActionsMenu() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Actions' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage - the buttons follow the answer for this estimate', () => {
  it('offers send, archive and delete on a draft the person made, with no View estimates and no Edit estimates', async () => {
    setupMocks({ ...DRAFT_ESTIMATE, actions: ['edit', 'send', 'delete', 'cancel'] });

    renderEstimateWorkspace({ ability: noEstimateSwitches() });

    expect(await screen.findByRole('button', { name: 'Send' })).toBeInTheDocument();
    await openActionsMenu();
    expect(screen.getByRole('menuitem', { name: 'Mark Sent' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    // The creator rule never opens the money action.
    expect(screen.queryByRole('button', { name: 'Record Payment' })).not.toBeInTheDocument();
  });

  it('offers none of them on an estimate whose answer is empty, to a person whose ability holds every grant', async () => {
    setupMocks({ ...DRAFT_ESTIMATE, actions: [] });

    renderEstimateWorkspace({ ability: everythingGranted() });

    await openActionsMenu();
    await screen.findByRole('menuitem', { name: /duplicate/i });
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Mark Sent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record Payment' })).not.toBeInTheDocument();
  });

  it('offers record payment when the answer lists it, whatever the ability says', async () => {
    setupMocks({ ...DRAFT_ESTIMATE, actions: ['record_payment'] });

    renderEstimateWorkspace({ ability: noEstimateSwitches() });

    expect((await screen.findAllByRole('button', { name: 'Record Payment' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });
});
