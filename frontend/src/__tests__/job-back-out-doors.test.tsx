/**
 * Roles & Permissions, PRD 6, S06.18 - the routed job page offers the backward move out of Office review and Ready to close
 * from what the server says, and never judges the status itself.
 *
 * A backward move needs the door's own switch AND Complete jobs. The job's own answer carries `backward_move_open` for a
 * person who may make it (the completed-job lock does not bind it, so Start, Schedule and Reschedule are drawn open although the
 * lock withholds Assign) and `status_door_closed_reason` for a person who may not (the PRD's sentence, drawn beside the
 * closed controls).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

const JOB_ID = 'j0000000-0000-0000-0000-000000000018';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

// Everything is allowed to this person by role: only the job's own answer decides what the page draws.
const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const NEEDS_COMPLETE = 'Only someone who can complete jobs can move this job out of office review.';

function mountJob(over: Record<string, unknown> = {}) {
  const job = {
    id: JOB_ID, job_number: 'J00018', status: 'OFFICE_REVIEW', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', started_at: null,
    completed_at: '2026-10-02T16:00:00.000Z', cancelled_at: null, cancelled_reason: null, cancel_reason: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null,
    locked: true, locked_actions: ['assign', 'schedule'], actions: [],
    new_visit_closed_reason: 'Move this job back out of review first', status_door_closed_reason: null, backward_move_open: true, ready_to_close: null,
    ...over,
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/visits`) return { data: { visits: [] } } as never;
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } } as never;
    return { data: {} } as never;
  });
  return renderWithProviders(<JobDetailPage />, { ability });
}

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
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
