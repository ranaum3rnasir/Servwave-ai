import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { toast } from '@/ui-kit/components/ui/sonner';
import { renderWithProviders } from '@/__tests__/helpers';

import JobsPage from '../JobsPage';

/**
 * Roles & Permissions, PRD 6, S06.17 - bulk start and bulk arrive on a Cancelled job.
 *
 * The Jobs list cannot know which selected jobs are closed (it holds no per-job answer), so the server is the check: it
 * lists a Done or Cancelled job as failed with "Reopen this job first" and the bar reports the reason as the server wrote it.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

const mockApi = vi.mocked(api);
const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

const JOB_LIST = {
  jobs: [
    {
      id: JOB_ID, job_number: 'J00001', status: 'CANCELLED', scheduled_start: '2026-07-20T09:00:00.000Z',
      created_at: '2026-07-15T00:00:00.000Z',
      customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, customer_number: 'C00001' },
      assignees: [], service_location: null,
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: { unassigned: 0, scheduled: 0, in_progress: 0, completed: 0, cancelled: 1, need_invoices: 0 },
  users: [], departments: [], tags: [],
};

// A person who holds every bulk status switch: only the server decides what happens to the closed job.
const ability = buildAbility([
  { action: 'read', subject: 'Job' },
  { action: 'arrive', subject: 'Job' },
  { action: 'start', subject: 'Job' },
  { action: 'update_any_visit_status', subject: 'Job' },
]);

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  mockApi.get.mockResolvedValue({ data: JOB_LIST });
  mockApi.post.mockResolvedValue({
    data: { updated: [], failed: [{ id: JOB_ID, error: 'Reopen this job first', code: 'JOB_CLOSE_OUT_REFUSED' }] },
  } as never);
});

describe('bulk start and bulk arrive on a Cancelled job', () => {
  it.each([['In progress', 'start'], ['On site', 'arrive']])('reports the server\'s "Reopen this job first" for %s', async (label, action) => {
    renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
    await screen.findByText('J00001');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select J00001' }));
    await screen.findByText('1 job selected');
    await userEvent.click(screen.getByRole('button', { name: /change status/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: label }));
    await userEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/bulk-status', { ids: [JOB_ID], action }));
    await waitFor(() =>
      expect(vi.mocked(toast)).toHaveBeenCalledWith(
        'Some jobs could not be updated',
        { description: expect.stringContaining('Reopen this job first') },
      ),
    );
  });
});
