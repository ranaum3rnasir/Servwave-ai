import { describe, it, expect } from 'vitest';
import { buildDays, buildPayroll, buildWeeks, isoWeekKey } from './payroll';
import type { Session } from './aggregate';
import type { ReviewState } from './types';

const HOUR = 3600000;

// Bucket in a fixed org timezone so the ISO-week keys are deterministic regardless
// of the test runner's local zone (mirrors how the report threads `org.timezone`).
const TZ = 'America/New_York';

/** A closed session of `hours` length starting at `dayTs` + `startHour`. */
function session(
  s: Partial<Session> & Pick<Session, 'userId' | 'inTs'> & { hours: number },
): Session {
  return {
    userName: 'Tester',
    outTs: s.inTs + s.hours * HOUR,
    minutes: Math.round(s.hours * 60),
    inStatus: 'in_zone',
    inReview: 'none',
    matchedZoneId: 'store',
    matchedZoneLabel: 'Main office',
    zoneKind: 'store',
    jobNumber: null,
    ...s,
  } as Session;
}

// A weekday at 08:00 in TZ (Mon 2024-01-08). All dates used fall in January, which
// is EST (UTC-5) year-round, so anchoring at 13:00Z = 08:00 ET is exact and keeps
// the ISO-week / day bucketing deterministic across runner timezones. (isLate uses
// the runner-local hour, which the existing tests don't assert on.)
function dayAt(dayOffset: number): number {
  const base = Date.UTC(2024, 0, 8, 13, 0, 0, 0); // 08:00 America/New_York (EST)
  return base + dayOffset * 24 * HOUR;
}

describe('buildDays — daily OT split', () => {
  it('a day under 8h is all regular, no OT', () => {
    const [d] = buildDays([session({ userId: 'a', inTs: dayAt(0), hours: 6 })], TZ);
    expect(d!.regMin).toBe(360);
    expect(d!.ot1Min).toBe(0);
    expect(d!.ot2Min).toBe(0);
    expect(d!.isJobOt).toBe(false);
  });

  it('an 8–12h day produces OT1 only', () => {
    const [d] = buildDays([session({ userId: 'a', inTs: dayAt(0), hours: 10 })], TZ);
    expect(d!.regMin).toBe(480); // 8h
    expect(d!.ot1Min).toBe(120); // 2h
    expect(d!.ot2Min).toBe(0);
  });

  it('a >12h day caps OT1 at 4h and spills into OT2', () => {
    const [d] = buildDays([session({ userId: 'a', inTs: dayAt(0), hours: 14 })], TZ);
    expect(d!.regMin).toBe(480); // 8h
    expect(d!.ot1Min).toBe(240); // 4h (8–12)
    expect(d!.ot2Min).toBe(120); // 2h (>12)
  });

  it('isJobOt is true only when OT > 0 on a job-attributed day', () => {
    const jobShort = buildDays([
      session({ userId: 'a', inTs: dayAt(0), hours: 7, zoneKind: 'job', jobNumber: 'J1' }),
    ], TZ);
    expect(jobShort[0]!.isJobOt).toBe(false); // OT == 0
    const jobLong = buildDays([
      session({ userId: 'a', inTs: dayAt(1), hours: 10, zoneKind: 'job', jobNumber: 'J1' }),
    ], TZ);
    expect(jobLong[0]!.isJobOt).toBe(true);
  });

  it('first IN and last OUT define the day window', () => {
    const [d] = buildDays([
      session({ userId: 'a', inTs: dayAt(0) + 1 * HOUR, hours: 2 }),
      session({ userId: 'a', inTs: dayAt(0) + 5 * HOUR, hours: 3 }),
    ], TZ);
    expect(d!.inTs).toBe(dayAt(0) + 1 * HOUR);
    expect(d!.outTs).toBe(dayAt(0) + 8 * HOUR); // 5h + 3h
    expect(d!.workedMin).toBe(300); // 2h + 3h
  });
});

// dayAt(0) is Mon 2024-01-08 → dayAt(0..5) are Mon–Sat of ISO week 2024-W02.
describe('buildWeeks — weekly-over-40 OT', () => {
  it('a week under 40h has no overtime', () => {
    const days = buildDays(
      Array.from({ length: 5 }, (_, i) => session({ userId: 'a', inTs: dayAt(i), hours: 7 })), // 35h
    TZ,
    );
    const [w] = buildWeeks(days, TZ);
    expect(w!.workedMin).toBe(35 * 60);
    expect(w!.otMin).toBe(0);
    expect(w!.periodKey).toBe('2024-W02');
    expect(w!.reviewKey).toBe('a:2024-W02');
  });

  it('a week over 40h produces weekly OT for the surplus', () => {
    const days = buildDays(
      Array.from({ length: 6 }, (_, i) => session({ userId: 'a', inTs: dayAt(i), hours: 9 })), // 54h
    TZ,
    );
    const [w] = buildWeeks(days, TZ);
    expect(w!.workedMin).toBe(54 * 60);
    expect(w!.otMin).toBe(14 * 60); // 54 - 40
    expect(w!.regMin).toBe(40 * 60);
  });

  it('splits work that straddles two ISO weeks into separate week rows', () => {
    // dayAt(5) = Sat W02; dayAt(7) = Mon W03.
    const days = buildDays([
      session({ userId: 'a', inTs: dayAt(5), hours: 10 }),
      session({ userId: 'a', inTs: dayAt(7), hours: 10 }),
    ], TZ);
    const weeks = buildWeeks(days, TZ);
    expect(weeks).toHaveLength(2);
    expect(weeks.map((w) => w.periodKey)).toEqual(['2024-W02', '2024-W03']);
    // Neither week alone exceeds 40h → no OT despite 20h total.
    expect(weeks.every((w) => w.otMin === 0)).toBe(true);
  });

  it('marks a week as job OT when an OT week has a job-attributed day', () => {
    const days = buildDays(
      Array.from({ length: 6 }, (_, i) =>
        session({ userId: 'a', inTs: dayAt(i), hours: 9, zoneKind: i === 0 ? 'job' : 'store', jobNumber: i === 0 ? 'J1' : null }),
      ),
    TZ,
    );
    const [w] = buildWeeks(days, TZ);
    expect(w!.otMin).toBeGreaterThan(0);
    expect(w!.isJobOt).toBe(true);
  });
});

describe('isoWeekKey — org-timezone bucketing (agrees with the backend)', () => {
  it('computes the ISO week in the passed IANA zone, not the runner zone', () => {
    // 2026-06-15T02:00:00Z is Mon 2026-06-15 in UTC but Sun 2026-06-14 22:00 in ET.
    // Either way the instant falls in ISO week 2026-W24, matching the backend
    // aggregate's localDate → isoWeek algorithm for the same instant.
    const ts = Date.parse('2026-06-15T02:00:00Z');
    expect(isoWeekKey('America/New_York', ts)).toBe('2026-W24');
    expect(isoWeekKey('UTC', ts)).toBe('2026-W25');
  });
});

describe('buildPayroll — weekly-40 OT + per-week approval split', () => {
  it('a single long day under 40h/week has no overtime (weekly model)', () => {
    // 14h in one day; under the weekly-40 rule the week (14h) has no OT.
    const days = buildDays([session({ userId: 'a', inTs: dayAt(0), hours: 14 })], TZ);
    const [p] = buildPayroll(days, {}, TZ);
    expect(p!.ot1Min + p!.ot2Min).toBe(0);
    expect(p!.regMin).toBe(14 * 60);
  });

  it('weekly OT over 40h appears as OT and totals reconcile', () => {
    const days = buildDays(
      Array.from({ length: 6 }, (_, i) => session({ userId: 'a', inTs: dayAt(i), hours: 9 })), // 54h
    TZ,
    );
    const [p] = buildPayroll(days, {}, TZ);
    expect(p!.ot1Min + p!.ot2Min).toBe(14 * 60); // weekly surplus
    expect(p!.regMin).toBe(40 * 60);
    expect(p!.totalMin).toBe(54 * 60);
  });

  it('splits weekly OT into approved vs pending (per-week key) and excludes rejected', () => {
    // Week W02: 54h → 14h OT (approved). Week W03: 54h → 14h OT (pending).
    const w2 = Array.from({ length: 6 }, (_, i) => session({ userId: 'a', inTs: dayAt(i), hours: 9 }));
    const w3 = Array.from({ length: 6 }, (_, i) => session({ userId: 'a', inTs: dayAt(i + 7), hours: 9 }));
    const days = buildDays([...w2, ...w3], TZ);
    const reviews: Record<string, ReviewState> = {
      'a:2024-W02': 'approved',
      // a:2024-W03 absent → pending
    };
    const [p] = buildPayroll(days, reviews, TZ);
    expect(p!.otApprovedMin).toBe(14 * 60);
    expect(p!.otPendingMin).toBe(14 * 60);

    const rejected = buildPayroll(days, { 'a:2024-W02': 'rejected', 'a:2024-W03': 'rejected' }, TZ);
    expect(rejected[0]!.otApprovedMin).toBe(0);
    expect(rejected[0]!.otPendingMin).toBe(0); // rejected counts toward neither
  });

  it('job OT minutes sum weekly OT for job-attributed weeks regardless of review state', () => {
    const days = buildDays(
      Array.from({ length: 6 }, (_, i) =>
        session({ userId: 'a', inTs: dayAt(i), hours: 9, zoneKind: i === 0 ? 'job' : 'store', jobNumber: i === 0 ? 'J1' : null }),
      ),
    TZ,
    );
    const [p] = buildPayroll(days, {}, TZ);
    expect(p!.jobOtMin).toBe(14 * 60); // the OT week is job-attributed
  });
});
