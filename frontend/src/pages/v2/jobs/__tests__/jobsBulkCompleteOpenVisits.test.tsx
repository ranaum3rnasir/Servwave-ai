import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import JobsPage from '../JobsPage';

/**
 * Roles & Permissions S04.17 - a bulk Completed over jobs that still have open visits.
 *
 * The server refuses the whole batch (it completes none of the jobs) and names the jobs and their open visits; the
 * Jobs list then shows the confirmation, cancel-and-complete as the default and a way back, and sends the same batch
 * again with the cancel choice only when the person agrees.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mockApi = vi.mocked(api);

const JOB_LIST = {
  jobs: [
    {
      id: 'j0000000-0000-0000-0000-000000000001',
      job_number: 'J00001',
      status: 'SCHEDULED',
      scheduled_start: '2026-07-20T09:00:00.000Z',
      created_at: '2026-07-15T00:00:00.000Z',
      customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, customer_number: 'C00001' },
      assignees: [],
      service_location: null,
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: { unassigned: 2, scheduled: 5, in_progress: 1, completed: 3, cancelled: 1, need_invoices: 4 },
  users: [],
  departments: [],
  tags: [],
};

const OPEN_VISITS_REFUSAL = {
  response: {
    status: 409,
    data: {
      error: 'Some of these jobs still have open visits. Cancel them to complete the jobs.',
      code: 'JOB_COMPLETE_HAS_OPEN_VISITS',
      jobs: [
        {
          id: 'j0000000-0000-0000-0000-000000000001',
          job_number: 'J00001',
          open_visits: [
            { id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: '2026-07-20T09:00:00.000Z', scheduled_end: '2026-07-20T11:00:00.000Z' },
            { id: 'v2', visit_seq: 2, status: 'IN_PROGRESS', scheduled_at: '2026-07-21T09:00:00.000Z', scheduled_end: '2026-07-21T11:00:00.000Z' },
          ],
        },
      ],
    },
  },
};

// What View jobs and Complete jobs grant.
const completer = () => buildAbility([
  { action: 'read', subject: 'Job' },
  { action: 'complete', subject: 'Job' },
]);

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  mockApi.get.mockResolvedValue({ data: JOB_LIST });
});

const bulkCalls = () => mockApi.post.mock.calls.filter(([url]) => url === '/api/jobs/bulk-status');

/** Selects the job, picks Complete job and agrees to the "Complete 1 job?" confirm. */
async function chooseCompleted() {
  renderWithProviders(<JobsPage />, { ability: completer(), initialEntries: ['/jobs'] });
  await screen.findByText('J00001');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select J00001' }));
  await screen.findByText('1 job selected');
  await userEvent.click(screen.getByRole('button', { name: /change status/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Complete job' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Complete job' }));
}

describe('Jobs list bulk Completed over open visits', () => {
  it('lists the open visits per job with cancel-and-complete as the default, after a first request with no cancel choice', async () => {
    mockApi.post.mockRejectedValueOnce(OPEN_VISITS_REFUSAL);

    await chooseCompleted();

    const confirm = await screen.findByRole('dialog', { name: /open visits/i });
    expect(within(confirm).getByText('J00001')).toBeInTheDocument();
    expect(within(confirm).getByText('Visit 1')).toBeInTheDocument();
    expect(within(confirm).getByText('Visit 2')).toBeInTheDocument();
    expect(within(confirm).getByText('In Progress')).toBeInTheDocument();
    expect(within(confirm).getByRole('button', { name: 'Cancel these visits and complete the job' })).toHaveFocus();
    expect(within(confirm).getByRole('button', { name: 'Go back' })).toBeInTheDocument();
    expect(bulkCalls()).toEqual([[
      '/api/jobs/bulk-status',
      { ids: ['j0000000-0000-0000-0000-000000000001'], action: 'complete' },
    ]]);
  });

  it('sends the same batch again with the cancel choice when the person agrees', async () => {
    mockApi.post
      .mockRejectedValueOnce(OPEN_VISITS_REFUSAL)
      .mockResolvedValueOnce({ data: { updated: ['j0000000-0000-0000-0000-000000000001'], failed: [] } });
    await chooseCompleted();
    const confirm = await screen.findByRole('dialog', { name: /open visits/i });

    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel these visits and complete the job' }));

    await waitFor(() => expect(bulkCalls()).toHaveLength(2));
    expect(bulkCalls()[1]).toEqual([
      '/api/jobs/bulk-status',
      { ids: ['j0000000-0000-0000-0000-000000000001'], action: 'complete', cancel_open_visits: true },
    ]);
  });

  it('says "jobs" in the title and on the button when several jobs are selected but only one holds open visits', async () => {
    const second = { ...JOB_LIST.jobs[0], id: 'j0000000-0000-0000-0000-000000000002', job_number: 'J00002' };
    mockApi.get.mockResolvedValue({ data: { ...JOB_LIST, jobs: [...JOB_LIST.jobs, second] } });
    mockApi.post.mockRejectedValueOnce(OPEN_VISITS_REFUSAL);
    renderWithProviders(<JobsPage />, { ability: completer(), initialEntries: ['/jobs'] });
    await screen.findByText('J00002');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select J00001' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select J00002' }));
    await screen.findByText('2 jobs selected');
    await userEvent.click(screen.getByRole('button', { name: /change status/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Complete job' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Complete jobs' }));

    const confirm = await screen.findByRole('dialog', { name: /open visits/i });
    expect(within(confirm).getByText('Some of these jobs still have open visits')).toBeInTheDocument();
    expect(within(confirm).getByRole('button', { name: 'Cancel these visits and complete the jobs' })).toBeInTheDocument();
  });

  it('going back sends nothing more and keeps the selection', async () => {
    mockApi.post.mockRejectedValueOnce(OPEN_VISITS_REFUSAL);
    await chooseCompleted();
    const confirm = await screen.findByRole('dialog', { name: /open visits/i });

    await userEvent.click(within(confirm).getByRole('button', { name: 'Go back' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /open visits/i })).toBeNull());
    expect(bulkCalls()).toHaveLength(1);
    expect(screen.getByText('1 job selected')).toBeInTheDocument();
  });

  it('shows no open-visits confirmation when the batch goes through', async () => {
    mockApi.post.mockResolvedValueOnce({ data: { updated: ['j0000000-0000-0000-0000-000000000001'], failed: [] } });

    await chooseCompleted();

    await waitFor(() => expect(bulkCalls()).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: /open visits/i })).toBeNull();
  });

  it('offers no Complete job to a person without Complete jobs', async () => {
    renderWithProviders(<JobsPage />, { ability: buildAbility([{ action: 'read', subject: 'Job' }]), initialEntries: ['/jobs'] });
    await screen.findByText('J00001');
    expect(screen.queryByRole('button', { name: /change status/i })).toBeNull();
    expect(screen.queryByText('Complete job', { selector: '[role="menuitem"]' })).toBeNull();
  });
});
