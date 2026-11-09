import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mountJobDetail, stubBrowser } from './harness/jobDetailPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock('react-router-dom', async () => (await import('./harness/jobDetailRouter')).jobDetailRouter());

stubBrowser();

// Everything is allowed to this person by role: only the job's own answer decides what the page draws.

const NEEDS_COMPLETE = 'Only someone who can complete jobs can move this job out of office review.';

function mountJob(over: Record<string, unknown> = {}) {
  return mountJobDetail({
    job: {
      job_number: 'J00018', status: 'OFFICE_REVIEW', completed_at: '2026-10-02T16:00:00.000Z',
      locked: true, locked_actions: ['assign', 'schedule'], actions: [],
      new_visit_closed_reason: 'Move this job back out of review first', status_door_closed_reason: null, backward_move_open: true, ready_to_close: null,
      ...over,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubBrowser();
});

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Actions' }));
}

describe.each(['OFFICE_REVIEW', 'READY_TO_CLOSE'])('the job page on a %s job, for a person who may move it back', (status) => {
  it('draws Reschedule open and Assign behind the lock', async () => {
    mountJob({ status });
    expect(await screen.findByText('J00018')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Reschedule job' })).toBeInTheDocument();

    const user = userEvent.setup();
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: /Reschedule/ })).not.toHaveAttribute('aria-disabled', 'true');
    // The crew-only Assign door is not a backward move: the lock still holds it.
    expect(screen.getByRole('menuitem', { name: /^Assign/ })).toHaveAttribute('aria-disabled', 'true');
  });

  it('offers Start on a job with no visits, as the backward move the server said is open', async () => {
    mountJob({ status });
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
  });
});

describe.each(['OFFICE_REVIEW', 'READY_TO_CLOSE'])('the job page on a %s job, for a person who cannot complete jobs', (status) => {
  // A Change locked jobs holder without Complete jobs: the lock does not bind them, and the close-out rule still does.
  const closed = { status, locked: false, locked_actions: [], actions: ['assign', 'schedule'], status_door_closed_reason: NEEDS_COMPLETE, backward_move_open: false };

  it('offers no Start and no Reschedule tile', async () => {
    mountJob(closed);
    expect(await screen.findByText('J00018')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reschedule job' })).not.toBeInTheDocument();
  });

  it('draws Reschedule disabled with the server\'s words and keeps Assign open', async () => {
    mountJob(closed);
    const user = userEvent.setup();
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: /Reschedule/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Assign' })).not.toHaveAttribute('aria-disabled', 'true');
  });
});

describe('the job page keeps the completed-job lock for a person the server has not opened the move back to', () => {
  it('offers no Start on a job in review whose answer does not open the backward move', async () => {
    mountJob({ backward_move_open: false, status_door_closed_reason: null });
    expect(await screen.findByText('J00018')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });
});
