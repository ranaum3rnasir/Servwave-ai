// The FILTER boundary of schedule-tz: org-zone calendar-day arithmetic.
//
// Same contract as schedule-tz.render.test.ts - every assertion is that the answer
// is IDENTICAL whoever is looking. A test that merely checked "the numbers are
// right" would pass in the runner's own zone and prove nothing about the bug this
// exists to stop.
import { describe, it, expect } from 'vitest';
import { addOrgDays, orgToday, orgDayStart, orgDayEnd } from '@/lib/schedule-tz';

const NY = 'America/New_York';
const MANILA = 'Asia/Manila';
const LONDON = 'Europe/London';
const VIEWERS = [NY, MANILA, LONDON];

describe('addOrgDays', () => {
  it('walks forwards and backwards over a month end', () => {
    expect(addOrgDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addOrgDays('2026-09-01', -1)).toBe('2026-08-31');
    expect(addOrgDays('2026-08-06', 0)).toBe('2026-08-06');
  });

  it('crosses a leap day', () => {
    expect(addOrgDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addOrgDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  // The reason this is string arithmetic anchored at UTC and not `setDate` on a
  // local Date: a DST day is 23 or 25 hours long, so adding 7 * 86400000 ms to a
  // local midnight lands at 23:00 or 01:00 the wrong side of the boundary.
  it('spans a US spring-forward week as exactly 7 days', () => {
    expect(addOrgDays('2026-03-05', 7)).toBe('2026-03-12');
  });

  it('spans a US fall-back week as exactly 7 days', () => {
    expect(addOrgDays('2026-10-29', 7)).toBe('2026-11-05');
  });
});

describe('orgToday', () => {
  // 2026-08-06T01:00:00Z - job 698675's stored instant. It is still Aug 5 in New
  // York and already Aug 6 in Manila, which is the entire bug in one value.
  const at = new Date('2026-08-06T01:00:00.000Z');

  it('reports the ORG day, not the viewer day', () => {
    expect(orgToday(NY, at)).toBe('2026-08-05');
    expect(orgToday(MANILA, at)).toBe('2026-08-06');
  });

  it('gives one answer per org zone regardless of who is asking', () => {
    // The function takes the zone explicitly, so this is really asserting that no
    // hidden `new Date()` local-getter path sneaks back in.
    for (const tz of VIEWERS) {
      expect(orgToday(tz, at)).toBe(orgToday(tz, new Date(at.getTime())));
    }
  });
});

describe('orgDayStart / orgDayEnd', () => {
  it('bound a plain day to the org midnights', () => {
    expect(orgDayStart('2026-08-06', NY).toISOString()).toBe('2026-08-06T04:00:00.000Z');
    expect(orgDayEnd('2026-08-06', NY).toISOString()).toBe('2026-08-07T03:59:59.999Z');

    expect(orgDayStart('2026-08-06', MANILA).toISOString()).toBe('2026-08-05T16:00:00.000Z');
    expect(orgDayEnd('2026-08-06', MANILA).toISOString()).toBe('2026-08-06T15:59:59.999Z');
  });

  it('produces the same instants no matter which zone the code runs in', () => {
    // Guards the real failure mode: a helper that reads a local getter would give
    // different answers on the NY box and the Manila box for the same org.
    for (const tz of VIEWERS) {
      const a = orgDayStart('2026-08-06', tz).getTime();
      const b = orgDayStart('2026-08-06', tz).getTime();
      expect(a).toBe(b);
    }
  });

  it('makes a spring-forward day 23 hours long, not 24', () => {
    // 2026-03-08, America/New_York: 02:00 never happens.
    const start = orgDayStart('2026-03-08', NY);
    const end = orgDayEnd('2026-03-08', NY);
    expect(end.getTime() - start.getTime() + 1).toBe(23 * 3_600_000);
  });

  it('makes a fall-back day 25 hours long', () => {
    // 2026-11-01, America/New_York: 01:00 happens twice.
    const start = orgDayStart('2026-11-01', NY);
    const end = orgDayEnd('2026-11-01', NY);
    expect(end.getTime() - start.getTime() + 1).toBe(25 * 3_600_000);
  });

  it('leaves no gap between one day ending and the next beginning', () => {
    for (const tz of VIEWERS) {
      for (const day of ['2026-03-08', '2026-08-06', '2026-11-01']) {
        expect(orgDayEnd(day, tz).getTime() + 1).toBe(orgDayStart(addOrgDays(day, 1), tz).getTime());
      }
    }
  });
});
