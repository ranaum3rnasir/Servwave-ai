// Roles & Permissions, PRD 7, slice S07.5 - the routed job page's Logistics tab.
//
// The tab used to ride the stock read alone. It now shows for a person attached to the job, or holding View stock, or
// holding View logistic orders; its staging part for attached or View stock, its orders part for View logistic
// orders. Each case builds the ability from the switches' grants (a read on Inventory is View stock, a read on
// LogisticOrder is View logistic orders) and renders the page the route renders.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, ALL_JOB_ACTIONS } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility, type AbilityRule } from '@/lib/ability';

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

vi.mock('@/pages/v2/_shared/loList', () => ({
  LOList: () => <div data-testid="job-orders" />,
}));
vi.mock('@/components/jobs/JobStagesSection', () => ({
  JobStagesSection: () => <div data-testid="job-stages" />,
}));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);

const BASE_JOB = {
  id: JOB_ID,
  job_number: 'J00042',
  status: 'UNSCHEDULED',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null,
  scheduled_end: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: null,
    email: 'john@doe.com',
    phone: '5551234567',
  },
  assignees: [],
  service_location: null,
  estimate: null,
  invoices: [],
  tags: [],
  source_plan_id: null,
  actions: ALL_JOB_ACTIONS,
  source_plan: null,
};

const VIEW_STOCK: AbilityRule = { action: 'read', subject: 'Inventory' };
const VIEW_LOGISTIC_ORDERS: AbilityRule = { action: 'read', subject: 'LogisticOrder' };
// Any one rule that is neither of the two (the person can still open the job).
const VIEW_JOBS: AbilityRule = { action: 'read', subject: 'Job' };

function showJob(viewerAttached: boolean) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    if (url.includes('/api/jobs/')) return { data: { job: { ...BASE_JOB, viewer_attached: viewerAttached } } };
    return { data: {} };
  });
}

async function renderJob(rules: AbilityRule[], viewerAttached: boolean) {
  showJob(viewerAttached);
  renderWithProviders(<JobDetailPage />, { ability: buildAbility(rules) });
  await screen.findByRole('tab', { name: /Overview/ });
}

/** Opens the Logistics tab and says which of its two parts are on the page. */
async function logisticsParts() {
  await userEvent.click(await screen.findByRole('tab', { name: /Logistics/ }));
  return {
    staging: screen.queryByTestId('job-stages') !== null,
    orders: screen.queryByTestId('job-orders') !== null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JobDetailPage - the Logistics tab follows attachment, View stock and View logistic orders', () => {
  it('View stock alone, not attached: the staging part only', async () => {
    await renderJob([VIEW_JOBS, VIEW_STOCK], false);
    expect(await logisticsParts()).toEqual({ staging: true, orders: false });
  });

  it('View logistic orders alone, not attached: the orders part only', async () => {
    await renderJob([VIEW_JOBS, VIEW_LOGISTIC_ORDERS], false);
    expect(await logisticsParts()).toEqual({ staging: false, orders: true });
  });

  it('both View switches: both parts', async () => {
    await renderJob([VIEW_JOBS, VIEW_STOCK, VIEW_LOGISTIC_ORDERS], false);
    expect(await logisticsParts()).toEqual({ staging: true, orders: true });
  });

  it('attached with neither View switch: the staging part only', async () => {
    await renderJob([VIEW_JOBS], true);
    expect(await logisticsParts()).toEqual({ staging: true, orders: false });
  });

  it('not attached with neither View switch: no Logistics tab', async () => {
    await renderJob([VIEW_JOBS], false);
    expect(screen.queryByRole('tab', { name: /Logistics/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('job-stages')).not.toBeInTheDocument();
    expect(screen.queryByTestId('job-orders')).not.toBeInTheDocument();
  });

  it('attached and holding View logistic orders: both parts', async () => {
    await renderJob([VIEW_JOBS, VIEW_LOGISTIC_ORDERS], true);
    expect(await logisticsParts()).toEqual({ staging: true, orders: true });
  });

  it('shows the orders part on View logistic orders alone', async () => {
    // View logistic orders is the only rule in play.
    await renderJob([VIEW_LOGISTIC_ORDERS], false);
    expect((await logisticsParts()).orders).toBe(true);
  });

  it('keeps Logistics away from an org that did not buy inventory, even for an attached person', async () => {
    vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        user: {
          id: '00000000-0000-0000-0000-000000000001',
          email: 'tech@test.com',
          first_name: 'Test',
          last_name: 'Tech',
          role: 'TECHNICIAN',
          org_plan: 'PRO',
          org_features: ['customers', 'jobs', 'estimates', 'invoices', 'payments', 'scheduling', 'leads'],
        },
        isAuthenticated: true,
        isLoading: false,
        error: null,
      }),
    );
    await renderJob([VIEW_JOBS, VIEW_STOCK, VIEW_LOGISTIC_ORDERS], true);
    expect(screen.queryByRole('tab', { name: /Logistics/ })).not.toBeInTheDocument();
  });
});
