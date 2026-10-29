/**
 * #2048 — Convert to job: primary lead header button, estimate Actions item, and
 * folding several WON estimates into one job.
 *
 * Ground truth on this commit (Pass A / Pass B, both confirmed against source):
 *  (a) LeadDetailPage's ONLY convert control is the "Lead actions" kebab's "Convert to
 *      job" menuitem, gated solely on `create Job` — there is no PRIMARY header button
 *      (LeadDetailPage.tsx:237,423-427).
 *  (b) EstimateWorkspacePage's Actions dropdown has no convert item at all; only the
 *      pre-existing header "Create Job" button exists (mirrors nothing in the menu)
 *      (EstimateWorkspacePage.tsx:451,663-671,678-811).
 *  (c) The lead's convert dialog is single-select (`selectedId: string | null`, a
 *      decorative radio dot, no checkbox role) and can only ever post `estimate_id`,
 *      never `estimate_ids` (createJobFromLeadDialog.tsx:29-33,71-77,111-119,170-177).
 *
 * Each `it` below is written against the DESIRED behaviour from the issue's acceptance
 * list and is expected to fail on this commit for exactly the gap named above.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE, NOTES_FIXTURE } from './helpers';
import { buildAbility } from '@/lib/ability';
import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

// Shared route param for whichever page a given test mounts — LeadDetailPage and
// EstimateWorkspacePage both read `useParams().id`, so one mock covers both; each
// describe block below sets it to the id its own fixture expects.
const routeParams = vi.hoisted(() => ({ id: 'e0000000-0000-0000-0000-000000000001' }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: routeParams.id }),
    useNavigate: () => vi.fn(),
  };
});

// EstimateWorkspacePage's heavy sub-surfaces — stubbed the same way as the sibling
// suites exercising this page (estimate-create-job-gate.test.tsx, estimate-copy-to-invoice.test.tsx).
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

// floating-ui (under Radix dropdown) does `new ResizeObserver(...)`.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

beforeEach(() => {
  vi.clearAllMocks();
  routeParams.id = 'e0000000-0000-0000-0000-000000000001';
});

// ─── (a) Lead header: primary "Convert to job" button ───────────────────────

const ONE_WON_ESTIMATE = {
  id: 'es000000-0000-0000-0000-000000000001',
  estimate_number: 'E00001',
  status: 'WON',
  total_amount: '1500.00',
  created_at: '2026-02-01T00:00:00.000Z',
  job: null,
};

function serveLeadWithOneWonEstimate() {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
    if (url.includes('/api/leads/')) {
      return { data: { lead: { ...LEAD_FIXTURE, status: 'WON', estimates: [ONE_WON_ESTIMATE] } } };
    }
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
}

describe('#2048 (a) - lead header primary "Convert to job" button', () => {
  it('shows a primary header Convert-to-job button when create Job is granted and the lead has a WON estimate without a job, and never shows it without the grant', async () => {
    serveLeadWithOneWonEstimate();

    const granted = renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    // Desired behaviour 1: a PRIMARY button in the header (not buried in the kebab).
    // Today the header renders only the "Lead actions" kebab trigger; this control does
    // not exist anywhere in the DOM, so this assertion times out.
    expect(
      await screen.findByRole('button', { name: /convert to job/i }, { timeout: 3000 }),
    ).toBeInTheDocument();
    granted.unmount();

    // Same lead, an ability that can read/edit the lead and create estimates but lacks
    // `create Job` — the button must never appear for this user either.
    const noConvertAbility = buildAbility([
      { action: 'read', subject: 'Lead' },
      { action: 'update', subject: 'Lead' },
      { action: 'create', subject: 'Estimate' },
    ]);
    renderWithProviders(<LeadDetailPage />, { ability: noConvertAbility });
    await screen.findByRole('heading', { name: /L00001\b/ });
    expect(screen.queryByRole('button', { name: /convert to job/i })).toBeNull();
  });
});

// ─── (b) Estimate Actions dropdown: "Convert to job" item ───────────────────

const ESTIMATE_ID = 'est-2048-actions-id';

/** WON, no deposit invoice outstanding, no job link either way — the state in which the
 * header's "Create Job" button is offered today, and where the Actions item should mirror it. */
const WON_ESTIMATE = {
  id: ESTIMATE_ID,
  lead_id: 'lead-2048',
  estimate_number: 'L00005-1',
  name: null,
  status: 'WON',
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
    id: 'lead-2048',
    status: 'ESTIMATED',
    service_request: 'HVAC repair',
    service_address_line1: '100 Test St',
    service_city: 'Boston',
    service_state: 'MA',
    service_zip: '02101',
    customer: {
      id: 'cust-2048',
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

describe('#2048 (b) - estimate Actions "Convert to job" item', () => {
  it('offers "Convert to job" in the Actions dropdown for a WON, non-job-anchored estimate, mirroring the header button', async () => {
    routeParams.id = ESTIMATE_ID;
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/state-tax-rates')) return { data: { data: [] } };
      if (url.includes('/api/estimates/')) return { data: { estimate: WON_ESTIMATE } };
      return { data: {} };
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    // Confirms the fixture is in the gate-satisfying state (the pre-existing header
    // button, unaffected by #2048) before asserting on the Actions item.
    expect(await screen.findByRole('button', { name: /Create Job/i })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Actions' }));

    // Desired behaviour 2: an Actions item mirroring the header button's exact gate and
    // mutation. Today the Actions menu has no convert item at all, so this times out.
    expect(
      await screen.findByRole('menuitem', { name: /convert to job/i }, { timeout: 3000 }),
    ).toBeInTheDocument();
  });
});

// ─── (c) Lead's convert dialog: multi-select + estimate_ids payload ─────────

const WON_A = {
  id: 'es-2048-a',
  estimate_number: 'E00010',
  status: 'WON',
  total_amount: '1000.00',
  created_at: '2026-03-01T00:00:00.000Z',
  job: null,
};
const WON_B = {
  id: 'es-2048-b',
  estimate_number: 'E00011',
  status: 'WON',
  total_amount: '800.00',
  created_at: '2026-03-02T00:00:00.000Z',
  job: null,
};

function serveLeadWithTwoWonEstimates() {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
    if (url.includes('/api/leads/')) {
      return { data: { lead: { ...LEAD_FIXTURE, status: 'WON', estimates: [WON_A, WON_B] } } };
    }
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
}

describe('#2048 (c) - lead convert dialog folds several WON estimates into one job', () => {
  it('shows both WON estimates as checked checkboxes and posts estimate_ids: [a, b] to POST /api/jobs on confirm', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    serveLeadWithTwoWonEstimates();
    mockApi.post.mockResolvedValue({ data: { job: { id: 'job-2048' } } });

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: /Lead actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Convert to job/i }));

    const dialog = await screen.findByRole('dialog');

    // Desired behaviour 3: several convertible estimates render as CHECKBOXES, default
    // checked when there is more than one convertible. Today the dialog is single-select
    // (a decorative radio dot with no accessible checkbox role), so this throws
    // synchronously — no checkbox role exists in the dialog at all.
    const checkboxes = within(dialog).getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    checkboxes.forEach((box) => expect(box).toBeChecked());

    await user.click(within(dialog).getByRole('button', { name: /create job/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs', {
        estimate_ids: [WON_A.id, WON_B.id],
      }),
    );
  });
});
