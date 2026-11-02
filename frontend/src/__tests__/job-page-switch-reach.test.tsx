// Roles & Permissions scenario pass 1 - the routed job page draws no link and makes no read that the person's own
// switches say is not theirs: the Service Plan link follows the Service plans page route's gate (View service plans), and the Items tab asks for the vendor list only for someone who may read vendors.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, ALL_JOB_ACTIONS } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility, type AbilityRule } from '@/lib/ability';

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

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
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: switches } };
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    if (url.includes('/api/jobs/')) return { data: { job: BASE_JOB } };
    return { data: {} };
  });
}

async function renderJob(rules: AbilityRule[], switches: Record<string, boolean>) {
  answerJob(switches);
  renderWithProviders(<JobDetailPage />, { ability: buildAbility([VIEW_JOBS, ...rules]) });
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
    await renderJob([], { view_service_plans: true, view_service_plans: false });
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
