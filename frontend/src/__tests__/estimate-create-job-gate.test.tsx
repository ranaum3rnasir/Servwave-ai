/**
 * EstimateWorkspacePage - the "Create Job" hero button, and the two DIFFERENT job links it has to
 * clear before offering a conversion:
 *   - `job`     = PROVENANCE. A Job created FROM this estimate (Job.estimate_id points back).
 *   - `job_id`  = the ANCHOR. This estimate was written against an EXISTING job (SERV10X-61 §5.4);
 *                 nothing points back, so the provenance relation is null.
 *
 * Gating on `job` alone still offered the button on a job-anchored estimate. Converting one used
 * to re-point the estimate off its anchor job - that job silently lost the estimate's paid deposit
 * credit and its line items were billed again on a second job - so the backend now rejects it with
 * 400 "already attached to a job" (job.controller.ts create()). Without the `job_id` half of the
 * gate the button is still there, it just turns into an error toast.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';

const ESTIMATE_ID = 'est-create-job-gate-id';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: ESTIMATE_ID }), useNavigate: () => vi.fn() };
});

// Heavy sub-surfaces with no bearing on the hero buttons - stubbed out (same set as
// estimate-copy-to-invoice.test.tsx, the sibling suite exercising this same page).
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
vi.mock('@/components/estimates/SendEstimateDialog', () => ({ SendEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

/** WON, no deposit invoice outstanding - the state in which "Create Job" is offered. */
const WON_ESTIMATE = {
  id: ESTIMATE_ID,
  lead_id: 'lead-1',
  estimate_number: 'L00005-1',
  name: null,
  status: ESTIMATE_STATUS.WON,
  approved_at: '2026-07-20T00:00:00.000Z',
  sent_at: '2026-07-19T00:00:00.000Z',
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
  // Neither job link set: no Job was created from it, and it is not anchored to one.
  job: null,
  job_id: null,
  invoices: [],
};

function setupMocks(fixture: Record<string, unknown>) {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url.includes('/api/estimates/')) return { data: { estimate: fixture } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage - "Create Job" gating', () => {
  it('offers Create Job on a WON estimate with neither a provenance job nor a job anchor', async () => {
    setupMocks(WON_ESTIMATE);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: /Create Job/i })).toBeInTheDocument();
  });

  it('does NOT offer Create Job on a JOB-ANCHORED estimate (job_id set, provenance job null)', async () => {
    setupMocks({ ...WON_ESTIMATE, job_id: 'job-anchor-1', job: null });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    // Wait for the estimate to actually LAND before asserting absence - otherwise "no button"
    // would pass trivially on the loading state.
    expect(await screen.findByRole('button', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Job/i })).toBeNull();
  });

  it('still does NOT offer Create Job once a Job was created FROM the estimate (provenance)', async () => {
    setupMocks({ ...WON_ESTIMATE, job: { id: 'job-1', job_number: 'J00010', status: 'SCHEDULED' } });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Job/i })).toBeNull();
  });
});
