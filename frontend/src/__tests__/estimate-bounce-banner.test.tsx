import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderEstimateWorkspace, serveEstimateWorkspace } from '@/__tests__/harness/estimateWorkspacePage';
import type { CommItem } from '@/lib/api/jobCommunications';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: __route.id }),
  };
});
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
beforeEach(() => { __route.id = 'est-bounce-test-id'; });
/**
 * Email slice 5 — the Estimate workspace's hard-bounce banner.
 *
 * "Delivered and Bounced are shown as FACT... a hard bounce on an Estimate's
 * send specifically should surface something ACTIONABLE on that estimate's
 * own page - not just sit as a quiet pill in a list."
 *
 * Correlation under test: Email carries no estimate_id column, so the page
 * reads the lead's comm timeline (GET /api/leads/:id/communications) and
 * picks out THIS estimate's own send by its deterministic subject prefix
 * (`Estimate ${estimate_number} ...`) — see findTransactionalEmail's doc
 * comment in lib/api/jobCommunications.ts.
 */

// Same stub set as estimate-detail-deposit.test.tsx — nothing under test here
// needs these heavy sub-surfaces real.

const ESTIMATE = {
  id: 'est-bounce-test-id',
  lead_id: 'lead-bounce-1',
  estimate_number: 'E00777',
  name: null,
  status: 'SENT',
  sent_at: '2026-08-01T00:00:00.000Z',
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
  public_token: 'tok-777',
  version: 1,
  modified_after_send: false,
  superseded_by_id: null,
  created_by: 'user-1',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  send_config: { id: 'sc-777', deposit_required: false, deposit_percentage: null, deposit_amount: null, payment_methods: [], message_body: null },
  invoices: [],
  // The server's answer for this estimate: every action the page can offer.
  actions: ['edit', 'send', 'delete', 'cancel', 'record_payment'],
  lead: {
    id: 'lead-bounce-1',
    status: 'ESTIMATED',
    service_request: 'HVAC repair',
    service_address_line1: '100 Test St',
    service_city: 'Boston',
    service_state: 'MA',
    service_zip: '02101',
    customer: {
      id: 'cust-777',
      first_name: 'Bea',
      last_name: 'Bounce',
      company_name: null,
      email: 'bea@example.com',
      phone: '5550009999',
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

function emailItem(overrides: Partial<CommItem> = {}): CommItem {
  return {
    id: 'email-1',
    channel: 'email',
    direction: 'out',
    who: 'Bea Bounce',
    title: 'Estimate E00777 from ServWave',
    preview: 'Your estimate is ready.',
    at: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

function setupMocks(leadItems: CommItem[]) {
  serveEstimateWorkspace({ estimate: ESTIMATE, routes: [{ match: (url) => url.includes('/communications'), data: { items: leadItems } }] });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage — hard-bounce banner (email slice 5)', () => {
  it('shows nothing when no email has ever been sent for this estimate', async () => {
    setupMocks([]);
    renderEstimateWorkspace();

    await waitFor(() => {
      expect(screen.getAllByText('E00777').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/bounced/i)).toBeNull();
  });

  it('shows nothing when the matching send is DELIVERED', async () => {
    setupMocks([emailItem({ deliveryStatus: 'DELIVERED' })]);
    renderEstimateWorkspace();

    await waitFor(() => {
      expect(screen.getAllByText('E00777').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/bounced/i)).toBeNull();
  });

  it('shows nothing for a SOFT bounce (only a HARD bounce is actionable at the banner level)', async () => {
    setupMocks([
      emailItem({ deliveryStatus: 'BOUNCED', bounceKind: 'SOFT', deliveryStatusReason: 'mailbox full' }),
    ]);
    renderEstimateWorkspace();

    await waitFor(() => {
      expect(screen.getAllByText('E00777').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/bounced/i)).toBeNull();
  });

  it('shows the actionable banner with the bounce reason and a Resend action for a HARD bounce', async () => {
    setupMocks([
      emailItem({ deliveryStatus: 'BOUNCED', bounceKind: 'HARD', deliveryStatusReason: '550 5.1.1 mailbox unavailable' }),
    ]);
    renderEstimateWorkspace();

    await waitFor(() => {
      expect(screen.getByText(/bounced - the customer likely never received it/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/550 5\.1\.1 mailbox unavailable/)).toBeInTheDocument();
    // The top toolbar already renders its own "Resend" button once the estimate is SENT
    // (line ~587) - the banner's inline action is a SECOND one, not the only one.
    expect(screen.getAllByRole('button', { name: /resend/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('ignores a hard-bounced email whose subject belongs to a DIFFERENT estimate on the same lead', async () => {
    setupMocks([
      emailItem({
        id: 'email-other',
        title: 'Estimate E00999 from ServWave',
        deliveryStatus: 'BOUNCED',
        bounceKind: 'HARD',
      }),
    ]);
    renderEstimateWorkspace();

    await waitFor(() => {
      expect(screen.getAllByText('E00777').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/bounced/i)).toBeNull();
  });

  it('ignores a hard-bounced email belonging to a sibling REVISION (E00777-2), not this estimate', async () => {
    // Real collision risk: EstimateTabs lets a lead carry several sibling
    // estimates/revisions (E00777, E00777-2, ...). A naive subject prefix
    // match would let "Estimate E00777-2 ..." bleed onto E00777's own page.
    setupMocks([
      emailItem({
        id: 'email-revision',
        title: 'Estimate E00777-2 from ServWave',
        deliveryStatus: 'BOUNCED',
        bounceKind: 'HARD',
      }),
    ]);
    renderEstimateWorkspace();

    await waitFor(() => {
      expect(screen.getAllByText('E00777').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/bounced/i)).toBeNull();
  });

  it('picks the MOST RECENT send when a resend cleared an earlier hard bounce', async () => {
    setupMocks([
      emailItem({
        id: 'email-1',
        at: '2026-08-01T09:00:00.000Z',
        deliveryStatus: 'BOUNCED',
        bounceKind: 'HARD',
      }),
      emailItem({
        id: 'email-2',
        at: '2026-08-02T09:00:00.000Z',
        deliveryStatus: 'DELIVERED',
      }),
    ]);
    renderEstimateWorkspace();

    await waitFor(() => {
      expect(screen.getAllByText('E00777').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/bounced/i)).toBeNull();
  });
});
