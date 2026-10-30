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
 * WHY THERE IS NO MEMBER-LANE DROP FOR A SELF-ONLY VIEWER ANY MORE (Roles & Permissions S04.11): the
 * Member view's lanes for other people follow the Assign work to other people switch (`assign User`), where
 * they used to follow the signed-in person's role name. A viewer who may name nobody but themselves has one
 * lane and no Member view, so the only board they have is the standard calendar - the view half 2 cannot
 * drive, covered by `dropModalStandardLaneSelfCrew.test.tsx` (its self-only cases assert the same locked
 * chip, the absent rule and the live Schedule button this file used to assert on a member lane). What stays
 * here is the grant holder, whose Member view and removable chip are still reachable, and the proof that the
 * self-only viewer is not offered the lane at all.
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

/** Reads the board, may schedule visits and assign people to jobs - and may NOT name anybody but themselves. */
const SELF_ONLY = buildAbility([
  { action: 'read', subject: 'all' },
  { action: 'update', subject: 'Job' },
  { action: 'reschedule', subject: 'Job' },
  { action: 'assign', subject: 'Job' },
  { action: 'create', subject: 'Job' },
]);
/** The same viewer plus the one grant. Nothing else differs. */
const GRANT_HOLDER = buildAbility([
  { action: 'read', subject: 'all' },
  { action: 'update', subject: 'Job' },
  { action: 'reschedule', subject: 'Job' },
  { action: 'assign', subject: 'Job' },
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

/** WHO is at the keyboard is the actor. The board's controls follow the ability, never this role. */
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

beforeEach(() => {
  vi.clearAllMocks();
  signedInAsActor();
});

describe('the board, for a viewer who may name nobody but themselves', () => {
  it('has one lane: no Member view to drop a card on', async () => {
    mockBoard();
    renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: SELF_ONLY },
    );
    await screen.findAllByText(/J00043/);
    expect(screen.queryByLabelText('Member')).not.toBeInTheDocument();
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
      'crew: ev.type === \'job\' && !canAssignJobCrew ? [] : seedCrewForActor(draft.crew, canAssignOthers, actorId),',
    );
  });

  it('re-seeds when the grant or the actor changes, rather than closing over a stale pair', () => {
    // A drop is a user action, so there is no mount-time hydration window to cover - but the
    // callback must not be memoised on `[org]` alone or it would keep the pre-session verdict.
    expect(SOURCE).toContain('[org, canAssignOthers, canAssignJobCrew, actorId],');
  });

  it('hands the modal the SAME verdict the seed used, not a literal', () => {
    expect(SOURCE).toContain('canAssignOthers={canAssignOthers}');
  });
});
