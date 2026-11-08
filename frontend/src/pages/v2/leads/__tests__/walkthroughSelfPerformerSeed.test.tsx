// THE LAST MILE OF THE REPORTED BUG. A salesperson opens their own lead's Walkthrough tab and the
// Performers field is empty, so `wtPerformers.length === 0` holds Schedule Walkthrough disabled -
// and the dropdown that would fix it offers nobody, because their scoped roster is one row long
// and it is them. The field must therefore ARRIVE holding that one row, locked, with the rule
// written under it.
//
// WHY NOT `walkthroughSchedule.test.tsx` / `walkthroughReschedule.test.tsx`. Both STUB
// MultiAssigneeSelect with a button that ignores `disabled`, `purpose` and `knownPeople`, and the
// repo's only Schedule-button enablement assertion lives in that first file and supplies the
// performer by CLICKING that stub. It passes identically with and without any of this. This suite
// renders the REAL picker (mocking only the roster endpoint behind it, as
// `walkthroughPerformersScoped.test.tsx` does) so the seeding, the lock and the button are all
// judged on what a person would actually see.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { WalkthroughTabContent, walkthroughSyncKey } from '../components/walkthroughTab';

// The walkthrough form now holds TWO comboboxes - Performers and the visit-location picker
// added by the visit-location spec - so every query here names the one it means. The
// Performers field is named by its own <Label htmlFor>, so this stays stable whether the field
// is empty or holds chips.
const PERFORMERS = { name: /performers/i };

const SALES = { id: 'u-sales', first_name: 'Sam', last_name: 'Sales' };
const TECH = { id: 'u-tech', first_name: 'Terry', last_name: 'Tech' };
/** A SECOND performer, so the multi-performer arity is a real fixture and not an assumption. */
const TECH2 = { id: 'u-tech-2', first_name: 'Pat', last_name: 'Pike' };

/** The roster `GET /api/users/assignable` answers with - one row for a self-only viewer. */
const rosterState = vi.hoisted(() => ({
  users: [] as { id: string; first_name: string; last_name: string; role: string; department: null }[],
}));

vi.mock('@/lib/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/users')>()),
  useAssignableUsers: () => ({ data: rosterState.users }),
}));

vi.mock('@/lib/schedule-tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/schedule-tz')>()),
  useScheduleTimezone: () => 'America/New_York',
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

/** SALES: books walkthroughs on their own leads, holds NO `assign User`. That grant is the switch. */
const selfOnlyAbility = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
]);
/** The same rep plus the one grant, i.e. a dispatcher. Nothing else differs. */
const grantHolderAbility = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
  { action: 'assign', subject: 'User' },
]);

/** The global setup mock signs in an ADMIN; every case here says who is at the keyboard. */
function signedInAs(id: string | null) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: id ? { ...SALES, id, email: 'sam@test.com', role: 'SALES' } : null,
      isAuthenticated: Boolean(id),
      isLoading: false,
      error: null,
    } as never),
  );
}

/** A lead with no walkthrough at all: the tab's booking form, and the dead button. */
const UNBOOKED = {
  walkthrough_scheduled_at: null,
  walkthrough_completed_at: null,
  walkthrough_cancelled_at: null,
  walkthrough_notes: '',
  walkthrough_performers: [] as { user: typeof TECH }[],
};

/** Already booked, with a technician a DISPATCHER put on it - somebody this viewer cannot name. */
const BOOKED_WITH_TECH = {
  ...UNBOOKED,
  walkthrough_scheduled_at: '2026-09-10T15:00:00.000Z',
  walkthrough_duration_minutes: 60,
  walkthrough_performers: [{ user: TECH }],
};

/**
 * THE REPRO (staging demo org, lead L00139): every visit this lead ever had is CANCELLED, and
 * nothing is live. The wire key still names the person who was on the cancelled trip, so the
 * form used to arrive holding a technician this rep may not name, with no remove control - and
 * the POST it pre-filled came back 403 quoting the very sentence printed under the field.
 *
 * The server's notion of "already staffed" is `findActiveWalkthrough`: the LIVE visit, and there
 * is none here. The form has to agree, or it leads people into that 403.
 */
const CANCELLED_ONLY = {
  ...UNBOOKED,
  walkthrough_scheduled_at: '2026-08-01T15:00:00.000Z',
  walkthrough_duration_minutes: 60,
  walkthrough_cancelled_at: '2026-08-02T10:00:00.000Z',
  walkthrough_cancelled_reason: 'Customer rescheduled',
  walkthrough_performers: [{ user: TECH }],
};

/** The same booking, crewed by TWO people. "Existing visits with multiple performers keep them"
 *  is an acceptance criterion in its own right, and the one-performer fixture above cannot
 *  distinguish "keeps what is stored" from "keeps the FIRST of what is stored". */
const BOOKED_WITH_TWO = {
  ...BOOKED_WITH_TECH,
  walkthrough_performers: [{ user: TECH }, { user: TECH2 }],
};

function renderTab(lead: Record<string, unknown>, ability = selfOnlyAbility) {
  return renderWithProviders(
    <WalkthroughTabContent
      lead={lead}
      leadId="lead-1"
      canPerformWalkthrough={false}
      canScheduleWalkthrough
    />,
    { ability },
  );
}

/** [start date, start time, end date, end time] - the four ScheduleTimeFields inputs. */
function timeFields() {
  return screen.getAllByRole('textbox').filter(
    (el) => (el as HTMLInputElement).placeholder === 'MM/DD/YYYY'
      || (el as HTMLInputElement).placeholder === 'Time',
  ) as HTMLInputElement[];
}

beforeEach(() => {
  rosterState.users = [{ ...SALES, role: 'SALES', department: null }];
  signedInAs(SALES.id);
});

describe('a rep who may not name others finds themselves already on the walkthrough', () => {
  it('pre-fills the empty Performers field with the one person the API would accept', async () => {
    renderTab(UNBOOKED);

    // Not a placeholder and not a hint - the value itself, which is what the POST will carry.
    expect(screen.getByText('Sam Sales')).toBeInTheDocument();
  });

  it('locks the chip and the dropdown rather than offering a choice that does not exist', async () => {
    renderTab(UNBOOKED);

    // The chip is a statement, not an editable selection: taking themselves off would leave a
    // field they cannot refill.
    expect(screen.queryByRole('button', { name: /Remove Sam Sales/i })).not.toBeInTheDocument();
    // The combobox will not open. Its own wording already says why (slice 3), and the roster
    // behind it holds nobody else in any case.
    expect(screen.getByRole('combobox', PERFORMERS)).toBeDisabled();
    expect(screen.getByText('You cannot add others')).toBeInTheDocument();
  });

  it('says NOTHING under the field - the lock is the whole message', async () => {
    renderTab(UNBOOKED);

    // Ran removed the explanatory sentence on 1 Sep: a field holding your own name, with no
    // remove control and a combobox that will not open, already states the rule. This asserts
    // its ABSENCE so a well-meaning re-add is caught rather than quietly accepted. The API still
    // returns that sentence on a 403 - `selfOnlyRefusalCopy.test.ts` pins the backend copy.
    expect(screen.queryByText('You can only put yourself on a walkthrough.')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', PERFORMERS)).toBeDisabled();
  });

  // THE BUTTON. This is the assertion the pre-slice-4 code fails: with nobody seeded,
  // `wtPerformers.length === 0` holds Schedule Walkthrough disabled no matter how complete the
  // time fields are, and this rep has no way to add the missing performer.
  it('brings Schedule Walkthrough alive once a date and time are entered', async () => {
    const user = userEvent.setup();
    renderTab(UNBOOKED);

    const button = screen.getByRole('button', { name: /Schedule Walkthrough/ });
    // Nothing to post yet: no date. Proves the enablement below is the fields' doing.
    expect(button).toBeDisabled();

    await user.type(timeFields()[0]!, '09/10/2026');
    await user.tab();
    await user.type(timeFields()[1]!, '9:00 AM');
    await user.tab();

    expect(button).toBeEnabled();
  });

  it('keeps the performers a visit already has instead of re-seeding them', async () => {
    const user = userEvent.setup();
    renderTab(BOOKED_WITH_TECH);
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));

    // The technician stays, named off the lead's own payload (they are not in this roster), and
    // the viewer is NOT quietly added as a second performer to a visit that already has one.
    expect(screen.getByText('Terry Tech')).toBeInTheDocument();
    expect(screen.queryByText('Sam Sales')).not.toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    // ...and moving the time is therefore a ONE-FIELD change. Save New Time shares the whole of
    // `scheduleBlocked` with Schedule Walkthrough, so a viewer who cannot edit this field would
    // be stuck on a dead button if the stored performers had been dropped - the same bug, on the
    // reschedule door. Nothing is re-picked here; the button is simply alive.
    expect(screen.getByRole('button', { name: /Save New Time/ })).toBeEnabled();
  });

  // THE REPRO, as a test. Everything this lead ever had is cancelled, so there is no live visit
  // and the server takes the strict path - the seed has to fire here exactly as it does on a
  // lead that never had a visit at all.
  it('seeds the actor on a lead whose only visits are cancelled, not the cancelled visit\'s crew', async () => {
    renderTab(CANCELLED_ONLY);

    // The one person this rep may name, and the one the API will accept from them.
    expect(screen.getByText('Sam Sales')).toBeInTheDocument();
    // NOT the technician off the cancelled trip. His name in this field is what the 403 was:
    // the form pre-filled him, refused to let go of him, and then the save quoted the rule back.
    expect(screen.queryByText('Terry Tech')).not.toBeInTheDocument();
    // Still locked - narrowing the seed must not quietly unlock the field.
    expect(screen.queryByRole('button', { name: /Remove Sam Sales/i })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', PERFORMERS)).toBeDisabled();
    expect(screen.queryByText('You can only put yourself on a walkthrough.')).not.toBeInTheDocument();
    // The cancelled visit's time is still seeded into the fields, so the ONLY thing that ever
    // held this button back was the performer. It is alive, and what it posts is `[Sam Sales]`.
    expect(screen.getByRole('button', { name: /Schedule Walkthrough/ })).toBeEnabled();
  });

  it('keeps BOTH performers on a visit that has two, and adds itself to neither end', async () => {
    const user = userEvent.setup();
    renderTab(BOOKED_WITH_TWO);
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));

    // Both survive, both named off the lead's own payload - this viewer's roster holds neither.
    expect(screen.getByText('Terry Tech')).toBeInTheDocument();
    expect(screen.getByText('Pat Pike')).toBeInTheDocument();
    // Neither replaced by the actor, and the actor not appended as a third.
    expect(screen.queryByText('Sam Sales')).not.toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    // The stored set is intact, so rescheduling stays the one-field change it was.
    expect(screen.getByRole('button', { name: /Save New Time/ })).toBeEnabled();
  });

  // The grant and the actor both arrive with the session. A tab that mounted first reads
  // `{ canAssignOthers: false, actorId: '' }` and must seed nothing - `['']` is a 400 - then seed
  // for real the moment the session lands.
  it('seeds nobody before the session lands, and the right person after it does', async () => {
    const user = userEvent.setup();
    signedInAs(null);
    const { rerender } = renderTab(UNBOOKED);

    expect(screen.queryByText('Sam Sales')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Schedule Walkthrough/ })).toBeDisabled();
    // NOBODY, not an id-shaped blank. Seeding `['']` would render a chip reading `Unknown` and -
    // worse - satisfy `wtPerformers.length === 0`, so a complete date and time would ARM the
    // button on a payload the API answers 400 "Performer not found or inactive" for. The guard
    // is what stops that, so the test has to reach past the empty field to the button.
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    await user.type(timeFields()[0]!, '09/10/2026');
    await user.tab();
    await user.type(timeFields()[1]!, '9:00 AM');
    await user.tab();
    expect(screen.getByRole('button', { name: /Schedule Walkthrough/ })).toBeDisabled();

    signedInAs(SALES.id);
    rerender(
      <WalkthroughTabContent
        lead={UNBOOKED}
        leadId="lead-1"
        canPerformWalkthrough={false}
        canScheduleWalkthrough
      />,
    );

    expect(screen.getByText('Sam Sales')).toBeInTheDocument();
  });
});

/**
 * WHO THE RULE LINE IS FOR - and it is not everyone the field is disabled for.
 *
 * The default (no-active-visit) branch renders the whole scheduling block unconditionally; only
 * the Schedule Walkthrough BUTTON is gated on `canScheduleWalkthrough`. So a role holding
 * `read Lead` and neither of the two grants reaches this form, sees a disabled Performers field
 * pre-seeded with their own name, and used to be told they may only put THEMSELVES on a
 * walkthrough - when they may put nobody on anything, and it is the other grant stopping them.
 */
describe('a viewer who cannot schedule at all is told nothing about who they may name', () => {
  const readOnlyAbility = buildAbility([{ action: 'read', subject: 'Lead' }]);

  const renderReadOnly = () =>
    renderWithProviders(
      <WalkthroughTabContent
        lead={UNBOOKED}
        leadId="lead-1"
        canPerformWalkthrough={false}
        canScheduleWalkthrough={false}
      />,
      { ability: readOnlyAbility },
    );

  it('leaves everything else about that branch exactly as it was', () => {
    renderReadOnly();
    // The field is still on screen and still disabled - by `canScheduleWalkthrough` this time -
    // and there is still no button to press. Only the sentence went.
    expect(screen.getByRole('combobox', PERFORMERS)).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Schedule Walkthrough/ })).not.toBeInTheDocument();
  });

  // The two tests that used to live here guarded the `canScheduleWalkthrough && !canAssignOthers`
  // conjunction on the explanatory line. The line is gone, so the conjunction is gone with it -
  // deleting them beats leaving two tests asserting a rule about nothing.
});

describe('a holder of `assign User` keeps the field they have today', () => {
  beforeEach(() => {
    rosterState.users = [
      { ...SALES, role: 'SALES', department: null },
      { ...TECH, role: 'TECHNICIAN', department: null },
    ];
  });

  it('starts empty, opens onto the roster and says nothing about a rule', async () => {
    const user = userEvent.setup();
    renderTab(UNBOOKED, grantHolderAbility);

    // No seed: a dispatcher booking somebody else's walkthrough must not start with their own
    // name in the field.
    expect(screen.queryByText('Sam Sales')).not.toBeInTheDocument();
    // And no rule stated under a field that has no rule on it.
    expect(screen.queryByText('You can only put yourself on a walkthrough.')).not.toBeInTheDocument();

    const combobox = screen.getByRole('combobox', PERFORMERS);
    expect(combobox).toBeEnabled();
    await user.click(combobox);
    expect(await screen.findByRole('option', { name: /Terry Tech/ })).toBeInTheDocument();
  });
});

// The page mounts this tab under `walkthroughSyncKey`, so the key is the ONLY thing that re-seeds
// a tab already on screen. The seed now reads the completed/cancelled stamps, so the key has to
// as well - and those are exactly the two transitions that move nothing else it reads.
describe('the resync key covers everything the seed reads', () => {
  const LIVE = {
    ...BOOKED_WITH_TECH,
    walkthrough_notes: '',
  };

  it('moves when the current visit is cancelled, though its time, crew and notes do not', () => {
    // A cancel writes `cancelled_at` and touches nothing else on the wire: the same visit, at the
    // same time, with the same crew. Without the stamp in the key the tab would sit there holding
    // a seed the server has stopped agreeing with.
    expect(walkthroughSyncKey({ ...LIVE, walkthrough_cancelled_at: '2026-09-11T10:00:00.000Z' }))
      .not.toBe(walkthroughSyncKey(LIVE));
  });

  it('moves when the current visit is completed, on the same reasoning', () => {
    expect(walkthroughSyncKey({ ...LIVE, walkthrough_completed_at: '2026-09-10T16:00:00.000Z' }))
      .not.toBe(walkthroughSyncKey(LIVE));
  });
});
