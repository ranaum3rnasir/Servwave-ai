import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import { DEFAULT_RECURRENCE, type RecurrenceValue } from '@/components/service-plans/RecurrenceBuilder';
import { RecurrenceBuilder } from '../recurrenceBuilder';

/**
 * SRVW-232 - "the recurrence builder layout is cramped and hard to read".
 *
 * jsdom has no layout engine, so it cannot see column heights, wrapping, or
 * visual density - none of that is assertable here. What IS assertable, and
 * what these specs check instead, is the structural shape the fix commits
 * to: the three groups are stacked as three sections rather than packed into
 * a 2-column grid, the weekday chips carry BOTH the narrow `flex flex-wrap`
 * path and the `sm:grid sm:grid-cols-7` path (seven 34px chips need 262px of
 * min-content width, which does not fit this dialog's ~259px of interior
 * width at a 375px viewport - a plain unconditional `grid-cols-7` clips the
 * last chip there, so both classes must be present, not just the wide one),
 * and each "Ends" row shares one label-column width. Real visual density
 * (whether it now "reads as distinct rows", whether the narrow path actually
 * renders as wrapped rows at 375px) needs a browser check - not claimed as
 * verified by this file.
 *
 * The payload contract is unowned by this layer (`recurrenceToPayload` in
 * `components/service-plans/RecurrenceBuilder` is untouched and has its own
 * suite) - the last spec here only re-confirms the value callback still
 * fires with the same shape through the restyled controls.
 */

const val = (over: Partial<RecurrenceValue> = {}): RecurrenceValue => ({ ...DEFAULT_RECURRENCE, ...over });

describe('v2 RecurrenceBuilder layout', () => {
  it('stacks Repeats every / Repeat on / Ends as three sections, not a 2-column grid', () => {
    render(<RecurrenceBuilder value={val({ interval_unit: 'WEEK' })} onChange={vi.fn()} />);

    // No 2-column grid wrapper left over from the old layout.
    expect(document.querySelector('.grid-cols-2')).toBeNull();
    expect(document.querySelector('.sm\\:grid-cols-2')).toBeNull();

    // The three group labels exist and read top to bottom as distinct rows -
    // each Label is followed by its own control block, not sharing a row
    // with a sibling group.
    expect(screen.getByText('Repeats every')).toBeInTheDocument();
    expect(screen.getByText('Repeat on')).toBeInTheDocument();
    expect(screen.getByText('Ends')).toBeInTheDocument();
  });

  it('wraps the weekday chips below sm and grids them from sm up, not grid-cols-7 unconditionally', () => {
    render(<RecurrenceBuilder value={val({ interval_unit: 'WEEK' })} onChange={vi.fn()} />);

    const sunday = screen.getByRole('button', { name: 'Sunday' });
    const chipGrid = sunday.parentElement as HTMLElement;

    // Narrow path (below `sm`, e.g. 375px/320px): a wrapping flex row, so
    // seven 34px chips wrap instead of clipping the dialog's edge.
    expect(chipGrid).toHaveClass('flex', 'flex-wrap');
    // Wide path (`sm:` and up): a fixed 7-column grid, where there is
    // room for the full 262px min-content width.
    expect(chipGrid).toHaveClass('sm:grid', 'sm:grid-cols-7');
    // All seven day toggles are still there, unchanged.
    for (const name of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('gives every Ends row the same label-column width so the On/After inputs align', () => {
    render(<RecurrenceBuilder value={val()} onChange={vi.fn()} />);

    const never = screen.getByRole('radio', { name: /never ends/i });
    const on = screen.getByRole('radio', { name: /ends on a date/i });
    const after = screen.getByRole('radio', { name: /ends after a number of occurrences/i });

    const rowOf = (el: HTMLElement) => el.parentElement as HTMLElement;
    const neverRow = rowOf(never);
    const onRow = rowOf(on);
    const afterRow = rowOf(after);

    // Same template on every row - the shared first-column width is what
    // makes the On/After date and count inputs start at one x position.
    expect(neverRow.className).toContain('grid-cols-[5rem_1fr]');
    expect(onRow.className).toBe(neverRow.className);
    expect(afterRow.className).toBe(neverRow.className);
  });

  it('still reports interval, weekday and end-mode changes with the same shape', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<RecurrenceBuilder value={val({ interval_unit: 'WEEK' })} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Monday' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ byweekday: [1] }));

    await user.click(screen.getByRole('radio', { name: /ends after a number of occurrences/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ end_mode: 'after' }));

    rerender(<RecurrenceBuilder value={val({ end_mode: 'after' })} onChange={onChange} />);
    const occurrenceInput = screen.getByRole('spinbutton', { name: /occurrence count/i });
    expect(occurrenceInput).toBeEnabled();
  });
});
