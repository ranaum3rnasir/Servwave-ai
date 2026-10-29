import { describe, expect, it } from 'vitest';

import { orgDayDiff } from './schedule-tz';
import { orgDayDiffIntl } from './schedule-tz-intl';

/**
 * Mobile slice 47: `orgDayDiffIntl` is the public invoice page's way of asking "is this overdue",
 * computed without date-fns-tz so a customer does not download it. It is only acceptable if it
 * answers exactly as `orgDayDiff` does, so this holds the two equal on a grid that includes the
 * awkward cases: zones east and west of UTC, a half-hour zone, an instant either side of local
 * midnight, and both DST days of a year in a zone that observes it.
 */
const ZONES = [
  'America/New_York',
  'America/Los_Angeles',
  'America/Santiago',
  'Europe/London',
  'Asia/Kolkata',
  'Asia/Manila',
  'Pacific/Auckland',
  'UTC',
];

// An instant either side of midnight in several zones, plus the 2026 US DST transitions.
const DUES = [
  '2026-01-01T00:00:00.000Z',
  '2026-03-08T06:59:59.000Z',
  '2026-03-08T07:00:00.000Z',
  '2026-03-08T09:30:00.000Z',
  '2026-07-10T02:35:00.000Z',
  '2026-07-10T23:59:59.999Z',
  '2026-11-01T05:30:00.000Z',
  '2026-11-01T06:00:00.000Z',
  '2026-12-31T23:30:00+05:30',
  '2027-02-28T22:00:00-08:00',
];

const NOWS = [
  '2026-03-07T12:00:00.000Z',
  '2026-03-08T12:00:00.000Z',
  '2026-07-10T03:00:00.000Z',
  '2026-07-10T04:30:00.000Z',
  '2026-11-01T12:00:00.000Z',
  '2026-11-02T12:00:00.000Z',
];

describe('orgDayDiffIntl matches orgDayDiff', () => {
  for (const tz of ZONES) {
    it(`in ${tz}, for every due instant against every clock`, () => {
      const mismatches: string[] = [];
      for (const due of DUES) {
        for (const now of NOWS) {
          const want = orgDayDiff(due, tz, now);
          const got = orgDayDiffIntl(due, tz, now);
          if (got !== want) mismatches.push(`${due} vs now ${now}: orgDayDiff ${want}, Intl ${got}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('reads the real clock when no reference instant is given', () => {
    const iso = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect(orgDayDiffIntl(iso, 'America/New_York')).toBe(orgDayDiff(iso, 'America/New_York'));
  });

  it('can be told apart from a wrong answer: yesterday is negative, today is zero, tomorrow positive', () => {
    const now = '2026-07-10T16:00:00.000Z';
    expect(orgDayDiffIntl('2026-07-09T16:00:00.000Z', 'America/New_York', now)).toBe(-1);
    expect(orgDayDiffIntl('2026-07-10T20:00:00.000Z', 'America/New_York', now)).toBe(0);
    expect(orgDayDiffIntl('2026-07-11T16:00:00.000Z', 'America/New_York', now)).toBe(1);
  });
});
