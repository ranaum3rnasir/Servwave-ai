import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';
import { JOB_ID, mountJobDetail, stubBrowser } from './harness/jobDetailPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock('react-router-dom', async () => (await import('./harness/jobDetailRouter')).jobDetailRouter());

stubBrowser();

// Everything is allowed to this person by role: only the job's own list decides what the page draws.
const mockApi = vi.mocked(api);

const VISIT = {
  id: `${JOB_ID}-v1`, visit_seq: 1, status: 'CANCELLED', purpose: 'WORK',
  scheduled_at: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', is_all_day: false,
  en_route_at: null, on_site_at: null, started_at: null, completed_at: null, cancelled_at: '2026-10-01T00:00:00.000Z',
  customer_email_sent_at: null, notes: null, status_steps: [], assignees: [],
};

function mountJob(over: Record<string, unknown> = {}) {
  return mountJobDetail({
    job: {
      job_number: 'J00016', status: 'DONE', completed_at: '2026-10-02T15:00:00.000Z', visits: [VISIT],
      locked: true, locked_actions: [], actions: ['reopen'], new_visit_closed_reason: 'Reopen this job first', ready_to_close: null,
      ...over,
    },
    visits: [VISIT],
  });
}

const reopenCalls = () => mockApi.post.mock.calls.filter(([url]) => String(url).endsWith('/reopen'));
const jobReads = () => mockApi.get.mock.calls.filter(([url]) => url === `/api/jobs/${JOB_ID}`);

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Actions' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  stubBrowser();
  mockApi.post.mockResolvedValue({ data: { job: {} } } as never);
});

describe('Reopen in the job page overflow menu', () => {
  it.each(['DONE', 'CANCELLED'])('is offered on a %s job when the job\'s own list says so, and sends the reopen', async (status) => {
    mountJob({ status, cancelled_at: status === 'CANCELLED' ? '2026-10-01T00:00:00.000Z' : null });
    const user = userEvent.setup();
    await openMenu(user);

    await user.click(await screen.findByRole('menuitem', { name: 'Reopen Job' }));

    await waitFor(() => expect(reopenCalls()).toHaveLength(1));
    expect(reopenCalls()[0]![0]).toBe(`/api/jobs/${JOB_ID}/reopen`);
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith('Job reopened'));
  });

  it.each(['DONE', 'CANCELLED', 'COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'IN_PROGRESS'])(
    'judges no status itself: a %s job whose list does not carry reopen shows no Reopen, whatever the person\'s role abilities',
    async (status) => {
      mountJob({ status, actions: ['duplicate'] });
      const user = userEvent.setup();
      await openMenu(user);
      expect(await screen.findByRole('menuitem', { name: 'Duplicate Job' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Reopen Job' })).not.toBeInTheDocument();
    },
  );

  it('shows the server\'s refusal as it was written and reads the job again when the reopen is refused', async () => {
    const refusal = 'This job is not closed, so there is nothing to reopen.';
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: refusal, code: 'JOB_CLOSE_OUT_REFUSED' } }, isAxiosError: true });
    mountJob();
    const user = userEvent.setup();
    await openMenu(user);
    const readsBefore = jobReads().length;

    await user.click(await screen.findByRole('menuitem', { name: 'Reopen Job' }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    await waitFor(() => expect(jobReads().length).toBeGreaterThan(readsBefore));
  });
});
