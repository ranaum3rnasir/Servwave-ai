import { describe, it, expect } from 'vitest';
import { statedWindowMoves, type JobScheduleWindow } from '../lib/job-schedule-projection';

/** A window the way a stored visit holds it: 10:00-11:00 UTC, timed. */
const STORED: JobScheduleWindow = {
  scheduled_start: new Date('2030-01-01T10:00:00.000Z'),
  scheduled_end: new Date('2030-01-01T11:00:00.000Z'),
  is_all_day: false,
};

describe('statedWindowMoves: the window a write would leave, against the stored one', () => {
  it('is a move when only the end, only the start or only the all-day flag differs', () => {
    expect(statedWindowMoves(STORED, { scheduled_end: '2031-01-01T11:00:00.000Z' })).toBe(true);
    expect(statedWindowMoves(STORED, { scheduled_start: '2031-01-01T10:00:00.000Z' })).toBe(true);
    expect(statedWindowMoves(STORED, { is_all_day: true })).toBe(true);
  });

  it('is a move when a stated start or end is cleared on a stored window', () => {
    expect(statedWindowMoves(STORED, { scheduled_start: null })).toBe(true);
    expect(statedWindowMoves(STORED, { scheduled_end: null })).toBe(true);
  });

  it('is no move when nothing is stated or the stored window is restated, to the minute', () => {
    expect(statedWindowMoves(STORED, {})).toBe(false);
    expect(statedWindowMoves(STORED, { scheduled_start: '2030-01-01T10:00:30.000Z', scheduled_end: '2030-01-01T11:00:00.000Z', is_all_day: false })).toBe(false);
    expect(statedWindowMoves({ ...STORED, scheduled_start: null, scheduled_end: null }, { scheduled_start: null })).toBe(false);
  });

  it('leaves a value that is not a date or not a flag to validation', () => {
    expect(statedWindowMoves(STORED, { scheduled_start: 'tomorrow', scheduled_end: 42, is_all_day: 'yes' })).toBe(false);
  });
});
