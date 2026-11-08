/**
 * The time list opens somewhere USEFUL, and it scrolls.
 *
 * Both bugs are the same complaint from a dispatcher's seat: a 96-row list that opens
 * at midnight and then refuses the mouse wheel is a list you cannot get out of.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { TimeCombobox, anchorTimeValue } from '@/components/form/TimeCombobox';

function openList() {
  fireEvent.click(screen.getByRole('button', { name: 'Open time list' }));
}

/** The list's own rows, in DOM order - `within` the popover, so the trigger is excluded. */
function rows() {
  const list = screen.getByRole('dialog');
  return within(list)
    .getAllByRole('button')
    .map((b) => b.textContent);
}

/** classList, not a substring match - every row carries `hover:bg-primary-subtle`, so a
 *  substring test reports the whole list as highlighted and silently returns row 0. */
function highlightedRow() {
  const list = screen.getByRole('dialog');
  const hit = within(list)
    .getAllByRole('button')
    .filter((b) => b.classList.contains('bg-primary-subtle'));
  expect(hit).toHaveLength(1);
  return hit[0]!.textContent;
}

describe('anchorTimeValue', () => {
  it('returns the field own value verbatim, on-grid or not', () => {
    const now = new Date(2026, 7, 5, 9, 48);
    expect(anchorTimeValue('14:00', 15, now)).toBe('14:00');
    expect(anchorTimeValue('09:07', 15, now)).toBe('09:07');
  });

  it('floors the current time onto the step grid when the field is empty', () => {
    expect(anchorTimeValue('', 15, new Date(2026, 7, 5, 9, 48))).toBe('09:45');
    expect(anchorTimeValue('', 15, new Date(2026, 7, 5, 9, 15))).toBe('09:15');
    expect(anchorTimeValue('', 15, new Date(2026, 7, 5, 0, 3))).toBe('00:00');
    expect(anchorTimeValue('', 15, new Date(2026, 7, 5, 23, 59))).toBe('23:45');
  });

  it('honours a non-15-minute step', () => {
    expect(anchorTimeValue('', 30, new Date(2026, 7, 5, 9, 48))).toBe('09:30');
    expect(anchorTimeValue('', 60, new Date(2026, 7, 5, 9, 48))).toBe('09:00');
  });
});

describe('TimeCombobox opens on a useful row', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 7, 5, 9, 48));
  });
  afterEach(() => vi.useRealTimers());

  it('highlights the field own value, not midnight', () => {
    render(<TimeCombobox value="14:00" onChange={() => {}} />);
    openList();
    expect(highlightedRow()).toBe('2:00 PM');
  });

  it('highlights the current time floored to the grid when the field is empty', () => {
    render(<TimeCombobox value="" onChange={() => {}} />);
    openList();
    expect(highlightedRow()).toBe('9:45 AM');
  });

  it('still offers the whole day in both directions from the anchor', () => {
    render(<TimeCombobox value="14:00" onChange={() => {}} />);
    openList();
    const all = rows();
    expect(all).toHaveLength(96);
    expect(all[0]).toBe('12:00 AM');
    expect(all[95]).toBe('11:45 PM');
  });

  it('hands the highlight to the typed match, then back to the anchor when cleared', () => {
    render(<TimeCombobox value="14:00" onChange={() => {}} />);
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '3p' } });
    expect(highlightedRow()).toBe('3:00 PM');

    fireEvent.change(input, { target: { value: '' } });
    expect(highlightedRow()).toBe('2:00 PM');
  });

  it('re-anchors on the value the user just picked', () => {
    function Harness() {
      const [v, setV] = useState('14:00');
      return <TimeCombobox value={v} onChange={setV} />;
    }
    render(<Harness />);
    openList();
    fireEvent.click(screen.getByText('4:30 PM'));
    openList();
    expect(highlightedRow()).toBe('4:30 PM');
  });
});

describe('TimeCombobox list scrolling', () => {
  it('keeps wheel events off document, where a modal scroll lock would cancel them', () => {
    render(<TimeCombobox value="14:00" onChange={() => {}} />);
    openList();

    // Stands in for react-remove-scroll: a dialog's lock listens on `document` and
    // preventDefaults any wheel it sees from outside the locked subtree. The list is
    // portaled to document.body, so without stopPropagation it is always "outside".
    const lock = vi.fn((e: Event) => e.preventDefault());
    document.addEventListener('wheel', lock);
    try {
      const row = within(screen.getByRole('dialog')).getAllByRole('button')[0]!;
      const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      row.dispatchEvent(wheel);
      expect(lock).not.toHaveBeenCalled();
      expect(wheel.defaultPrevented).toBe(false);
    } finally {
      document.removeEventListener('wheel', lock);
    }
  });
});
