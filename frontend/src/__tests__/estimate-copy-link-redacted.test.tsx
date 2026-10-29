/**
 * #1997 round 3 (HIGH) — the backend now deletes `public_token` from the estimate detail
 * response entirely (not just nulls it) when the requester cannot read the anchored customer,
 * because an unauthenticated public PDF route accepts that token with no read-Customer check at
 * all. The workspace's "Copy Link" control must degrade the same way it already does for a
 * genuinely un-sent (`public_token: null`) estimate: hidden, no crash, and it must never build a
 * `/p/estimates/...?token=undefined` URL.
 *
 * `canCopyLink`/`handleCopyLink` (EstimateWorkspacePage.tsx) already gate on `!!estimate.public_token`,
 * which is false for BOTH `null` and `undefined` — this suite pins that this control needed no
 * code change, the way `customer-header-leadless.test.tsx` pinned CustomerHeader for the round-1
 * contact-key redaction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const ESTIMATE_ID = 'est-1997-copylink-id';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: ESTIMATE_ID }) };
});

// Heavy sub-surfaces with no bearing on the Actions menu — same stub set as the sibling page
// suites (estimate-pdf-preview-dialog / estimate-send-recipient-prefill).
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({ EstimateTabs: () => null }));
vi.mock('@/components/estimates/EstimateLineItemsEditor', () => ({
  EstimateLineItemsEditor: () => null,
  EstimateScopeOfWorkCard: () => null,
  estimateLinesToInvoiceShape: (lines: unknown) => lines,
}));
vi.mock('@/components/estimates/EstimateReceiptCard', () => ({ EstimateReceiptCard: () => null }));
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

const mockApi = vi.mocked(api);

function baseEstimate(overrides: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_ID,
    lead_id: null,
    customer_id: 'cust-1997',
    estimate_number: 'E01997',
    name: null,
    status: 'SENT',
    sent_at: '2026-06-01T00:00:00.000Z',
    approved_at: null,
    declined_at: null,
    cancelled_at: null,
    scope_notes: '',
    tax_rate: '0',
    subtotal: '0.00',
    tax_amount: '0.00',
    total_amount: '0.00',
    discount_type: null,
    discount_value: null,
    discount_name: null,
    discount_amount: '0.00',
    signature_data: null,
    signature_at: null,
    version: 1,
    modified_after_send: false,
    superseded_by_id: null,
    created_by: 'user-1',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    send_config: null,
    invoices: [],
    lead: null,
    customer: {
      id: 'cust-1997',
      first_name: 'Jane',
      last_name: 'Doe',
      company_name: null,
      // #1997 — a denied requester never receives email/phone/billing_* at all (absent).
    },
    creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
    line_items: [],
    scopes: [],
    job: null,
    ...overrides,
  };
}

function setupMocks(estimate: Record<string, unknown>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/estimates/')) return { data: { estimate } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage — Copy Link control when public_token is redacted', () => {
  it('hides Copy Link when public_token is entirely ABSENT (redacted requester), with no crash', async () => {
    const estimate = baseEstimate();
    delete (estimate as { public_token?: string }).public_token; // key absent, not null
    setupMocks(estimate);
    const user = userEvent.setup();

    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    expect(screen.queryByRole('menuitem', { name: /copy link/i })).not.toBeInTheDocument();
  });

  it('shows Copy Link when public_token is present, and it never copies a "token=undefined" URL', async () => {
    const estimate = baseEstimate({ public_token: 'tok-1997' });
    setupMocks(estimate);
    const user = userEvent.setup();
    // Mock clipboard API (not available in JSDOM) — same shape as EstimateNameTitle.test.tsx.
    // Defined AFTER userEvent.setup(), which installs its own clipboard stub on setup.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });

    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    const item = await screen.findByRole('menuitem', { name: /copy link/i });
    await user.click(item);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('token=tok-1997'),
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(expect.stringContaining('undefined'));
  });

  it('hides Copy Link when public_token is null (genuinely never sent) — unchanged pre-existing behavior', async () => {
    const estimate = baseEstimate({ status: 'DRAFT', sent_at: null, public_token: null });
    setupMocks(estimate);

    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    expect(screen.queryByRole('menuitem', { name: /copy link/i })).not.toBeInTheDocument();
  });
});
