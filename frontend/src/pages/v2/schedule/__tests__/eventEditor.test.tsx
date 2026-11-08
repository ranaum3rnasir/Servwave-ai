/**
 * The v2 event editor - the port of
 * `src/components/schedule/EventEditor.test.tsx` onto the rebuilt component at
 * `pages/v2/schedule/components/eventEditor.tsx`.
 *
 * The contract is unchanged by the rebuild: this is the ONLY per-person crew
 * path (drags are whole-lane swaps, the D5 modal is initial scheduling), it is
 * a PURE controlled dialog that stages crew and time drafts locally and emits
 * onSaveCrew / onSaveTime / onUnschedule / onClose, and the commission owner is
 * OFF-BOARD - display only.
 *
 * ONE ASSERTION HAD TO CHANGE, and the change is the finding rather than a
 * concession:
 *
 *  1. NAVIGATION TARGETS ARE PINNED. `detailUrlOf` runs the path through
 *     `preferV2Path`, so the popup navigates to `/jobs/:id` and
 *     `/leads/:id?tab=walkthrough` - the same destinations the original
 *     component used. They were `/v2`-prefixed for as long as the two designs
 *     sat at different URLs; `preferV2Path` is a no-op shim now (see `uiV2.ts`),
 *     so the destinations are pinned here to catch it ever growing logic again.
 *
 *  2. CALL / TEXT ARE BUTTONS, NOT ANCHORS. The legacy pair are raw `tel:` and
 *     `sms:` anchors carrying the destination in `href`. The raw-anchor ratchet
 *     is at its floor, so the v2 pair are kit Buttons that assign
 *     `window.location.href` on click. Same destinations and same accessible
 *     names, reached differently - so `toHaveAttribute('href', ...)` becomes a
 *     click plus an assertion on the assigned location. This is a real
 *     behavioural difference: there is no middle-click, no long-press "copy
 *     link", and no href for a screen reader's link list.
 */
import { asWallClock } from '@/lib/schedule-tz';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentProps } from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import api from '@/lib/axios';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';
import type { AssignableUser } from '@/lib/api/users';

import { EM, EN } from '../glyphs';
import { EventEditor } from '../components/eventEditor';

// Navigation spy: whole-popup click + Open-full-page must navigate via useNavigate.
const navSpy = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig() as object),
  useNavigate: () => navSpy,
}));

// The call/text buttons assign window.location.href. jsdom's real Location
// cannot be assigned to, so it is swapped for a plain object for this file.
const REAL_LOCATION = window.location;
Object.defineProperty(window, 'location', {
  configurable: true,
  writable: true,
  value: { ...window.location, href: '' },
});
afterAll(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: REAL_LOCATION });
});

// The PICKER roster. It carries no contact fields at all - `/api/users/assignable` is gated
// on `assign User` and answers "who may I ADD", so crew phone numbers cannot come from here.
// The fixture used to invent a `phone` key the API can no longer return, which made the crew
// contact test below a false green: vitest does not typecheck, so only tsc ever saw it.
const MEMBERS: AssignableUser[] = [
  { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', role: 'TECHNICIAN', department: null },
  { id: 'u-bob', first_name: 'Bob', last_name: 'Ortiz', role: 'TECHNICIAN', department: null },
];

/**
 * Somebody the picker COULD add: NOT on the job, so `available` is non-empty and the trigger's
 * enabled/disabled state is decided by the `disabled` prop alone rather than by an exhausted
 * list. Both slice-4 describes below depend on that separation.
 */
const CAROL: AssignableUser = {
  id: 'u-carol', first_name: 'Carol', last_name: 'Diaz', role: 'TECHNICIAN', department: null,
};

const OWNER = { id: 'u-olivia', first_name: 'Olivia', last_name: 'Owner' };

/** Reads the board and may edit it - and may NOT name anybody but themselves (`assign User`). */
const SELF_ONLY = buildAbility([
  { action: 'read', subject: 'all' },
  { action: 'update', subject: 'Job' },
]);
/** The same viewer plus the one grant. Nothing else differs. */
const GRANT_HOLDER = buildAbility([
  { action: 'read', subject: 'all' },
  { action: 'update', subject: 'Job' },
  { action: 'assign', subject: 'User' },
]);

/** State-2 job: crew >=1 + timed, SCHEDULED; owner reached via estimate.lead. */
const scheduledJob: SchedulableEvent = {
  boardId: 'job-1',
  parentId: 'job-1',
  type: 'job',
  number: 'J00043',
  title: 'Rooftop Unit Swap',
  customer: 'Acme Corp',
  crew: ['u-alice', 'u-bob'],
  ownerId: 'u-olivia',
  start: asWallClock(new Date(2026, 5, 10, 9, 0)),
  end: asWallClock(new Date(2026, 5, 10, 11, 0)),
  raw: {
    status: 'SCHEDULED',
    customer: { phone: '555-0199' },
    // The header's address line reads the JOB's own location (entityAddress.jobAddress),
    // never the customer's - a customer can have several sites.
    service_location: { address_line1: '12 Depot Way', city: 'Austin', state: 'TX' },
    // The crew's contact detail rides on the RECORD (jobListSelect projects `phone` onto
    // `assignees[].user`), which is what the call/text affordance reads. Bob has none, so he
    // is the "no phone, no affordance" half of the same assertion.
    assignees: [
      { user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', phone: '555-0101' } },
      { user: { id: 'u-bob', first_name: 'Bob', last_name: 'Ortiz', phone: null } },
    ],
    estimate: { lead: { commission_owner: OWNER } },
  },
};

/** Timed walkthrough - owner read straight off lead.commission_owner. */
const walkthrough: SchedulableEvent = {
  boardId: 'wt-lead-1',
  parentId: 'lead-1',
  type: 'walkthrough',
  number: 'L00012',
  title: 'Initial site visit',
  customer: 'Acme Corp',
  crew: ['u-alice'],
  ownerId: 'u-olivia',
  start: asWallClock(new Date(2026, 5, 11, 14, 0)),
  end: asWallClock(new Date(2026, 5, 11, 15, 0)),
  raw: {
    id: 'lead-1',
    status: 'CONTACTED',
    walkthrough_performers: [{ user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', phone: '555-0101' } }],
    commission_owner: OWNER,
  },
};

/** State-3 job: keeps its crew, no time. */
const unscheduledJob: SchedulableEvent = {
  ...scheduledJob,
  boardId: 'job-2',
  parentId: 'job-2',
  number: 'J00044',
  start: null,
  end: null,
};

function renderEditor(
  over: Partial<ComponentProps<typeof EventEditor>> = {},
  renderOptions: Parameters<typeof renderWithProviders>[1] = {},
) {
  const onSaveCrew = vi.fn();
  const onSaveTime = vi.fn();
  const onUnschedule = vi.fn();
  const onComplete = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <EventEditor
      open
      event={scheduledJob}
      members={MEMBERS}
      // The DEFAULT is the grant holder, so every pre-slice-4 case below is the field it has
      // always described. The lock is asked for explicitly, in its own describe block.
      canAssignOthers
      canUnschedule
      onSaveCrew={onSaveCrew}
      onSaveTime={onSaveTime}
      onUnschedule={onUnschedule}
      onComplete={onComplete}
      onClose={onClose}
      {...over}
    />,
    renderOptions,
  );
  return { onSaveCrew, onSaveTime, onUnschedule, onComplete, onClose };
}

beforeEach(() => {
  // MultiAssigneeSelect self-fetches the org-wide assignable roster for chip labels.
  // GET /api/users/assignable answers with a BARE array - no `{ users }` wrapper.
  vi.mocked(api.get).mockResolvedValue({ data: MEMBERS });
  vi.mocked(api.post).mockClear();
  navSpy.mockClear();
  window.location.href = '';
});

describe('v2 EventEditor', () => {
  it('renders a state-2 job: type pill, owner row, crew chips, time inputs', async () => {
    renderEditor();
    // Header line 1: type pill, then the number and the customer as ONE string - the
    // same way the board's own cards name a job, so the modal opens saying what you
    // clicked. The job's own title ("Rooftop Unit Swap") is deliberately not here: the
    // header carries identity, address and reach, and the scope line was dropped from it.
    expect(screen.getByText('Job')).toBeInTheDocument();
    expect(screen.getByText(`J00043 ${EN} Acme Corp`)).toBeInTheDocument();
    expect(screen.queryByText(/Rooftop Unit Swap/)).not.toBeInTheDocument();
    // Line 2 is the JOB's own service location - never resolved through the customer.
    expect(screen.getByText('12 Depot Way, Austin, TX')).toBeInTheDocument();
    // A crewed job flies no flag, and the state banner that used to sit under the
    // header is gone with it - its label and hint duplicated the crew field and the
    // schedule field directly below.
    expect(screen.queryByText('Needs crew')).not.toBeInTheDocument();
    expect(screen.queryByText(/crew ≥1 · timed/)).not.toBeInTheDocument();
    // Owner row - off-board, read-only
    expect(screen.getByText('Owner (off-board)')).toBeInTheDocument();
    expect(screen.getByText('Olivia Owner')).toBeInTheDocument();
    // Current crew as chips (labels resolve from the event payload, roster second). Alice
    // also has a contact row (she has a phone) so her name can appear more than once.
    expect((await screen.findAllByText('Alice Ng')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Bob Ortiz')).length).toBeGreaterThan(0);
    // Timed, so the schedule fields are pre-filled from the event. Both are
    // typeable pickers now (`_shared/datePicker` / `_shared/timeCombobox`), so
    // they DISPLAY US text - MM/DD/YYYY and a 12-hour clock - where the native
    // inputs showed their raw 'yyyy-MM-dd' / 'HH:mm' in the browser's locale.
    // The value handed to the handlers is unchanged.
    expect(screen.getByLabelText('Start date')).toHaveValue('06/10/2026');
    expect(screen.getByLabelText('Start time')).toHaveValue('9:00 AM');
    // The event's duration reads as an end, not as a Duration dropdown: `onSaveTime`
    // still speaks start + durationMin, and the duration is derived at that seam.
    expect(screen.getByLabelText('End date')).toHaveValue('06/10/2026');
    expect(screen.getByLabelText('End time')).toHaveValue('11:00 AM');
    expect(screen.queryByLabelText('Duration')).not.toBeInTheDocument();
    // Nothing is dirty yet, so no save buttons
    expect(screen.queryByRole('button', { name: 'Save crew' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save time' })).not.toBeInTheDocument();
  });

  it('crew edit + Save crew emits the full REPLACE array - and the component never POSTs', async () => {
    const { onSaveCrew } = renderEditor();
    fireEvent.click(await screen.findByLabelText('Remove Alice Ng'));
    // Draft differs from the event crew, so the explicit save button appears
    fireEvent.click(screen.getByRole('button', { name: 'Save crew' }));
    expect(onSaveCrew).toHaveBeenCalledWith(['u-bob']);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('time edit + Save time emits (start, durationMin, allDay) - page owns the POST', () => {
    const { onSaveTime } = renderEditor();
    // A typeable field commits on blur, so the edit is change-then-blur. It
    // still emits 'HH:mm' to handleTimeChange, hence the same Date below.
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '1:30 PM' } });
    fireEvent.blur(screen.getByLabelText('Start time'));
    fireEvent.click(screen.getByRole('button', { name: 'Save time' }));
    expect(onSaveTime).toHaveBeenCalledWith(new Date(2026, 5, 10, 13, 30), 120, false);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('All day removes both time fields - an all-day job has no time of day', () => {
    renderEditor();
    expect(screen.getByLabelText('Start time')).toBeInTheDocument();
    expect(screen.getByLabelText('End time')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /All day/i }));

    expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('End time')).not.toBeInTheDocument();
    // The dates are what an all-day booking is made of, so they stay.
    expect(screen.getByLabelText('Start date')).toBeInTheDocument();
    expect(screen.getByLabelText('End date')).toBeInTheDocument();
  });

  it('ticking All day is itself an edit, and saves a whole-day span', () => {
    const { onSaveTime } = renderEditor();
    fireEvent.click(screen.getByRole('checkbox', { name: /All day/i }));

    // Ticking the box with no other change still counts as dirty - otherwise a
    // timed job could never BECOME an all-day one.
    fireEvent.click(screen.getByRole('button', { name: 'Save time' }));

    const [, durationMin, allDay] = vi.mocked(onSaveTime).mock.calls[0]!;
    expect(allDay).toBe(true);
    // One calendar day, inclusive - not the job's original 2h.
    expect(durationMin).toBe(1440);
  });

  it('Move to Unscheduled fires onUnschedule (page owns confirm + POST)', () => {
    const { onUnschedule } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Move to Unscheduled/ }));
    expect(onUnschedule).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('canUnschedule=false disables the button and renders the reason', () => {
    renderEditor({
      canUnschedule: false,
      unscheduleDisabledReason: "In-progress jobs can't be unscheduled.",
    });
    expect(screen.getByRole('button', { name: /Move to Unscheduled/ })).toBeDisabled();
    expect(screen.getByText("In-progress jobs can't be unscheduled.")).toBeInTheDocument();
  });

  it('a walkthrough renders its type pill and owner', () => {
    renderEditor({ event: walkthrough });
    expect(screen.getByText('Walkthrough')).toBeInTheDocument();
    // Same one-line identity as a job, reading the LEAD's number and customer.
    expect(screen.getByText(`L00012 ${EN} Acme Corp`)).toBeInTheDocument();
    expect(screen.getByText('Owner (off-board)')).toBeInTheDocument();
    expect(screen.getByText('Olivia Owner')).toBeInTheDocument();
  });

  it('readOnly renders crew as plain text with no editing affordances', () => {
    renderEditor({ readOnly: true });
    // Joined names are per-member rows - both names still queryable.
    expect(screen.getByText('Alice Ng')).toBeInTheDocument();
    expect(screen.getByText('Bob Ortiz')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove Alice Ng')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save crew' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save time' })).not.toBeInTheDocument();
    // The unschedule action is hidden entirely when readOnly
    expect(screen.queryByRole('button', { name: /Move to Unscheduled/ })).not.toBeInTheDocument();
    // Time renders as text, not inputs
    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();
  });

  it('an unscheduled event says so - no time inputs, no unschedule button', () => {
    renderEditor({ event: unscheduledJob });
    expect(screen.getByText(new RegExp(`Unscheduled ${EM}`))).toBeInTheDocument();
    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument();
    // Move to Unscheduled is for TIMED events only
    expect(screen.queryByRole('button', { name: /Move to Unscheduled/ })).not.toBeInTheDocument();
  });

  it('Mark Complete is a job-only, canComplete-only affordance and emits onComplete', () => {
    const { onComplete } = renderEditor({ canComplete: true });
    fireEvent.click(screen.getByRole('button', { name: /Mark Complete/ }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('Mark Complete is absent without canComplete, on a walkthrough, and when readOnly', () => {
    renderEditor();
    expect(screen.queryByRole('button', { name: /Mark Complete/ })).not.toBeInTheDocument();
    renderEditor({ event: walkthrough, canComplete: true });
    expect(screen.queryByRole('button', { name: /Mark Complete/ })).not.toBeInTheDocument();
    renderEditor({ canComplete: true, readOnly: true });
    expect(screen.queryByRole('button', { name: /Mark Complete/ })).not.toBeInTheDocument();
  });

  // ── whole-popup click, Open-full-page icon, call/text affordances ──

  it('clicking a non-interactive body area closes and navigates to the job page', () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByText('Owner (off-board)')); // a label, not a control
    expect(onClose).toHaveBeenCalled();
    // v2 delta: the destination is the v2 job page, not the bare legacy path.
    expect(navSpy).toHaveBeenCalledWith('/jobs/job-1');
  });

  it('clicking interactive elements does NOT close or navigate', async () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByLabelText('Start date'));                  // input
    fireEvent.click(await screen.findByLabelText('Remove Alice Ng'));      // crew chip button
    fireEvent.click(screen.getByLabelText('Call Alice Ng'));               // call affordance
    expect(onClose).not.toHaveBeenCalled();
    expect(navSpy).not.toHaveBeenCalled();
  });

  /**
   * Slice 07. The crew picker is a non-modal popover now, so two things reach this whole-popup
   * click guard that the old modal Select never let through: clicks INSIDE the open list (it
   * portals to <body>, but React bubbles the click through this dialog anyway, and the search
   * row, list padding and "No results" line are not controls), and a click on the popup's dead
   * space while the list is open. Either one used to throw away an unsaved crew edit by
   * navigating to the job page.
   */
  describe('with the crew list open', () => {
    async function openCrewList(user: ReturnType<typeof userEvent.setup>) {
      vi.mocked(api.get).mockResolvedValue({ data: [...MEMBERS, CAROL] });
      const handlers = renderEditor({ members: [...MEMBERS, CAROL] }, { ability: GRANT_HOLDER });
      // An unsaved crew edit, so navigating away would visibly lose something.
      await user.click(await screen.findByLabelText('Remove Alice Ng'));
      expect(screen.getByRole('button', { name: 'Save crew' })).toBeInTheDocument();
      await user.click((await screen.findByText('Add member...')).closest('button')!);
      await screen.findByRole('option', { name: /Carol Diaz/ });
      return handlers;
    }

    it('a click on dead space only closes the list - no navigation, the edit survives', async () => {
      const user = userEvent.setup();
      const { onClose } = await openCrewList(user);

      await user.click(screen.getByText('12 Depot Way, Austin, TX'));

      await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());
      expect(navSpy).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Save crew' })).toBeInTheDocument();
    });

    it('a click inside the open list that is not an option never navigates', async () => {
      const user = userEvent.setup();
      const { onClose } = await openCrewList(user);

      const search = screen.getByRole('textbox', { name: 'Search options' });
      await user.click(search.parentElement!); // the search row's padding
      await user.type(search, 'zzz');
      await user.click(await screen.findByText('No results for "zzz"'));

      expect(navSpy).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Save crew' })).toBeInTheDocument();
    });

    it('once the list is closed, dead space navigates again as it always has', async () => {
      const user = userEvent.setup();
      const { onClose } = await openCrewList(user);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());

      await user.click(screen.getByText('12 Depot Way, Austin, TX'));

      expect(onClose).toHaveBeenCalled();
      expect(navSpy).toHaveBeenCalledWith('/jobs/job-1');
    });
  });

  it('the header offers no second route to the detail page', () => {
    renderEditor();
    // An Open-full-page icon used to sit beside the close X. It went where the
    // footer's View details already goes, so the corner is the crew flag's now and
    // there is exactly one way out to the record.
    expect(screen.queryByRole('button', { name: 'Open full page' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /View details/ })).toHaveLength(1);
  });

  it('View details on a walkthrough navigates to the lead walkthrough tab', () => {
    renderEditor({ event: walkthrough });
    fireEvent.click(screen.getByRole('button', { name: /View details/ }));
    // The ?tab= suffix is appended AFTER the v2 prefix is resolved: the matcher
    // compares path segments, so a query string on the last one would make it
    // unmatchable and silently drop the user out of v2.
    expect(navSpy).toHaveBeenCalledWith('/leads/lead-1?tab=walkthrough');
  });

  it('a crewless job flies the Needs crew flag in the header corner', () => {
    renderEditor({ event: { ...scheduledJob, crew: [] } });
    expect(screen.getByText('Needs crew')).toBeInTheDocument();
  });

  it('offers call/text next to the customer name from the payload phone', () => {
    renderEditor();
    fireEvent.click(screen.getByLabelText('Call Acme Corp'));
    expect(window.location.href).toBe('tel:555-0199');
    fireEvent.click(screen.getByLabelText('Text Acme Corp'));
    expect(window.location.href).toBe('sms:555-0199');
  });

  it('crew contact affordances: crew member with a PAYLOAD phone gets call/text, phoneless member gets none (edit mode)', () => {
    renderEditor();
    fireEvent.click(screen.getByLabelText('Call Alice Ng'));
    expect(window.location.href).toBe('tel:555-0101');
    fireEvent.click(screen.getByLabelText('Text Alice Ng'));
    expect(window.location.href).toBe('sms:555-0101');
    expect(screen.queryByLabelText('Call Bob Ortiz')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Text Bob Ortiz')).not.toBeInTheDocument();
  });

  /**
   * The regression this pair pins. `GET /api/users/assignable` is gated on the `assign User`
   * grant: a rep who owns the job but may not change its crew gets a roster that holds NONE
   * of the people already on it. Everything the editor SHOWS about the saved crew therefore
   * has to come off the event payload - the roster only says who may be ADDED.
   */
  it('a viewer whose roster holds none of the crew still sees the crew NAMES (readOnly)', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    renderEditor({ members: [], readOnly: true });
    expect(screen.queryByText('No crew')).not.toBeInTheDocument();
    expect((await screen.findAllByText('Alice Ng')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Bob Ortiz')).length).toBeGreaterThan(0);
  });

  it('a viewer whose roster holds none of the crew still gets the call/text affordance', () => {
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    renderEditor({ members: [], readOnly: true });
    fireEvent.click(screen.getByLabelText('Call Alice Ng'));
    expect(window.location.href).toBe('tel:555-0101');
    fireEvent.click(screen.getByLabelText('Text Alice Ng'));
    expect(window.location.href).toBe('sms:555-0101');
  });

  it('crew contact affordances render in readOnly mode too', () => {
    renderEditor({ readOnly: true });
    fireEvent.click(screen.getByLabelText('Call Alice Ng'));
    expect(window.location.href).toBe('tel:555-0101');
    fireEvent.click(screen.getByLabelText('Text Alice Ng'));
    expect(window.location.href).toBe('sms:555-0101');
    expect(screen.queryByLabelText('Call Bob Ortiz')).not.toBeInTheDocument();
  });

  it('the View details button still navigates', () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /View details/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navSpy).toHaveBeenCalledWith('/jobs/job-1');
  });

  /**
   * SLICE 4 ON THE EDITOR - the per-person crew path for somebody who may name nobody but
   * themselves. The third surface of one rule (the lead tab's
   * `walkthroughSelfPerformerSeed.test.tsx` and the board's `dropModalSelfCrew.test.tsx` are the
   * other two), and the one where an unlocked field costs the most: the crew a card arrives with
   * was put there by a grant holder, every door this editor saves through refuses a CHANGED set
   * from a non-holder with 403, and there is no undo in the dialog.
   *
   * `boardCapabilitiesFor` gives SALES `readOnly: false`, so this is the EDITABLE branch below -
   * not a role that was already reading crew as text.
   *
   * THE ROSTER FIXTURE IS DELIBERATELY OVER-SERVED in the lock cases: it holds Carol, somebody
   * addable. The real `/api/users/assignable` would answer this viewer with one row, which makes
   * `available` empty and disables the trigger ALL BY ITSELF - the exact false green the board
   * twin had to write a paragraph around. With Carol in the list the ONLY thing that can disable
   * the trigger is the `disabled` prop, so these assertions fail when the lock is removed. It is
   * also the honest test of the client's job: the field must be locked on the GRANT, not on the
   * server happening to send a short list.
   */
  describe('for a viewer who may name nobody but themselves', () => {
    /** The Crew field's own trigger. The time fields are typeable comboboxes too. */
    const crewTrigger = () => screen.getByText('Add member...').closest('button');

    const renderLocked = (over: Partial<ComponentProps<typeof EventEditor>> = {}) => {
      vi.mocked(api.get).mockResolvedValue({ data: [CAROL] });
      return renderEditor({ members: [CAROL], canAssignOthers: false, ...over }, { ability: SELF_ONLY });
    };

    it('locks the picker on the GRANT, not on an exhausted roster', async () => {
      renderLocked();
      // Carol is addable, so the trigger's disabled state can only be the lock's doing.
      expect(await screen.findByText('Add member...')).toBeInTheDocument();
      expect(crewTrigger()).toBeDisabled();
    });

    it('takes the remove control off every chip - the crew is a statement, not a selection', async () => {
      renderLocked();
      // Dropping a dispatcher-assigned technician and pressing Save crew is a 403 with no way
      // back from inside the dialog. Removing the affordance is the whole fix.
      await screen.findAllByText('Alice Ng');
      expect(screen.queryByLabelText('Remove Alice Ng')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Remove Bob Ortiz')).not.toBeInTheDocument();
    });

    it('leaves no way to reach Save crew, because a locked field cannot go dirty', async () => {
      renderLocked();
      await screen.findAllByText('Alice Ng');
      // The button carries no grant condition of its own (see the component comment): the two
      // callers of setDraftCrew are the chip X and the dropdown, and the lock closed both. So
      // this walks the ONE path that could arm it rather than just reading the initial render -
      // a clean field is un-dirty whether or not it is locked, and asserting that alone would
      // pass with the lock removed. If a remove control is ever back, clicking it arms Save crew
      // and this goes red.
      const remove = screen.queryByLabelText('Remove Alice Ng');
      if (remove) fireEvent.click(remove);
      expect(screen.queryByRole('button', { name: 'Save crew' })).not.toBeInTheDocument();
    });

    it('states NO rule under the locked field - the subtitle was removed on purpose', async () => {
      renderLocked();
      // The editor used to print job.controller.ts ASSIGN_CREW_SELF_ONLY verbatim here. The
      // product owner judged that sentence redundant (a locked field with no dropdown already
      // says it) and it came off all three surfaces that carried it. Asserted as an ABSENCE so a
      // re-add is caught rather than silently accepted - and anchored to a positive fact about
      // the same render, so a component that failed to mount at all cannot pass this by
      // rendering nothing.
      expect((await screen.findAllByText('Alice Ng')).length).toBeGreaterThan(0);
      expect(
        screen.queryByText('You can only assign yourself as job crew.'),
      ).not.toBeInTheDocument();
    });

    it('states no rule on a walkthrough either - both twins are gone, not just one', async () => {
      renderLocked({ event: walkthrough });
      // The walkthrough branch printed walkthrough.service.ts PERFORMER_SELF_ONLY. Removing one
      // sentence and not the other is the exact half-fix this asserts against: the board would
      // then say on a walkthrough card what the lead's own tab no longer says.
      expect((await screen.findAllByText('Alice Ng')).length).toBeGreaterThan(0);
      expect(
        screen.queryByText('You can only put yourself on a walkthrough.'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText('You can only assign yourself as job crew.'),
      ).not.toBeInTheDocument();
    });

    it('still names the crew it cannot change, off the RECORD rather than the roster', async () => {
      // The realistic roster now: `/api/users/assignable` is gated on `assign User`, so it holds
      // NEITHER person already on this job. Seeing who is on it is not the same permission as
      // changing who is on it, and `Unknown` chips would be this lock's most obvious regression.
      vi.mocked(api.get).mockResolvedValue({ data: [] });
      renderEditor({ members: [], canAssignOthers: false }, { ability: SELF_ONLY });
      expect((await screen.findAllByText('Alice Ng')).length).toBeGreaterThan(0);
      expect((await screen.findAllByText('Bob Ortiz')).length).toBeGreaterThan(0);
      expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    });

    it('changes nothing for a readOnly viewer - text crew, and no rule under a field with no controls', async () => {
      renderLocked({ readOnly: true });
      // The role gate short-circuits first and is untouched by the grant gate.
      expect(screen.getByText('Alice Ng')).toBeInTheDocument();
      expect(screen.getByText('Bob Ortiz')).toBeInTheDocument();
      expect(screen.queryByText('Add member...')).not.toBeInTheDocument();
      expect(
        screen.queryByText('You can only assign yourself as job crew.'),
      ).not.toBeInTheDocument();
    });
  });

  /**
   * PRD story 15 - "I want to see my own name rendered correctly on any chip that names me, so
   * that I never see 'Unknown' where my name should be."
   *
   * The two label sources `MultiAssigneeSelect` resolves a chip through are the ROSTER and
   * `knownPeople`, and there is a real card where NEITHER can name the viewer: they are the crew,
   * the record's payload carries no `assignees[].user` rows (an optimistic post-assign window, a
   * ghost minted from a bucket card), and their roster has not arrived. `useAssignableUsers`
   * carries no `placeholderData` for a cold key, so `data` is `undefined` - `[]` at the call site
   * - for the whole of the request AND for ever if it fails.
   *
   * These cases render the REAL picker over a roster query that never settles / rejects, which is
   * the only way to see that window at all: every other case in this file resolves the roster
   * synchronously and cannot distinguish "resolved from the roster" from "resolved from the
   * actor".
   */
  describe('the viewer\'s own chip, while the roster is unavailable', () => {
    /** Crewed by the ACTOR alone, with no crew rows on the payload to name them from. */
    const ownCrewJob: SchedulableEvent = {
      ...scheduledJob,
      crew: ['m-sales'],
      raw: { status: 'SCHEDULED', customer: { phone: null } },
    };
    const ACTOR_AS_KNOWN = [{ id: 'm-sales', first_name: 'Sam', last_name: 'Sales' }];

    it('names them while the roster request is still in flight', async () => {
      // Never settles: `data` stays undefined for the whole of this test.
      vi.mocked(api.get).mockReturnValue(new Promise(() => {}) as never);
      renderEditor(
        { event: ownCrewJob, members: [], canAssignOthers: false, actorKnownPeople: ACTOR_AS_KNOWN },
        { ability: SELF_ONLY },
      );

      expect(await screen.findByText('Sam Sales')).toBeInTheDocument();
      expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    });

    it('names them for ever when the roster request FAILS', async () => {
      vi.mocked(api.get).mockRejectedValue(new Error('boom'));
      renderEditor(
        { event: ownCrewJob, members: [], canAssignOthers: false, actorKnownPeople: ACTOR_AS_KNOWN },
        { ability: SELF_ONLY },
      );

      expect(await screen.findByText('Sam Sales')).toBeInTheDocument();
      expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    });

    it('reads `Unknown` without it - the prop is what is doing the work here', async () => {
      // The negative control. Without this the two cases above would pass off any accidental
      // second source (the `members` prop, a stale cache) as the fix.
      vi.mocked(api.get).mockRejectedValue(new Error('boom'));
      renderEditor(
        { event: ownCrewJob, members: [], canAssignOthers: false },
        { ability: SELF_ONLY },
      );

      expect(await screen.findByText('Unknown')).toBeInTheDocument();
    });
  });

  describe('for a holder of `assign User`, the editor is the one it has always been', () => {
    it('keeps the removable chips, the live dropdown, Save crew - and states no rule', async () => {
      // Carol is not on the job, so the dropdown genuinely has somebody to offer - the trigger
      // being enabled is the grant's doing and not an accident of the fixture.
      vi.mocked(api.get).mockResolvedValue({ data: [...MEMBERS, CAROL] });
      renderEditor({ members: [...MEMBERS, CAROL] }, { ability: GRANT_HOLDER });

      expect(await screen.findByLabelText('Remove Alice Ng')).toBeInTheDocument();
      // Awaited: until the roster query settles the trigger reads 'No more members' (an empty
      // list, not a rule), so a synchronous read here would test the loading state.
      expect((await screen.findByText('Add member...')).closest('button')).toBeEnabled();
      // No rule stated under a field that has no rule on it - either wording.
      expect(
        screen.queryByText(/You can only (put yourself|assign yourself)/),
      ).not.toBeInTheDocument();
      // And the save path is intact: the lock is about WHO, never about whether.
      fireEvent.click(screen.getByLabelText('Remove Alice Ng'));
      expect(screen.getByRole('button', { name: 'Save crew' })).toBeInTheDocument();
    });
  });

  /**
   * The two things the DOM in this file cannot reach, matched as EXACT text so neutering fails as
   * loudly as deleting (the fallback `SchedulePage.dragWiringGuard.test.ts` documents).
   *
   * It proves WIRING, not behaviour: that the page hands over the live verdict instead of a
   * literal, and that Save crew grew no second gate. That the verdict itself is real - that
   * `useAssignUserPermission` reaches this page at all - is proven by running code in
   * `dropModalSelfCrew.test.tsx`, which drives the same `canAssignOthers` through a real ability.
   */
  describe('wiring (source scan)', () => {
    const PAGE = readFileSync(join(__dirname, '../SchedulePage.tsx'), 'utf8');
    const EDITOR = readFileSync(join(__dirname, '../components/eventEditor.tsx'), 'utf8');

    it('the page hands the editor the SAME verdict it scoped the roster with, not a literal', () => {
      expect(PAGE).toContain('canAssignOthers={canAssignOthers}');
      // ...and not next to a hardcoded one. Both surfaces read the one hook result.
      expect(PAGE).not.toMatch(/canAssignOthers=\{(true|false)\}/);
    });

    it('Save crew is gated on dirtiness ALONE - the lock has exactly one mechanism', () => {
      // The decision recorded in the component: no `&& canAssignOthers` here. It would be
      // unreachable today and would silently swallow an edit under any future partial lock.
      expect(EDITOR).toContain('{crewDirty && (');
      expect(EDITOR).not.toContain('crewDirty && canAssignOthers');
    });
  });

  it('renders nothing without an event', () => {
    const { container } = renderWithProviders(
      <EventEditor
        open
        event={null}
        members={MEMBERS}
        canAssignOthers
        canUnschedule
        onSaveCrew={vi.fn()}
        onSaveTime={vi.fn()}
        onUnschedule={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
