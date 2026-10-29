// TG9 — D5 unified drop modal. The modal is a PURE controlled component: it renders the
// draft, surfaces auto-fill highlights + the advisory conflict note, and emits patches /
// confirm / cancel. It computes nothing and never posts — the page owns submission.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import api from '@/lib/axios';
import { UnifiedDropModal } from '@/components/schedule/UnifiedDropModal';
import { draftFromDrop, type SchedulableEvent } from '@/components/schedule/scheduleModel';
import type { AssignableUser } from '@/lib/api/users';
import { asWallClock } from '@/lib/schedule-tz';

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

// Dropped on Alice's 9:00 cell (Member·Day) → date+time+member all auto-filled.
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

describe('UnifiedDropModal (D5)', () => {
  it('pre-fills from a member-day draft: crew chip, drop time, ring-ai highlights on auto fields', async () => {
    renderModal();
    // Header: type + number + title + customer
    expect(screen.getByText('J00043')).toBeInTheDocument();
    expect(screen.getByText(/Rooftop Unit Swap/)).toBeInTheDocument();
    expect(screen.getByText(/Acme Corp/)).toBeInTheDocument();
    // Crew chip resolved from the lane member (async — roster query)
    expect(await screen.findByText('Alice Ng')).toBeInTheDocument();
    // Drop-derived values. Date is a DatePicker now - displays MM/DD/YYYY (typeable
    // text), not the native input's raw 'yyyy-MM-dd'.
    expect(screen.getByLabelText('Start date')).toHaveValue('06/10/2026');
    // TimeCombobox renders 12-hour text; the native input showed a 24-hour clock
    // in any non-US browser locale, and this is a US-only product.
    expect(screen.getByLabelText('Start time')).toHaveValue('9:00 AM');
    // The drop's duration reads as an end, not as a Duration dropdown: the drop modal
    // stores start + durationMin internally, and converts at its own seam.
    expect(screen.getByLabelText('End date')).toHaveValue('06/10/2026');
    expect(screen.getByLabelText('End time')).toHaveValue('11:00 AM');
    expect(screen.queryByLabelText('Duration')).not.toBeInTheDocument();
    // Auto-fill highlights (member-day: all three came from the drop). Date's ring
    // now wraps the whole DatePicker control (input + calendar-icon button) via its
    // own wrapper div, not the bare input directly.
    expect(screen.getByLabelText('Start date').parentElement?.className).toContain('ring-ai');
    expect(screen.getByLabelText('Start time').parentElement?.className).toContain('ring-ai');
    // Caption explains the highlight language
    expect(screen.getByText(/auto-filled from where you dropped/)).toBeInTheDocument();
  });

  it('crew edit calls onChange with the new crew (autoMember highlight cleared)', async () => {
    const { onChange } = renderModal();
    fireEvent.click(await screen.findByLabelText('Remove Alice Ng'));
    expect(onChange).toHaveBeenCalledWith({ crew: [], autoMember: false });
  });

  it('editing the start time patches start (same day) and clears the autoTime highlight', () => {
    const { onChange } = renderModal();
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '1:30 PM' } });
    fireEvent.blur(screen.getByLabelText('Start time'));
    // The duration rides along unchanged: moving the start drags the end with it, so a
    // 2-hour slot stays a 2-hour slot rather than silently stretching to the old end.
    expect(onChange).toHaveBeenCalledWith({
      start: new Date(2026, 5, 10, 13, 30),
      durationMin: 120,
      autoTime: false,
    });
  });

  it('shows the end time the drop implies, and editing it re-derives the duration', () => {
    const { onChange } = renderModal();
    expect(screen.getByLabelText('End time')).toHaveValue('11:00 AM');
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '12:30 PM' } });
    fireEvent.blur(screen.getByLabelText('End time'));
    // Start is untouched; only the span changed.
    expect(onChange).toHaveBeenCalledWith({
      start: new Date(2026, 5, 10, 9, 0),
      durationMin: 210,
    });
  });

  it('renders the advisory conflict banner — proceed is still allowed', () => {
    renderModal({ conflictNote: 'overlaps J00099 for Alice' });
    expect(screen.getByText(/overlaps J00099 for Alice/)).toBeInTheDocument();
    expect(screen.getByText(/you can still proceed/)).toBeInTheDocument();
    // Confirm stays enabled — the note is advisory, never a blocker
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeEnabled();
  });

  it('renders a nonstandard duration as the end it implies', () => {
    renderModal({ draft: { ...memberDayDraft(), durationMin: 75 } });
    expect(screen.getByLabelText('End time')).toHaveValue('10:15 AM');
  });

  it('ignores an end dragged back before the start - the draft cannot hold one', () => {
    const { onChange } = renderModal();
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '06/09/2026' } });
    fireEvent.blur(screen.getByLabelText('End date'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Confirm calls onConfirm once — the page owns posting, the modal never POSTs', () => {
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
});

// ─── phase 11b: Date / Start time render through FormField ──────────────────
//
//   before  <div><Label htmlFor={uid-date}>Date</Label>
//                <Input id={uid-date} className={cn('mt-1', ...)} /></div>
//   after   <FormField label="Start date" htmlFor={uid-date}>
//                <Input className={cn(...)} /></FormField>
//
// The label's own class string is unchanged (FormField renders the same
// `ui/label.tsx` primitive with the same default props), and so is the
// control's once `mt-1` comes off. Those are what the assertions below pin.
//
// THE CLASS STRINGS BEING BYTE-IDENTICAL DOES NOT MAKE THIS A ZERO-PIXEL
// CHANGE, AND THESE TESTS CANNOT SEE THE PART THAT MOVES - jsdom does no
// layout. Measured instead in Chromium at 1200px against the compiled
// project CSS: FormField composes `Stack`, so the field container goes from
// a block `<div>` to `flex flex-col`. That blockifies the `<label>`, which
// until now was an inline box whose line box was governed by the container's
// 24px strut (nothing here sets `text-sm` or `leading-*` on an ancestor -
// DialogContent does not). Blockified, the label's own `leading-none` wins
// and it occupies 14px. Net, per field: 72px tall before, 64px after, and
// the label-to-control seam goes from 7px to 6px.
//
// That 8px is a REAL rendered change. It is deliberately not asserted here,
// because a jsdom assertion about layout would be theatre; it is disclosed
// in the PR body and is the open item this batch is held on.
const LABEL_CLASS =
  'text-sm leading-none transition-colors duration-300 hover:text-text-primary ' +
  'has-[+input:is(:hover,:focus)]:text-text-primary has-[+textarea:is(:hover,:focus)]:text-text-primary ' +
  'peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-text-secondary font-bold';

const INPUT_CLASS =
  'flex h-11 w-full rounded border-2 border-transparent bg-text-primary/5 px-4 py-2 text-base ' +
  'transition-colors duration-300 file:border-0 file:bg-transparent file:text-sm file:font-medium ' +
  'file:text-text-primary placeholder:text-text-soft hover:border-primary focus-visible:outline-none ' +
  'focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 md:text-sm';

describe('UnifiedDropModal - FormField adoption (phase 11b)', () => {
  it('wires one generated id to BOTH the label and the control, for Date and Start time alike', () => {
    renderModal();
    for (const name of ['Start date', 'Start time']) {
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

  it('renders the field through Stack at FormField\'s default gap, with mt-1 off the control', () => {
    renderModal();
    const date = screen.getByLabelText('Start date');
    // DatePicker's own wrapper (input + calendar-icon button) sits directly under
    // FormField's Stack now, not the bare input - Stack is the grandparent.
    expect(date.parentElement?.parentElement?.getAttribute('class')).toBe('flex flex-col gap-1.5');
    expect(date.getAttribute('class')).not.toContain('mt-1');
  });

  it('leaves the label class string exactly as the pre-conversion Label rendered it', () => {
    renderModal();
    expect(screen.getByText('Start date').getAttribute('class')).toBe(LABEL_CLASS);
    expect(screen.getByText('Start time').getAttribute('class')).toBe(LABEL_CLASS);
  });

  it('keeps the auto-fill ring on the control: exact class string, highlighted and not', () => {
    renderModal();
    // Both controls are now typeable pickers (input + icon button), so the ring
    // wraps the WHOLE control via its wrapper div rather than sitting on the
    // input - the native <input type="time"> it replaces rendered a 24-hour
    // clock in any non-US browser locale.
    for (const name of ['Start date', 'Start time']) {
      expect(screen.getByLabelText(name).parentElement?.getAttribute('class')).toBe(
        'flex items-stretch gap-1 ring-2 ring-ai',
      );
    }
  });

  it('emits the bare control class when the drop did not seed that field', () => {
    renderModal({ draft: { ...memberDayDraft(), autoDate: false, autoTime: false } });
    for (const name of ['Start date', 'Start time']) {
      expect(screen.getByLabelText(name).parentElement?.getAttribute('class')).toBe('flex items-stretch gap-1');
    }
  });
});
