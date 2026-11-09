import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderEstimateWorkspace, serveEstimateWorkspace } from '@/__tests__/harness/estimateWorkspacePage';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { CONVERT_BLOCK_REASONS } from '@/features/estimate-workspace/lib/convertToJob';
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
 *
 * #2188 slice 15 - a blocked conversion no longer HIDES. Every case below except "no create Job
 * grant" now renders the button disabled with the refusing rule's reason, because an absent
 * control is indistinguishable from a capability the product does not have. That is what made an
 * operator conclude a lead can only ever produce one job.
 */

const ESTIMATE_ID = 'est-create-job-gate-id';

// Heavy sub-surfaces with no bearing on the hero buttons - stubbed out (same set as
// estimate-copy-to-invoice.test.tsx, the sibling suite exercising this same page).

// Everything EXCEPT `create Job` - the one case that must still render nothing at all.
const noJobAbility = buildAbility([
  { action: 'manage', subject: 'Estimate' },
  { action: 'read', subject: 'all' },
]);

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
  serveEstimateWorkspace({ estimate: fixture });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage - "Create Job" gating', () => {
  it('offers Create Job on a WON estimate with neither a provenance job nor a job anchor', async () => {
    setupMocks(WON_ESTIMATE);
    renderEstimateWorkspace();

    expect(await screen.findByRole('button', { name: /Create Job/i })).toBeInTheDocument();
  });

  it('a JOB-ANCHORED estimate (attached to ANOTHER job) shows the button DISABLED, with its reason', async () => {
    setupMocks({ ...WON_ESTIMATE, job_id: 'job-anchor-1', job: null });
    renderEstimateWorkspace();

    const button = await screen.findByRole('button', { name: /Create Job/i });
    expect(button).toBeDisabled();
    expect(button.parentElement).toHaveAttribute('title', CONVERT_BLOCK_REASONS.ATTACHED_TO_OTHER_JOB);
  });

  it('a SENT estimate shows the button DISABLED, saying it must be won first', async () => {
    setupMocks({ ...WON_ESTIMATE, status: ESTIMATE_STATUS.SENT, approved_at: null });
    renderEstimateWorkspace();

    const button = await screen.findByRole('button', { name: /Create Job/i });
    expect(button).toBeDisabled();
    expect(button.parentElement).toHaveAttribute('title', CONVERT_BLOCK_REASONS.NOT_WON);
  });

  it('winning the estimate is the ONLY change needed: the same estimate, won, is enabled', async () => {
    // Cause and effect, stated as the pair. The gate reads `estimate.status` on every render and
    // latches nothing, so the moment the status mutation lands the control is live.
    setupMocks(WON_ESTIMATE);
    renderEstimateWorkspace();

    const button = await screen.findByRole('button', { name: 'Create Job' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('title');
    expect(screen.queryByRole('button', { name: 'View Job' })).toBeNull();
  });

  it('an estimate that already produced ITS OWN job reads View Job, and is live', async () => {
    // The shape a conversion actually leaves behind: both pointers set, at the same job. The
    // backend answers it with its idempotent find-or-create (200), so this is not "attached" -
    // but the control must not keep offering to CREATE what already exists.
    setupMocks({
      ...WON_ESTIMATE,
      job_id: 'job-1',
      job: { id: 'job-1', job_number: 'J00010', status: 'SCHEDULED' },
    });
    renderEstimateWorkspace();

    const button = await screen.findByRole('button', { name: 'View Job' });
    expect(button).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Create Job' })).toBeNull();
  });

  it('a SECOND estimate on a lead whose sibling already became a job is still offered', async () => {
    // The reported case. The sibling's conversion is a fact about the SIBLING: it leaves no mark
    // on this estimate, and a lead may hold as many jobs as it has won estimates. The lead is
    // already WON from that first conversion - that must not gate this one.
    setupMocks({
      ...WON_ESTIMATE,
      id: ESTIMATE_ID,
      estimate_number: 'L00005-2',
      lead: { ...WON_ESTIMATE.lead, status: 'WON' },
    });
    renderEstimateWorkspace();

    const button = await screen.findByRole('button', { name: /Create Job/i });
    expect(button).toBeEnabled();
  });

  it('renders NO control at all for a requester without create Job - a grant must not advertise itself', async () => {
    setupMocks({ ...WON_ESTIMATE, status: ESTIMATE_STATUS.SENT, approved_at: null });
    renderEstimateWorkspace({ ability: noJobAbility });

    // Wait for the estimate to actually LAND before asserting absence - otherwise "no button"
    // would pass trivially on the loading state.
    expect(await screen.findByRole('button', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Job/i })).toBeNull();
  });
});
