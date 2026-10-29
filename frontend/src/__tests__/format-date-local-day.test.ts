/**
 * Mobile slice 61: `todayLocalDay` and `instantFromLocalDay` used to call date-fns' `format` and
 * `parse`, which put the whole date-fns formatter and the English locale tables into the staff
 * app's first download for two one-line jobs. They are plain Date arithmetic now. date-fns is used
 * here as the oracle, so this test pins that the answers did not change.
 */
import { describe, expect, it } from 'vitest';
import { format, parse } from 'date-fns';
import { instantFromLocalDay, todayLocalDay } from '@/lib/format-date';

describe('todayLocalDay', () => {
  it.each([
    new Date(2026, 0, 5, 23, 59, 59),
    new Date(2026, 11, 31, 0, 0, 0),
    new Date(2026, 2, 8, 2, 30),
    new Date(2028, 1, 29, 12),
    new Date(2026, 9, 4, 18, 45),
  ])('matches date-fns for %s (the LOCAL day, never the UTC day)', (now) => {
    expect(todayLocalDay(now)).toBe(format(now, 'yyyy-MM-dd'));
  });

  it('zero-pads month and day', () => {
    expect(todayLocalDay(new Date(2026, 2, 4, 9))).toBe('2026-03-04');
  });
});

describe('instantFromLocalDay', () => {
  const now = new Date(2026, 9, 4, 18, 45, 12);

  it('keeps the real clock time for today', () => {
    expect(instantFromLocalDay('2026-10-04', now)).toBe(now.toISOString());
  });

  it.each(['2026-10-03', '2026-03-08', '2026-11-01', '2026-01-01', '2028-02-29', '2026-12-31', '2026-1-5'])(
    'takes local noon for the back-dated %s, the same instant date-fns gave',
    (day) => {
      const expected = parse(`${day} 12:00`, 'yyyy-MM-dd HH:mm', now).toISOString();
      expect(instantFromLocalDay(day, now)).toBe(expected);
    },
  );

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2027-02-29', 'not a day', '', '10/03/2026'])(
    'refuses %j as date-fns did: an invalid date throws instead of becoming some other day',
    (day) => {
      expect(() => parse(`${day} 12:00`, 'yyyy-MM-dd HH:mm', now).toISOString()).toThrow(RangeError);
      expect(() => instantFromLocalDay(day, now)).toThrow(RangeError);
    },
  );
});
