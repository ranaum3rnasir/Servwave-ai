/**
 * SLICE 4 ON THE BOARD - the drop modal's Crew field for somebody who may name nobody but
 * themselves. The twin of `pages/v2/leads/__tests__/walkthroughSelfPerformerSeed.test.tsx`; the
 * board is a twin of the lead tab, not shared code, so the rule is asserted twice on purpose.
 *
 * TWO HALVES, AND EACH IS HONEST ABOUT WHAT IT PROVES.
 *
 *  1. BEHAVIOURAL. The real `SchedulePage` is rendered with a real CASL ability, a real bucket
 *     card is dropped through the member grid's own native drop listener, and the modal that
 *     opens is read the way a person would read it. This proves the ability actually REACHES the
 *     modal - the half most likely to break silently, because a hardcoded `canAssignOthers`
 *     would type-check and would look right in every other test in this directory.
 *
 *  2. SOURCE-SCANNING, for one thing behaviour cannot reach here. The seed DOES execute in the
 *     block above and these tests do notice: `draftFromDrop`'s member-week branch happens to
 *     hand the lane's own id over, so the seed is a no-op for this particular drop - but strip
 *     that branch's `crew` AND the seed together and every assertion above goes red, while
 *     stripping only the branch leaves them green because the seed then supplies the id. That is
 *     the seed running, not being read.
 *
 *     What THIS FILE cannot reach is the drop that makes the seed NECESSARY: a target naming no
 *     member (`standard-time` / `standard-day`, where the draft's crew is the card's own). Those
 *     arrive through react-big-calendar's `onDropFromOutside`, fired from RBC's `Selection`
 *     machinery off `getBoundsForNode`; jsdom reports every rect as 0x0, so `pointInColumn` can
 *     never be satisfied and the callback is unreachable with the real addon mounted. And that
 *     is the ONLY board a seeded SALES rep has - see the role note below. This is the same wall
 *     `SchedulePage.dragWiringGuard.test.ts` documents and the same fallback it sanctions: the
 *     call is matched as EXACT text, so neutering it (`seedCrewForActor(draft.crew, true, ...)`)
 *     fails as loudly as deleting it. `seedCrewForActor`'s own clauses are proven by running
 *     code in `components/schedule/scheduleModel.test.ts`.
 *
 *     THAT DROP IS NOW DRIVEN FOR REAL in `dropModalStandardLaneSelfCrew.test.tsx`, which stubs
 *     the drag-and-drop ADDON alone (leaving the page, the draft, the seed and the modal real) so
 *     `onDropFromOutside` can be fired the way RBC would fire it. Keep both: that file proves the
 *     seed's BEHAVIOUR on the target that needs it, this one proves the ability reaches the modal
 *     through the page's real wiring.
 *
 * WHY THE FIXTURE'S ROLE IS ADMIN WHILE THE ABILITY IS SELF-ONLY, and why that is not a
 * contrivance: `boardCapabilitiesFor` reads `user.role`, and it gives SALES `memberView: false` -
 * so the ONLY board a seeded SALES rep ever sees is the standard calendar, i.e. exactly the view
 * half 2 cannot drive. An ADMIN with `assign User` withheld is a real, supported configuration
 * (the per-user allow/deny overrides the assignee-pool decision record calls out), and it is the
 * one shape that puts a self-only viewer in front of a member lane a jsdom test can drop onto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, fireEvent, within } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { JOB_ID, FROM_MEMBER } from '@/components/schedule/dragChannels';

import SchedulePage from '../SchedulePage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ACTOR = { id: 'm-sales', first_name: 'Sam', last_name: 'Sales' };

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

const BUCKET_JOB = {
  id: 'job-bucket-1',
  job_number: 'J00043',
  title: 'Rooftop Unit Swap',
  status: 'UNSCHEDULED',
  customer: { id: 'c1', first_name: 'Acme', last_name: 'Corp' },
  scheduled_start: null,
  scheduled_end: null,
  assignees: [],
  visits: [],
};

const mockApi = vi.mocked(api);
const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });

/** The roster the SERVER would answer a self-only caller with: one row, and it is them. */
function mockBoard() {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED'
        || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [BUCKET_JOB] : [] } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({
        data: { users: [{ ...ACTOR, is_active: true, role: 'ADMIN' }] },
      });
    }
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    if (url === '/api/calendar-entries') return Promise.resolve({ data: { calendar_entries: [] } });
    return Promise.resolve({ data: {} });
  });
}

/** Board-capability role stays ADMIN (see the file note); WHO is at the keyboard is the actor. */
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

/** Mounts the board, switches to the Member week view, and drops the bucket card on the lane. */
async function dropBucketCardOnOwnLane(ability = SELF_ONLY) {
  mockBoard();
  renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability },
  );
  await screen.findAllByText(/J00043/);
  // By LABEL, not by text: the toolbar refresh turned Standard/Member from two text
  // segments into two icon segments. The name is unchanged and still on the control
  // (`aria-label="Member"`), but the only rendered "Member" string is now inside a
  // tooltip, which does not exist in the DOM until the control is hovered.
  fireEvent.click(screen.getByLabelText('Member'));

  const cell = await screen.findByTestId(
    `week-cell-${ACTOR.id}-${format(addDays(WEEK_START, 2), 'yyyy-MM-dd')}`,
  );
  // The same channels handleBucketCardDragStart writes on a real dragStart.
  fireEvent.drop(cell, {
    dataTransfer: {
      getData: (k: string) => (k === JOB_ID ? BUCKET_JOB.id : k === FROM_MEMBER ? '' : ''),
      types: [JOB_ID],
    },
  });
  return screen.findByRole('dialog');
}

/** The Crew field's own picker - the time fields are comboboxes too. */
const crewPicker = (dialog: HTMLElement) =>
  within(within(dialog).getByRole('group')).getByRole('combobox');

beforeEach(() => {
  vi.clearAllMocks();
  signedInAsActor();
});

describe('the board drop modal, for a viewer who may name nobody but themselves', () => {
  it('opens holding that viewer, by name', async () => {
    const dialog = await dropBucketCardOnOwnLane();
    // Not a placeholder and not a hint - the value the Schedule button will post.
    expect(await within(dialog).findByText('Sam Sales')).toBeInTheDocument();
  });

  it('locks the chip and the dropdown rather than offering a choice that does not exist', async () => {
    const dialog = await dropBucketCardOnOwnLane();
    await within(dialog).findByText('Sam Sales');

    // The chip is a statement, not an editable selection: taking themselves off would leave a
    // field they cannot refill. This is the assertion the lock owns - the trigger below is
    // disabled either way here, because a one-row roster already holding its one row has nothing
    // left to offer, which is exactly the server's answer to this viewer.
    expect(within(dialog).queryByRole('button', { name: /Remove Sam Sales/i })).not.toBeInTheDocument();
    expect(crewPicker(dialog)).toBeDisabled();
    // ...and it says which of the two silences this is - the rule, not an exhausted list.
    expect(within(dialog).getByText('You cannot add others')).toBeInTheDocument();
  });

  it('states NO rule - the locked field is the message', async () => {
    const dialog = await dropBucketCardOnOwnLane();
    // Ran removed the explanatory sentence on 1 Sep, from all three surfaces at once. Asserted
    // as an absence so a re-add on this door alone is caught: the board and the lead tab saying
    // different things is worse than either choice on its own. The API still answers a real
    // violation with that sentence; `selfOnlyRefusalCopy.test.ts` pins the backend copy.
    expect(within(dialog).queryByText('You can only assign yourself as job crew.')).not.toBeInTheDocument();
  });

  it('leaves Schedule alive - the lock is about WHO, never about whether', async () => {
    const dialog = await dropBucketCardOnOwnLane();
    expect(within(dialog).getByRole('button', { name: 'Schedule' })).toBeEnabled();
  });
});

describe('the board drop modal, for a holder of `assign User`', () => {
  it('is the field they have today - removable chip, live dropdown, no rule stated', async () => {
    const dialog = await dropBucketCardOnOwnLane(GRANT_HOLDER);
    await within(dialog).findByText('Sam Sales');

    // Removable, so a dispatcher can hand the trip to somebody else - the whole point of the
    // grant. The trigger is still disabled here only because this fixture's roster is one row
    // and that row is already on the card; its wording is the tell, and it is the OTHER silence.
    expect(within(dialog).getByRole('button', { name: /Remove Sam Sales/i })).toBeInTheDocument();
    expect(within(dialog).getByText('No more members')).toBeInTheDocument();
    expect(within(dialog).queryByText(/You can only (put yourself|assign yourself)/)).not.toBeInTheDocument();
  });
});

/**
 * The half a DOM test cannot reach (see the file note): the seed itself, which only fires on a
 * member-less drop target. Matched as exact text, so `|| true`, a hardcoded `true`, or a dropped
 * argument all fail - the neutering failure mode `SchedulePage.dragWiringGuard.test.ts` was
 * rewritten for.
 */
describe('openDropModal wires the seed and the lock (source scan)', () => {
  const SOURCE = readFileSync(join(__dirname, '../SchedulePage.tsx'), 'utf8');

  it('routes the drop-derived crew through seedCrewForActor with the live grant and actor', () => {
    expect(SOURCE).toContain(
      'draft: { ...draft, crew: seedCrewForActor(draft.crew, canAssignOthers, actorId) },',
    );
  });

  it('re-seeds when the grant or the actor changes, rather than closing over a stale pair', () => {
    // A drop is a user action, so there is no mount-time hydration window to cover - but the
    // callback must not be memoised on `[org]` alone or it would keep the pre-session verdict.
    expect(SOURCE).toContain('[org, canAssignOthers, actorId],');
  });

  it('hands the modal the SAME verdict the seed used, not a literal', () => {
    expect(SOURCE).toContain('canAssignOthers={canAssignOthers}');
  });
});
