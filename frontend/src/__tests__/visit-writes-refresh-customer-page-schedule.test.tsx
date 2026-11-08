/**
 * Every visit write made from the SCHEDULER board refreshes the customer page
 * (visits-and-task-categories slice 01). See the job-page suite beside this one for the defect.
 *
 * Drives the real routed board (pages/v2/schedule/SchedulePage) the way rescheduleNotify.test.tsx
 * does: synthetic drops onto Member-view week cells, and the card editor's actions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { asWallClock } from '@/lib/schedule-tz';
import { renderWithProviders } from '@/__tests__/helpers';
import { expectCustomerPageStale, seedCustomerPage } from '@/__tests__/support/customerPageCache';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';
import SchedulePage from '@/pages/v2/schedule/SchedulePage';
import { ScheduleCreatePopover } from '@/pages/v2/schedule/creation/scheduleCreatePopover';
import { useScheduleVisit } from '@/lib/api/service-plans';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0)).toISOString();
}

const ALICE = { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' };
const BOB = { id: 'm-bob', first_name: 'Bob', last_name: 'Ode' };
const CUSTOMER = { first_name: 'Pat', last_name: 'Sample', company_name: 'Sample Co', email: 'pat@example.test' };
const visitCrew = [{ user_id: ALICE.id, user: ALICE }];

const TWO_VISIT_JOB = {
  id: 'job-1',
  job_number: 'J00041',
  status: 'SCHEDULED',
  scope_notes: 'Gate repair',
  customer: CUSTOMER,
  assignees: [{ user: ALICE }],
  tags: [],
  scheduled_start: dayAt(1),
  scheduled_end: dayAt(1, 16),
  visits: [
    { id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: visitCrew },
    { id: 'v2', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(2), scheduled_end: dayAt(2, 16), is_all_day: false, assignees: visitCrew },
  ],
};
const SINGLE_VISIT_JOB = {
  ...TWO_VISIT_JOB,
  id: 'job-2',
  job_number: 'J00042',
  visits: [TWO_VISIT_JOB.visits[0]!],
};
const NO_VISIT_JOB = { ...TWO_VISIT_JOB, id: 'job-3', job_number: 'J00043', visits: [] };
const WALKTHROUGH_LEAD = {
  id: 'lead-1',
  lead_number: 'L00007',
  customer: CUSTOMER,
  walkthrough_scheduled_at: dayAt(1, 10),
  walkthrough_duration_minutes: 60,
  walkthrough_performers: [{ user: ALICE }],
  tags: [],
};

function mockBoard(jobs: Array<Record<string, unknown>>, leads: Array<Record<string, unknown>>) {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED' || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [] : jobs } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') {
      const params = (config?.params ?? {}) as { walkthrough_after?: string };
      return Promise.resolve({ data: { leads: params.walkthrough_after ? leads : [] } });
    }
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({
        data: { users: [ALICE, BOB].map((u) => ({ ...u, is_active: true, role: 'TECHNICIAN' })) },
      });
    }
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

/** Mounts the board in Member view with the customer page's queries cached beside it. */
async function mountBoard(
  { jobs = [], leads = [] }: { jobs?: Array<Record<string, unknown>>; leads?: Array<Record<string, unknown>> },
  waitForText: RegExp,
) {
  mockBoard(jobs, leads);
  const { queryClient } = renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN },
  );
  seedCustomerPage(queryClient);
  await screen.findAllByText(waitForText);
  fireEvent.click(screen.getByRole('button', { name: 'Member' }));
  return queryClient;
}

async function drop(boardId: string, { toMember = ALICE.id, toOffset }: { toMember?: string; toOffset: number },
  type: 'job' | 'walkthrough' = 'job') {
  const cell = await screen.findByTestId(`week-cell-${toMember}-${format(addDays(WEEK_START, toOffset), 'yyyy-MM-dd')}`);
  fireEvent.drop(cell, {
    dataTransfer: {
      getData: (k: string) =>
        k === GRID_EVENT_ID ? boardId : k === FROM_MEMBER ? ALICE.id : k === GRID_EVENT_TYPE ? type : '',
      types: [GRID_EVENT_ID, FROM_MEMBER],
    },
  });
}

async function openEditor(cardText: RegExp) {
  const [card] = await screen.findAllByText(cardText);
  if (!card) throw new Error('no card');
  fireEvent.click(card);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.patch.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('rescheduling on the board', () => {
  it('dragging a job visit to another day marks the customer page stale', async () => {
    const qc = await mountBoard({ jobs: [TWO_VISIT_JOB] }, /J00041/);
    await drop('jv-v2', { toOffset: 5 });
    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/jobs/job-1/visits/v2', expect.anything()));
    await expectCustomerPageStale(qc);
  });

  it('dragging a job with no visit row yet (books it through /assign) marks the customer page stale', async () => {
    const qc = await mountBoard({ jobs: [NO_VISIT_JOB] }, /J00043/);
    await drop('job-3', { toOffset: 5 });
    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-3/assign', expect.anything()));
    await expectCustomerPageStale(qc);
  });

  it('dragging a walkthrough to another day marks the customer page stale', async () => {
    const qc = await mountBoard({ leads: [WALKTHROUGH_LEAD] }, /L00007/);
    await drop('wt-lead-1', { toOffset: 5 }, 'walkthrough');
    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-1/walkthrough/schedule', expect.anything()),
    );
    await expectCustomerPageStale(qc);
  });
});

describe('re-crewing on the board', () => {
  it('dropping a job card onto another member the same day marks the customer page stale', async () => {
    const qc = await mountBoard({ jobs: [SINGLE_VISIT_JOB] }, /J00042/);
    await drop('jv-v1', { toMember: BOB.id, toOffset: 1 });

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-2/visits/v1/assignees', { assignee_ids: [BOB.id] }),
    );
    await expectCustomerPageStale(qc);
  });

  it('dropping a walkthrough onto another member the same day marks the customer page stale', async () => {
    const qc = await mountBoard({ leads: [WALKTHROUGH_LEAD] }, /L00007/);
    await drop('wt-lead-1', { toMember: BOB.id, toOffset: 1 }, 'walkthrough');

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-1/walkthrough/performers', { performer_ids: [BOB.id] }),
    );
    await expectCustomerPageStale(qc);
  });
});

describe('unscheduling and completing from the card editor', () => {
  async function unschedule(cardText: RegExp) {
    await openEditor(cardText);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Unscheduled/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Unschedule$/i }));
  }

  it('removing one visit of a multi-visit job marks the customer page stale', async () => {
    const qc = await mountBoard({ jobs: [TWO_VISIT_JOB] }, /J00041/);
    await unschedule(/Visit 2 of 2/);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-1/visits/v2/cancel', expect.anything()));
    await expectCustomerPageStale(qc);
  });

  it('unscheduling a single-visit job marks the customer page stale', async () => {
    const qc = await mountBoard({ jobs: [SINGLE_VISIT_JOB] }, /J00042/);
    await unschedule(/J00042/);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-2/unassign', {}));
    await expectCustomerPageStale(qc);
  });

  it('unscheduling a walkthrough marks the customer page stale', async () => {
    const qc = await mountBoard({ leads: [WALKTHROUGH_LEAD] }, /L00007/);
    await unschedule(/L00007/);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-1/walkthrough/unschedule'));
    await expectCustomerPageStale(qc);
  });

  it('"Mark Complete" marks the customer page stale', async () => {
    const qc = await mountBoard({ jobs: [SINGLE_VISIT_JOB] }, /J00042/);
    await openEditor(/J00042/);
    fireEvent.click(await screen.findByRole('button', { name: /Mark Complete/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-2/complete'));
    await expectCustomerPageStale(qc);
  });
});

describe('the board\'s "Schedule" create popover', () => {
  function renderPopover() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    seedCustomerPage(qc);
    const start = asWallClock(new Date(2026, 9, 2, 9, 0));
    const end = asWallClock(new Date(2026, 9, 2, 11, 0));
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <ScheduleCreatePopover
            open
            onOpenChange={() => {}}
            anchor={{ x: 100, y: 100 }}
            tz="America/New_York"
            seed={{ start, end }}
            unassignedJobs={[{ ...NO_VISIT_JOB, status: 'UNSCHEDULED' }]}
            unscheduledWalkthroughs={[{ ...WALKTHROUGH_LEAD, walkthrough_scheduled_at: null }]}
            showWalkthroughs
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    return qc;
  }

  it('scheduling a job marks the customer page stale', async () => {
    const user = userEvent.setup();
    const qc = renderPopover();

    await user.type(screen.getByLabelText('Search jobs...'), 'J00043');
    await user.click(await screen.findByRole('button', { name: /J00043/ }));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-3/assign', expect.anything()));
    await expectCustomerPageStale(qc);
  });

  it('scheduling a walkthrough marks the customer page stale', async () => {
    const user = userEvent.setup();
    const qc = renderPopover();

    await user.click(screen.getByRole('tab', { name: 'Walkthrough' }));
    await user.type(screen.getByLabelText('Search walkthroughs...'), 'L00007');
    await user.click(await screen.findByRole('button', { name: /L00007/ }));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-1/walkthrough/schedule', expect.anything()),
    );
    await expectCustomerPageStale(qc);
  });
});

describe('a service-plan visit dropped from the board\'s plan bucket', () => {
  it('booking it marks the customer page stale', async () => {
    mockApi.post.mockResolvedValueOnce({ data: { job: { id: 'job-7' } } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedCustomerPage(qc);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useScheduleVisit(), { wrapper });

    await result.current.mutateAsync({ id: 'plan-1', scheduled_start: dayAt(3), scheduled_end: dayAt(3, 16) });

    expect(mockApi.post).toHaveBeenCalledWith('/api/service-plans/plan-1/schedule-visit', expect.anything());
    await expectCustomerPageStale(qc);
  });
});
