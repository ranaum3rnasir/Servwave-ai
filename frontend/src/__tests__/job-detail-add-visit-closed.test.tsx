/**
 * Roles & Permissions, PRD 4, S04.23 and PRD 6, S06.4 - no new visit on a locked job, on the routed job page.
 *
 * GET /api/jobs/:id answers `new_visit_closed_reason`: the words, set while the job is locked (Completed or later, or
 * Cancelled), for everyone, a person who can change locked jobs included. The Visits tab then draws Add visit disabled
 * with exactly those words and never judges the status itself: "Reopen this job first", or in Office review and Ready to
 * close "Move this job back out of review first". The rest of the lock (existing visits, details, people) is a separate
 * answer and is left as it was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

const JOB_ID = 'j0000000-0000-0000-0000-000000000002';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

/** The PRD's own wording, written out here rather than imported from the page. */
const REOPEN_FIRST = 'Reopen this job first';
const BACK_OUT_FIRST = 'Move this job back out of review first';
const LOCK_REASON = 'This job is locked. Only someone who can change locked jobs can change it.';

const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const VISIT = {
  id: `${JOB_ID}-v1`, visit_seq: 1, status: 'SCHEDULED', purpose: 'WORK',
  scheduled_at: '2026-08-21T13:00:00.000Z', scheduled_end: '2026-08-21T15:00:00.000Z', is_all_day: false,
  en_route_at: null, on_site_at: null, started_at: null, completed_at: null, cancelled_at: null,
  customer_email_sent_at: null, notes: null, status_steps: [], assignees: [],
};

function mount(overrides: Record<string, unknown>) {
  const job = {
    id: JOB_ID, job_number: 'J00002', status: 'COMPLETED', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-08-21T13:00:00.000Z', scheduled_end: '2026-08-21T15:00:00.000Z', started_at: null,
    completed_at: '2026-08-22T13:00:00.000Z', cancelled_at: null, cancelled_reason: null,
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [VISIT], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null,
    ...overrides,
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/visits`) return { data: { visits: [VISIT] } } as never;
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } } as never;
    return { data: {} } as never;
  });
  return renderWithProviders(<JobDetailPage />, { ability });
}

async function openVisits() {
  await screen.findByText('J00002');
  await userEvent.setup().click(screen.getByRole('tab', { name: /visits/i }));
  return screen.findByRole('button', { name: 'Add visit' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Add visit on the routed job page', () => {
  it('is disabled with "Reopen this job first" for a person who can change locked jobs', async () => {
    // The lock is lifted for them (locked false, Schedule visits still listed); a new visit is still closed.
    mount({ locked: false, locked_actions: [], actions: ['schedule', 'edit'], new_visit_closed_reason: REOPEN_FIRST });
    const addVisit = await openVisits();
    expect(addVisit).toBeDisabled();
    expect(addVisit).toHaveAccessibleDescription(REOPEN_FIRST);
    // Their other visit controls are left alone: only the new visit is closed.
    expect(within(await screen.findByRole('group', { name: 'Office actions' })).getByRole('button', { name: 'Reschedule' })).toBeEnabled();
  });

  it('is disabled with "Reopen this job first", not the lock words, for a person the lock also holds back', async () => {
    mount({ locked: true, locked_actions: ['schedule'], actions: [], new_visit_closed_reason: REOPEN_FIRST });
    const addVisit = await openVisits();
    expect(addVisit).toBeDisabled();
    expect(addVisit).toHaveAccessibleDescription(REOPEN_FIRST);
    // Existing visits keep the lock's own reason.
    const office = await screen.findByRole('group', { name: 'Office actions' });
    expect(within(office).getByRole('button', { name: 'Reschedule' })).toHaveAccessibleDescription(LOCK_REASON);
  });

  it.each([
    ['OFFICE_REVIEW', BACK_OUT_FIRST],
    ['READY_TO_CLOSE', BACK_OUT_FIRST],
    ['DONE', REOPEN_FIRST],
  ])('is disabled with the server\'s words on a %s job, whoever asks', async (status, words) => {
    mount({ status, locked: false, locked_actions: [], actions: ['schedule'], new_visit_closed_reason: words });
    const addVisit = await openVisits();
    expect(addVisit).toBeDisabled();
    expect(addVisit).toHaveAccessibleDescription(words);
  });

  it('draws the words the server sent, not ones it works out from the status', async () => {
    mount({ status: 'OFFICE_REVIEW', locked: false, locked_actions: [], actions: ['schedule'], new_visit_closed_reason: 'Words from the server' });
    expect(await openVisits()).toHaveAccessibleDescription('Words from the server');
  });

  it('is not drawn at all for a person who cannot schedule visits, even though the job is closed to a new visit', async () => {
    mount({ locked: false, locked_actions: [], actions: [], new_visit_closed_reason: REOPEN_FIRST });
    await screen.findByText('J00002');
    await userEvent.setup().click(screen.getByRole('tab', { name: /visits/i }));
    await screen.findAllByText(/visit 1/i);
    expect(screen.queryByRole('button', { name: 'Add visit' })).not.toBeInTheDocument();
  });

  it('is enabled once the job is open again', async () => {
    mount({ status: 'IN_PROGRESS', locked: false, locked_actions: [], actions: ['schedule'], new_visit_closed_reason: null });
    expect(await openVisits()).toBeEnabled();
  });
});
