/**
 * Tests for "Copy Estimate to Invoice" — converts an Estimate directly into a standalone
 * Invoice from the Estimate workspace's Actions menu, independent of the Job pipeline.
 *
 * Covers:
 *  - The "Copy to Invoice" menu item's CASL gating (`create Invoice`), independent of status
 *    (available on a DRAFT estimate — NOT gated on isApproved/WON like Create Job).
 *  - Disabled + informative tooltip when the estimate already has a Job, or a non-VOIDED
 *    kind:'STANDARD' invoice already exists for it (already copied).
 *  - A VOIDED STANDARD invoice does NOT count as "already copied" (action stays enabled).
 *  - The reciprocal "View invoice" menu item (mirrors "View job") and its navigation.
 *  - The mutation firing POST /api/estimates/:id/copy-to-invoice (no body) and navigating to
 *    /invoices/:id on success.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-copy-test-id' }),
    useNavigate: () => mockNavigate,
  };
});

// Heavy sub-surfaces with no bearing on the Actions menu — stubbed out (same set as
// estimate-detail-deposit.test.tsx, the sibling suite exercising this same page).
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
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const mockApi = vi.mocked(api);

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
// Can view/manage the estimate but NOT create Invoice — proves the gate is the Invoice grant.
const noInvoiceCreateAbility = buildAbility([
  { action: 'read', subject: 'Estimate' },
  { action: 'update', subject: 'Estimate' },
]);

const BASE_ESTIMATE = {
  id: 'est-copy-test-id',
  lead_id: 'lead-1',
  estimate_number: 'E00201',
  name: null,
  status: 'DRAFT',
  sent_at: null,
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
  invoices: [],
};

function setupMocks(fixture: Record<string, unknown>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url.includes('/api/estimates/')) return { data: { estimate: fixture } };
    return { data: {} };
  });
}

async function openActionsMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Actions' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage — Copy to Invoice gating', () => {
  it('shows the "Copy to Invoice" menu item when ability grants create Invoice, even on a DRAFT (non-approved) estimate', async () => {
    setupMocks(BASE_ESTIMATE);
    const user = userEvent.setup();
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await openActionsMenu(user);
    expect(await screen.findByRole('menuitem', { name: /Copy to Invoice/i })).toBeInTheDocument();
  });

  it('hides the "Copy to Invoice" menu item when ability lacks create Invoice', async () => {
    setupMocks(BASE_ESTIMATE);
    const user = userEvent.setup();
    renderWithProviders(<EstimateWorkspacePage />, { ability: noInvoiceCreateAbility });

    await openActionsMenu(user);
    // Anchor on a menu item that IS present to confirm the menu actually opened.
    expect(await screen.findByRole('menuitem', { name: /Preview/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Copy to Invoice/i })).toBeNull();
  });

  it('disables "Copy to Invoice" with an informative tooltip when the estimate already has a Job', async () => {
    setupMocks({ ...BASE_ESTIMATE, job: { id: 'job-1', job_number: 'J00010' } });
    const user = userEvent.setup();
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await openActionsMenu(user);
    const item = await screen.findByRole('menuitem', { name: /Copy to Invoice/i });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute(
      'title',
      'This estimate already has a Job — invoice through the Job instead',
    );
  });

  // SRVW-86 - a job-attached estimate (Estimate.job_id, no Job pointing back) is the case a
  // multi-estimate conversion and the job-anchored create both produce. The backend refuses it
  // now, so the menu item must too rather than surfacing a raw 409 toast. Substring assertion:
  // the full title carries a pre-existing em dash this test must not re-author.
  it('disables "Copy to Invoice" with an informative tooltip when the estimate is attached to a job via job_id (no provenance job)', async () => {
    setupMocks({ ...BASE_ESTIMATE, job: null, job_id: 'job-multi-1' });
    const user = userEvent.setup();
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await openActionsMenu(user);
    const item = await screen.findByRole('menuitem', { name: /Copy to Invoice/i });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item.getAttribute('title')).toContain('already has a Job');
  });

  it('disables "Copy to Invoice" with an informative tooltip when a non-VOIDED STANDARD invoice already exists (already copied)', async () => {
    setupMocks({
      ...BASE_ESTIMATE,
      invoices: [{ id: 'inv-std-1', invoice_number: 'I00050', kind: 'STANDARD', status: 'SENT' }],
    });
    const user = userEvent.setup();
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await openActionsMenu(user);
    const item = await screen.findByRole('menuitem', { name: /Copy to Invoice/i });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', 'Already copied to Invoice I00050');
  });

  it('keeps "Copy to Invoice" enabled when the only STANDARD invoice is VOIDED (does not count as already-copied)', async () => {
    setupMocks({
      ...BASE_ESTIMATE,
      invoices: [{ id: 'inv-std-voided', invoice_number: 'I00051', kind: 'STANDARD', status: 'VOIDED' }],
    });
    const user = userEvent.setup();
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await openActionsMenu(user);
    const item = await screen.findByRole('menuitem', { name: /Copy to Invoice/i });
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    // Reciprocal "View invoice" also stays hidden — a VOIDED standard invoice isn't "the" copy.
    expect(screen.queryByRole('menuitem', { name: /View invoice/i })).toBeNull();
  });
});

describe('EstimateWorkspacePage — reciprocal "View invoice" menu item', () => {
  it('navigates to /invoices/:id on click', async () => {
    setupMocks({
      ...BASE_ESTIMATE,
      job: { id: 'job-1', job_number: 'J00010' },
      invoices: [{ id: 'inv-std-1', invoice_number: 'I00050', kind: 'STANDARD', status: 'SENT' }],
    });
    const user = userEvent.setup();
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await openActionsMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'View invoice' }));

    expect(mockNavigate).toHaveBeenCalledWith('/invoices/inv-std-1');
  });

  // The job's reachability moved OUT of this menu. It used to be a "View job" item here -
  // unlabelled, invisible until you opened the menu, and in a different place from the lead link
  // the hero showed for a lead-anchored estimate. Both now live in the hero's "Attached to"
  // strip, so this assertion moved with it rather than being dropped.
  //
  // SRVW-86 - the 409 and the tooltip both tell the operator to bill through the job, so the job
  // still has to be reachable from this page for an estimate whose only job pointer is the
  // scalar job_id (the provenance relation is null for every attached estimate).
  it('reaches the attached job from the hero when the estimate has job_id but no provenance job', async () => {
    setupMocks({ ...BASE_ESTIMATE, job: null, job_id: 'job-multi-1' });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await screen.findByRole('link', { name: /Job/ })).toHaveAttribute(
      'href',
      '/jobs/job-multi-1',
    );
  });

  it('names the attached job in the hero when job_link is present', async () => {
    setupMocks({
      ...BASE_ESTIMATE,
      job: null,
      job_id: 'job-multi-1',
      job_link: { id: 'job-multi-1', job_number: 'J00010', status: 'SCHEDULED' },
    });
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await screen.findByRole('link', { name: /Job J00010/ })).toHaveAttribute(
      'href',
      '/jobs/job-multi-1',
    );
  });
});

describe('EstimateWorkspacePage — Copy to Invoice mutation', () => {
  it('fires POST /api/estimates/:id/copy-to-invoice with no body and navigates to /invoices/:id on success', async () => {
    setupMocks(BASE_ESTIMATE);
    mockApi.post.mockResolvedValue({
      data: { invoice: { id: 'inv-new-1', invoice_number: 'I00099' } },
    });
    const user = userEvent.setup();
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await openActionsMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Copy to Invoice/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/estimates/est-copy-test-id/copy-to-invoice'),
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/invoices/inv-new-1'));
  });

  it('shows a destructive toast and does not navigate when the backend 409s', async () => {
    setupMocks(BASE_ESTIMATE);
    mockApi.post.mockRejectedValue({
      isAxiosError: true,
      response: { data: { error: 'This estimate already has a Job' } },
    });
    const user = userEvent.setup();
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await openActionsMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Copy to Invoice/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
