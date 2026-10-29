/**
 * TimeField - the unified time control (SRVW-247 step 1) replacing
 * `components/form/TimeCombobox`, `pages/v2/_shared/timeCombobox`,
 * `components/form/TimeSelect` and `pages/v2/_shared/timeSelect`.
 *
 * Value contract: '' or 'HH:MM' (24-hour), identical across every prior
 * control, so this suite drives the rendered field the same way the legacy
 * suites did - type, focus, press keys, click options - rather than reaching
 * into internals.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TimeField, anchorTimeValue } from '../timeField';

function setup(props: Partial<React.ComponentProps<typeof TimeField>> = {}) {
  const onChange = vi.fn();
  render(<TimeField value="" onChange={onChange} aria-label="Time" {...props} />);
  return { onChange, field: screen.getByLabelText('Time') as HTMLInputElement };
}

/** The list's own rows, in DOM order - `within` the popover, so the trigger
 *  and the clear button (also `<button>`s, outside the popover) are excluded. */
function rows() {
  const list = screen.getByRole('dialog');
  return within(list).getAllByRole('button').map((b) => b.textContent);
}

/** classList, not a substring match - every row shares the same hover class,
 *  so a substring test would report the whole list as highlighted. */
function highlightedRow() {
  const list = screen.getByRole('dialog');
  const hit = within(list).getAllByRole('button').filter((b) => b.classList.contains('bg-muted'));
  expect(hit).toHaveLength(1);
  return hit[0]!.textContent;
}

describe('anchorTimeValue', () => {
  it('returns the value itself when one is set, off-grid included', () => {
    expect(anchorTimeValue('14:00', 15)).toBe('14:00');
    expect(anchorTimeValue('09:07', 15)).toBe('09:07');
  });

  it('floors the current time to the step grid when empty', () => {
    expect(anchorTimeValue('', 15, new Date(2026, 7, 5, 9, 48))).toBe('09:45');
    expect(anchorTimeValue('', 15, new Date(2026, 7, 5, 9, 15))).toBe('09:15');
    expect(anchorTimeValue('', 15, new Date(2026, 7, 5, 0, 3))).toBe('00:00');
    expect(anchorTimeValue('', 15, new Date(2026, 7, 5, 23, 59))).toBe('23:45');
    expect(anchorTimeValue('', 30, new Date(2026, 7, 5, 9, 48))).toBe('09:30');
    expect(anchorTimeValue('', 60, new Date(2026, 7, 5, 9, 48))).toBe('09:00');
  });
});

describe('TimeField (variant="input")', () => {
  describe('typed shorthand (ability 1 - reuses parseTimeInputText, not reimplemented)', () => {
    it.each([
      ['3p', '15:00'],
      ['3pm', '15:00'],
      ['3:00', '03:00'],
      ['3:00pm', '15:00'],
      ['15:00', '15:00'],
      ['1500', '15:00'],
      ['300pm', '15:00'],
    ])('commits "%s" as %s on blur', (typed, expected) => {
      const { onChange, field } = setup();
      fireEvent.change(field, { target: { value: typed } });
      fireEvent.blur(field);
      expect(onChange).toHaveBeenCalledWith(expected);
    });

    it('resolves a bare "3" through the open list (Enter selects the filtered match, not a raw parse)', () => {
      const { onChange, field } = setup();
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: '3' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith('03:00');
    });

    it('reverts to the prior value on blur when the typed text is unparseable', () => {
      const { onChange, field } = setup({ value: '09:00' });
      fireEvent.change(field, { target: { value: 'not a time' } });
      fireEvent.blur(field);
      expect(onChange).not.toHaveBeenCalled();
      expect(field).toHaveValue('9:00 AM');
    });
  });

  describe('off-grid values are accepted, not snapped (ability 2)', () => {
    it('keeps 15:07 on commit when stepMinutes is 15', () => {
      const { onChange, field } = setup({ stepMinutes: 15 });
      fireEvent.change(field, { target: { value: '3:07 PM' } });
      fireEvent.blur(field);
      expect(onChange).toHaveBeenCalledWith('15:07');
      expect(onChange).not.toHaveBeenCalledWith('15:00');
      expect(onChange).not.toHaveBeenCalledWith('15:15');
    });
  });

  describe('list anchoring (ability 3)', () => {
    beforeEach(() => vi.useFakeTimers().setSystemTime(new Date(2026, 7, 5, 9, 48)));
    afterEach(() => vi.useRealTimers());

    it('anchors an empty field on "now" floored to the step grid, not the top of the list', () => {
      const { field } = setup({ stepMinutes: 15 });
      fireEvent.focus(field);
      const anchorRow = screen.getByText('9:45 AM').closest('button');
      const topRow = screen.getByText('12:00 AM').closest('button');
      expect(anchorRow).toHaveClass('bg-muted');
      expect(topRow).not.toHaveClass('bg-muted');
    });

    it('anchors an off-grid 9:10 value on the 9:00 row (floor), not 9:15 (nearest)', () => {
      // 9:10 is deliberately NOT equidistant from both grid neighbours: floor
      // gives 9:00, nearest-rounding gives 9:15 - a value where the two
      // strategies disagree, unlike 9:07 (both floor and round land on 9:00).
      const { field } = setup({ value: '09:10', stepMinutes: 15 });
      fireEvent.focus(field);
      expect(highlightedRow()).toBe('9:00 AM');
    });

    it('still offers the whole day in both directions from the anchor', () => {
      const { field } = setup({ value: '14:00', stepMinutes: 15 });
      fireEvent.focus(field);
      const all = rows();
      expect(all).toHaveLength(96);
      expect(all[0]).toBe('12:00 AM');
      expect(all[95]).toBe('11:45 PM');
    });

    it('hands the highlight to the typed match, then back to the anchor when the query is cleared', () => {
      const { field } = setup({ value: '14:00', stepMinutes: 15 });
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: '3p' } });
      expect(highlightedRow()).toBe('3:00 PM');

      fireEvent.change(field, { target: { value: '' } });
      expect(highlightedRow()).toBe('2:00 PM');
    });

    it('re-anchors on the value the user just picked', () => {
      function Harness() {
        const [v, setV] = useState('14:00');
        return <TimeField value={v} onChange={setV} aria-label="Time" />;
      }
      render(<Harness />);
      fireEvent.focus(screen.getByLabelText('Time'));
      fireEvent.click(screen.getByText('4:30 PM'));
      fireEvent.focus(screen.getByLabelText('Time'));
      expect(highlightedRow()).toBe('4:30 PM');
    });
  });

  describe('the wheel fix (ability 4)', () => {
    it('stops a wheel event on the open list from reaching document', () => {
      const { field } = setup();
      fireEvent.focus(field);
      const docListener = vi.fn();
      document.addEventListener('wheel', docListener);
      const list = document.querySelector('[data-slot="popover-content"]');
      expect(list).toBeTruthy();
      fireEvent.wheel(list as Element);
      expect(docListener).not.toHaveBeenCalled();
      document.removeEventListener('wheel', docListener);
    });
  });

  describe('query decoupling (ability 6)', () => {
    it('shows the full nearby list on focus of a filled field, not just the exact match', () => {
      const { field } = setup({ value: '09:30' });
      fireEvent.focus(field);
      // The field's own text is the filled value, but the list is NOT filtered
      // down to it - a distant option is present too.
      expect(field).toHaveValue('9:30 AM');
      expect(screen.getByText('12:00 AM')).toBeInTheDocument();
      expect(screen.getByText('9:30 AM')).toBeInTheDocument();
    });
  });

  describe('keyboard (ability 7)', () => {
    it('ArrowDown opens a closed list, anchored', () => {
      vi.useFakeTimers().setSystemTime(new Date(2026, 7, 5, 9, 48));
      const { field } = setup();
      expect(screen.queryByText('9:45 AM')).not.toBeInTheDocument();
      fireEvent.keyDown(field, { key: 'ArrowDown' });
      expect(screen.getByText('9:45 AM')).toBeInTheDocument();
      vi.useRealTimers();
    });

    it('ArrowDown moves the highlight down once the list is open', () => {
      const { onChange, field } = setup({ value: '09:00' });
      fireEvent.focus(field); // opens, anchored at 09:00
      fireEvent.keyDown(field, { key: 'ArrowDown' }); // list already open -> steps to 09:15
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith('09:15');
    });

    it('ArrowUp does not open a closed list', () => {
      const { field } = setup();
      fireEvent.keyDown(field, { key: 'ArrowUp' });
      expect(screen.queryByText('12:00 AM')).not.toBeInTheDocument();
    });

    it('Enter commits the typed text when the list is closed', () => {
      const { onChange, field } = setup();
      fireEvent.change(field, { target: { value: '9:00am' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith('09:00');
    });

    it('Enter selects the highlighted option when the list is open', () => {
      vi.useFakeTimers().setSystemTime(new Date(2026, 7, 5, 9, 48));
      const { onChange, field } = setup();
      fireEvent.keyDown(field, { key: 'ArrowDown' }); // opens, anchored at 09:45
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith('09:45');
      vi.useRealTimers();
    });

    it('Escape closes without selecting', () => {
      const { onChange, field } = setup();
      fireEvent.focus(field);
      expect(screen.getByText('12:00 AM')).toBeInTheDocument();
      fireEvent.keyDown(field, { key: 'Escape' });
      expect(screen.queryByText('12:00 AM')).not.toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('clearable', () => {
    it('shows a clear affordance for a set value by default and clears on click', () => {
      const { onChange } = setup({ value: '09:00' });
      const clear = screen.getByLabelText('Clear time');
      fireEvent.click(clear);
      expect(onChange).toHaveBeenCalledWith('');
    });

    it('omits the clear affordance when clearable is false', () => {
      setup({ value: '09:00', clearable: false });
      expect(screen.queryByLabelText('Clear time')).not.toBeInTheDocument();
    });

    it('omits the clear affordance when there is no value to clear', () => {
      setup({ value: '' });
      expect(screen.queryByLabelText('Clear time')).not.toBeInTheDocument();
    });

    it('does not leave a stale anchor after clearing - the next open re-anchors on "now"', () => {
      vi.useFakeTimers().setSystemTime(new Date(2026, 7, 5, 9, 48));
      function Harness() {
        const [v, setV] = useState('14:00');
        return <TimeField value={v} onChange={setV} aria-label="Time" />;
      }
      render(<Harness />);
      const field = screen.getByLabelText('Time');
      fireEvent.focus(field); // opens, anchored/highlighted at 14:00 (2:00 PM)
      fireEvent.click(screen.getByLabelText('Clear time'));
      // Re-opening after the clear must not act on the old 2:00 PM anchor.
      fireEvent.focus(field);
      expect(highlightedRow()).toBe('9:45 AM'); // "now" floored, not the stale row
      vi.useRealTimers();
    });
  });

  describe('inputClassName (distinct from the wrapper className)', () => {
    it('merges onto the inner text field only, leaving the wrapper className alone', () => {
      const { field } = setup({ className: 'w-40', inputClassName: 'h-7 text-xs' });
      expect(field).toHaveClass('h-7', 'text-xs');
      expect(field).not.toHaveClass('w-40');
      const wrapper = field.parentElement;
      expect(wrapper).toHaveClass('w-40');
      expect(wrapper).not.toHaveClass('h-7', 'text-xs');
    });

    it('still applies the inner field default sizing alongside an override', () => {
      const { field } = setup({ inputClassName: 'h-7' });
      expect(field).toHaveClass('h-7', 'min-w-0', 'flex-1');
    });
  });

  describe('disabled reaches every interactive sub-part', () => {
    it('disables the text field, the clear button and the list trigger', () => {
      setup({ value: '09:00', disabled: true });
      expect(screen.getByLabelText('Time')).toBeDisabled();
      expect(screen.getByLabelText('Clear time')).toBeDisabled();
      expect(screen.getByLabelText('Open time list')).toBeDisabled();
    });
  });

  it('passes aria-invalid through to the text field', () => {
    setup({ 'aria-invalid': true });
    expect(screen.getByLabelText('Time')).toHaveAttribute('aria-invalid', 'true');
  });

  it('accepts a collisionPadding value (object or number) without throwing', () => {
    const { field } = setup({ collisionPadding: { top: 64 } });
    expect(() => fireEvent.focus(field)).not.toThrow();
    expect(screen.getByText('12:00 AM')).toBeInTheDocument();
  });
});

describe('TimeField (variant="select")', () => {
  it('displays an off-grid saved value instead of showing blank (ability 9)', async () => {
    const user = userEvent.setup();
    render(<TimeField value="09:07" onChange={vi.fn()} variant="select" aria-label="Time" />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('9:07 AM');
    await user.click(trigger);
    expect(screen.getByRole('option', { name: '9:07 AM' })).toBeInTheDocument();
  });

  it('calls onChange with the HH:MM value when an option is picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimeField value="" onChange={onChange} variant="select" aria-label="Time" />);
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: '1:30 PM' }));
    expect(onChange).toHaveBeenCalledWith('13:30');
  });

  it('keeps the reset-to-blank option reachable and clearable by default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimeField value="13:30" onChange={onChange} variant="select" aria-label="Time" />);
    await user.click(screen.getByRole('combobox'));
    const reset = screen.getByRole('option', { name: 'Select time…' });
    expect(reset).not.toHaveAttribute('data-disabled');
    await user.click(reset);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('disables the reset-to-blank option when clearable is false', async () => {
    const user = userEvent.setup();
    render(<TimeField value="13:30" onChange={vi.fn()} variant="select" clearable={false} aria-label="Time" />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Select time…' })).toHaveAttribute('data-disabled');
  });

  it('disables the trigger when disabled is set', () => {
    render(<TimeField value="09:00" onChange={vi.fn()} variant="select" disabled aria-label="Time" />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('respects a custom stepMinutes grid', async () => {
    const user = userEvent.setup();
    render(<TimeField value="" onChange={vi.fn()} variant="select" stepMinutes={30} aria-label="Time" />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('option', { name: '9:15 AM' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: '9:30 AM' })).toBeInTheDocument();
  });
});
