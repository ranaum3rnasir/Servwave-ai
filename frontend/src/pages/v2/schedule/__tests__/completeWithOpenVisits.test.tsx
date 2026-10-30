/**
 * Roles & Permissions, PRD 4, slice S04.17 - "Complete job" on the routed Schedule page when the job still has open
 * visits.
 *
 * The job-level complete never finishes a visit. The server refuses it while a visit is open unless the request says
 * to cancel them, so the board holds the refusal, shows a confirmation that lists the open visits with
 * cancel-and-complete as the default and a way back, and sends the complete again with that choice only when the
 * person agrees. The page is the routed one (`pages/v2/schedule/SchedulePage`); what is asserted is what a person
 * sees and what the board sends to the server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { addDays, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { toast } from '@/ui-kit/components/ui/sonner';
import SchedulePage from '../SchedulePage';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);

// What View jobs, View leads, View events and Complete jobs grant: enough to open the board and complete a job.
const VIEW_AND_COMPLETE: AbilityRule[] = [
  { action: 'read', subject: 'Job' },
  { action: 'read', subject: 'Lead' },
  { action: 'read', subject: 'CalendarEntry' },
  { action: 'complete', subject: 'Job' },
];

const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0)).toISOString();
}

const BOB = { id: 'm-bob', first_name: 'Bob', last_name: 'Ode', phone: null };
const CUSTOMER = { first_name: 'Pat', last_name: 'Sample', company_name: 'Sample Co', email: 'pat@example.test' };

const SCHEDULED_JOB = {
  id: 'job-1',
  job_number: 'J00044',
  status: 'SCHEDULED',
  scope_notes: 'Gate operator swap',
  customer: CUSTOMER,
  assignees: [{ user: BOB }],
  tags: [],
  scheduled_start: dayAt(3),
  scheduled_end: dayAt(3, 16),
  visits: [
    { id: 'v2', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(3), scheduled_end: dayAt(3, 16), is_all_day: false, assignees: [{ user_id: BOB.id, user: BOB }] },
  ],
};

/** The server's refusal of a complete over open visits (visit 2 booked, visit 3 on site). */
const OPEN_VISITS_REFUSAL = {
  response: {
    status: 409,
    data: {
      error: 'This job still has open visits. Cancel them to complete the job.',
      code: 'JOB_COMPLETE_HAS_OPEN_VISITS',
      open_visits: [
        { id: 'v2', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(3), scheduled_end: dayAt(3, 16) },
        { id: 'v3', visit_seq: 3, status: 'ON_SITE', scheduled_at: dayAt(4), scheduled_end: dayAt(4, 16) },
      ],
    },
  },
};

/** The job the board is showing; a case swaps it to put the job in another status. */
let boardJob: typeof SCHEDULED_JOB = SCHEDULED_JOB;

function mockBoard() {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/jobs') return Promise.resolve({ data: { jobs: [boardJob] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({ data: { users: [{ ...BOB, is_active: true, role: 'TECHNICIAN' }] } });
    }
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    if (url === '/api/calendar-entries') return Promise.resolve({ data: { calendar_entries: [] } });
    return Promise.resolve({ data: {} });
  });
  mockApi.patch.mockResolvedValue({ data: {} });
}

async function mountBoard(rules: AbilityRule[] = VIEW_AND_COMPLETE) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { id: 'u-viewer', email: 'viewer@test.com', first_name: 'Vic', last_name: 'Viewer', role: 'CUSTOM_ROLE' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
  mockBoard();
  const view = renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: buildAbility(rules), initialEntries: ['/schedule'] },
  );
  await screen.findAllByText(/J00044/);
  await waitFor(() => expect(view.container.querySelector('.schedule-cal .animate-spin')).toBeNull());
  return view;
}

/** Clicks the job's card: its peek card opens, and "Open" in it opens the editor. */
async function openEditor(): Promise<HTMLElement> {
  fireEvent.click(screen.getAllByText(/J00044/)[0]!);
  const peek = await screen.findByRole('dialog');
  fireEvent.click(within(peek).getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(within(document.body).queryByRole('button', { name: 'Open' })).toBeNull());
  return screen.findByRole('dialog');
}

const completeCalls = () => mockApi.post.mock.calls.filter(([url]) => url === '/api/jobs/job-1/complete');

beforeEach(() => {
  vi.clearAllMocks();
  boardJob = SCHEDULED_JOB;
  localStorage.clear();
  sessionStorage.clear();
});

describe('Complete job on the board for a job with open visits', () => {
  it('shows the open visits with cancel-and-complete as the default, and completes nothing yet', async () => {
    mockApi.post.mockRejectedValueOnce(OPEN_VISITS_REFUSAL);
    await mountBoard();
    const editor = await openEditor();

    fireEvent.click(within(editor).getByRole('button', { name: /Complete job/ }));

    const confirm = await screen.findByRole('dialog', { name: /open visits/i });
    expect(within(confirm).getByText('Visit 2')).toBeInTheDocument();
    expect(within(confirm).getByText('Visit 3')).toBeInTheDocument();
    expect(within(confirm).getByText('Scheduled')).toBeInTheDocument();
    expect(within(confirm).getByText('On Site')).toBeInTheDocument();
    // Cancel-and-complete is the default action; going back is always there.
    const confirmButton = within(confirm).getByRole('button', { name: 'Cancel these visits and complete the job' });
    expect(confirmButton).toHaveFocus();
    expect(within(confirm).getByRole('button', { name: 'Go back' })).toBeInTheDocument();
    // The first request said nothing about cancelling, and nothing was sent after it.
    expect(completeCalls()).toEqual([['/api/jobs/job-1/complete']]);
  });

  it('sends the complete again with the cancel choice when the person agrees', async () => {
    mockApi.post.mockRejectedValueOnce(OPEN_VISITS_REFUSAL).mockResolvedValueOnce({ data: {} });
    await mountBoard();
    const editor = await openEditor();
    fireEvent.click(within(editor).getByRole('button', { name: /Complete job/ }));
    const confirm = await screen.findByRole('dialog', { name: /open visits/i });

    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel these visits and complete the job' }));

    await waitFor(() => expect(completeCalls()).toHaveLength(2));
    expect(completeCalls()[1]).toEqual(['/api/jobs/job-1/complete', { cancel_open_visits: true }]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /open visits/i })).toBeNull());
  });

  it('going back sends nothing more', async () => {
    mockApi.post.mockRejectedValueOnce(OPEN_VISITS_REFUSAL);
    await mountBoard();
    const editor = await openEditor();
    fireEvent.click(within(editor).getByRole('button', { name: /Complete job/ }));
    const confirm = await screen.findByRole('dialog', { name: /open visits/i });

    fireEvent.click(within(confirm).getByRole('button', { name: 'Go back' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /open visits/i })).toBeNull());
    expect(completeCalls()).toHaveLength(1);
  });

  it('shows no confirmation when the complete goes through', async () => {
    mockApi.post.mockResolvedValueOnce({ data: {} });
    await mountBoard();
    const editor = await openEditor();

    fireEvent.click(within(editor).getByRole('button', { name: /Complete job/ }));

    await waitFor(() => expect(completeCalls()).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: /open visits/i })).toBeNull();
  });

  it('offers no Complete job at all without Complete jobs', async () => {
    await mountBoard(VIEW_AND_COMPLETE.filter((r) => r.action !== 'complete'));
    await openEditor();

    expect(screen.queryByRole('button', { name: /Complete job/ })).toBeNull();
  });
});

describe('Complete job on the board lands the job in office review (PRD 6, S06.1)', () => {
  it('says "Job completed" when the complete goes through', async () => {
    mockApi.post.mockResolvedValueOnce({ data: {} });
    await mountBoard();
    const editor = await openEditor();

    fireEvent.click(within(editor).getByRole('button', { name: /Complete job/ }));

    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith('Job completed', expect.anything()));
    expect(screen.queryByText(/mark complete/i)).toBeNull();
  });

  it('asks the server for the close-out statuses too, so a completed job\'s trips stay on the board', async () => {
    await mountBoard();

    const jobsRequest = mockApi.get.mock.calls.find(([url]) => url === '/api/jobs');
    expect((jobsRequest![1] as { params: { status: string[] } }).params.status).toEqual(
      expect.arrayContaining(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE']),
    );
  });

  it.each(['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'CANCELLED'])(
    'offers no Complete job on a %s job, even to a holder of Complete jobs',
    async (status) => {
      boardJob = { ...SCHEDULED_JOB, status };
      await mountBoard();
      await openEditor();

      expect(screen.queryByRole('button', { name: /Complete job/ })).toBeNull();
    },
  );
});
