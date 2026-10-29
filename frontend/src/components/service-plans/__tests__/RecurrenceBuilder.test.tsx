import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  RecurrenceBuilder,
  recurrenceToPayload,
  DEFAULT_RECURRENCE,
  type RecurrenceValue,
} from '../RecurrenceBuilder';

const val = (over: Partial<RecurrenceValue> = {}): RecurrenceValue => ({ ...DEFAULT_RECURRENCE, ...over });

describe('recurrenceToPayload', () => {
  it('maps a weekly multi-weekday rule with an occurrence-count terminator', () => {
    expect(
      recurrenceToPayload(
        val({ interval_unit: 'WEEK', interval_count: 2, byweekday: [1, 4], end_mode: 'after', occurrence_count: 6 }),
      ),
    ).toEqual({ interval_unit: 'WEEK', interval_count: 2, byweekday: [1, 4], end_date: null, occurrence_count: 6 });
  });

  it('drops weekdays for non-weekly units and maps an on-date terminator', () => {
    const p = recurrenceToPayload(
      val({ interval_unit: 'MONTH', interval_count: 3, byweekday: [1], end_mode: 'on', end_date: '2026-12-31' }),
    );
    expect(p.byweekday).toEqual([]);
    expect(p.occurrence_count).toBeNull();
    expect(p.end_date).toBe(new Date('2026-12-31').toISOString());
  });

  it('clears both terminators when end_mode is never', () => {
    const p = recurrenceToPayload(val({ end_mode: 'never' }));
    expect(p.end_date).toBeNull();
    expect(p.occurrence_count).toBeNull();
  });
});

describe('RecurrenceBuilder', () => {
  it('shows weekday chips only for weekly units', () => {
    const { rerender } = render(<RecurrenceBuilder value={val({ interval_unit: 'MONTH' })} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Monday' })).toBeNull();
    rerender(<RecurrenceBuilder value={val({ interval_unit: 'WEEK' })} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Monday' })).toBeInTheDocument();
  });

  it('toggles a weekday on click', () => {
    const onChange = vi.fn();
    render(<RecurrenceBuilder value={val({ interval_unit: 'WEEK', byweekday: [] })} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ byweekday: [1] }));
  });

  it('removes an already-selected weekday on click', () => {
    const onChange = vi.fn();
    render(<RecurrenceBuilder value={val({ interval_unit: 'WEEK', byweekday: [1, 4] })} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thursday' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ byweekday: [1] }));
  });

  it('switches the end mode via the radios', () => {
    const onChange = vi.fn();
    render(<RecurrenceBuilder value={val()} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Ends after a number of occurrences' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ end_mode: 'after' }));
  });

  it('updates the interval count', () => {
    const onChange = vi.fn();
    render(<RecurrenceBuilder value={val()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Interval count'), { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ interval_count: 3 }));
  });
});
