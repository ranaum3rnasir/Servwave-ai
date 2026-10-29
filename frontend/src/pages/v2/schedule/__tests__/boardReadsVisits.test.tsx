/**
 * Multi-visit spec slice S6 - the board paints one card per VISIT, not one per job.
 *
 * `Job.scheduled_start` is a write-through mirror of the job's NEXT upcoming visit (D14), so a
 * job with three booked trips contributed exactly one card and trips 2..N were invisible. These
 * tests drive the routed board (`pages/v2/schedule/SchedulePage` - App.tsx has no /schedule route
 * at all, the v2 route table owns the only one) and the two shared board views, and they build
 * their events through the REAL adapter rather than restating a fixture, so an adapter that
 * stopped fanning out cannot pass.
 *
 * `data-board-id` is the card's identity on the board. It is asserted rather than the card count
 * alone because three cards sharing one id is the failure mode that typechecks perfectly: the id
 * is simultaneously the React key, the drag payload and the path segment in every write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { MemberWeekBoard } from '@/components/schedule/MemberWeekBoard';
import { TechnicianGridView } from '@/components/schedule/TechnicianGridView';
import { jobToEvents } from '@/components/schedule/eventAdapters';
import { draftFromDrop } from '@/components/schedule/scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';

import SchedulePage, { ScheduleEvent } from '../SchedulePage';

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);
const TZ = 'America/New_York';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// Three consecutive days inside the week the board opens on, so the fixture cannot rot out of
// the default window. 14:00Z is mid-morning in the org zone all year round.
const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14, minute = 0): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0)).toISOString();
}

const CREW = [{ user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }];
/**
 * Alice as a VISIT carries her. Since slice 02 (visits-and-task-categories) a trip's card reads
 * its crew off the trip itself, not off the job-level `assignees` union above - so every trip that
 * is meant to sit in Alice's lane has to be crewed with her, as the server would serve it.
 */
const ALICE_ON_VISIT = [{ user_id: 'm-alice', user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }];

const THREE_VISIT_JOB = {
  id: 'job-1',
  job_number: 'J00041',
  status: 'SCHEDULED',
  scope_notes: 'Rooftop Unit Swap',
  customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme' },
  assignees: CREW,
  tags: [],
  // The mirror still holds visit 1 (D14). A board reading it shows exactly one card.
  scheduled_start: dayAt(1),
  scheduled_end: dayAt(1, 16),
  visits: [
    { id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: ALICE_ON_VISIT },
    { id: 'v2', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(2), scheduled_end: dayAt(2, 16), is_all_day: false, assignees: ALICE_ON_VISIT },
    { id: 'v3', visit_seq: 3, status: 'SCHEDULED', scheduled_at: dayAt(3), scheduled_end: dayAt(3, 16), is_all_day: false, assignees: ALICE_ON_VISIT },
  ],
};

/**
 * `/api/jobs` is asked TWICE by the board - once for the window, once for the UNSCHEDULED
 * bucket - so the fake has to read the params. Answering both with the same rows would put
 * every board card in the sidebar too, and a board drag would then be classified as a bucket
 * drop rather than a reschedule.
 */
function mockBoard(jobs: Array<Record<string, unknown>>, bucket: Array<Record<string, unknown>> = []) {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED'
        || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? bucket : jobs } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    // The board's roster moved to the scoped endpoint; serve it the same fixture.
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({
        data: { users: [{ id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' }] },
      });
    }
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

const boardIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-board-id]')).map((el) => el.getAttribute('data-board-id'));

const STAFF = [{ id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' }];

describe('the routed schedule board paints one card per visit (S6, F1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders three distinct cards for one job holding three visits', async () => {
    mockBoard([THREE_VISIT_JOB]);

    const { container } = renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );

    await screen.findAllByText(/J00041/);

    const ids = boardIds(container);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    // The job id is what every card carried before this slice. If a card still holds it, the
    // three cards are the same card and every write from them targets the same trip.
    expect(ids).not.toContain('job-1');
  });
});

describe('both shared board views fan the same job out (S6, F1, D36)', () => {
  const events = () => jobToEvents(THREE_VISIT_JOB, TZ);

  it('MemberWeekBoard renders one card per visit, each with its own board id', () => {
    const { container } = renderWithProviders(
      <MemberWeekBoard
        weekStart={asWallClock(WEEK_START)}
        staff={STAFF}
        events={events()}
        conflictIds={new Set()}
        isLoading={false}
        tz={TZ}
        onSelectEvent={vi.fn()}
        onDropJob={vi.fn()}
      />,
    );

    const ids = boardIds(container);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('TechnicianGridView renders the day\'s visit as its own card', () => {
    const dayTwo = asWallClock(addDays(WEEK_START, 2));
    const { container } = renderWithProviders(
      <TechnicianGridView
        date={dayTwo}
        events={events()}
        members={STAFF}
        conflictIds={new Set()}
        isLoading={false}
        draggingJobIdRef={{ current: null }}
        onDropJob={vi.fn()}
        onSelectJob={vi.fn()}
        onEventClick={vi.fn()}
      />,
    );

    // The grid view is a single DAY, so exactly the one visit booked on it is on screen - and it
    // is visit 2, which the mirror never held.
    expect(boardIds(container)).toEqual(['jv-v2']);
  });
});

describe('all-day is a fact about the TRIP, not about the job (S6, F2)', () => {
  /**
   * The office marks the upcoming trip all-day from the job page (AssignJobDialog sends
   * `is_all_day`), and `/assign` writes it onto visit 1 AND onto the job's mirror column. Every
   * card is built from the same `raw` job row, so routing that reads the mirror answers one
   * trip's question for all of them - and the Friday trip, a plain 14:00-16:00 booking, is
   * rendered as an all-day pill with its time thrown away.
   */
  const ONE_ALL_DAY_TRIP = {
    ...THREE_VISIT_JOB,
    is_all_day: true,
    visits: [
      { id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: true, assignees: [] },
      { id: 'v2', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(2), scheduled_end: dayAt(2, 16), is_all_day: false, assignees: [] },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the timed trip in the timed grid while its all-day sibling sits in the strip', async () => {
    mockBoard([ONE_ALL_DAY_TRIP]);

    const { container } = renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00041/);

    expect(container.querySelector('.rbc-allday-cell [data-board-id="jv-v1"]')).not.toBeNull();
    // The whole point: the sibling's flag must not follow it.
    expect(container.querySelector('.rbc-allday-cell [data-board-id="jv-v2"]')).toBeNull();
    expect(container.querySelector('.rbc-time-content [data-board-id="jv-v2"]')).not.toBeNull();
  });
});

describe('the card says which trip it is, from the payload (S6, F2, D13)', () => {
  const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

  async function openMemberBoard(job: Record<string, unknown>) {
    mockBoard([job]);
    renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00041/);
    fireEvent.click(screen.getByRole('button', { name: 'Member' }));
    await screen.findByTestId(cellFor(1));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('labels each card from the visit_seq the API sent, not from its position on the board', async () => {
    await openMemberBoard(THREE_VISIT_JOB);

    expect(screen.getAllByText('Visit 1 of 3').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Visit 2 of 3').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Visit 3 of 3').length).toBeGreaterThan(0);
  });

  /**
   * D19 keeps a called-off trip as a CANCELLED row and D13 forbids renumbering, so the API
   * (whose select excludes CANCELLED) sends the survivors still numbered 2 and 3. Counting the
   * live rows for the denominator while labelling from the creation-order numerator mixes two
   * axes and prints a card that cannot be true.
   */
  it('never prints an impossible "Visit 3 of 2" after the first trip is called off', async () => {
    await openMemberBoard({
      ...THREE_VISIT_JOB,
      visits: [THREE_VISIT_JOB.visits[1], THREE_VISIT_JOB.visits[2]],
    });

    expect(screen.queryByText('Visit 3 of 2')).not.toBeInTheDocument();
    expect(screen.getAllByText('Visit 2 of 3').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Visit 3 of 3').length).toBeGreaterThan(0);
  });
});

describe('dragging the third visit moves the THIRD visit (S6, F3, D34)', () => {
  const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  /** Open the member board, drag one card onto another day in the same lane, and confirm. */
  async function dragAndConfirm(boardId: string, toOffset: number) {
    mockBoard([THREE_VISIT_JOB]);
    renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00041/);

    fireEvent.click(screen.getByRole('button', { name: 'Member' }));
    const cell = await screen.findByTestId(cellFor(toOffset));
    fireEvent.drop(cell, {
      dataTransfer: {
        getData: (k: string) =>
          k === GRID_EVENT_ID ? boardId : k === FROM_MEMBER ? 'm-alice' : k === GRID_EVENT_TYPE ? 'job' : '',
        types: [GRID_EVENT_ID, FROM_MEMBER],
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));
  }

  it('PATCHes the dragged visit, and never re-POSTs /assign (which moves visit 1)', async () => {
    await dragAndConfirm('jv-v3', 5);

    // onMutate awaits cancelQueries before the request goes out, so the write is a tick away.
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch).toHaveBeenCalledWith(
      '/api/jobs/job-1/visits/v3',
      expect.objectContaining({
        // The card kept its wall-clock time and changed day, so the instant is the same
        // time-of-day converted through the ORG zone. A browser-zone conversion (#1551's
        // second defect) lands on a different instant and fails here.
        scheduled_start: dayAt(5),
        scheduled_end: dayAt(5, 16),
      }),
    );
    // /assign routes through syncJobWindowOntoVisits, which moves the NEXT UPCOMING trip -
    // dragging visit 3 would silently reschedule visit 1. That is the #1550 class.
    const assignCalls = mockApi.post.mock.calls.filter(([url]) => String(url).includes('/assign'));
    expect(assignCalls).toEqual([]);
  });

  it('sends no assignee_ids on a plain move, so a reschedule-only grantee is not 403d', async () => {
    await dragAndConfirm('jv-v3', 5);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch.mock.calls[0]![1]).not.toHaveProperty('assignee_ids');
  });
});

describe('saving a new time in the event editor moves THAT trip (S6, F3, D34)', () => {
  const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('PATCHes the edited visit rather than re-POSTing /assign, which moves visit 1', async () => {
    mockBoard([THREE_VISIT_JOB]);
    renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00041/);
    fireEvent.click(screen.getByRole('button', { name: 'Member' }));

    // Open visit 2's card in the editor - the same door the dispatcher uses.
    fireEvent.click(
      screen.getByTestId(cellFor(2)).querySelector('[data-board-id="jv-v2"]') as HTMLElement,
    );

    const start = await screen.findByLabelText('Start time');
    fireEvent.change(start, { target: { value: '1:30 PM' } });
    fireEvent.blur(start);
    fireEvent.click(screen.getByRole('button', { name: 'Save time' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch.mock.calls[0]![0]).toBe('/api/jobs/job-1/visits/v2');
    // /assign routes through syncJobWindowOntoVisits, which rewrites the job's EARLIEST
    // upcoming trip - editing visit 2 would silently move visit 1 onto visit 2's new time,
    // and the customer's "Visit 1" email would then name the wrong day.
    const assignCalls = mockApi.post.mock.calls.filter(([url]) => String(url).includes('/assign'));
    expect(assignCalls).toEqual([]);
  });
});

describe('a per-visit drag still warns about a double-booking (S6, F3, D21)', () => {
  const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

  const CONFLICT_409 = {
    response: {
      status: 409,
      data: {
        error: 'Schedule conflict detected',
        conflicts: [{
          type: 'job', id: 'job-99', number: 'J00099',
          start: dayAt(5, 14, 30), end: dayAt(5, 15, 30),
        }],
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({ data: {} });
  });

  /**
   * Before S6 this gesture POSTed `/assign`, which raises the 409 the "Schedule Anyway" modal is
   * built on. Moving it onto the per-visit route without carrying the warning across would have
   * deleted the double-booking warning from the board's main gesture - the crew is booked twice
   * and nobody is told.
   */
  it('shows the conflict modal on a 409, and Schedule Anyway forces the same move through', async () => {
    mockApi.patch.mockRejectedValueOnce(CONFLICT_409).mockResolvedValue({ data: {} });
    mockBoard([THREE_VISIT_JOB]);

    renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00041/);
    fireEvent.click(screen.getByRole('button', { name: 'Member' }));

    fireEvent.drop(await screen.findByTestId(cellFor(5)), {
      dataTransfer: {
        getData: (k: string) =>
          k === GRID_EVENT_ID ? 'jv-v3' : k === FROM_MEMBER ? 'm-alice' : k === GRID_EVENT_TYPE ? 'job' : '',
        types: [GRID_EVENT_ID, FROM_MEMBER],
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    // The warning names the trip it clashes with, exactly as the /assign path always did.
    expect(await screen.findByText('Scheduling Conflict')).toBeInTheDocument();
    expect(screen.getByText('J00099')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Schedule Anyway/i }));

    // D21 - warn, never block: the retry is the SAME trip, forced.
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(2));
    expect(mockApi.patch.mock.calls[1]![0]).toBe('/api/jobs/job-1/visits/v3');
    expect(mockApi.patch.mock.calls[1]![1]).toEqual(expect.objectContaining({ force: true }));
  });
});

describe('a dragged card stays where it was dropped before the refetch lands (S6, F5)', () => {
  const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;
  const cardIn = (offset: number) =>
    screen.getByTestId(cellFor(offset)).querySelector('[data-board-id="jv-v2"]');

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('holds visit 2 on its new day while the PATCH is still in flight', async () => {
    // Never resolved: the whole point is the window between the write and the refetch.
    mockApi.patch.mockReturnValue(new Promise(() => {}));
    mockBoard([THREE_VISIT_JOB]);

    renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00041/);
    fireEvent.click(screen.getByRole('button', { name: 'Member' }));

    // Visit 2 starts on day 2; drop it on day 4.
    expect(cardIn(2)).not.toBeNull();
    const target = await screen.findByTestId(cellFor(4));
    fireEvent.drop(target, {
      dataTransfer: {
        getData: (k: string) =>
          k === GRID_EVENT_ID ? 'jv-v2' : k === FROM_MEMBER ? 'm-alice' : k === GRID_EVENT_TYPE ? 'job' : '',
        types: [GRID_EVENT_ID, FROM_MEMBER],
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    // The write has not come back. The card must already be on Thursday, not snapped back:
    // the optimistic patch has to reach the VISIT row, because that is what the board reads.
    await waitFor(() => expect(cardIn(4)).not.toBeNull());
    expect(cardIn(2)).toBeNull();
  });
});

describe('removing a card from the board removes only THAT trip (S6, F6, D16)', () => {
  const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({ data: {} });
    mockApi.patch.mockResolvedValue({ data: {} });
  });

  it('cancels the one visit, and leaves the job\'s other two trips on the board', async () => {
    mockBoard([THREE_VISIT_JOB]);
    renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00041/);
    fireEvent.click(screen.getByRole('button', { name: 'Member' }));

    const visitTwoCard = screen
      .getByTestId(cellFor(2))
      .querySelector('[data-board-id="jv-v2"]') as HTMLElement;
    fireEvent.click(visitTwoCard);

    fireEvent.click(await screen.findByRole('button', { name: /Move to Unscheduled/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Unschedule$/i }));

    // /unassign now cancels EVERY live visit on the job (S6, B4), so sending it here would wipe
    // all three trips and drop a three-trip job to UNSCHEDULED - strictly worse than the silent
    // divergence it replaced.
    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post).toHaveBeenCalledWith(
      '/api/jobs/job-1/visits/v2/cancel',
      expect.objectContaining({ cancelled_reason: expect.any(String) }),
    );
    const unassignCalls = mockApi.post.mock.calls.filter(([url]) => String(url).includes('/unassign'));
    expect(unassignCalls).toEqual([]);
  });

  it('still sends /unassign for a job that holds a single trip - the gesture\'s original meaning', async () => {
    const oneVisitJob = {
      ...THREE_VISIT_JOB,
      visits: [THREE_VISIT_JOB.visits[0]],
    };
    mockBoard([oneVisitJob]);
    renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00041/);
    fireEvent.click(screen.getByRole('button', { name: 'Member' }));

    const onlyCard = screen
      .getByTestId(cellFor(1))
      .querySelector('[data-board-id="jv-v1"]') as HTMLElement;
    fireEvent.click(onlyCard);

    fireEvent.click(await screen.findByRole('button', { name: /Move to Unscheduled/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Unschedule$/i }));

    // The job door, not the per-visit cancel - the assertion is on WHICH door. The body is
    // empty: the confirm offers no notify composer any more (customer notifications come only
    // from automations, scheduling-notifications follow-up f3), so no notify key rides it.
    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/unassign'));
    expect(call?.[0]).toBe('/api/jobs/job-1/unassign');
    expect(call?.[1]).toEqual({});
  });
});

describe('first-booking a job from the bucket still lands it on the board (S6, F4)', () => {
  const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

  /** The unassigned case: no visit row exists yet, so there is nothing to PATCH. */
  const BUCKET_JOB = {
    id: 'job-9',
    job_number: 'J00099',
    status: 'UNSCHEDULED',
    scope_notes: 'Annual service',
    customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme' },
    assignees: [],
    tags: [],
    scheduled_start: null,
    scheduled_end: null,
    visits: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({ data: {} });
    mockApi.patch.mockResolvedValue({ data: {} });
  });

  it('POSTs /assign (the only path that books visit 1) and shows the card once the job comes back', async () => {
    mockBoard([], [BUCKET_JOB]);
    renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00099/);
    fireEvent.click(screen.getByRole('button', { name: 'Member' }));

    fireEvent.drop(await screen.findByTestId(cellFor(3)), {
      dataTransfer: {
        getData: (k: string) => (k === 'job-id' ? 'job-9' : ''),
        types: ['job-id'],
      },
    });

    // The drop modal seeds the crew from the lane it was dropped in; confirm it.
    // The server's answer AFTER the write: the job now holds its first visit. Armed before the
    // confirm so the mutation's own invalidate-refetch reads it, which is the real sequence.
    const booked = {
      ...BUCKET_JOB,
      status: 'SCHEDULED',
      assignees: CREW,
      scheduled_start: dayAt(3),
      scheduled_end: dayAt(3, 16),
      visits: [{ id: 'v9', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(3), scheduled_end: dayAt(3, 16), is_all_day: false, assignees: ALICE_ON_VISIT }],
    };

    fireEvent.click(await screen.findByRole('button', { name: /^Schedule$/i }));
    mockBoard([booked], []);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const [url, body] = mockApi.post.mock.calls[0]!;
    expect(url).toBe('/api/jobs/job-9/assign');
    expect(body).toEqual(
      expect.objectContaining({
        assignee_ids: ['m-alice'],
        scheduled_start: expect.any(String),
        scheduled_end: expect.any(String),
      }),
    );

    // The refetch brings the job back with its first visit - the card must be on the board, and
    // it must have left the bucket.
    await waitFor(() =>
      expect(screen.getByTestId(cellFor(3)).querySelector('[data-board-id="jv-v9"]')).not.toBeNull(),
    );
  });
});

describe('an unscheduled job is a JOB in the bucket, never a finished trip (S6, F4, D16)', () => {
  const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

  /**
   * The divergent shape `/unassign` leaves behind: it cancels only the LIVE visits (D16), so a
   * job whose trip was already COMPLETED keeps that row while the job drops to UNSCHEDULED. The
   * bucket query asks for UNSCHEDULED jobs, so this row comes back with a finished trip attached.
   */
  const FINISHED_TRIP_BUCKET_JOB = {
    id: 'job-8',
    job_number: 'J00050',
    status: 'UNSCHEDULED',
    scope_notes: 'Return visit',
    customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme' },
    assignees: [],
    tags: [],
    scheduled_start: null,
    scheduled_end: null,
    visits: [{
      id: 'v8', visit_seq: 1, status: 'COMPLETED',
      scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: [],
    }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({ data: {} });
    mockApi.patch.mockResolvedValue({ data: {} });
  });

  it('books NEW work when its card is dragged out, instead of rewriting the finished trip', async () => {
    mockBoard([], [FINISHED_TRIP_BUCKET_JOB]);
    renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00050/);
    fireEvent.click(screen.getByRole('button', { name: 'Member' }));

    // The REAL drag channel: the page writes it in the card's own onDragStart, and every drop
    // handler (and the plan-mode ghost's sourceId) reads what it wrote.
    const channels: Record<string, string> = {};
    const card = screen.getAllByText(/J00050/)[0]!.closest('[draggable="true"]') as HTMLElement;
    fireEvent.dragStart(card, {
      dataTransfer: {
        setData: (k: string, v: string) => { channels[k] = v; },
        getData: (k: string) => channels[k] ?? '',
        setDragImage: () => {},
        types: [],
      },
    });

    // A bucket card addresses the JOB. `jv-<visitId>` here would be decoded by parseBoardDragId
    // as a job id (it has no `jv-` case), so a plan-mode ghost would POST to
    // /api/jobs/jv-<uuid>/assign and 404.
    expect(channels['job-id']).toBe('job-8');

    fireEvent.drop(await screen.findByTestId(cellFor(3)), {
      dataTransfer: {
        getData: (k: string) => channels[k] ?? '',
        types: Object.keys(channels),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Schedule$/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0]![0]).toBe('/api/jobs/job-8/assign');
    // Rewriting the completed visit's window would destroy the record of when the work was
    // actually done, and would create no new booking - which is the gesture's whole purpose.
    expect(mockApi.patch).not.toHaveBeenCalled();
  });
});

describe('a card is seeded from the trip it IS, not from the job mirror (S6, F7)', () => {
  /** Visit 2 is 10:00 for 90 minutes; the mirror still holds visit 1 at 08:00 for 60. */
  const MIXED_JOB = {
    ...THREE_VISIT_JOB,
    scheduled_start: dayAt(1, 12),
    scheduled_end: dayAt(1, 13),
    visits: [
      { id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1, 12), scheduled_end: dayAt(1, 13), is_all_day: false, assignees: [] },
      { id: 'v2', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(2, 14), scheduled_end: dayAt(2, 15, 30), is_all_day: false, assignees: [] },
      { id: 'v3', visit_seq: 3, status: 'SCHEDULED', scheduled_at: dayAt(3), scheduled_end: null, is_all_day: true, assignees: [] },
    ],
  };

  it('takes each card\'s window from its own visit, and the all-day flag with it', () => {
    const [first, second, third] = jobToEvents(MIXED_JOB, TZ);

    // 90 minutes, off the visit's own scheduled_end - NOT the 120-minute job default.
    expect(second!.end!.getTime() - second!.start!.getTime()).toBe(90 * 60_000);
    expect(first!.end!.getTime() - first!.start!.getTime()).toBe(60 * 60_000);
    expect(third!.isAllDay).toBe(true);
    expect(second!.isAllDay).toBe(false);
  });

  it('a drop draft built from the second card carries THAT trip\'s duration', () => {
    const second = jobToEvents(MIXED_JOB, TZ)[1]!;
    const draft = draftFromDrop(
      second,
      { kind: 'member-week', memberId: 'm-alice', date: asWallClock(addDays(WEEK_START, 4)) },
      { defaultStartMin: 8 * 60, defaultDurationMin: 120 },
    );
    expect(draft.durationMin).toBe(90);
    expect(draft.eventId).toBe('jv-v2');
  });

  it('falls back to the job default only when the visit has no end at all', () => {
    const openEnded = { ...MIXED_JOB, visits: [{ ...MIXED_JOB.visits[1], scheduled_end: null }] };
    const [only] = jobToEvents(openEnded, TZ);
    expect(only!.end!.getTime() - only!.start!.getTime()).toBe(120 * 60_000);
  });
});

describe('the STANDARD board says which trip it is too (S6, F2, D13)', () => {
  /**
   * The Standard week view is the board a dispatcher lands on, and it renders through a THIRD
   * card component (`ScheduleEvent`, in this page) which does not use ScheduleCardBody at all.
   * Driven in a browser on 2026-08-19, a three-trip job painted three cards there reading exactly
   * the same "J00041 - Ada Byron / time / crew" - correctly keyed jv-v1..v3, with nothing on the
   * card to say which trip is which.
   */
  const cardFor = (container: HTMLElement, boardId: string) =>
    container.querySelector(`[data-board-id="${boardId}"]`) as HTMLElement | null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function openStandardBoard(job: Record<string, unknown>) {
    mockBoard([job]);
    const rendered = renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );
    await screen.findAllByText(/J00041/);
    return rendered;
  }

  it('labels the second of three trips "Visit 2 of 3" on the card the dispatcher lands on', async () => {
    const { container } = await openStandardBoard(THREE_VISIT_JOB);

    expect(cardFor(container, 'jv-v2')).toHaveTextContent('Visit 2 of 3');
    expect(cardFor(container, 'jv-v1')).toHaveTextContent('Visit 1 of 3');
    expect(cardFor(container, 'jv-v3')).toHaveTextContent('Visit 3 of 3');
  });

  it('leaves a single-trip job unlabelled - the 99% case must not gain noise', async () => {
    const { container } = await openStandardBoard({
      ...THREE_VISIT_JOB,
      visits: [THREE_VISIT_JOB.visits[0]],
    });

    expect(cardFor(container, 'jv-v1')).not.toHaveTextContent(/Visit \d+ of \d+/);
  });

  /**
   * Rendered directly rather than through plan mode: the ghost only exists mid-drag, and the
   * point of the assertion is structural - the badge must sit INSIDE the job/walkthrough
   * branches, below the two early returns, not in a wrapper above them.
   */
  it('never badges a plan-mode ghost or a drag-in preview', () => {
    const ghost = {
      boardId: 'jv-ghost', parentId: 'job-1', type: 'job' as const,
      number: 'J00041', title: 'Rooftop Unit Swap', customer: 'Acme',
      crew: ['m-alice'], ownerId: null,
      start: asWallClock(new Date(2026, 5, 10, 9, 0)),
      end: asWallClock(new Date(2026, 5, 10, 11, 0)),
      visitId: 'ghost', visitSeq: 2, visitCount: 3,
      isGhost: true,
      raw: { status: 'SCHEDULED', job_number: 'J00041', customer: { first_name: 'Ada', last_name: 'Byron' } },
    };

    const withRaw = renderWithProviders(<ScheduleEvent event={ghost} />);
    expect(screen.queryByText(/Visit \d+ of \d+/)).not.toBeInTheDocument();
    withRaw.unmount();

    // The external drag-in preview: no `raw` at all, so it takes the first early return.
    renderWithProviders(<ScheduleEvent event={{ ...ghost, isGhost: false, raw: undefined }} />);
    expect(screen.queryByText(/Visit \d+ of \d+/)).not.toBeInTheDocument();
  });
});
