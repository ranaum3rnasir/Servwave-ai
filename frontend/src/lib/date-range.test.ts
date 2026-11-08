import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  todayDay, daysAgoDay, startOfWeekDay, startOfMonthDay, endOfMonthDay, startOfYearDay,
  PRESETS, matchPreset,
} from './date-range';

/**
 * #1634 — the date-range half. Each of the six functions above gained an
 * OPTIONAL `tz`. Omitted, every one of them must be byte-identical to the
 * pre-existing browser-clock implementation - that is the load-bearing
 * "no silent flip" contract every unmigrated call site depends on.
 *
 * Per the house rule on discriminating instants: every zone-comparison test
 * below picks an instant that renders on DIFFERENT calendar days (or weeks,
 * or months, or years, as the function requires) in America/New_York and
 * Asia/Manila, and pairs it with a control instant that renders the SAME in
 * both - proving the probe can actually tell a correct implementation from a
 * broken one.
 */

const NY = 'America/New_York';
const MANILA = 'Asia/Manila';

describe('the six *-Day functions — tz threading', () => {
  afterEach(() => vi.useRealTimers());

  describe('todayDay', () => {
    it('discriminates: 22:00Z splits the calendar day between NY and Manila', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T22:00:00.000Z'));
      expect(todayDay(NY)).toBe('2026-08-24');
      expect(todayDay(MANILA)).toBe('2026-08-25');
    });

    it('control: 13:00Z is the same calendar day in both zones', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T13:00:00.000Z'));
      expect(todayDay(NY)).toBe('2026-08-24');
      expect(todayDay(MANILA)).toBe('2026-08-24');
    });
  });

  describe('daysAgoDay', () => {
    it('discriminates: "yesterday" differs between NY and Manila at the same instant', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T22:00:00.000Z'));
      expect(daysAgoDay(1, NY)).toBe('2026-08-23');
      expect(daysAgoDay(1, MANILA)).toBe('2026-08-24');
    });

    it('daysAgoDay(0, tz) === todayDay(tz)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T22:00:00.000Z'));
      expect(daysAgoDay(0, MANILA)).toBe(todayDay(MANILA));
    });
  });

  describe('startOfWeekDay', () => {
    it('discriminates: NY is still last week’s Saturday while Manila has already rolled into a new week', () => {
      // 2026-08-30T00:00:00Z: NY = Sat Aug 29 (week of Sun Aug 23); Manila = Sun Aug 30 (a new week).
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'));
      expect(startOfWeekDay(NY)).toBe('2026-08-23');
      expect(startOfWeekDay(MANILA)).toBe('2026-08-30');
    });

    it('control: an instant mid-week in both zones resolves to the same Sunday', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T13:00:00.000Z')); // Mon in both
      expect(startOfWeekDay(NY)).toBe('2026-08-23');
      expect(startOfWeekDay(MANILA)).toBe('2026-08-23');
    });
  });

  describe('startOfMonthDay / endOfMonthDay', () => {
    it('discriminates: NY is still in August while Manila has already rolled into September', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-31T22:00:00.000Z'));
      expect(startOfMonthDay(NY)).toBe('2026-08-01');
      expect(endOfMonthDay(NY)).toBe('2026-08-31');
      expect(startOfMonthDay(MANILA)).toBe('2026-09-01');
      expect(endOfMonthDay(MANILA)).toBe('2026-09-30');
    });

    it('control: mid-month, both zones agree on the month bounds', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T13:00:00.000Z'));
      expect(startOfMonthDay(NY)).toBe('2026-08-01');
      expect(startOfMonthDay(MANILA)).toBe('2026-08-01');
      expect(endOfMonthDay(NY)).toBe('2026-08-31');
      expect(endOfMonthDay(MANILA)).toBe('2026-08-31');
    });
  });

  describe('startOfYearDay', () => {
    it('discriminates: NY is still in 2026 while Manila has already rolled into 2027', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-12-31T22:00:00.000Z'));
      expect(startOfYearDay(NY)).toBe('2026-01-01');
      expect(startOfYearDay(MANILA)).toBe('2027-01-01');
    });

    it('control: mid-year, both zones agree', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T13:00:00.000Z'));
      expect(startOfYearDay(NY)).toBe('2026-01-01');
      expect(startOfYearDay(MANILA)).toBe('2026-01-01');
    });
  });
});

/**
 * NO SILENT FLIP — the contract every unmigrated call site depends on: omitting
 * `tz` must produce EXACTLY what the pre-existing browser-clock implementation
 * produced, regardless of what any org's timezone happens to be. Proven by
 * forcing the process/runtime clock (`process.env.TZ`) to a zone that
 * DISAGREES with the org-zone fixture above at the same discriminating
 * instant - if an omitted `tz` silently fell back to reading an org zone
 * instead of the runtime's own, this test would catch it.
 */
describe('omitted tz — byte-identical to the pre-existing browser-clock behaviour', () => {
  let originalTz: string | undefined;
  beforeEach(() => {
    originalTz = process.env.TZ;
  });
  afterEach(() => {
    process.env.TZ = originalTz;
    vi.useRealTimers();
  });

  it('todayDay() follows the RUNTIME clock (New York here), not Manila, at the discriminating instant', () => {
    process.env.TZ = NY;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T22:00:00.000Z'));

    expect(todayDay()).toBe('2026-08-24'); // NY's day (the runtime clock)
    expect(todayDay()).not.toBe(todayDay(MANILA)); // proves it did NOT fall back to org zone
  });

  it('daysAgoDay(n) follows the runtime clock', () => {
    process.env.TZ = NY;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T22:00:00.000Z'));
    expect(daysAgoDay(1)).toBe('2026-08-23');
  });

  it('startOfWeekDay() follows the runtime clock', () => {
    process.env.TZ = NY;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'));
    expect(startOfWeekDay()).toBe('2026-08-23'); // NY's week, not Manila's
  });

  it('startOfMonthDay()/endOfMonthDay() follow the runtime clock', () => {
    process.env.TZ = NY;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T22:00:00.000Z'));
    expect(startOfMonthDay()).toBe('2026-08-01'); // NY's month, not Manila's September
    expect(endOfMonthDay()).toBe('2026-08-31');
  });

  it('startOfYearDay() follows the runtime clock', () => {
    process.env.TZ = NY;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-31T22:00:00.000Z'));
    expect(startOfYearDay()).toBe('2026-01-01'); // NY's year, not Manila's 2027
  });
});

describe('PRESETS / matchPreset — consolidated array (#1634 dedup)', () => {
  it('exposes exactly the eight presets every call site relied on', () => {
    expect(PRESETS.map((p) => p.key)).toEqual([
      'any', 'today', 'week', 'month', 'last7', 'last30', 'last90', 'year',
    ]);
  });

  it('range(tz) threads tz through to the org zone, discriminating instant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T22:00:00.000Z'));
    const today = PRESETS.find((p) => p.key === 'today')!;
    expect(today.range(NY)).toEqual({ from: '2026-08-24', to: '2026-08-24' });
    expect(today.range(MANILA)).toEqual({ from: '2026-08-25', to: '2026-08-25' });
    vi.useRealTimers();
  });

  it('range() omitted tz stays on the browser clock (no silent flip)', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = NY;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T22:00:00.000Z'));

    const today = PRESETS.find((p) => p.key === 'today')!;
    expect(today.range()).toEqual({ from: '2026-08-24', to: '2026-08-24' });

    vi.useRealTimers();
    process.env.TZ = originalTz;
  });

  it('matchPreset resolves "today" for the ORG day when tz is given, and for the browser day when omitted', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = NY;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T22:00:00.000Z'));

    expect(matchPreset('2026-08-24', '2026-08-24')).toBe('today'); // browser (NY) day
    expect(matchPreset('2026-08-25', '2026-08-25', MANILA)).toBe('today'); // org (Manila) day
    expect(matchPreset('2026-08-25', '2026-08-25')).toBe('custom'); // Manila's day is NOT "today" on the browser clock

    vi.useRealTimers();
    process.env.TZ = originalTz;
  });

  it("'any' and 'custom' still resolve with no tz-sensitivity at all", () => {
    expect(matchPreset('', '')).toBe('any');
    expect(matchPreset('', '', MANILA)).toBe('any');
    expect(matchPreset('2020-01-01', '2020-01-02')).toBe('custom');
  });
});
