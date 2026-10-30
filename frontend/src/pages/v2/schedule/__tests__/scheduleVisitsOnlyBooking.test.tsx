/**
 * Booking an unscheduled job from the Jobs bucket with Schedule visits and WITHOUT Assign people to jobs
 * (scenario pass 2, slice S04.11).
 *
 * PRD 4 gives the bucket to Schedule visits and gives naming a job's crew to Assign people to jobs. The crew door
 * (`POST /api/jobs/:id/assign`) asks for Assign people to jobs, so a person with the first and not the second used to
 * be offered the bucket and then refused with "Insufficient permissions". They now book the job's visit through the
 * visits door, which asks only for Schedule visits, with nobody on it; the modal's Crew field is empty and locked
 * (the card's own crew is not carried over, because naming it is the refused part).
 *
 * The page, the draft, the modal and the post are real; the drag-and-drop addon is stubbed as in
 * `dropModalStandardLaneSelfCrew.test.tsx`, which explains why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';

// `vi.mock` is hoisted above this, so the page below is built on the stubbed addon.
import SchedulePage from '../SchedulePage';

/**
 * The drag-and-drop addon, replaced by a button that fires the ONE callback this suite is about.
 *
 * Only `react-big-calendar/lib/addons/dragAndDrop` is mocked - `Calendar`, `Views` and
 * `dateFnsLocalizer` stay real, because the page reads `Views.WEEK`/`Views.MONTH` to decide the
 * drop's granularity and a stubbed enum would make that decision meaningless.
 *
 * The payload is RBC's own: a 9:00-11:00 window on a real day, `allDay: false` - which
 * `handleDropFromOutside` classifies as a TIMED drop, i.e. the `standard-time` target. That is
 * the target with no member in it, and therefore the one whose draft crew is the card's own.
 */
vi.mock('react-big-calendar/lib/addons/dragAndDrop', () => ({
  default: () =>
    function StubDnDCalendar(props: { onDropFromOutside?: (args: unknown) => void }) {
      // A `div role="button"` rather than a `<button>`: the design system's raw-tag rule reads
      // every JSX file, and a test stub is not the place to spend an exemption.
      return (
        <div
          role="button"
          tabIndex={0}
          onClick={() =>
            props.onDropFromOutside?.({
              start: new Date(2026, 5, 10, 9, 0),
              end: new Date(2026, 5, 10, 11, 0),
              allDay: false,
            })
          }
        >
          drop on a standard time lane
        </div>
      );
    },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ACTOR = { id: 'm-sales', first_name: 'Sam', last_name: 'Sales' };
const TECH = { id: 'u-tech', first_name: 'Terry', last_name: 'Tech' };

/** Reads the board and may schedule visits. Nothing else: no Assign people to jobs, no Assign work to other people. */
const SCHEDULE_VISITS_ONLY = buildAbility([
  { action: 'read', subject: 'all' },
  { action: 'reschedule', subject: 'Job' },
]);
/** The same person plus Assign people to jobs: the crew door is theirs. */
const SCHEDULE_AND_ASSIGN = buildAbility([
  { action: 'read', subject: 'all' },
  { action: 'reschedule', subject: 'Job' },
  { action: 'assign', subject: 'Job' },
]);

/**
 * The card at the heart of it: UNSCHEDULED (so the server has no live visit to exempt a
 * restatement against) and yet crewed, because `/unassign` and a cancelled trip both leave the
 * crew behind. `assignees[].user` is what `crewPeopleOf('job', raw)` reads.
 */
const CREWED_BUCKET_JOB = {
  id: 'job-bucket-1',
  job_number: 'J00043',
  title: 'Rooftop Unit Swap',
  status: 'UNSCHEDULED',
  customer: { id: 'c1', first_name: 'Acme', last_name: 'Corp' },
  scheduled_start: null,
  scheduled_end: null,
  assignees: [{ user: TECH }],
  visits: [],
};

const mockApi = vi.mocked(api);

/** The roster the SERVER would answer a self-only caller with: one row, and it is them. */
function mockBoard() {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED'
        || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [CREWED_BUCKET_JOB] : [] } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({ data: [{ ...ACTOR, is_active: true, role: 'ADMIN', department: null }] });
    }
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    if (url === '/api/calendar-entries') return Promise.resolve({ data: { calendar_entries: [] } });
    return Promise.resolve({ data: {} });
  });
}

function signedInAsActor() {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { ...ACTOR, email: 'sam@test.com', role: 'ADMIN' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
}

/** dataTransfer, as much of it as `handleBucketCardDragStart` touches. */
function dragPayload() {
  const store: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => { store[k] = v; },
    getData: (k: string) => store[k] ?? '',
    setDragImage: () => {},
    types: [] as string[],
    effectAllowed: 'move',
  };
}

/** Mounts the board, starts the card's drag (which is what sets the page's drag ref), drops it. */
async function dropCrewedCardOnStandardLane(ability = SCHEDULE_VISITS_ONLY) {
  mockBoard();
  renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability },
  );
  const card = (await screen.findAllByText(/J00043/))[0]!.closest('[draggable]');
  expect(card).not.toBeNull();
  // The real drag-out: `handleDropFromOutside` reads `draggingJobIdRef.current`, and nothing but
  // a dragStart on the card ever sets it - so a test that skipped this would prove nothing.
  fireEvent.dragStart(card!, { dataTransfer: dragPayload() });
  fireEvent.click(screen.getByRole('button', { name: /drop on a standard time lane/ }));
  return screen.findByRole('dialog');
}

/** The Crew field's own picker - the time fields are comboboxes too. */
const crewPicker = (dialog: HTMLElement) =>
  within(within(dialog).getByRole('group')).getByRole('combobox');

beforeEach(() => {
  vi.clearAllMocks();
  signedInAsActor();
});

describe('a Schedule-visits-only viewer books the dropped job without naming a crew', () => {
  it('opens with an empty, locked Crew field, even though the card carried a crew', async () => {
    const dialog = await dropCrewedCardOnStandardLane();
    expect(within(dialog).queryByText('Terry Tech')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Sam Sales')).not.toBeInTheDocument();
    expect(crewPicker(dialog)).toBeDisabled();
  });

  it('books the visit through the visits door with no crew, and never calls assign', async () => {
    mockApi.post.mockResolvedValue({ data: { visit: { id: 'v1' } } });
    const dialog = await dropCrewedCardOnStandardLane();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    // No "schedule with no crew?" warning stands in the way: no crew is the rule for this person.
    expect(screen.queryByText(/no crew/i)).not.toBeInTheDocument();
    const calls = mockApi.post.mock.calls;
    expect(calls.map((c) => c[0])).toEqual(['/api/jobs/job-bucket-1/visits']);
    expect(calls[0]![1]).toMatchObject({ assignee_ids: [] });
    expect(calls[0]![1]).toHaveProperty('scheduled_start');
    expect(calls[0]![1]).toHaveProperty('scheduled_end');
  });
});

describe('the same drop with Assign people to jobs', () => {
  it('still goes through the crew door with the crew', async () => {
    mockApi.post.mockResolvedValue({ data: {} });
    const dialog = await dropCrewedCardOnStandardLane(SCHEDULE_AND_ASSIGN);
    expect(await within(dialog).findByText('Sam Sales')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0]![0]).toBe('/api/jobs/job-bucket-1/assign');
  });
});
