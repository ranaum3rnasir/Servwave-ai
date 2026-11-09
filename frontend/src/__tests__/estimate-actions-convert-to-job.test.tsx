import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderEstimateWorkspace, serveEstimateWorkspace } from '@/__tests__/harness/estimateWorkspacePage';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { CONVERT_BLOCK_REASONS, CONVERT_DEPOSIT_BLOCKED_REASON } from '@/features/estimate-workspace/lib/convertToJob';
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
 * #2048 — the estimate page's Actions "Convert to job" item, mirroring the pre-existing header
 * "Create Job" button's exact gate/mutation (`convertToJob.ts`'s shared `convertToJobState`).
 * Mirrors the stub set + fixture shape of `estimate-create-job-gate.test.tsx`, the prior art for
 * mounting `EstimateWorkspacePage` around its hero buttons.
 */

const ESTIMATE_ID = 'est-actions-convert-id';

// Heavy sub-surfaces with no bearing on the Actions menu - same stub set as
// estimate-create-job-gate.test.tsx / estimate-copy-to-invoice.test.tsx.

const noJobAbility = buildAbility([
  { action: 'read', subject: 'Estimate' },
  { action: 'update', subject: 'Estimate' },
  // Edit estimates needs See prices.
  { action: 'read', subject: 'Prices' },
]);

/** WON, no deposit invoice outstanding, no job link either way. */
const WON_ESTIMATE = {
  id: ESTIMATE_ID,
  lead_id: 'lead-actions-1',
  estimate_number: 'L00006-1',
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
    id: 'lead-actions-1',
    status: 'ESTIMATED',
    service_request: 'HVAC repair',
    service_address_line1: '100 Test St',
    service_city: 'Boston',
    service_state: 'MA',
    service_zip: '02101',
    customer: {
      id: 'cust-actions-1',
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
};

function setupMocks(fixture: Record<string, unknown>) {
  serveEstimateWorkspace({ estimate: fixture });
}

async function openActionsMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Actions' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage Actions - "Convert to job" item (#2048)', () => {
  it('is present for a WON, unattached estimate when the caller holds create Job', async () => {
    setupMocks(WON_ESTIMATE);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderEstimateWorkspace();

    await openActionsMenu(user);
    const item = await screen.findByRole('menuitem', { name: /convert to job/i });
    expect(item).toBeInTheDocument();
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('is DISABLED with its reason when the estimate is anchored to ANOTHER job (#2188 slice 15)', async () => {
    // Was absent. A hidden item and a missing capability look identical, so it now says why.
    setupMocks({ ...WON_ESTIMATE, job_id: 'job-anchor-1', job: null });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderEstimateWorkspace();

    await openActionsMenu(user);
    const item = await screen.findByRole('menuitem', { name: /convert to job/i });
    expect(item).toHaveAttribute('title', CONVERT_BLOCK_REASONS.ATTACHED_TO_OTHER_JOB);
    expect(item).toHaveAttribute('data-disabled');
  });

  it('is absent without create Job, even on an otherwise-convertible estimate', async () => {
    setupMocks(WON_ESTIMATE);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderEstimateWorkspace({ ability: noJobAbility });

    // Same-state control on the header: no "Create Job" button either - checked BEFORE opening
    // the Actions dropdown, which marks the rest of the page `aria-hidden` while it's open (a
    // false-negative trap: `queryByRole` also returns null for a hidden-but-present element).
    await screen.findByRole('button', { name: 'Actions' });
    expect(screen.queryByRole('button', { name: /create job/i })).toBeNull();

    await openActionsMenu(user);
    expect(screen.queryByRole('menuitem', { name: /convert to job/i })).toBeNull();
  });

  it('is disabled with the exact deposit reason when an unpaid DEPOSIT invoice exists', async () => {
    setupMocks({
      ...WON_ESTIMATE,
      invoices: [{ id: 'inv-1', kind: 'DEPOSIT', status: 'SENT', total_amount: '200.00', payments: [] }],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderEstimateWorkspace();

    // The header button carries the identical reason - checked BEFORE opening the Actions
    // dropdown, which marks the rest of the page `aria-hidden` while it's open.
    const createJob = await screen.findByRole('button', { name: /create job/i });
    // The reason lives on the shell around the disabled button (mobile slice 40): hover shows the
    // title, a tap opens it as helper text.
    expect(createJob.parentElement).toHaveAttribute('title', CONVERT_DEPOSIT_BLOCKED_REASON);

    await openActionsMenu(user);
    const item = await screen.findByRole('menuitem', { name: /convert to job/i });
    expect(item).toHaveAttribute('title', CONVERT_DEPOSIT_BLOCKED_REASON);
    expect(item).toHaveAttribute('data-disabled');
  });

  it('clicking it POSTs /api/jobs { estimate_id } - the same mutation the header button fires', async () => {
    setupMocks(WON_ESTIMATE);
    vi.mocked(api.post).mockResolvedValue({ data: { job: { id: 'job-actions-1' } } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderEstimateWorkspace();

    await openActionsMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /convert to job/i }));

    expect(api.post).toHaveBeenCalledWith('/api/jobs', { estimate_id: ESTIMATE_ID });
  });
});

// Payments go-live slice W3: Actions menu copy.
describe('EstimateWorkspacePage Actions - menu copy (W3)', () => {
  it('shows a disabled "Convert to job" without a grey second line, the reason staying in the title', async () => {
    setupMocks({ ...WON_ESTIMATE, job_id: 'job-anchor-1', job: null });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderEstimateWorkspace();

    await openActionsMenu(user);
    const item = await screen.findByRole('menuitem', { name: /convert to job/i });
    expect(item).toHaveAttribute('data-disabled');
    expect(item.textContent).toBe('Convert to job');
  });

  it('offers "Approve" (not "Approve (Verbal)") and confirms with a short dialog', async () => {
    setupMocks({ ...WON_ESTIMATE, status: ESTIMATE_STATUS.SENT, approved_at: null });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderEstimateWorkspace();

    await openActionsMenu(user);
    expect(screen.queryByText(/verbal/i)).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'Approve' }));

    expect(await screen.findByText('Approve L00006-1?')).toBeInTheDocument();
    expect(screen.getByText('No signature will be captured.')).toBeInTheDocument();
    expect(screen.queryByText(/verbal or off-platform/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });
});
