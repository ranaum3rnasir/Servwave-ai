import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { ALL_JOB_ACTIONS } from '@/__tests__/helpers';
import { JOB_ID, renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import api from '@/lib/axios';

stubBrowser();

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

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

// Roles & Permissions scenario pass 1 - the routed job page draws no link and makes no read that the person's own
// switches say is not theirs: the Service Plan link follows the Service plans page route's gate (View service plans), and the Items tab asks for the vendor list only for someone who may read vendors.
describe("the job page switch reach", () => {

  const mockApi = vi.mocked(api);

  const BASE_JOB = {
    id: JOB_ID, job_number: 'J00042', status: 'UNSCHEDULED', scope_notes: null, estimated_duration: null,
    completion_notes: null, scheduled_start: null, scheduled_end: null, started_at: null, completed_at: null,
    cancelled_at: null, cancelled_reason: null, created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z',
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001', first_name: 'John', last_name: 'Doe', company_name: null,
      email: 'john@doe.com', phone: '5551234567',
    },
    assignees: [], service_location: null, estimate: null, invoices: [], tags: [],
    actions: ALL_JOB_ACTIONS, viewer_attached: true,
    source_plan_id: 'p1', source_plan: { id: 'p1', service_plan_number: 'SP-7' },
  };

  const VIEW_JOBS: AbilityRule = { action: 'read', subject: 'Job' };

  // The Items tab draws the line items editor only for a person who holds See prices (P11), so the reads below are only
  // asked of a page that actually drew it.
  const SEE_PRICES: AbilityRule = { action: 'read', subject: 'Prices' };

  function answerJob(switches: Record<string, boolean>) {
    localStorage.clear();
    serveJobDetail({
      job: BASE_JOB,
      routes: [
        { match: (url) => url === '/api/permission-switches/me', data: { admin_box: false, values: switches } },
      ],
    });
  }

  async function renderJob(rules: AbilityRule[], switches: Record<string, boolean>) {
    answerJob(switches);
    renderJobDetail({ ability: buildAbility([VIEW_JOBS, ...rules]) });
    await screen.findByRole('tab', { name: /Overview/ });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
  }

  const asked = (path: string) => mockApi.get.mock.calls.some(([url]) => url === path);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('the job page Service Plan reference', () => {
    it('is a link for a person the Service plans route lets in', async () => {
      await renderJob([], { view_service_plans: true });
      expect(await screen.findByRole('link', { name: /Service Plan \(SP-7\)/ })).toHaveAttribute('href', expect.stringContaining('/service-plans'));
    });

    it('is plain text for a person the route would send to the dashboard', async () => {
      await renderJob([], { view_service_plans: false });
      expect(await screen.findByText(/Service Plan \(SP-7\)/)).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Service Plan/ })).toBeNull();
    });
  });

  describe('the job page Items tab reads', () => {
    it('asks for no vendor list when the person cannot order parts', async () => {
      await renderJob([SEE_PRICES, { action: 'read', subject: 'Inventory' }], {});
      await userEvent.click(await screen.findByRole('tab', { name: /Items/ }));
      await screen.findByText('No line items yet.');
      expect(asked('/api/inventory/vendors')).toBe(false);
    });

    it('asks for no vendor list for a person who may order parts but not read vendors', async () => {
      // Create purchase orders needs View purchase orders and Edit purchase orders.
      await renderJob([
        SEE_PRICES,
        { action: 'read', subject: 'PurchaseOrder' },
        { action: 'update', subject: 'PurchaseOrder' },
        { action: 'create', subject: 'PurchaseOrder' },
      ], {});
      await userEvent.click(await screen.findByRole('tab', { name: /Items/ }));
      await screen.findByText('No line items yet.');
      expect(asked('/api/inventory/vendors')).toBe(false);
    });
  });
});

describe("the processing badge", () => {

  // The processing amount and Balance due are prices, so the person holds See prices (P11).
  const invoiceReadAbility = buildAbility([
    { action: 'read', subject: 'Invoice' },
    { action: 'read', subject: 'Prices' },
  ]);

  stubBrowser();

  const BASE_JOB = {
    id: 'j0000000-0000-0000-0000-000000000001',
    job_number: 'J00001',
    status: 'IN_PROGRESS',
    job_type: 'HVAC Installation',
    scope_notes: null,
    estimated_duration: null,
    completion_notes: null,
    scheduled_start: '2026-05-10T09:00:00.000Z',
    scheduled_end: null,
    started_at: '2026-05-10T09:00:00.000Z',
    completed_at: null,
    cancelled_at: null,
    cancelled_reason: null,
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2026-02-01T00:00:00.000Z',
    dispatcher: null,
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      first_name: 'Sarah',
      last_name: 'Johnson',
      company_name: null,
      email: 'sarah@example.com',
      phone: '5125550198',
    },
    assignees: [] as { user: { id: string; first_name: string; last_name: string } }[],
    service_location: null,
    estimate: null,
    invoices: [
      {
        id: 'inv-bank',
        invoice_number: 'I00392',
        status: 'SENT',
        total_amount: '300',
        amount_due: '225.25',
        created_at: '2026-05-01T00:00:00.000Z',
      },
    ],
    tags: [] as Array<{ id: string; name: string; color: string }>,
    source_plan_id: null,
    actions: ALL_JOB_ACTIONS,
    source_plan: null,
  };

  const financials = (processing: number | undefined) => ({
    final_invoice: {
      id: 'inv-bank', invoice_number: 'I00392', total_amount: '300', amount_due: '225.25',
      status: 'SENT', sent_at: '2026-05-15T00:00:00.000Z', paid_at: null,
    },
    invoices: [
      {
        id: 'inv-bank', invoice_number: 'I00392', status: 'SENT', total_amount: '300', amount_due: '225.25',
        sent_at: '2026-05-15T00:00:00.000Z', paid_at: null, kind: 'STANDARD',
        ...(processing === undefined ? {} : { processing_amount: processing }),
      },
    ],
    payments: [
      { id: 'p1', invoice_kind: 'STANDARD', amount: '74.75', method: 'CARD', state: 'SUCCEEDED', paid_at: '2026-05-12T00:00:00.000Z', invoice_number: 'I00392' },
      { id: 'p2', invoice_kind: 'STANDARD', amount: '100', method: 'ACH', state: 'PROCESSING', paid_at: '2026-05-13T00:00:00.000Z', invoice_number: 'I00392' },
    ],
  });

  function mockJob(fin: ReturnType<typeof financials>, jobInvoiceProcessing: number | null = 100) {
    const job = {
      ...BASE_JOB,
      invoices: [{ ...BASE_JOB.invoices[0], ...(jobInvoiceProcessing === null ? {} : { processing_amount: jobInvoiceProcessing }) }],
    };
    serveJobDetail({
      job,
      routes: [
        { match: (url) => url.includes('/financials'), data: fin },
        { match: (url) => url.includes('/notes'), data: { notes: [] } },
        { match: (url) => url.includes('/attachments'), data: { attachments: [] } },
        { match: (url) => url.includes('/api/tags'), data: { tags: [] } },
      ],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Payments go-live slice 28 conductor ruling D1: a bank payment in flight is visible on the job page.
  describe('JobDetailPage - bank payment processing (D1)', () => {
    it('badges the Overview invoice line with the processing amount', async () => {
      mockJob(financials(100));
      renderJobDetail({ ability: invoiceReadAbility });
      await screen.findByRole('heading', { name: /J00001/ });
      const line = (await screen.findByRole('link', { name: 'I00392' })).parentElement!;
      expect(within(line).getByText('Processing $100.00')).toBeInTheDocument();
    });

    it('badges the Payments tab invoice card', async () => {
      mockJob(financials(100));
      renderJobDetail({ ability: invoiceReadAbility });
      await screen.findByRole('heading', { name: /J00001/ });
      await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));
      const panel = within(screen.getByRole('tabpanel'));
      expect(panel.getAllByText('Processing $100.00').length).toBeGreaterThan(0);
    });

    it('keeps Balance due as money not yet received and adds a Processing line beside it', async () => {
      mockJob(financials(100));
      renderJobDetail({ ability: invoiceReadAbility });
      await screen.findByRole('heading', { name: /J00001/ });
      expect(await screen.findByText('Balance due')).toBeInTheDocument();
      // 300 contract - 74.75 landed: processing money is not subtracted.
      expect(screen.getByText('$225.25')).toBeInTheDocument();
      expect(screen.getByText('25% collected')).toBeInTheDocument();
      expect(screen.getByTestId('balance-processing')).toHaveTextContent('Processing $100.00');
    });

    it('shows no badge and no balance line when nothing is processing, or the old payload lacks the field', async () => {
      mockJob(financials(undefined), null);
      renderJobDetail({ ability: invoiceReadAbility });
      await screen.findByRole('heading', { name: /J00001/ });
      await screen.findByText('Balance due');
      expect(screen.queryByTestId('balance-processing')).not.toBeInTheDocument();
      expect(screen.queryByTestId('processing-badge')).not.toBeInTheDocument();
    });
  });
});
