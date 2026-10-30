/**
 * Roles & Permissions, PRD 6, S06.1 - the routed job page's Complete job control.
 *
 * It follows the server's per-record list alone (`job.actions`): shown on a job that can still be completed to a holder
 * of Complete jobs, never on a job already in Office review, Ready to close, Done or Cancelled (the server leaves
 * `complete` off its list there), and never to someone without the switch. Pressing it completes the job and the toast
 * reads "Job completed". The phone dock carries the same control. Nothing on the page reads "Mark Complete".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { toast } from '@/ui-kit/components/ui/sonner';
import { renderWithProviders, ALL_JOB_ACTIONS } from '@/__tests__/helpers';

import JobDetailPage from '../JobDetailPage';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

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

const JOB = {
  id: JOB_ID,
  job_number: 'J00001',
  status: 'IN_PROGRESS',
  job_type: 'HVAC Installation',
  description: 'Replace the rooftop unit',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null,
  scheduled_end: null,
  started_at: '2026-09-05T13:00:00.000Z',
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
  visits: [],
  service_location: { id: 'l-1', address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
  estimate: null,
  invoices: [],
  linked_estimates: [],
  tags: [],
  source_plan_id: null,
  source_plan: null,
  actions: [] as string[],
};

function mountJob(overrides: Partial<typeof JOB>) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { id: 'u-me', email: 'me@x.test', first_name: 'Me', last_name: 'Person', role: 'CUSTOM_ROLE' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
  const job = { ...JOB, ...overrides };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/visits')) return { data: { visits: [] } };
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('job page - Complete job', () => {
  it('reads "Complete job" and, once pressed, completes the job and says "Job completed"', async () => {
    mockApi.post.mockResolvedValueOnce({ data: { job: { ...JOB, status: 'OFFICE_REVIEW' } } });
    mountJob({ actions: ALL_JOB_ACTIONS });

    await userEvent.click(await screen.findByRole('button', { name: 'Complete job' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/complete`));
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith('Job completed'));
    expect(screen.queryByText(/mark complete/i)).toBeNull();
  });

  it.each(['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'CANCELLED'])(
    'shows no Complete job on a %s job, because the server leaves it off the list there',
    async (status) => {
      // The person holds every other action; the server's list for a job past Complete carries no `complete`.
      mountJob({ status, actions: ALL_JOB_ACTIONS.filter((a) => a !== 'complete') });
      await screen.findByRole('heading', { name: /J00001/ });

      expect(screen.queryByRole('button', { name: /complete job/i })).toBeNull();
    },
  );

  it('shows no Complete job to a person without Complete jobs, whatever the job\'s status', async () => {
    mountJob({ status: 'SCHEDULED', actions: ALL_JOB_ACTIONS.filter((a) => a !== 'complete') });
    await screen.findByRole('heading', { name: /J00001/ });

    expect(screen.queryByRole('button', { name: /complete job/i })).toBeNull();
  });

  it('follows the list, not the status: a listed complete shows the control on any status it is listed for', async () => {
    mountJob({ status: 'UNSCHEDULED', actions: ['complete'] });

    expect(await screen.findByRole('button', { name: 'Complete job' })).toBeInTheDocument();
  });

  it('carries an Office review job\'s status chip under its own name', async () => {
    mountJob({ status: 'OFFICE_REVIEW', actions: [] });
    await screen.findByRole('heading', { name: /J00001/ });

    expect(screen.getAllByText('Office review').length).toBeGreaterThan(0);
  });
});
