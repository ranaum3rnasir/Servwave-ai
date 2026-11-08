import { describe, it, expect } from 'vitest';
import {
  durationMinutesOf,
  isInvertedRange,
  scheduleTimeFrom,
  startDateOf,
  withDurationMinutes,
  withEndDate,
  withEndTime,
  withStartDate,
  withStartTime,
  type ScheduleTimeValue,
} from './scheduleTimeValue';

const v = (over: Partial<ScheduleTimeValue> = {}): ScheduleTimeValue => ({
  date: '2026-08-10',
  startTime: '09:00',
  endDate: '2026-08-10',
  endTime: '11:00',
  ...over,
});

describe('durationMinutesOf', () => {
  it('derives the duration from the two ends', () => {
    expect(durationMinutesOf(v())).toBe(120);
  });

  it('counts across a day boundary', () => {
    expect(durationMinutesOf(v({ startTime: '22:00', endDate: '2026-08-11', endTime: '01:30' }))).toBe(210);
  });

  it('is null when a half is unset or the range is inverted', () => {
    expect(durationMinutesOf(v({ endTime: '' }))).toBeNull();
    expect(durationMinutesOf(v({ startTime: '' }))).toBeNull();
    expect(durationMinutesOf(v({ endTime: '08:00' }))).toBeNull();
  });

  it('survives a spring-forward day - wall-clock math, not elapsed local time', () => {
    // 2026-03-08 is the US DST transition; 1:00 AM + 3h is 4:00 AM on the wall clock.
    expect(durationMinutesOf(v({ date: '2026-03-08', startTime: '01:00', endDate: '2026-03-08', endTime: '04:00' }))).toBe(180);
  });
});

describe('withDurationMinutes', () => {
  it('moves the end, never the start', () => {
    expect(withDurationMinutes(v(), 90)).toEqual(v({ endTime: '10:30' }));
  });

  it('rolls the end onto the next day when the duration passes midnight', () => {
    expect(withDurationMinutes(v({ startTime: '23:00' }), 120)).toEqual(
      v({ startTime: '23:00', endDate: '2026-08-11', endTime: '01:00' }),
    );
  });

  it('does nothing without a usable start', () => {
    const partial = v({ date: '', startTime: '' });
    expect(withDurationMinutes(partial, 60)).toBe(partial);
  });
});

describe('withEndTime', () => {
  it('sets the end time on the start day', () => {
    expect(withEndTime(v(), '13:15')).toEqual(v({ endTime: '13:15' }));
  });

  it('rolls to the next day when the end would land on or before the start', () => {
    expect(withEndTime(v({ startTime: '20:00', endTime: '22:00' }), '01:00')).toEqual(
      v({ startTime: '20:00', endDate: '2026-08-11', endTime: '01:00' }),
    );
  });

  it('keeps an existing multi-day span instead of collapsing it', () => {
    const multi = v({ endDate: '2026-08-12', endTime: '11:00' });
    expect(withEndTime(multi, '15:00')).toEqual(v({ endDate: '2026-08-12', endTime: '15:00' }));
  });
});

describe('withStartDate / withStartTime', () => {
  it('drags the end along so the duration survives a date change', () => {
    expect(withStartDate(v(), '2026-09-01')).toEqual(
      v({ date: '2026-09-01', endDate: '2026-09-01' }),
    );
  });

  it('preserves a multi-day span when the start date moves', () => {
    const multi = v({ endDate: '2026-08-12', endTime: '11:00' });
    expect(withStartDate(multi, '2026-08-20')).toEqual(
      v({ date: '2026-08-20', endDate: '2026-08-22', endTime: '11:00' }),
    );
  });

  it('drags the end along so the duration survives a time change', () => {
    expect(withStartTime(v(), '14:00')).toEqual(v({ startTime: '14:00', endTime: '16:00' }));
  });

  it('leaves the end alone when there is no duration to preserve', () => {
    expect(withStartTime(v({ endTime: '' }), '14:00')).toEqual(v({ startTime: '14:00', endTime: '' }));
  });
});

describe('withEndDate / isInvertedRange', () => {
  it('sets the end day outright', () => {
    expect(withEndDate(v(), '2026-08-13').endDate).toBe('2026-08-13');
  });

  it('flags an end DATE dragged back before the start', () => {
    expect(isInvertedRange(v())).toBe(false);
    expect(isInvertedRange(withEndDate(v(), '2026-08-09'))).toBe(true);
  });

  it('treats a zero-length range as inverted - a job cannot end the instant it starts', () => {
    expect(isInvertedRange(v({ endTime: '09:00' }))).toBe(true);
  });

  it('does not call a half-filled range wrong', () => {
    expect(isInvertedRange(v({ endTime: '' }))).toBe(false);
    expect(isInvertedRange(v({ date: '', startTime: '' }))).toBe(false);
  });
});

describe('scheduleTimeFrom / startDateOf', () => {
  it('round-trips a board start + duration', () => {
    const value = scheduleTimeFrom(new Date(2026, 7, 10, 9, 0), 120);
    expect(value).toEqual(v());
    expect(durationMinutesOf(value)).toBe(120);
    expect(startDateOf(value)).toEqual(new Date(2026, 7, 10, 9, 0));
  });

  it('returns a null start until both halves are set', () => {
    expect(startDateOf(v({ startTime: '' }))).toBeNull();
  });
});
