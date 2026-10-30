/**
 * Roles & Permissions, PRD 4, S04.17 - Complete job on the routed job page when the job still has open visits.
 *
 * The job-level complete never finishes a visit: the server refuses it while a visit is open unless the request says
 * to cancel them. The page holds the refusal, lists the open visits with cancel-and-complete as the default and a way
 * back, and sends the complete again with that choice only when the person agrees.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, ALL_JOB_ACTIONS } from '@/__tests__/helpers';

import JobDetailPage from '../JobDetailPage';

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);
// The page draws its controls from the server's per-record action list, so the browser-side ability stays empty.
const nothing = buildAbility([]);

const VISIT = {
  id: 'v-1',
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: '2026-09-05T13:00:00.000Z',
  scheduled_end: '2026-09-05T15:00:00.000Z',
  is_all_day: false,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-08-20T10:00:00.000Z',
  status_steps: [],
};

const JOB = {
  id: JOB_ID,
  job_number: 'J00001',
  status: 'SCHEDULED',
  job_type: 'HVAC Installation',
  description: 'Replace the rooftop unit',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: '2026-09-05T13:00:00.000Z',
  scheduled_end: '2026-09-05T15:00:00.000Z',
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  dispatcher: null,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Johnson',
    company_name: null,
    email: 'sarah@example.com',
    phone: '5125550198',
  },
  assignees: [],
  visits: [VISIT],
  service_location: { id: 'l-1', address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
  estimate: null,
  invoices: [],
  linked_estimates: [],
  tags: [],
  source_plan_id: null,
  source_plan: null,
  actions: [] as string[],
};

const OPEN_VISITS_REFUSAL = {
  response: {
    status: 409,
    data: {
      error: 'This job still has open visits. Cancel them to complete the job.',
      code: 'JOB_COMPLETE_HAS_OPEN_VISITS',
      open_visits: [
        { id: 'v-1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: '2026-09-05T13:00:00.000Z', scheduled_end: '2026-09-05T15:00:00.000Z' },
        { id: 'v-2', visit_seq: 2, status: 'EN_ROUTE', scheduled_at: '2026-09-06T13:00:00.000Z', scheduled_end: '2026-09-06T15:00:00.000Z' },
      ],
    },
  },
};

function mountWith(actions: string[]) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { id: 'u-me', email: 'me@x.test', first_name: 'Me', last_name: 'Person', role: 'CUSTOM_ROLE' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
  const job = { ...JOB, actions };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/visits')) return { data: { visits: [VISIT] } };
    if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
    if (url.includes('/line-items')) return { data: { lines: [], billing: { subtotal: 0, discount_amount: 0, tax_rate: 0, tax_amount: 0, total: 0 } } };
    if (url.includes('/notes')) return { data: { notes: [] } };
    if (url.includes('/api/attachments/')) return { data: { attachments: [] } };
    if (url.includes('/communications')) return { data: { items: [] } };
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } };
    return { data: {} };
  });
  return renderWithProviders(<JobDetailPage />, { ability: nothing, initialEntries: [`/jobs/${JOB_ID}`] });
}

const completeCalls = () => mockApi.post.mock.calls.filter(([url]) => url === `/api/jobs/${JOB_ID}/complete`);

async function pressCompleteJob() {
  await screen.findByRole('heading', { name: /J00001/ });
  await userEvent.click(screen.getByRole('button', { name: /complete job/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('job page - Complete job over open visits', () => {
  it('lists the open visits with cancel-and-complete as the default, after a first request with no cancel choice', async () => {
    mockApi.post.mockRejectedValueOnce(OPEN_VISITS_REFUSAL);
    mountWith(ALL_JOB_ACTIONS);

    await pressCompleteJob();

    const confirm = await screen.findByRole('dialog', { name: /open visits/i });
    expect(within(confirm).getByText('Visit 1')).toBeInTheDocument();
    expect(within(confirm).getByText('Visit 2')).toBeInTheDocument();
    expect(within(confirm).getByText('Scheduled')).toBeInTheDocument();
    expect(within(confirm).getByText('On the way')).toBeInTheDocument();
    expect(within(confirm).getByRole('button', { name: 'Cancel these visits and complete the job' })).toHaveFocus();
    expect(within(confirm).getByRole('button', { name: 'Go back' })).toBeInTheDocument();
    expect(completeCalls()).toEqual([[`/api/jobs/${JOB_ID}/complete`]]);
  });

  it('sends the complete again with the cancel choice when the person agrees', async () => {
    mockApi.post.mockRejectedValueOnce(OPEN_VISITS_REFUSAL).mockResolvedValueOnce({ data: { job: { ...JOB, status: 'COMPLETED' } } });
    mountWith(ALL_JOB_ACTIONS);
    await pressCompleteJob();
    const confirm = await screen.findByRole('dialog', { name: /open visits/i });

    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel these visits and complete the job' }));

    await waitFor(() => expect(completeCalls()).toHaveLength(2));
    expect(completeCalls()[1]).toEqual([`/api/jobs/${JOB_ID}/complete`, { cancel_open_visits: true }]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /open visits/i })).toBeNull());
  });

  it('going back sends nothing more', async () => {
    mockApi.post.mockRejectedValueOnce(OPEN_VISITS_REFUSAL);
    mountWith(ALL_JOB_ACTIONS);
    await pressCompleteJob();
    const confirm = await screen.findByRole('dialog', { name: /open visits/i });

    await userEvent.click(within(confirm).getByRole('button', { name: 'Go back' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /open visits/i })).toBeNull());
    expect(completeCalls()).toHaveLength(1);
  });

  it('shows no confirmation when the complete goes through', async () => {
    mockApi.post.mockResolvedValueOnce({ data: { job: { ...JOB, status: 'COMPLETED' } } });
    mountWith(ALL_JOB_ACTIONS);

    await pressCompleteJob();

    await waitFor(() => expect(completeCalls()).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: /open visits/i })).toBeNull();
  });

  it('keeps the plain error toast for any other refusal', async () => {
    mockApi.post.mockRejectedValueOnce({ response: { status: 403, data: { error: 'Insufficient permissions' } } });
    mountWith(ALL_JOB_ACTIONS);

    await pressCompleteJob();

    await waitFor(() => expect(completeCalls()).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: /open visits/i })).toBeNull();
  });

  it('offers no Complete job without Complete jobs', async () => {
    mountWith(ALL_JOB_ACTIONS.filter((a) => a !== 'complete'));
    await screen.findByRole('heading', { name: /J00001/ });

    expect(screen.queryByRole('button', { name: /complete job/i })).toBeNull();
  });
});
