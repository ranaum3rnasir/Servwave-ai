/**
 * The v2 unified drop modal - the port of
 * `src/components/schedule/UnifiedDropModal.test.tsx` onto the rebuilt
 * component at `pages/v2/schedule/components/unifiedDropModal.tsx`.
 *
 * The contract under test is unchanged by the rebuild: this is a PURE
 * controlled component. It renders the draft, highlights the fields the drop
 * seeded, surfaces the ADVISORY conflict note, and emits patches / confirm /
 * cancel. It computes nothing and never POSTs - the page owns submission.
 *
 * ONE GROUP OF LEGACY ASSERTIONS DELIBERATELY DID NOT COME ACROSS. The legacy
 * suite's "FormField adoption (phase 11b)" block pinned the byte-exact class
 * string that the LEGACY `ui/label.tsx` and `ui/input.tsx` primitives emit. The
 * v2 modal renders the KIT's Label and Input, so re-asserting those strings
 * would be asserting the rebuild had not happened. What that block was actually
 * protecting - one generated id shared by label and control, no invented aria
 * hooks, no id collision, `mt-1` off the control, the field wrapper's own
 * `flex flex-col gap-1.5`, and the auto-fill ring present iff the drop seeded
 * the field - is all carried over below, with the ring asserted as the
 * component's whole `AUTO_HIGHLIGHT` constant rather than a substring of it.
 */
import { asWallClock } from '@/lib/schedule-tz';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';
import { screen, fireEvent, within } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import api from '@/lib/axios';
import { draftFromDrop, type SchedulableEvent } from '@/components/schedule/scheduleModel';
import type { AssignableUser } from '@/lib/api/users';

import { UnifiedDropModal } from '../components/unifiedDropModal';

/** The component's own drop-derived highlight, asserted whole. */
const AUTO_HIGHLIGHT = 'ring-2 ring-ai';

const MEMBERS: AssignableUser[] = [
  { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', role: 'TECHNICIAN', department: null },
  { id: 'u-bob', first_name: 'Bob', last_name: 'Ortiz', role: 'TECHNICIAN', department: null },
];

const bucketJob: SchedulableEvent = {
  boardId: 'job-1',
  parentId: 'job-1',
  type: 'job',
  number: 'J00043',
  title: 'Rooftop Unit Swap',
  customer: 'Acme Corp',
  crew: [],
  ownerId: null,
  start: null,
  end: null,
  raw: {},
};

// Dropped on Alice's 9:00 cell (Member-Day), so date + time + member are all auto-filled.
const memberDayDraft = () =>
  draftFromDrop(
    bucketJob,
    { kind: 'member-day', memberId: 'u-alice', start: asWallClock(new Date(2026, 5, 10, 9, 0)) },
    { defaultStartMin: 480, defaultDurationMin: 120 },
  );

function renderModal(over: Partial<ComponentProps<typeof UnifiedDropModal>> = {}) {
  const onChange = vi.fn();
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  renderWithProviders(
    <UnifiedDropModal
      open
      event={bucketJob}
      draft={memberDayDraft()}
      conflictNote={null}
      members={MEMBERS}
      // The default is the GRANT HOLDER - a dispatcher, i.e. every assertion that predates the
      // scoped-assignee work is still describing the field they have today.
      canAssignOthers
      onChange={onChange}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onChange, onConfirm, onCancel };
}

beforeEach(() => {
  // MultiAssigneeSelect self-fetches the org-wide assignable roster for chip labels.
  // GET /api/users/assignable answers with a BARE array - no `{ users }` wrapper.
  vi.mocked(api.get).mockResolvedValue({ data: MEMBERS });
  vi.mocked(api.post).mockClear();
});

describe('v2 UnifiedDropModal', () => {
  it('pre-fills from a member-day draft: crew chip, drop time, ring-ai highlights on auto fields', async () => {
    renderModal();
    // Header: type + number + title + customer
    expect(screen.getByText('J00043')).toBeInTheDocument();
    expect(screen.getByText(/Rooftop Unit Swap/)).toBeInTheDocument();
    expect(screen.getByText(/Acme Corp/)).toBeInTheDocument();
    // Crew chip resolved from the lane member (async - roster query)
    expect(await screen.findByText('Alice Ng')).toBeInTheDocument();
    // Drop-derived values. Both fields are typeable pickers now
    // (`_shared/datePicker` / `_shared/timeCombobox`), so they DISPLAY US text -
    // MM/DD/YYYY and a 12-hour clock - where the native inputs showed their raw
    // 'yyyy-MM-dd' / 'HH:mm' in the browser's locale. What onChange emits is
    // unchanged.
    expect(screen.getByLabelText('Start date')).toHaveValue('06/10/2026');
    expect(screen.getByLabelText('Start time')).toHaveValue('9:00 AM');
    // The drop's duration reads as an end, not as a Duration dropdown: the drop modal
    // stores start + durationMin internally, and converts at its own seam.
    expect(screen.getByLabelText('End date')).toHaveValue('06/10/2026');
    expect(screen.getByLabelText('End time')).toHaveValue('11:00 AM');
    expect(screen.queryByLabelText('Duration')).not.toBeInTheDocument();
    // Auto-fill highlights (member-day: all three came from the drop). A picker's
    // className addresses the whole control - the text field plus its icon
    // button - so the ring lands on that wrapper rather than on the input.
    expect(screen.getByLabelText('Start date').parentElement?.className).toContain('ring-ai');
    expect(screen.getByLabelText('Start time').parentElement?.className).toContain('ring-ai');
    // Caption explains the highlight language
    expect(screen.getByText(/auto-filled from where you dropped/)).toBeInTheDocument();
  });

  it('names the lane the member came from, next to the Crew label', () => {
    renderModal();
    expect(screen.getByText(/pre-filled from Alice Ng's lane/)).toBeInTheDocument();
  });

  it('crew edit calls onChange with the new crew (autoMember highlight cleared)', async () => {
    const { onChange } = renderModal();
    fireEvent.click(await screen.findByLabelText('Remove Alice Ng'));
    expect(onChange).toHaveBeenCalledWith({ crew: [], autoMember: false });
  });

  // Every field commits on blur, so each edit is change-then-blur. The draft still
  // stores start + durationMin, so each patch carries both - the duration is derived
  // from the two ends at this modal's own seam, not picked from a control. Moving the
  // start drags the end with it, which is why the 120-minute span survives both edits.
  it('editing the start time patches start (same day) and clears the autoTime highlight', () => {
    const { onChange } = renderModal();
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '1:30 PM' } });
    fireEvent.blur(screen.getByLabelText('Start time'));
    expect(onChange).toHaveBeenCalledWith({
      start: asWallClock(new Date(2026, 5, 10, 13, 30)), durationMin: 120, autoTime: false,
    });
  });

  it('editing the date patches start (same time) and clears the autoDate highlight', () => {
    const { onChange } = renderModal();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '06/15/2026' } });
    fireEvent.blur(screen.getByLabelText('Start date'));
    expect(onChange).toHaveBeenCalledWith({
      start: asWallClock(new Date(2026, 5, 15, 9, 0)), durationMin: 120, autoDate: false,
    });
  });

  it('editing the end time re-derives the duration, leaving the start alone', () => {
    const { onChange } = renderModal();
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '10:00 AM' } });
    fireEvent.blur(screen.getByLabelText('End time'));
    expect(onChange).toHaveBeenCalledWith({
      start: asWallClock(new Date(2026, 5, 10, 9, 0)), durationMin: 60,
    });
  });

  it('ignores an end dragged back before the start - the draft cannot hold one', () => {
    const { onChange } = renderModal();
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '06/09/2026' } });
    fireEvent.blur(screen.getByLabelText('End date'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders the advisory conflict banner - proceed is still allowed', () => {
    renderModal({ conflictNote: 'overlaps J00099 for Alice' });
    expect(screen.getByText(/overlaps J00099 for Alice/)).toBeInTheDocument();
    expect(screen.getByText(/you can still proceed/)).toBeInTheDocument();
    // Confirm stays enabled - the note is advisory, never a blocker
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeEnabled();
  });

  it('renders a nonstandard duration as the end it implies', () => {
    renderModal({ draft: { ...memberDayDraft(), durationMin: 75 } });
    expect(screen.getByLabelText('End time')).toHaveValue('10:15 AM');
  });

  it('Confirm calls onConfirm once - the page owns posting, the modal never POSTs', () => {
    const { onConfirm } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('Cancel calls onCancel', () => {
    const { onCancel } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without an event or a draft', () => {
    const { container } = renderWithProviders(
      <UnifiedDropModal
        open
        event={null}
        draft={null}
        conflictNote={null}
        members={MEMBERS}
        canAssignOthers
        onChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument();
  });
});

describe('v2 UnifiedDropModal - field wiring', () => {
  it('wires one generated id to BOTH the label and the control, on every one of the four', () => {
    renderModal();
    for (const name of ['Start date', 'Start time', 'End date', 'End time']) {
      const control = screen.getByLabelText(name) as HTMLInputElement;
      const label = screen.getByText(name);
      expect(control.id).toBeTruthy();
      expect(label.getAttribute('for')).toBe(control.id);
      // No hint and no error on these two fields: neither aria hook is invented.
      expect(control).not.toHaveAttribute('aria-describedby');
      expect(control).not.toHaveAttribute('aria-invalid');
    }
    // The two fields do not collide on one id.
    expect(screen.getByLabelText('Start date').id).not.toBe(screen.getByLabelText('Start time').id);
  });

  it('renders the field as a gap-1.5 column, with mt-1 off the control', () => {
    renderModal();
    const date = screen.getByLabelText('Start date');
    // A picker's own wrapper (text field + icon button) is what sits under the
    // field column now, not the bare input - so the column is the grandparent.
    expect(date.parentElement?.parentElement?.getAttribute('class')).toBe('flex flex-col gap-1.5');
    expect(date.getAttribute('class')).not.toContain('mt-1');
  });

  it('puts the whole auto-fill ring on a control the drop seeded', () => {
    renderModal();
    // The ring lands on each picker's wrapper - "the whole control" is now
    // literally that, the text field together with its icon button.
    expect(screen.getByLabelText('Start date').parentElement?.getAttribute('class')).toContain(AUTO_HIGHLIGHT);
    expect(screen.getByLabelText('Start time').parentElement?.getAttribute('class')).toContain(AUTO_HIGHLIGHT);
    // The crew group carries it too - it is a group, not a labelled control.
    expect(screen.getByRole('group').getAttribute('class')).toContain(AUTO_HIGHLIGHT);
  });

  it('leaves the ring off entirely when the drop did not seed that field', () => {
    renderModal({
      draft: { ...memberDayDraft(), autoDate: false, autoTime: false, autoMember: false },
    });
    expect(screen.getByLabelText('Start date').parentElement?.getAttribute('class')).not.toContain('ring-ai');
    expect(screen.getByLabelText('Start time').parentElement?.getAttribute('class')).not.toContain('ring-ai');
    expect(screen.getByRole('group').getAttribute('class')).not.toContain('ring-ai');
    // And with no seeded member there is no lane attribution on the Crew label.
    expect(screen.queryByText(/pre-filled from/)).not.toBeInTheDocument();
  });
});

/**
 * SLICE 4 - the board's booking surface behaves like the lead's Walkthrough tab.
 *
 * A viewer without `assign User` gets a one-row picker roster (themselves), so a Crew field they
 * can edit offers a choice that does not exist. The page has already put the only crew the API
 * would accept into `draft.crew` (`seedCrewForActor` at `openDropModal`); this component's job is
 * to lock the field and say why.
 *
 * The MEMBERS fixture stays two rows long on purpose: what the roster contains and what the rule
 * says are different questions, and reading the rule off a roster length is the bug
 * `MultiAssigneeSelect`'s own `mayAddOthers` note warns about.
 */
describe('v2 UnifiedDropModal - a viewer who may not name others', () => {
  const selfOnly = (over: Partial<ComponentProps<typeof UnifiedDropModal>> = {}) =>
    renderModal({ canAssignOthers: false, ...over });

  it('locks the chip and the dropdown rather than offering a choice that does not exist', async () => {
    selfOnly();

    // The seeded chip still renders and still has a name - seeing who is on it is not the same
    // permission as changing who is on it - but it cannot be taken off.
    expect(await screen.findByText('Alice Ng')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove Alice Ng/i })).not.toBeInTheDocument();
    // The crew picker is the combobox inside the Crew group - the time fields are comboboxes too.
    expect(within(screen.getByRole('group')).getByRole('combobox')).toBeDisabled();
  });

  it('states NO rule under the field, on either door', () => {
    // Ran removed the explanatory sentence on 1 Sep. It went from all three surfaces together -
    // leaving the board saying it while the lead tab did not would be a worse outcome than
    // either choice on its own. Asserted as an absence on BOTH doors so a partial re-add is
    // caught: the job wording and the walkthrough wording were separate strings.
    selfOnly();
    expect(screen.queryByText('You can only assign yourself as job crew.')).not.toBeInTheDocument();
    expect(screen.queryByText('You can only put yourself on a walkthrough.')).not.toBeInTheDocument();

    selfOnly({ event: { ...bucketJob, type: 'walkthrough' } });
    expect(screen.queryByText('You can only put yourself on a walkthrough.')).not.toBeInTheDocument();
    expect(screen.queryByText('You can only assign yourself as job crew.')).not.toBeInTheDocument();
  });

  it('never blocks Schedule - the lock is about WHO, not about whether', () => {
    selfOnly();
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeEnabled();
  });
});

/**
 * PRD story 15 - "I want to see my own name rendered correctly on any chip that names me, so that
 * I never see 'Unknown' where my name should be."
 *
 * The seeded chip is the one chip on this surface that NEITHER of `MultiAssigneeSelect`'s label
 * sources can name. The roster (`useAssignableUsers`) has no `placeholderData` for a cold key, so
 * its `data` is `undefined` - `[]` at the call site - for the whole of the request and for ever if
 * it fails; and `crewPeopleOf(event)` is empty precisely in the case that made the seed necessary,
 * because the card carried nobody.
 *
 * The other blocks in this file resolve the roster synchronously, which is exactly why they cannot
 * see this: a chip named from a settled roster and one named from the actor look identical.
 */
describe('v2 UnifiedDropModal - the seeded chip on a cold load', () => {
  /** Dropped where no member is named, and seeded by the page with the actor's own id. */
  const seededDraft = () => ({ ...memberDayDraft(), crew: ['m-sales'], autoMember: false });
  const ACTOR_AS_KNOWN = [{ id: 'm-sales', first_name: 'Sam', last_name: 'Sales' }];

  it('names the viewer while the roster request is still in flight', async () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => {}) as never);
    renderModal({
      draft: seededDraft(),
      members: [],
      canAssignOthers: false,
      actorKnownPeople: ACTOR_AS_KNOWN,
    });

    expect(await screen.findByText('Sam Sales')).toBeInTheDocument();
    // The whole point: a chip reading `Unknown` on a locked field is the form refusing to name
    // the one person it will let you book.
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    expect(within(screen.getByRole('group')).getByRole('combobox')).toBeDisabled();
  });

  it('names the viewer for ever when the roster request FAILS', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'));
    renderModal({
      draft: seededDraft(),
      members: [],
      canAssignOthers: false,
      actorKnownPeople: ACTOR_AS_KNOWN,
    });

    expect(await screen.findByText('Sam Sales')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('reads `Unknown` without it - the prop is what is doing the work here', async () => {
    // The negative control, so the two cases above cannot pass off some accidental second source.
    vi.mocked(api.get).mockRejectedValue(new Error('boom'));
    renderModal({ draft: seededDraft(), members: [], canAssignOthers: false });

    expect(await screen.findByText('Unknown')).toBeInTheDocument();
  });
});

describe('v2 UnifiedDropModal - a holder of `assign User` keeps the field they have today', () => {
  it('can take the seeded member off and opens onto the roster, with no rule stated', async () => {
    const { onChange } = renderModal();

    fireEvent.click(await screen.findByLabelText('Remove Alice Ng'));
    expect(onChange).toHaveBeenCalledWith({ crew: [], autoMember: false });
    expect(within(screen.getByRole('group')).getByRole('combobox')).toBeEnabled();
    // No rule stated under a field that has no rule on it - in either wording.
    expect(screen.queryByText(/You can only (put yourself|assign yourself)/)).not.toBeInTheDocument();
  });
});
