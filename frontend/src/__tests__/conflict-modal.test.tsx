/**
 * ConflictModal (Q6 + a11y) - pages/v2/schedule/components/conflictModal.tsx.
 *
 * Q6 (RATIFIED): a conflict row used to show only a JOB/WT badge, the record number and a bare
 * time window - no date, no customer, no crew member, which is the one fact the warning exists
 * to convey on a multi-member crew. `crew` / `customer_name` are ADDITIVE fields BE-routes is
 * adding to the 409 body, so this modal is exercised against BOTH the old and the new shape.
 *
 * a11y: this is a hand-rolled overlay, DELIBERATELY not a Radix Dialog (see the comment at its
 * call site in SchedulePage.tsx) - so role/aria-modal/aria-label and focus-in/focus-restore are
 * asserted directly here rather than inherited from a kit primitive. No focus TRAP is claimed or
 * tested: Tab containment is out of scope for this fix.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConflictModal } from '@/pages/v2/schedule/components/conflictModal';
import type { ScheduleConflictItem } from '@/pages/v2/_shared/scheduleConflict';

const TZ = 'America/New_York';

// A fixed instant so the rendered weekday/date/window are deterministic regardless of the
// machine's local timezone: 2026-08-27T17:00-19:00 UTC is 1:00-3:00 PM on Thursday, Aug 27 in
// America/New_York.
const START = '2026-08-27T17:00:00.000Z';
const END = '2026-08-27T19:00:00.000Z';

const FULL_SHAPE: ScheduleConflictItem = {
  type: 'job',
  id: 'job-1',
  number: 'J00299',
  start: START,
  end: END,
  crew: [{ id: 'u-1', name: 'Mike Turner' }, { id: 'u-2', name: 'Alice Ng' }],
  customer_name: 'Dana Reyes',
};

const OLD_SHAPE: ScheduleConflictItem = {
  type: 'walkthrough',
  id: 'wt-1',
  number: 'L00042',
  start: START,
  end: END,
  // no `crew`, no `customer_name` - the body shape from before BE-routes merges
};

function noop() {}

describe('ConflictModal - a11y semantics', () => {
  it('carries role=alertdialog, aria-modal=true and the aria-label', () => {
    render(<ConflictModal message="Conflict" tz={TZ} onCancel={noop} onConfirm={noop} />);
    const panel = screen.getByRole('alertdialog', { name: 'Scheduling conflict' });
    expect(panel).toHaveAttribute('aria-modal', 'true');
  });

  it('moves focus into the panel on mount', () => {
    render(<ConflictModal message="Conflict" tz={TZ} onCancel={noop} onConfirm={noop} />);
    const panel = screen.getByRole('alertdialog');
    expect(document.activeElement).toBe(panel);
  });

  it('restores focus to whatever held it before, on unmount', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'open';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(<ConflictModal message="Conflict" tz={TZ} onCancel={noop} onConfirm={noop} />);
    expect(document.activeElement).toBe(screen.getByRole('alertdialog'));

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe('ConflictModal - Q6 row content', () => {
  it('renders badge, number, customer, crew names and the org-zone weekday/date/window (new-shaped body)', () => {
    render(
      <ConflictModal message="A performer is double-booked." conflicts={[FULL_SHAPE]} tz={TZ} onCancel={noop} onConfirm={noop} />,
    );

    expect(screen.getByText('JOB')).toBeInTheDocument();
    expect(screen.getByText('J00299')).toBeInTheDocument();

    // The detail line joins customer, crew and date/window with a middle dot - assert the whole
    // rendered sentence rather than each fragment, so a broken join (missing separator, wrong
    // order) fails the test too.
    expect(
      screen.getByText('Dana Reyes · Mike Turner, Alice Ng · Thu, Aug 27 · 1:00 PM – 3:00 PM'),
    ).toBeInTheDocument();
  });

  it('degrades gracefully on an OLD-shaped body - no crash, no crew/customer segment, date still renders', () => {
    render(
      <ConflictModal message="The API refused this slot." conflicts={[OLD_SHAPE]} tz={TZ} onCancel={noop} onConfirm={noop} />,
    );

    expect(screen.getByText('WT')).toBeInTheDocument();
    expect(screen.getByText('L00042')).toBeInTheDocument();
    // No customer/crew segment to join - just the date/window, no stray leading/double dots.
    expect(screen.getByText('Thu, Aug 27 · 1:00 PM – 3:00 PM')).toBeInTheDocument();
  });

  it('renders every row when multiple conflicts are present', () => {
    render(
      <ConflictModal
        message="Two clashes."
        conflicts={[FULL_SHAPE, OLD_SHAPE]}
        tz={TZ}
        onCancel={noop}
        onConfirm={noop}
      />,
    );
    expect(screen.getByText('J00299')).toBeInTheDocument();
    expect(screen.getByText('L00042')).toBeInTheDocument();
  });

  it('renders no conflict rows, without crashing, when the list is absent (a non-409 or bodyless error)', () => {
    render(<ConflictModal message="Scheduling conflict detected." tz={TZ} onCancel={noop} onConfirm={noop} />);
    expect(screen.getByText('Scheduling conflict detected.')).toBeInTheDocument();
    expect(screen.queryByText('JOB')).not.toBeInTheDocument();
    expect(screen.queryByText('WT')).not.toBeInTheDocument();
  });
});

describe('ConflictModal - actions', () => {
  it('calls onCancel from the Cancel button and onConfirm from Schedule Anyway', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConflictModal message="Conflict" tz={TZ} onCancel={onCancel} onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Schedule Anyway' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows the in-flight label while isLoading', () => {
    render(<ConflictModal message="Conflict" tz={TZ} isLoading onCancel={noop} onConfirm={noop} />);
    expect(within(screen.getByRole('alertdialog')).getByText('Scheduling...')).toBeInTheDocument();
  });
});
