/**
 * Roles & Permissions, PRD 6, S06.17 - the routed job page draws no door the server refuses on a Done or Cancelled job.
 *
 * A Done or Cancelled job leaves only through Reopen. The job's own answer carries `status_door_closed_reason` for those
 * statuses ("Reopen this job first"), whoever asks, and the page draws Start, Schedule and Reschedule closed with those
 * words: the browser never judges the status itself. A job whose answer carries no reason keeps every one of them.
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

const JOB_ID = 'j0000000-0000-0000-0000-000000000017';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

// Everything is allowed to this person by role: only the job's own answer decides what the page draws.
const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const REOPEN_FIRST = 'Reopen this job first';

function mountJob(over: Record<string, unknown> = {}) {
  const job = {
    id: JOB_ID, job_number: 'J00017', status: 'CANCELLED', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', started_at: null,
    completed_at: null, cancelled_at: '2026-10-01T00:00:00.000Z', cancelled_reason: null, cancel_reason: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null,
    // A Change locked jobs holder: the lock does not bind them, and the close-out rule still does.
    locked: false, locked_actions: [], actions: ['assign', 'schedule', 'reopen'],
    new_visit_closed_reason: REOPEN_FIRST, status_door_closed_reason: REOPEN_FIRST, ready_to_close: null,
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

describe('the job page on a job whose status doors the server has closed', () => {
  it.each(['CANCELLED', 'DONE'])('offers no Start and no Reschedule tile on a %s job', async (status) => {
    mountJob({ status });
    expect(await screen.findByText('J00017')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reschedule job' })).not.toBeInTheDocument();
    // The lifecycle rail's Scheduled node is no longer a button that opens the schedule dialog.
    expect(screen.queryByRole('button', { name: /Scheduled/ })).not.toBeInTheDocument();
  });

  it.each(['CANCELLED', 'DONE'])('draws Reschedule disabled in the Actions menu of a %s job, with the server\'s words, and keeps Reopen', async (status) => {
    mountJob({ status });
    const user = userEvent.setup();
    await openMenu(user);

    const reschedule = await screen.findByRole('menuitem', { name: /Reschedule/ });
    expect(reschedule).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Reopen Job' })).not.toHaveAttribute('aria-disabled', 'true');
    // The crew-only Assign door is not a status door and stays open to a holder.
    expect(screen.getByRole('menuitem', { name: 'Assign' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps Start, the Reschedule tile and an enabled Reschedule item on a job whose answer carries no reason', async () => {
    mountJob({ status: 'SCHEDULED', cancelled_at: null, status_door_closed_reason: null, new_visit_closed_reason: null, actions: ['assign', 'schedule'] });
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reschedule job' })).toBeInTheDocument();
    const user = userEvent.setup();
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: /Reschedule/ })).not.toHaveAttribute('aria-disabled', 'true');
  });
});
