/**
 * Guards the estimate workspace's "Preview" action (Actions → Preview): it opens a dialog for
 * the estimate document, fetched from that estimate's own PDF endpoint, with a working Download.
 *
 * This file was previously named for #393 and asserted a rich in-page customer view. That view
 * only ever existed on `EstimateDetailPage.tsx`, which App.tsx never routed to — `/estimates/:id`
 * has always resolved to `EstimateWorkspacePage`. #393 was therefore implemented on a page no
 * user could reach, and was never actually delivered. The dead page is now deleted (D5, port
 * plan §14.6) and this suite exercises the live surface instead.
 *
 * Re-pointed AGAIN 2026-08-27, for the same reason a second time: `/estimates/:id`
 * moved to the v2 page (`pages/v2/estimates/`) on 2026-08-13 and this suite kept
 * importing the v1 copy at `pages/`, so "the real live surface" above quietly
 * stopped being true. The v1 copy is now deleted and this suite imports the v2
 * page. If a third fork ever appears, the import here is the thing to check first.
 *
 * #393 remains OPEN, with PR #729 ("estimate Preview shows full customer-facing page") as its
 * pending fix. This file is deliberately NOT named for #393, and deliberately does NOT assert
 * that the dialog renders an iframe: pinning the iframe would make #729 fail CI for implementing
 * exactly the behaviour the issue asks for. The assertions below hold under either
 * implementation — what matters is which document Preview fetches, and that it can be downloaded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-393-test-id' }),
  };
});

// Heavy sub-surfaces with no bearing on the Preview dialog — stubbed out so the
// page mounts on the one fetch this suite cares about (the estimate itself)
// plus the PDF fetch under test. None of these are what #393 guards.
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({
  EstimateTabs: () => null,
}));
vi.mock('@/components/estimates/EstimateLineItemsEditor', () => ({
  EstimateLineItemsEditor: () => null,
  EstimateScopeOfWorkCard: () => null,
  estimateLinesToInvoiceShape: (lines: unknown) => lines,
}));
vi.mock('@/components/estimates/EstimateReceiptCard', () => ({
  EstimateReceiptCard: () => null,
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
vi.mock('@/components/estimates/CancelEstimateDialog', () => ({ CancelEstimateDialog: () => null }));
vi.mock('@/components/estimates/SendEstimateDialog', () => ({ SendEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const mockApi = vi.mocked(api);

const ESTIMATE = {
  id: 'est-393-test-id',
  lead_id: 'lead-1',
  estimate_number: 'E00393',
  name: null,
  status: 'SENT',
  sent_at: '2026-06-01T00:00:00.000Z',
  approved_at: null,
  declined_at: null,
  cancelled_at: null,
  scope_notes: 'Replace the rooftop condenser and rebalance airflow.',
  tax_rate: '0.0625',
  subtotal: '10000.00',
  tax_amount: '625.00',
  total_amount: '10625.00',
  discount_type: null,
  discount_value: null,
  discount_name: null,
  discount_amount: '0.00',
  signature_data: null,
  signature_at: null,
  public_token: 'tok-393',
  version: 1,
  modified_after_send: false,
  superseded_by_id: null,
  created_by: 'user-1',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  send_config: {
    id: 'sc-1',
    deposit_required: false,
    deposit_percentage: null,
    deposit_amount: null,
    payment_methods: [],
    message_body: null,
  },
  invoices: [],
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
};

function setupMocks() {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/estimates/')) return { data: { estimate: ESTIMATE } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupMocks();
  // PdfPreviewDialog fetches the PDF itself (raw fetch, not axios) — see
  // fetchPdf() in PdfPreviewDialog.tsx. global.fetch/getAccessToken are stubbed
  // globally in setup.ts; override fetch here with a realistic PDF response.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
    blob: async () => new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }),
  } as unknown as Response);
});

describe('EstimateWorkspacePage — Preview dialog', () => {
  it('opens a dialog for THIS estimate, fetched from its own PDF endpoint (Actions → Preview)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /preview/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Estimate E00393')).toBeInTheDocument();

    // Asserts WHICH document is fetched, not how it is rendered — the id in the URL is the part
    // that must never regress. Deliberately no iframe assertion; see the file header.
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/estimates/est-393-test-id/pdf'),
        expect.anything()
      );
    });
  });

  it('keeps a Download button in the PDF dialog, enabled once the PDF has loaded', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /preview/i }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: /download/i })).toBeEnabled();
    });
  });
});
