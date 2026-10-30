/**
 * The lead page must show the server's lead after estimate work, not a cached copy (issue #2755).
 *
 * Estimate work changes the lead on the server: a send moves it Contacted -> Estimate Sent and locks
 * the early statuses, a recall to Draft unlocks them again, a new estimate joins its Estimates list.
 * The lead page reads all of that from `['lead', id]`, which sits under the app's five-minute
 * staleTime with no refetch on focus. So a user who goes lead -> estimate -> back to the lead within
 * five minutes must still get the server's answer.
 *
 * This drives the realistic path in one SPA: the APP's own QueryClient (not the test helper's
 * staleTime-0 client), the routed LeadDetailPage, NewEstimateRedirect and EstimateWorkspacePage under
 * real routes, and the real dialogs and menus, with only the HTTP layer mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useNavigate, type NavigateFunction } from 'react-router-dom';
import api from '@/lib/axios';
import { queryClient } from '@/lib/queryClient';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { TooltipProvider as KitTooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { buildAbility } from '@/lib/ability';
import { LEAD_FIXTURE, NOTES_FIXTURE } from './helpers';
import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';
import NewEstimateRedirect from '@/pages/v2/estimates/NewEstimateRedirect';

// Lead page surfaces with no bearing on the status menu (same stubs as lead-detail-page.test.tsx).
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
// Workspace surfaces with no bearing on the send (same stubs as estimate-send-recipient-prefill).
// SendEstimateDialog is deliberately NOT stubbed: its onSuccess is the code under test.
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({ EstimateTabs: () => null }));
vi.mock('@/components/estimates/EstimateLineItemsEditor', () => ({
  EstimateLineItemsEditor: () => null,
  EstimateScopeOfWorkCard: () => null,
  estimateLinesToInvoiceShape: (lines: unknown) => lines,
}));
vi.mock('@/features/estimate-workspace/components/SignatureCard', () => ({ SignatureCard: () => null }));
vi.mock('@/features/estimate-workspace/components/NotesCard', () => ({ NotesCard: () => null }));
vi.mock('@/features/estimate-workspace/components/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('@/components/estimates/PdfPreviewDialog', () => ({ PdfPreviewDialog: () => null }));
vi.mock('@/components/estimates/CancelEstimateDialog', () => ({ CancelEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const LEAD_ID = LEAD_FIXTURE.id;
const ESTIMATE_ID = 'est-send-refresh-1';
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

// The server's lock text, word for word (backend/src/services/lead-status-options.ts).
const ESTIMATE_ALREADY_SENT = "An estimate was already sent to this lead, so it can't go back to this step.";
const NO_ESTIMATE_SENT = 'No estimate has been sent to this lead yet.';
const NO_WALKTHROUGH_BOOKED = "There's no walkthrough booked on this lead right now.";
const NO_WALKTHROUGH_DONE = 'No walkthrough on this lead is done yet.';

const opt = (status: string, reason: string | null) => ({ status, available: reason === null, reason });

/** Contacted, no visits, nothing sent: what leadStatusOptions() answers before the send. */
const BEFORE_SEND = {
  status: 'CONTACTED',
  estimates: [] as unknown[],
  status_options: [
    opt('NEW', null), opt('CONTACTED', null), opt('WALKTHROUGH_SCHEDULED', NO_WALKTHROUGH_BOOKED),
    opt('WALKTHROUGH_COMPLETED', NO_WALKTHROUGH_DONE), opt('ESTIMATED', NO_ESTIMATE_SENT), opt('WON', null), opt('LOST', null),
  ],
};
/** After send(): the lead auto-transitioned to ESTIMATED and the early statuses lock. */
const AFTER_SEND = {
  status: 'ESTIMATED',
  estimates: [{ id: ESTIMATE_ID, estimate_number: 'L00001-1', status: 'SENT', total_amount: '1062.50', created_at: '2026-07-01T00:00:00.000Z', invoices: [] }],
  status_options: [
    opt('NEW', ESTIMATE_ALREADY_SENT), opt('CONTACTED', ESTIMATE_ALREADY_SENT), opt('WALKTHROUGH_SCHEDULED', ESTIMATE_ALREADY_SENT),
    opt('WALKTHROUGH_COMPLETED', ESTIMATE_ALREADY_SENT), opt('ESTIMATED', null), opt('WON', null), opt('LOST', null),
  ],
};

/** Recalled to Draft: still Estimate Sent (the lead keeps its status), but nothing sent now, so the early steps unlock. */
const DRAFT_ON_LEAD = { ...AFTER_SEND.estimates[0] as object, status: 'DRAFT' };
const AFTER_RECALL = {
  status: 'ESTIMATED',
  estimates: [DRAFT_ON_LEAD],
  status_options: [
    opt('NEW', null), opt('CONTACTED', null), opt('WALKTHROUGH_SCHEDULED', NO_WALKTHROUGH_BOOKED),
    opt('WALKTHROUGH_COMPLETED', NO_WALKTHROUGH_DONE), opt('ESTIMATED', null), opt('WON', null), opt('LOST', null),
  ],
};

const ESTIMATE = {
  id: ESTIMATE_ID, estimate_number: 'L00001-1', name: null, status: 'DRAFT',
  approved_at: null, sent_at: null, declined_at: null, cancelled_at: null, scope_notes: null,
  tax_rate: '0.0625', subtotal: '1000.00', tax_amount: '62.50', total_amount: '1062.50',
  discount_type: null, discount_value: null, discount_name: null, discount_amount: '0.00',
  signature_data: null, signature_at: null, public_token: null, version: 1, modified_after_send: false,
  superseded_by_id: null, created_by: 'user-1', created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
  send_config: null, creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
  line_items: [], scopes: [], job: null, job_id: null, invoices: [],
  actions: ['edit', 'send', 'delete', 'cancel', 'record_payment'],
  lead_id: LEAD_ID,
  lead: { id: LEAD_ID, status: 'CONTACTED', service_request: 'AC not cooling', service_address_line1: '123 Main St',
    service_city: 'Austin', service_state: 'TX', service_zip: '78701', customer: LEAD_FIXTURE.customer },
  customer_id: null, customer: null,
};

// The "server": what GET /api/leads/:id and GET /api/estimates/:id answer right now.
let serverLead: Record<string, unknown>;
let serverEstimate: Record<string, unknown>;
const leadGets = () => vi.mocked(api.get).mock.calls.filter(([u]) => u === `/api/leads/${LEAD_ID}`).length;

const nav: { current?: NavigateFunction } = {};
function NavProbe() {
  const navigate = useNavigate();
  useEffect(() => { nav.current = navigate; }, [navigate]);
  return null;
}

function renderApp() {
  return render(
    <AbilityProvider ability={adminAbility}>
      <QueryClientProvider client={queryClient}>
        <KitTooltipProvider delayDuration={320}>
          <MemoryRouter initialEntries={[`/leads/${LEAD_ID}`]}>
            <NavProbe />
            <Routes>
              <Route path="/leads/:id" element={<LeadDetailPage />} />
              <Route path="/estimates/new" element={<NewEstimateRedirect />} />
              <Route path="/estimates/:id" element={<EstimateWorkspacePage />} />
            </Routes>
          </MemoryRouter>
        </KitTooltipProvider>
      </QueryClientProvider>
    </AbilityProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  localStorage.clear();
  serverLead = { ...LEAD_FIXTURE, ...BEFORE_SEND };
  serverEstimate = ESTIMATE;
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url === `/api/leads/${LEAD_ID}`) return { data: { lead: serverLead } };
    if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url.startsWith(`/api/estimates/${ESTIMATE_ID}`)) return { data: { estimate: serverEstimate } };
    if (url === '/api/organization') {
      return { data: { accepted_payment_methods: ['CARD'], deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50 } };
    }
    return { data: {} };
  });
  vi.mocked(api.patch).mockImplementation(async (url: string, body?: unknown) => {
    if (url === `/api/estimates/${ESTIMATE_ID}/status` && (body as { status?: string })?.status === 'DRAFT') {
      serverEstimate = { ...ESTIMATE, status: 'DRAFT' };
      serverLead = { ...LEAD_FIXTURE, ...AFTER_RECALL };
      return { data: { estimate: serverEstimate } };
    }
    return { data: {} };
  });
  vi.mocked(api.post).mockImplementation(async (url: string) => {
    if (url === `/api/estimates/${ESTIMATE_ID}/send`) {
      serverLead = { ...LEAD_FIXTURE, ...AFTER_SEND };
      return { data: { estimate: { ...ESTIMATE, status: 'SENT' } } };
    }
    if (url === '/api/estimates') {
      serverLead = { ...LEAD_FIXTURE, ...BEFORE_SEND, estimates: [DRAFT_ON_LEAD] };
      return { data: { estimate: ESTIMATE } };
    }
    return { data: {} };
  });
});

describe('Back on the lead after estimate work, the page shows the server\'s lead (#2755)', () => {
  it('lead -> estimate -> Send -> back to the lead shows Estimate Sent, not the cached Contacted menu', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderApp();

    // 1. The lead page, cached as Contacted with Estimate Sent locked.
    expect(await screen.findByRole('button', { name: 'Lead status: Contacted' })).toBeInTheDocument();
    expect(leadGets()).toBe(1);

    // 2. Over to the estimate (same SPA, same cache) and send it through the real dialog.
    act(() => { nav.current!(`/estimates/${ESTIMATE_ID}`); });
    await user.click(await screen.findByRole('button', { name: /^Send$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/api/estimates/${ESTIMATE_ID}/send`, expect.anything()));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // 3. Back to the lead, well inside five minutes.
    act(() => { nav.current!(`/leads/${LEAD_ID}`); });

    // The app must ask the server again, and the menu must show what the server now says.
    await waitFor(() => expect(leadGets()).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    expect(await screen.findByRole('button', { name: 'Lead status: Estimate Sent' }, { timeout: 3000 })).toBeInTheDocument();
  });

  it('lead -> estimate -> Recall to Draft -> back to the lead unlocks the early statuses again', async () => {
    serverLead = { ...LEAD_FIXTURE, ...AFTER_SEND };
    serverEstimate = { ...ESTIMATE, status: 'SENT', sent_at: '2026-07-01T00:00:00.000Z' };
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderApp();

    // 1. The lead page, cached as Estimate Sent with New locked.
    await user.click(await screen.findByRole('button', { name: 'Lead status: Estimate Sent' }));
    expect(await screen.findByRole('menuitem', { name: /^New/ })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Escape}');

    // 2. Over to the estimate and recall it through the status pill and its confirm.
    act(() => { nav.current!(`/estimates/${ESTIMATE_ID}`); });
    await user.click(await screen.findByRole('button', { name: /change status/i }));
    await user.click(await screen.findByRole('menuitem', { name: /draft/i }));
    await user.click(await screen.findByRole('button', { name: 'Recall to Draft' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`/api/estimates/${ESTIMATE_ID}/status`, { status: 'DRAFT' }));

    // 3. Back to the lead: nothing is sent any more, so New can be picked again.
    act(() => { nav.current!(`/leads/${LEAD_ID}`); });
    await user.click(await screen.findByRole('button', { name: 'Lead status: Estimate Sent' }));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /^New/ })).not.toHaveAttribute('aria-disabled', 'true'), { timeout: 3000 });
  });

  it('lead -> Create Estimate -> back to the lead lists the new estimate', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderApp();

    // 1. The lead page, cached with no estimates.
    expect(await screen.findByRole('button', { name: 'Lead status: Contacted' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Estimates (0)' })).toBeInTheDocument();

    // 2. Create Estimate makes an empty draft and lands on its workspace.
    await user.click(screen.getAllByRole('button', { name: /create estimate/i })[0]!);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/estimates', { lead_id: LEAD_ID }));
    expect(await screen.findByRole('button', { name: /change status/i })).toBeInTheDocument();

    // 3. Back to the lead: the draft is in its Estimates tab.
    act(() => { nav.current!(`/leads/${LEAD_ID}`); });
    await user.click(await screen.findByRole('tab', { name: 'Estimates (1)' }, { timeout: 3000 }));
    expect(await screen.findByText('L00001-1')).toBeInTheDocument();
  });
});
