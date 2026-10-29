/**
 * DateField - the unified date/time control (SRVW-247 step 2) replacing
 * `components/form/DatePicker`, `pages/v2/_shared/datePicker`,
 * `components/form/DateTimePicker`, `pages/v2/_shared/dateTimePicker`,
 * `components/form/DateRangeField` and the dead `ui-kit/components/form/datePicker`.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { setOrgFormattingPrefs } from '@/lib/org-format';

import { DateField, DEFAULT_DATE_RANGE_PRESETS } from '../dateField';

// The calendar is a lazy chunk (mobile slice 47). In the app it is fetched while the page is idle,
// so by the time anyone opens a picker it is already there. These tests model that warm state:
// render and open one calendar and wait for it, after which the lazy component resolves
// synchronously for every later render in this file. The cold path (fallback, then the grid) is
// pinned in dateFieldLazyCalendar.test.tsx.
beforeAll(async () => {
  const { unmount } = render(<DateField value="" onChange={() => {}} aria-label="Warm-up" />);
  fireEvent.click(screen.getByLabelText('Open calendar'));
  await screen.findByRole('grid');
  unmount();
});

function setupDate(props: Partial<React.ComponentProps<typeof DateField>> = {}) {
  const onChange = vi.fn();
  render(<DateField value="" onChange={onChange} aria-label="Date" {...(props as object)} />);
  return { onChange, field: screen.getByLabelText('Date') as HTMLInputElement };
}

describe('DateField mode="date" (default mode)', () => {
  describe('typed entry (ability 1 - delegates to date-input, not reimplemented)', () => {
    it('parses the default org pattern (MM/DD/YYYY) on blur', () => {
      const { onChange, field } = setupDate();
      fireEvent.change(field, { target: { value: '08/15/2026' } });
      fireEvent.blur(field);
      expect(onChange).toHaveBeenCalledWith('2026-08-15');
    });

    it('accepts a pasted ISO YYYY-MM-DD as an escape hatch regardless of pattern', () => {
      const { onChange, field } = setupDate();
      fireEvent.change(field, { target: { value: '2026-08-15' } });
      fireEvent.blur(field);
      expect(onChange).toHaveBeenCalledWith('2026-08-15');
    });

    it('commits on Enter', () => {
      const { onChange, field } = setupDate();
      fireEvent.change(field, { target: { value: '08/15/2026' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith('2026-08-15');
    });
  });

  describe('parse failure reverts silently (ability 2)', () => {
    it('reverts the display to the last valid value with no error state or callback', () => {
      const { onChange, field } = setupDate({ value: '2026-08-15' });
      fireEvent.change(field, { target: { value: 'not a date' } });
      fireEvent.blur(field);
      expect(onChange).not.toHaveBeenCalled();
      expect(field).toHaveValue('08/15/2026');
    });
  });

  describe('commit on popover close by any means (ability 3)', () => {
    // Clicking elsewhere in a real browser blurs the input, which is the path
    // that commits. jsdom's fireEvent.click does not move focus, so driving a
    // click on a sibling asserts an interaction jsdom never simulates - it
    // passes or fails for the wrong reason. Exercise the two real commit
    // paths directly instead: the input's own blur, and the popover's
    // onOpenChange firing on close.
    it('commits typed text on blur', () => {
      const onChange = vi.fn();
      render(<DateField value="" onChange={onChange} aria-label="Date" />);
      fireEvent.click(screen.getByLabelText('Open calendar'));
      const field = screen.getByLabelText('Date');
      fireEvent.change(field, { target: { value: '08/15/2026' } });
      fireEvent.blur(field);
      expect(onChange).toHaveBeenCalledWith('2026-08-15');
    });

    it('commits typed text when the popover closes on Escape', () => {
      const onChange = vi.fn();
      render(<DateField value="" onChange={onChange} aria-label="Date" />);
      fireEvent.click(screen.getByLabelText('Open calendar'));
      const field = screen.getByLabelText('Date');
      fireEvent.change(field, { target: { value: '08/15/2026' } });
      fireEvent.keyDown(field, { key: 'Escape' });
      expect(onChange).toHaveBeenCalledWith('2026-08-15');
    });
  });

  describe('Today quick action (ability 4)', () => {
    beforeEach(() => vi.useFakeTimers().setSystemTime(new Date(2026, 7, 5, 9, 0)));
    afterEach(() => vi.useRealTimers());

    it('sets the value to today and closes the popover', async () => {
      const { onChange } = setupDate();
      fireEvent.click(screen.getByLabelText('Open calendar'));
      expect(screen.getByText('Today')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Today'));
      expect(onChange).toHaveBeenCalledWith('2026-08-05');
      expect(screen.queryByText('Today')).not.toBeInTheDocument();
    });
  });

  describe('Clear quick action (ability 5, distinct from typing-empty-then-blur)', () => {
    it('clears via the inline X without requiring a blur', () => {
      const { onChange, field } = setupDate({ value: '2026-08-15' });
      fireEvent.click(screen.getByLabelText('Clear date'));
      expect(onChange).toHaveBeenCalledWith('');
      expect(field).toHaveValue('');
    });

    it('clears via the popover Clear action and closes the popover', async () => {
      const onChange = vi.fn();
      render(<DateField value="2026-08-15" onChange={onChange} aria-label="Date" />);
      fireEvent.click(screen.getByLabelText('Open calendar'));
      fireEvent.click(screen.getByText('Clear'));
      expect(onChange).toHaveBeenCalledWith('');
      expect(screen.queryByText('Clear')).not.toBeInTheDocument();
    });

    it('omits the inline clear affordance when clearable is false', () => {
      setupDate({ value: '2026-08-15', clearable: false });
      expect(screen.queryByLabelText('Clear date')).not.toBeInTheDocument();
    });

    it('omits the popover footer Clear action too when clearable is false', () => {
      setupDate({ value: '2026-08-15', clearable: false });
      fireEvent.click(screen.getByLabelText('Open calendar'));
      expect(screen.queryByText('Clear')).not.toBeInTheDocument();
      expect(screen.getByText('Today')).toBeInTheDocument();
    });
  });

  describe('disabled reaches every interactive sub-part', () => {
    it('disables the text field and the calendar trigger', () => {
      setupDate({ value: '2026-08-15', disabled: true });
      expect(screen.getByLabelText('Date')).toBeDisabled();
      expect(screen.getByLabelText('Clear date')).toBeDisabled();
      expect(screen.getByLabelText('Open calendar')).toBeDisabled();
    });
  });

  it('passes aria-invalid through to the text field', () => {
    setupDate({ 'aria-invalid': true });
    expect(screen.getByLabelText('Date')).toHaveAttribute('aria-invalid', 'true');
  });

  describe('min/max produce disabled calendar days (never react-day-picker\'s own count-based min/max)', () => {
    it('disables days outside the [min, max] window', async () => {
      render(
        <DateField
          value="2026-08-15"
          onChange={vi.fn()}
          aria-label="Date"
          min="2026-08-10"
          max="2026-08-20"
        />,
      );
      fireEvent.click(screen.getByLabelText('Open calendar'));
      const grid = screen.getByRole('grid');
      const dayButtons = within(grid).getAllByRole('gridcell');
      const find = (day: number) =>
        dayButtons
          .map((cell) => within(cell).queryByRole('button'))
          .find((btn) => btn?.textContent === String(day));
      expect(find(9)).toBeDisabled();
      expect(find(15)).not.toBeDisabled();
      expect(find(21)).toBeDisabled();
    });

    it('disablePast blocks days before today but keeps today selectable', async () => {
      vi.useFakeTimers().setSystemTime(new Date(2026, 7, 15, 14, 0));
      render(<DateField value="" onChange={vi.fn()} aria-label="Date" disablePast />);
      fireEvent.click(screen.getByLabelText('Open calendar'));
      const grid = screen.getByRole('grid');
      const cells = within(grid).getAllByRole('gridcell');
      const find = (day: number) =>
        cells.map((cell) => within(cell).queryByRole('button')).find((btn) => btn?.textContent === String(day));
      expect(find(14)).toBeDisabled();
      expect(find(15)).not.toBeDisabled();
      vi.useRealTimers();
    });
  });
});

describe('DateField mode="datetime"', () => {
  function setupDateTime(props: Partial<React.ComponentProps<typeof DateField>> = {}) {
    const onChange = vi.fn();
    render(
      <DateField mode="datetime" value="" onChange={onChange} aria-label="Due" {...(props as object)} />,
    );
    return {
      onChange,
      dateField: screen.getByLabelText('Due date') as HTMLInputElement,
      timeField: screen.getByLabelText('Due time') as HTMLInputElement,
    };
  }

  it('composes a typeable date field and a typeable TimeField (ability 6) - off-grid and shorthand time both work', () => {
    const { onChange, timeField } = setupDateTime({ value: '2026-08-15T00:00' });
    fireEvent.change(timeField, { target: { value: '3p' } });
    fireEvent.blur(timeField);
    expect(onChange).toHaveBeenCalledWith('2026-08-15T15:00');

    fireEvent.change(timeField, { target: { value: '3:07 PM' } });
    fireEvent.blur(timeField);
    expect(onChange).toHaveBeenCalledWith('2026-08-15T15:07');
  });

  describe('datetime edge cases (ability 7)', () => {
    it('setting a date when no time is set defaults the time to 09:00', () => {
      const { onChange, dateField } = setupDateTime();
      fireEvent.change(dateField, { target: { value: '08/15/2026' } });
      fireEvent.blur(dateField);
      expect(onChange).toHaveBeenCalledWith('2026-08-15T09:00');
    });

    it('setting a time when no date is set defaults the date to today', () => {
      vi.useFakeTimers().setSystemTime(new Date(2026, 7, 5, 9, 0));
      const { onChange, timeField } = setupDateTime();
      fireEvent.change(timeField, { target: { value: '2:00pm' } });
      fireEvent.blur(timeField);
      expect(onChange).toHaveBeenCalledWith('2026-08-05T14:00');
      vi.useRealTimers();
    });

    it('clearing the time clears the whole value', () => {
      const { onChange } = setupDateTime({ value: '2026-08-15T09:00' });
      fireEvent.click(screen.getByLabelText('Clear time'));
      expect(onChange).toHaveBeenCalledWith('');
    });
  });

  describe('Now quick action (ability 4)', () => {
    it('sets the full value and closes the popover', async () => {
      vi.useFakeTimers().setSystemTime(new Date(2026, 7, 5, 14, 30));
      const { onChange } = setupDateTime();
      fireEvent.click(screen.getByLabelText('Open calendar'));
      fireEvent.click(screen.getByText('Now'));
      expect(onChange).toHaveBeenCalledWith('2026-08-05T14:30');
      expect(screen.queryByText('Now')).not.toBeInTheDocument();
      vi.useRealTimers();
    });
  });

  describe('Clear quick action (ability 5)', () => {
    it('clears via the composite X button', () => {
      const { onChange } = setupDateTime({ value: '2026-08-15T09:00' });
      fireEvent.click(screen.getByLabelText('Clear date and time'));
      expect(onChange).toHaveBeenCalledWith('');
    });

    it('omits both the composite X and the popover footer Clear action when clearable is false', () => {
      setupDateTime({ value: '2026-08-15T09:00', clearable: false });
      expect(screen.queryByLabelText('Clear date and time')).not.toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('Open calendar'));
      expect(screen.queryByText('Clear')).not.toBeInTheDocument();
      expect(screen.getByText('Now')).toBeInTheDocument();
    });
  });

  it('disabled reaches the date field, the time field and the calendar trigger', () => {
    setupDateTime({ value: '2026-08-15T09:00', disabled: true });
    expect(screen.getByLabelText('Due date')).toBeDisabled();
    expect(screen.getByLabelText('Due time')).toBeDisabled();
    expect(screen.getByLabelText('Open calendar')).toBeDisabled();
  });

  it('composed layout forwards inputClassName to both sub-fields, falling back to px-2.5 to avoid meridiem clipping', () => {
    render(
      <DateField mode="datetime" value="" onChange={vi.fn()} aria-label="Due" inputClassName="h-7 px-1.5 py-0.5 text-xs" />,
    );
    expect(screen.getByLabelText('Due date')).toHaveClass('h-7', 'px-1.5', 'py-0.5', 'text-xs');
    expect(screen.getByLabelText('Due time')).toHaveClass('h-7', 'px-1.5', 'py-0.5', 'text-xs');
  });

  it('falls back to px-2.5 on both sub-fields when no inputClassName is supplied (legacy DateTimePicker default)', () => {
    render(<DateField mode="datetime" value="" onChange={vi.fn()} aria-label="Due" />);
    expect(screen.getByLabelText('Due date')).toHaveClass('px-2.5');
    expect(screen.getByLabelText('Due time')).toHaveClass('px-2.5');
  });

  it('passes aria-label through as undefined when the caller supplies none, matching date mode - so a linked <label htmlFor> is not shadowed', () => {
    render(
      <div>
        <label htmlFor="due-date-input">Due Date</label>
        <DateField mode="datetime" value="" onChange={vi.fn()} id="due-date-input" />
      </div>,
    );
    expect(screen.getByLabelText('Due Date')).toBeInTheDocument();
  });
});

describe('DateField mode="range"', () => {
  function setupRange(props: Partial<React.ComponentProps<typeof DateField>> = {}) {
    const onChange = vi.fn();
    render(
      <DateField
        mode="range"
        value={{ from: '', to: '' }}
        onChange={onChange}
        aria-label="Created"
        {...(props as object)}
      />,
    );
    return {
      onChange,
      fromField: screen.getByLabelText('Created from') as HTMLInputElement,
      toField: screen.getByLabelText('Created to') as HTMLInputElement,
    };
  }

  it('types both bounds in the org pattern', () => {
    const { onChange, fromField, toField } = setupRange();
    fireEvent.change(fromField, { target: { value: '08/01/2026' } });
    fireEvent.blur(fromField);
    expect(onChange).toHaveBeenCalledWith({ from: '2026-08-01', to: '' });

    fireEvent.change(toField, { target: { value: '08/31/2026' } });
    fireEvent.blur(toField);
    expect(onChange).toHaveBeenCalledWith({ from: '', to: '2026-08-31' });
  });

  describe('commit on popover close by any means (ability 3) - range mode', () => {
    it('does not discard a just-typed `from` when the popover closes on Escape', () => {
      const onChange = vi.fn();
      render(
        <DateField
          mode="range"
          value={{ from: '2026-08-01', to: '2026-08-31' }}
          onChange={onChange}
          aria-label="Created"
        />,
      );
      fireEvent.click(screen.getByLabelText('Open calendar'));
      const fromField = screen.getByLabelText('Created from');
      fireEvent.change(fromField, { target: { value: '08/05/2026' } });
      // Escape closes without blurring `from` first - the deterministic repro:
      // committing `from` then `to` back to back from the SAME stale render
      // used to let `to`'s commit overwrite `from`'s with the pre-edit value.
      fireEvent.keyDown(fromField, { key: 'Escape' });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({ from: '2026-08-05', to: '2026-08-31' });
    });

    it('does not fire onChange or un-highlight the active preset merely from opening and closing', () => {
      const onChange = vi.fn();
      render(
        <DateField
          mode="range"
          value={DEFAULT_DATE_RANGE_PRESETS.find((p) => p.key === 'today')!.range()}
          onChange={onChange}
          aria-label="Created"
        />,
      );
      fireEvent.click(screen.getByLabelText('Open calendar'));
      expect(screen.getByText('Today')).toHaveClass('bg-brand-subtle');
      fireEvent.keyDown(screen.getByLabelText('Created from'), { key: 'Escape' });
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.click(screen.getByLabelText('Open calendar'));
      expect(screen.getByText('Today')).toHaveClass('bg-brand-subtle');
    });
  });

  // Worded without a hyphen on purpose: the unresolved-classes ratchet scans
  // src/ with Tailwind's own extractor, which reads a hyphenated word here
  // as a class candidate and fails the guard on prose.
  describe('guard against wiping a legitimate open-ended range with only a to bound (ability 5 follow-up)', () => {
    it('does not collapse {from:"",to:set} to {from:"",to:""} on the next calendar click', () => {
      const onChange = vi.fn();
      render(
        <DateField mode="range" value={{ from: '', to: '2026-08-20' }} onChange={onChange} aria-label="Created" />,
      );
      fireEvent.click(screen.getByLabelText('Open calendar'));
      const grids = screen.getAllByRole('grid');
      const cells = within(grids[0]!).getAllByRole('gridcell');
      const day10 = cells.map((c) => within(c).queryByRole('button')).find((b) => b?.textContent === '10');
      expect(day10).toBeTruthy();
      fireEvent.click(day10!);
      expect(onChange).not.toHaveBeenCalledWith({ from: '', to: '' });
    });
  });

  describe('cross-field bounding (ability 11) - a range cannot be inverted at input time', () => {
    it('reverts a `from` typed later than the current `to`', () => {
      const { onChange, fromField } = setupRange({ value: { from: '2026-08-01', to: '2026-08-10' } });
      fireEvent.change(fromField, { target: { value: '08/20/2026' } });
      fireEvent.blur(fromField);
      expect(onChange).not.toHaveBeenCalled();
      expect(fromField).toHaveValue('08/01/2026');
    });

    it('reverts a `to` typed earlier than the current `from`', () => {
      const { onChange, toField } = setupRange({ value: { from: '2026-08-10', to: '2026-08-20' } });
      fireEvent.change(toField, { target: { value: '08/05/2026' } });
      fireEvent.blur(toField);
      expect(onChange).not.toHaveBeenCalled();
      expect(toField).toHaveValue('08/20/2026');
    });
  });

  describe('presets (ability 9) - data-driven, rendered as a rail, do not close the popover', () => {
    it('renders the default preset list and lights the range without closing', async () => {
      const { onChange } = setupRange();
      fireEvent.click(screen.getByLabelText('Open calendar'));
      for (const p of DEFAULT_DATE_RANGE_PRESETS) {
        expect(screen.getByText(p.label)).toBeInTheDocument();
      }
      fireEvent.click(screen.getByText('Today'));
      expect(onChange).toHaveBeenCalledWith(DEFAULT_DATE_RANGE_PRESETS.find((p) => p.key === 'today')!.range());
      expect(screen.getByText('Today')).toBeInTheDocument(); // still open
    });

    it('accepts a custom presets list via data, not a hardcoded set', async () => {
      const onChange = vi.fn();
      const presets = [{ key: 'custom-one', label: 'My Preset', range: () => ({ from: '2026-01-01', to: '2026-01-31' }) }];
      render(
        <DateField mode="range" value={{ from: '', to: '' }} onChange={onChange} aria-label="Created" presets={presets} />,
      );
      fireEvent.click(screen.getByLabelText('Open calendar'));
      expect(screen.getByText('My Preset')).toBeInTheDocument();
      expect(screen.queryByText('Any time')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('My Preset'));
      expect(onChange).toHaveBeenCalledWith({ from: '2026-01-01', to: '2026-01-31' });
    });

    // #1634 landed a `tz` on the DateRangeField this component replaces, so
    // the "scheduled" facet resolves its presets in the ORG's day boundaries
    // rather than the viewer's browser clock. Falsifying: a preset that echoes
    // the tz it was called with proves the prop is threaded, not defaulted.
    it('resolves presets in the tz it is given, and with no tz at all when none is passed', () => {
      const seen: (string | undefined)[] = [];
      const presets = [
        {
          key: 'echo',
          label: 'Echo',
          range: (tz?: string) => {
            seen.push(tz);
            return { from: '2026-01-01', to: '2026-01-31' };
          },
        },
      ];
      const { unmount } = render(
        <DateField
          mode="range"
          value={{ from: '', to: '' }}
          onChange={vi.fn()}
          aria-label="Created"
          presets={presets}
          tz="America/New_York"
        />,
      );
      fireEvent.click(screen.getByLabelText('Open calendar'));
      fireEvent.click(screen.getByText('Echo'));
      expect(seen).toContain('America/New_York');
      expect(seen).not.toContain(undefined);

      seen.length = 0;
      unmount();
      render(
        <DateField
          mode="range"
          value={{ from: '', to: '' }}
          onChange={vi.fn()}
          aria-label="Created"
          presets={presets}
        />,
      );
      fireEvent.click(screen.getByLabelText('Open calendar'));
      fireEvent.click(screen.getByText('Echo'));
      expect(seen).toContain(undefined);
      expect(seen).not.toContain('America/New_York');
    });
  });

  describe('sticky custom mode (ability 10) - genuinely falsifying coverage', () => {
    // Both tests below need the typed dates to ACTUALLY equal a preset's own
    // computed range under the same clock, so fake time is mandatory - without
    // it "today" typed by the user and "today" computed by the preset are
    // coincidentally usually equal anyway in a fast test run, which is exactly
    // the false-positive the review flagged. A controlled wrapper is mandatory
    // too: an uncontrolled `vi.fn()` onChange never moves `value`, so
    // `matchPresetKey` keeps evaluating the ORIGINAL (non-matching) props
    // forever and the assertion passes whether or not customMode exists.
    function ControlledRange(props: { initial: { from: string; to: string } }) {
      const [value, setValue] = useState(props.initial);
      return <DateField mode="range" value={value} onChange={setValue} aria-label="Created" />;
    }

    it('does not snap back to "Today" when the user TYPES today\'s date into both bounds', () => {
      vi.useFakeTimers().setSystemTime(new Date(2026, 7, 23, 9, 0)); // "today" = 2026-08-23
      render(<ControlledRange initial={{ from: '', to: '' }} />);
      fireEvent.change(screen.getByLabelText('Created from'), { target: { value: '08/23/2026' } });
      fireEvent.blur(screen.getByLabelText('Created from'));
      fireEvent.change(screen.getByLabelText('Created to'), { target: { value: '08/23/2026' } });
      fireEvent.blur(screen.getByLabelText('Created to'));
      fireEvent.click(screen.getByLabelText('Open calendar'));
      // Falsifiable: with customMode removed (activePresetKey computed as a
      // bare matchPresetKey with no sticky override), typing today into both
      // bounds resolves to the SAME {from,to} the "Today" preset itself
      // computes under this same fake clock, so this assertion flips to
      // failing - see the commit message for the stub-and-confirm run.
      expect(screen.getByText('Today')).not.toHaveClass('bg-brand-subtle');
      vi.useRealTimers();
    });

    it('resets stickiness via the render-time sync when both bounds clear EXTERNALLY, not through handleClear', () => {
      vi.useFakeTimers().setSystemTime(new Date(2026, 7, 23, 9, 0));
      function Wrapper() {
        const [value, setValue] = useState({ from: '', to: '' });
        return (
          <div>
            <DateField mode="range" value={value} onChange={setValue} aria-label="Created" />
            {/* Deliberately NOT DateField's own Clear button - handleClear already
                sets customMode false explicitly, which would exercise nothing.
                This simulates an outside actor (a parent "reset filters" action)
                writing {from:'',to:''} back in, which only the render-time sync
                at DateFieldRange's prevFrom/prevTo check can catch. */}
            <button type="button" onClick={() => setValue({ from: '', to: '' })}>external reset</button>
          </div>
        );
      }
      render(<Wrapper />);
      fireEvent.change(screen.getByLabelText('Created from'), { target: { value: '08/23/2026' } });
      fireEvent.blur(screen.getByLabelText('Created from'));
      fireEvent.change(screen.getByLabelText('Created to'), { target: { value: '08/23/2026' } });
      fireEvent.blur(screen.getByLabelText('Created to'));
      fireEvent.click(screen.getByLabelText('Open calendar'));
      expect(screen.getByText('Today')).not.toHaveClass('bg-brand-subtle');
      // The popover is still open (this click never touches the trigger, and
      // fireEvent.click does not simulate the pointerdown Radix's
      // outside-dismiss listens for) - so the SAME open rail is re-queried,
      // not a freshly reopened one.
      fireEvent.click(screen.getByText('external reset'));
      expect(screen.getByText('Any time')).toHaveClass('bg-brand-subtle');
      vi.useRealTimers();
    });
  });

  it('renders two months side by side (ability 8, harvested from the dead kit DateRangePicker)', async () => {
    setupRange();
    fireEvent.click(screen.getByLabelText('Open calendar'));
    expect(screen.getAllByRole('grid')).toHaveLength(2);
  });

  describe('Clear quick action (ability 5)', () => {
    it('clears both bounds via the inline X', () => {
      const { onChange } = setupRange({ value: { from: '2026-08-01', to: '2026-08-31' } });
      fireEvent.click(screen.getByLabelText('Clear date range'));
      expect(onChange).toHaveBeenCalledWith({ from: '', to: '' });
    });

    it('omits the inline clear affordance when clearable is false, even with a value set', () => {
      setupRange({ value: { from: '2026-08-01', to: '2026-08-31' }, clearable: false });
      expect(screen.queryByLabelText('Clear date range')).not.toBeInTheDocument();
    });
  });

  describe('min/max produce disabled calendar days', () => {
    it('disables days outside the [min, max] window in the range calendar', async () => {
      render(
        <DateField
          mode="range"
          value={{ from: '2026-08-15', to: '' }}
          onChange={vi.fn()}
          aria-label="Created"
          min="2026-08-10"
          max="2026-08-20"
        />,
      );
      fireEvent.click(screen.getByLabelText('Open calendar'));
      const grids = screen.getAllByRole('grid');
      const cells = within(grids[0]!).getAllByRole('gridcell');
      const find = (day: number) =>
        cells.map((cell) => within(cell).queryByRole('button')).find((btn) => btn?.textContent === String(day));
      expect(find(9)).toBeDisabled();
      expect(find(15)).not.toBeDisabled();
      expect(find(21)).toBeDisabled();
    });
  });

  it('disabled reaches the from field, the to field and the calendar trigger', () => {
    setupRange({ value: { from: '2026-08-01', to: '2026-08-31' }, disabled: true });
    expect(screen.getByLabelText('Created from')).toBeDisabled();
    expect(screen.getByLabelText('Created to')).toBeDisabled();
    expect(screen.getByLabelText('Open calendar')).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Ported from the legacy `__tests__/DateTimePicker.test.tsx` suite, which is
// deleted with the component it covered. Only the cases that were NOT already
// asserted above are carried over, so the coverage moves without duplicating.
// ---------------------------------------------------------------------------
describe('DateField mode="datetime" - coverage inherited from the legacy DateTimePicker', () => {
  afterEach(() => setOrgFormattingPrefs({}));

  it('renders the date-pattern and Time placeholders when the value is empty', () => {
    render(<DateField mode="datetime" value="" onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText('MM/DD/YYYY')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Time')).toBeInTheDocument();
  });

  it('offers only 15-minute increments in the time list', () => {
    render(<DateField mode="datetime" value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Open time list'));
    const options = screen.getAllByRole('button', { name: /^\d{1,2}:\d{2} (AM|PM)$/ });
    expect(options).toHaveLength(96);
    for (const o of options) expect(o.textContent ?? '').toMatch(/:(00|15|30|45)\s*(AM|PM)$/);
  });

  it('closes the calendar popover on an outside click', async () => {
    const user = userEvent.setup();
    render(<DateField mode="datetime" value="" onChange={vi.fn()} />);
    await user.click(screen.getByLabelText('Open calendar'));
    expect(await screen.findByRole('grid')).toBeInTheDocument();
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
  });

  it('respects an org-configured DD/MM/YYYY date format', () => {
    setOrgFormattingPrefs({ dateFormat: 'DD/MM/YYYY' });
    render(<DateField mode="datetime" value="2026-07-10T14:30" onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('10/07/2026')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// MUI-shaped calendar chrome: the caption doubles as a year-view toggle, and
// the panel holds one size across both views (SRVW-247 follow-up).
// ---------------------------------------------------------------------------
describe('DateField calendar - year view', () => {
  it('swaps the day grid for a year list when the caption is clicked, and back', () => {
    render(<DateField value="2026-08-15" onChange={vi.fn()} aria-label="Date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    expect(screen.getByRole('grid')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select a year'));
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Year' })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close year selection'));
    expect(screen.getByRole('grid')).toBeInTheDocument();
  });

  it('marks the displayed year as the selected option', () => {
    render(<DateField value="2026-08-15" onChange={vi.fn()} aria-label="Date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    fireEvent.click(screen.getByLabelText('Select a year'));
    expect(screen.getByRole('option', { name: '2026' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: '2027' })).toHaveAttribute('aria-selected', 'false');
  });

  it('picking a year moves the month and returns to the day grid, without committing a value', () => {
    const onChange = vi.fn();
    render(<DateField value="2026-08-15" onChange={onChange} aria-label="Date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    fireEvent.click(screen.getByLabelText('Select a year'));
    fireEvent.click(screen.getByRole('option', { name: '2029' }));

    // Back on the day grid, now showing the same month in the picked year.
    expect(screen.getByRole('grid')).toBeInTheDocument();
    expect(screen.getByLabelText('Select a year')).toHaveTextContent('August 2029');
    // Navigating is not choosing - the field's value is untouched until a day is clicked.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('offers no year toggle in range mode, where one year cannot speak for two months', () => {
    render(
      <DateField
        mode="range"
        value={{ from: '2026-08-01', to: '2026-08-31' }}
        onChange={vi.fn()}
        aria-label="Created"
      />,
    );
    fireEvent.click(screen.getByLabelText('Open calendar'));
    expect(screen.queryByLabelText('Select a year')).not.toBeInTheDocument();
    // Two grids, because range mode renders two months side by side.
    expect(screen.getAllByRole('grid')).toHaveLength(2);
  });
});
