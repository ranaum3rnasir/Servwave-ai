import { describe, it, expect } from 'vitest';

import { wholeDaySpanMinutes, type ScheduleTimeValue } from './scheduleTimeValue';

const value = (date: string, endDate: string): ScheduleTimeValue => ({
  date,
  endDate,
  // An all-day booking has no time of day, and the fields are not on screen.
  startTime: '',
  endTime: '',
});

describe('wholeDaySpanMinutes', () => {
  it('counts a single day as a whole day, not as nothing', () => {
    expect(wholeDaySpanMinutes(value('2026-08-20', '2026-08-20'))).toBe(1440);
  });

  it('counts start and end inclusive', () => {
    expect(wholeDaySpanMinutes(value('2026-08-20', '2026-08-21'))).toBe(2880);
    expect(wholeDaySpanMinutes(value('2026-08-20', '2026-08-24'))).toBe(7200);
  });

  it('falls back to one day when the end is missing or inverted', () => {
    expect(wholeDaySpanMinutes(value('2026-08-20', ''))).toBe(1440);
    expect(wholeDaySpanMinutes(value('2026-08-20', '2026-08-18'))).toBe(1440);
  });

  it('is null without a start date - there is nothing to span', () => {
    expect(wholeDaySpanMinutes(value('', '2026-08-20'))).toBeNull();
  });

  it('keeps a day 1440 minutes across a DST boundary', () => {
    // US DST ends 2026-11-01; a local-time subtraction would report 1500 here.
    expect(wholeDaySpanMinutes(value('2026-10-31', '2026-11-01'))).toBe(2880);
    // ...and starts 2026-03-08, where a local-time subtraction reports 1380.
    expect(wholeDaySpanMinutes(value('2026-03-07', '2026-03-08'))).toBe(2880);
  });
});
