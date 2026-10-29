/**
 * THE DEAD END ON THE BOARD, driven end to end - a bucket card that ALREADY CARRIES CREW, dropped
 * on a lane that names no member, by somebody who may name nobody but themselves.
 *
 * `dropModalSelfCrew.test.tsx` covers the member-lane drop and says plainly that it CANNOT reach
 * this one: `onDropFromOutside` is fired from react-big-calendar's `Selection` machinery off
 * `getBoundsForNode`, and jsdom reports every rect as 0x0, so `pointInColumn` is never satisfied.
 * That is a limitation of the LIBRARY's hit-testing, not of the page - so this suite replaces the
 * drag-and-drop ADDON with a stub whose only job is to hand `onDropFromOutside` the shape RBC
 * hands it. Everything downstream of that callback is the real page: the real
 * `handleDropFromOutside`, the real `draftFromDrop`, the real `seedCrewForActor`, the real
 * `UnifiedDropModal` and the real `MultiAssigneeSelect`.
 *
 * WHAT IT PINS. The job sits in the bucket crewed by a technician (an UNSCHEDULED job keeps its
 * cancelled trip's crew - `jobCrewIds` has no status filter, deliberately). Before the fix,
 * `draftFromDrop` copied `crew: ['u-tech']` through, `seedCrewForActor` returned it unchanged on
 * the strength of a restatement exemption that DOES NOT APPLY HERE, and the field arrived LOCKED
 * holding a name the door answers 403 for: `POST /api/jobs/:id/assign` passes `undefined` as
 * `currentCrewIds` when the job has no live visit, which is the strict path. The modal's own
 * `restoreDraftOnNon409` then put the user back in front of the same unfixable field.
 *
 * WHY THE FIXTURE'S ROLE IS ADMIN WHILE THE ABILITY IS SELF-ONLY: the same reason its twin gives -
 * `boardCapabilitiesFor` switches on `user.role`, and an ADMIN with `assign User` withheld by a
 * per-user override is a real, supported configuration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';

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

/** Reads the board, may schedule - and may NOT name anybody but themselves. */
const SELF_ONLY = buildAbility([
  { action: 'read', subject: 'all' },
  { action: 'update', subject: 'Job' },
  { action: 'create', subject: 'Job' },
]);
/** The same viewer plus the one grant. Nothing else differs. */
const GRANT_HOLDER = buildAbility([
  { action: 'read', subject: 'all' },
  { action: 'update', subject: 'Job' },
  { action: 'create', subject: 'Job' },
  { action: 'assign', subject: 'User' },
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
async function dropCrewedCardOnStandardLane(ability = SELF_ONLY) {
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

describe('a crewed bucket card dropped on a member-less lane, by a self-only viewer', () => {
  it('opens holding the VIEWER, not the crew the card carried', async () => {
    const dialog = await dropCrewedCardOnStandardLane();

    // The one crew the API would take from them - and the value Schedule will post.
    expect(await within(dialog).findByText('Sam Sales')).toBeInTheDocument();
    // The technician is gone. His id in this field was the 403: no live visit means
    // `validateCrew` is handed `undefined` as `currentCrewIds`, so it is not a restatement.
    expect(within(dialog).queryByText('Terry Tech')).not.toBeInTheDocument();
  });

  it('is still locked, and says nothing about why', async () => {
    const dialog = await dropCrewedCardOnStandardLane();
    await within(dialog).findByText('Sam Sales');

    expect(within(dialog).queryByRole('button', { name: /Remove Sam Sales/i })).not.toBeInTheDocument();
    expect(crewPicker(dialog)).toBeDisabled();
    // The explanatory sentence was removed on 1 Sep (Ran). The lock above IS the statement;
    // asserted as an absence so a re-add here alone cannot drift from the other two surfaces.
    expect(within(dialog).queryByText('You can only assign yourself as job crew.')).not.toBeInTheDocument();
  });

  it('leaves Schedule alive - the seed exists to make this button postable', async () => {
    const dialog = await dropCrewedCardOnStandardLane();
    expect(within(dialog).getByRole('button', { name: 'Schedule' })).toBeEnabled();
  });
});

describe('the same drop, for a holder of `assign User`', () => {
  it('keeps the crew the card carried - the grant holder is untouched by any of this', async () => {
    const dialog = await dropCrewedCardOnStandardLane(GRANT_HOLDER);

    // Named off the CARD's own payload (`crewPeopleOf` -> knownPeople), because this fixture's
    // roster does not contain him either - which is the point of that fallback.
    expect(await within(dialog).findByText('Terry Tech')).toBeInTheDocument();
    expect(within(dialog).queryByText('Sam Sales')).not.toBeInTheDocument();
    // ...and removable, so a dispatcher can still hand the trip to somebody else.
    expect(within(dialog).getByRole('button', { name: /Remove Terry Tech/i })).toBeInTheDocument();
    expect(within(dialog).queryByText(/You can only (put yourself|assign yourself)/)).not.toBeInTheDocument();
  });
});
