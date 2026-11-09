import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JOB_ID, mountJobDetail, stubBrowser } from './harness/jobDetailPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock('react-router-dom', async () => (await import('./harness/jobDetailRouter')).jobDetailRouter());

stubBrowser();

describe('a job whose status doors the server has closed', () => {
// Everything is allowed to this person by role: only the job's own answer decides what the page draws.

const REOPEN_FIRST = 'Reopen this job first';

function mountJob(over: Record<string, unknown> = {}) {
  return mountJobDetail({
    job: {
      job_number: 'J00017', status: 'CANCELLED', cancelled_at: '2026-10-01T00:00:00.000Z',
      // A Change locked jobs holder: the lock does not bind them, and the close-out rule still does.
      locked: false, locked_actions: [], actions: ['assign', 'schedule', 'reopen'],
      new_visit_closed_reason: REOPEN_FIRST, status_door_closed_reason: REOPEN_FIRST, ready_to_close: null,
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
});

describe('Add visit on a closed or locked job', () => {
/** The PRD's own wording, written out here rather than imported from the page. */
const REOPEN_FIRST = 'Reopen this job first';
const BACK_OUT_FIRST = 'Move this job back out of review first';
const LOCK_REASON = 'This job is locked. Only someone who can change locked jobs can change it.';

const VISIT = {
  id: `${JOB_ID}-v1`, visit_seq: 1, status: 'SCHEDULED', purpose: 'WORK',
  scheduled_at: '2026-08-21T13:00:00.000Z', scheduled_end: '2026-08-21T15:00:00.000Z', is_all_day: false,
  en_route_at: null, on_site_at: null, started_at: null, completed_at: null, cancelled_at: null,
  customer_email_sent_at: null, notes: null, status_steps: [], assignees: [],
};

function mount(overrides: Record<string, unknown>) {
  return mountJobDetail({
    job: {
      job_number: 'J00002', status: 'COMPLETED', scheduled_start: '2026-08-21T13:00:00.000Z', scheduled_end: '2026-08-21T15:00:00.000Z',
      completed_at: '2026-08-22T13:00:00.000Z', created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
      visits: [VISIT],
      ...overrides,
    },
    visits: [VISIT],
  });
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
});
