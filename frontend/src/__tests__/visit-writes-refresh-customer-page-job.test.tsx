/**
 * Every visit write made from the JOB page refreshes the customer page (visits-and-task-categories
 * slice 01).
 *
 * The customer page caches its detail, leads and calendar queries for the app-wide five-minute
 * staleTime, and no visit write used to touch them: a job booked seconds ago read "Unscheduled"
 * on the customer page until a reload. Each test seeds the customer page's queries, performs one
 * visit write through the real surface that makes it, and asserts those queries are stale - so
 * navigating back to the customer page refetches them.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { expectCustomerPageStale, seedCustomerPage } from '@/__tests__/support/customerPageCache';
import { VisitScheduleDialog } from '@/pages/v2/jobs/components/visitScheduleDialog';
import { AssignJobDialog } from '@/components/jobs/AssignJobDialog';
import { CancelJobDialog } from '@/components/jobs/CancelJobDialog';
import { useVisitLifecycle, type VisitLifecycleVars } from '@/lib/useVisitLifecycle';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { BulkBar } from '@/pages/v2/jobs/components/bulkBar';

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useParams: () => ({ id: 'j0000000-0000-0000-0000-000000000001' }),
  useNavigate: () => vi.fn(),
}));

// floating-ui (under the Radix menus) constructs a ResizeObserver; the global setup mock is not
// constructable.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const post = vi.mocked(api.post);
const patch = vi.mocked(api.patch);
const get = vi.mocked(api.get);

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: {} });
  patch.mockResolvedValue({ data: {} });
  get.mockResolvedValue({ data: {} });
});

/** Fills the four required schedule fields so the dialog's save button is enabled. */
async function fillWindow(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Start date'), '10/02/2026');
  await user.tab();
  await user.type(screen.getByLabelText('Start time'), '9:00 AM');
  await user.tab();
  await user.type(screen.getByLabelText('End date'), '10/02/2026');
  await user.tab();
  await user.type(screen.getByLabelText('End time'), '11:00 AM');
  await user.tab();
}

describe('the job page "Add Visit" / "Reschedule Visit" dialog', () => {
  it('booking a visit marks the customer page stale', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(
      <VisitScheduleDialog open onOpenChange={() => {}} jobId="job-1" canAssignCrew={false} />,
    );
    seedCustomerPage(queryClient);

    await fillWindow(user);
    await user.click(screen.getByRole('button', { name: 'Book visit' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/jobs/job-1/visits', expect.anything()));
    await expectCustomerPageStale(queryClient);
  });

  it('rescheduling a visit marks the customer page stale', async () => {
    const user = userEvent.setup();
    const visit = {
      id: 'visit-2',
      visit_seq: 2,
      status: 'SCHEDULED',
      scheduled_at: '2026-10-02T13:00:00.000Z',
      scheduled_end: '2026-10-02T15:00:00.000Z',
      is_all_day: false,
      assignees: [],
    } as unknown as Parameters<typeof VisitScheduleDialog>[0]['visit'];
    const { queryClient } = renderWithProviders(
      <VisitScheduleDialog open onOpenChange={() => {}} jobId="job-1" visit={visit} canAssignCrew={false} />,
    );
    seedCustomerPage(queryClient);

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/jobs/job-1/visits/visit-2', expect.anything()));
    await expectCustomerPageStale(queryClient);
  });
});

describe('the assign-job dialog', () => {
  it('scheduling a job marks the customer page stale', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(
      <AssignJobDialog
        open
        onOpenChange={() => {}}
        jobId="job-3"
        mode="schedule"
        defaultStart="2026-10-02T13:00:00.000Z"
        defaultEnd="2026-10-02T15:00:00.000Z"
      />,
    );
    seedCustomerPage(queryClient);

    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/jobs/job-3/assign', expect.anything()));
    await expectCustomerPageStale(queryClient);
  });

  it('"Schedule Anyway" past a conflict marks the customer page stale too', async () => {
    const user = userEvent.setup();
    post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Scheduling conflict' } } });
    const { queryClient } = renderWithProviders(
      <AssignJobDialog
        open
        onOpenChange={() => {}}
        jobId="job-3"
        mode="schedule"
        defaultStart="2026-10-02T13:00:00.000Z"
        defaultEnd="2026-10-02T15:00:00.000Z"
      />,
    );
    seedCustomerPage(queryClient);

    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));
    await user.click(await screen.findByRole('button', { name: /anyway/i }));

    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith('/api/jobs/job-3/assign', expect.objectContaining({ force: true })),
    );
    await expectCustomerPageStale(queryClient);
  });
});

describe('cancelling the job', () => {
  it('marks the customer page stale (it cancels every live visit with it)', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(
      <CancelJobDialog open onOpenChange={() => {}} jobId="job-4" />,
    );
    seedCustomerPage(queryClient);

    await user.type(screen.getByPlaceholderText('Why is this job being cancelled?'), 'Customer moved');
    await user.click(screen.getByRole('button', { name: 'Cancel Job' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/jobs/job-4/cancel', expect.anything()));
    await expectCustomerPageStale(queryClient);
  });
});

describe('the Visits card lifecycle steps', () => {
  const steps: VisitLifecycleVars[] = [
    { visitId: 'visit-1', action: 'en-route' },
    { visitId: 'visit-1', action: 'arrive' },
    { visitId: 'visit-1', action: 'start' },
    { visitId: 'visit-1', action: 'complete' },
    { visitId: 'visit-1', action: 'cancel', cancelled_reason: 'Rained out' },
  ];

  it.each(steps)('"$action" marks the customer page stale', async (vars) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCustomerPage(queryClient);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useVisitLifecycle('job-5'), { wrapper });

    await result.current.mutateAsync(vars);

    expect(post.mock.calls[0]?.[0]).toBe(`/api/jobs/job-5/visits/visit-1/${vars.action}`);
    await expectCustomerPageStale(queryClient);
  });
});

describe('the job page header', () => {
  it('"Mark Complete" marks the customer page stale (it completes the job\'s visits)', async () => {
    get.mockImplementation(async (url: string) =>
      url === `/api/jobs/${JOB_ID}`
        ? {
            data: {
              job: {
                id: JOB_ID, job_number: 'J00001', status: 'IN_PROGRESS',
                customer: { id: 'cust-1', first_name: 'Pat', last_name: 'Sample', company_name: null },
                assignees: [], invoices: [], linked_estimates: [], tags: [],
                created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
              },
            },
          }
        : { data: {} },
    );
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<JobDetailPage />, {
      ability: buildAbility([{ action: 'manage', subject: 'all' }]),
    });
    seedCustomerPage(queryClient);

    await user.click(await screen.findByRole('button', { name: /Mark Complete/ }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/complete`));
    await expectCustomerPageStale(queryClient);
  });
});

describe('the jobs list bulk actions (they write every selected job\'s visits)', () => {
  const SELECTED = ['job-6', 'job-7'];

  function renderBulkBar() {
    post.mockResolvedValue({ data: { updated: SELECTED, failed: [] } });
    const utils = renderWithProviders(
      <BulkBar
        selectedJobIds={SELECTED}
        onClear={() => {}}
        assignees={[{ id: 'tech-1', first_name: 'Terry', last_name: 'Tech' }]}
      />,
      { ability: buildAbility([{ action: 'manage', subject: 'all' }]) },
    );
    seedCustomerPage(utils.queryClient);
    return utils.queryClient;
  }

  it('a bulk status change (Completed) marks the customer page stale', async () => {
    const user = userEvent.setup();
    const queryClient = renderBulkBar();

    await user.click(screen.getByRole('button', { name: 'Change status' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Completed' }));
    await user.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/jobs/bulk-status', { ids: SELECTED, action: 'complete' }),
    );
    await expectCustomerPageStale(queryClient);
  });

  it('a bulk cancel marks the customer page stale', async () => {
    const user = userEvent.setup();
    const queryClient = renderBulkBar();

    await user.click(screen.getByRole('button', { name: 'Change status' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancelled' }));
    await user.type(await screen.findByPlaceholderText('Why are these jobs being cancelled?'), 'Season over');
    await user.click(screen.getByRole('button', { name: 'Cancel Job' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/jobs/bulk-status', expect.objectContaining({ ids: SELECTED, action: 'cancel' })),
    );
    await expectCustomerPageStale(queryClient);
  });

  it('a bulk crew assign marks the customer page stale', async () => {
    const user = userEvent.setup();
    const queryClient = renderBulkBar();

    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await user.click(await screen.findByRole('option', { name: 'Terry Tech' }));
    const confirmDialog = (await screen.findByText('Assign 1 technician to 2 jobs?'))
      .closest<HTMLElement>('[role="alertdialog"],[role="dialog"]')!;
    await user.click(within(confirmDialog).getByRole('button', { name: 'Assign' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/jobs/bulk-assign', { ids: SELECTED, assignee_ids: ['tech-1'] }),
    );
    await expectCustomerPageStale(queryClient);
  });
});
