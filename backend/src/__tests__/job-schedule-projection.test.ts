/**
 * A5 (RATIFIED 2026-08-24, Option A) - the computed projection that replaces the DROPPED
 * `jobs.scheduled_start` / `scheduled_end` / `is_all_day` mirror. This is the presenter unit test
 * Contract 11 Step 5.2 requires, covering the three ratified cases: next upcoming live visit,
 * fallback to earliest non-cancelled visit, and the zero-visit null case.
 *
 * CLOCK DISCIPLINE: resolveNextJobVisit (and therefore resolveJobScheduleWindow) measures
 * "upcoming" against `Date.now()` when no explicit `now` is passed - exactly the seam the
 * multi-visit close-out's own house rules flag as a midnight-crossing hazard. Every test below
 * freezes the clock with vi.useFakeTimers()/vi.setSystemTime() to a fixed instant and builds its
 * visit fixtures relative to THAT anchor, so a run at any real wall-clock time (including across
 * midnight) sees the identical fixture-vs-now relationship every time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveJobScheduleWindow, projectJobScheduleFields, type VisitForScheduleProjection, type JobScheduleWindow } from '../lib/job-schedule-projection';

// Frozen "now" for every test in this file - chosen with no significance beyond being fixed.
const NOW = new Date('2026-08-24T18:00:00.000Z');
const PAST = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000);
const FUTURE = (hoursAhead: number) => new Date(NOW.getTime() + hoursAhead * 3_600_000);

function visit(over: Partial<VisitForScheduleProjection> & { id?: string } = {}): VisitForScheduleProjection {
  return {
    status: 'SCHEDULED',
    scheduled_at: FUTURE(2),
    scheduled_end: FUTURE(4),
    is_all_day: false,
    created_at: PAST(48),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveJobScheduleWindow — condition (i): next upcoming live visit wins', () => {
  it('picks the single live, timed, upcoming visit', () => {
    const v = visit({ scheduled_at: FUTURE(3), scheduled_end: FUTURE(5) });
    const result = resolveJobScheduleWindow([v]);
    expect(result).toEqual({ scheduled_start: v.scheduled_at, scheduled_end: v.scheduled_end, is_all_day: false });
  });

  it('among several live upcoming visits, picks the EARLIEST', () => {
    const soon = visit({ scheduled_at: FUTURE(1), scheduled_end: FUTURE(2), created_at: PAST(10) });
    const later = visit({ scheduled_at: FUTURE(5), scheduled_end: FUTURE(6), created_at: PAST(20) });
    const result = resolveJobScheduleWindow([later, soon]);
    expect(result.scheduled_start).toEqual(soon.scheduled_at);
  });

  it('a visit already under way (started in the past, still live) still wins over a future one', () => {
    // resolveNextJobVisit measures "upcoming" on the END, not the start - a visit in progress
    // right now must not lose the board slot to next week's trip.
    const inFlight = visit({ status: 'IN_PROGRESS', scheduled_at: PAST(1), scheduled_end: FUTURE(1) });
    const nextWeek = visit({ status: 'SCHEDULED', scheduled_at: FUTURE(168), scheduled_end: FUTURE(170) });
    const result = resolveJobScheduleWindow([nextWeek, inFlight]);
    expect(result.scheduled_start).toEqual(inFlight.scheduled_at);
  });

  it('projects the WINNING visit is_all_day, not a default', () => {
    const v = visit({ is_all_day: true });
    expect(resolveJobScheduleWindow([v]).is_all_day).toBe(true);
  });

  it('a CANCELLED visit never wins over a live one, even if it is timed and sooner', () => {
    const cancelled = visit({ status: 'CANCELLED', scheduled_at: FUTURE(1) });
    const live = visit({ status: 'SCHEDULED', scheduled_at: FUTURE(5) });
    const result = resolveJobScheduleWindow([cancelled, live]);
    expect(result.scheduled_start).toEqual(live.scheduled_at);
  });

  it('a COMPLETED visit never wins over a live one', () => {
    const completed = visit({ status: 'COMPLETED', scheduled_at: PAST(2), scheduled_end: PAST(1) });
    const live = visit({ status: 'SCHEDULED', scheduled_at: FUTURE(5) });
    const result = resolveJobScheduleWindow([completed, live]);
    expect(result.scheduled_start).toEqual(live.scheduled_at);
  });
});

describe('resolveJobScheduleWindow — condition (ii): fallback to the earliest non-cancelled visit', () => {
  it('a single COMPLETED visit (no live visit at all) still projects non-blank', () => {
    // The dominant staging population (7,495 rows) this fallback exists for: a completed job
    // whose only visit has left the live set must not blank the Scheduled column.
    const completed = visit({ status: 'COMPLETED', scheduled_at: PAST(10), scheduled_end: PAST(8) });
    const result = resolveJobScheduleWindow([completed]);
    expect(result).toEqual({ scheduled_start: completed.scheduled_at, scheduled_end: completed.scheduled_end, is_all_day: false });
  });

  it('among multiple non-cancelled, non-live visits, picks the EARLIEST', () => {
    const earlyCompleted = visit({ status: 'COMPLETED', scheduled_at: PAST(20), scheduled_end: PAST(18) });
    const laterCompleted = visit({ status: 'COMPLETED', scheduled_at: PAST(5), scheduled_end: PAST(3) });
    const result = resolveJobScheduleWindow([laterCompleted, earlyCompleted]);
    expect(result.scheduled_start).toEqual(earlyCompleted.scheduled_at);
  });

  it('a CANCELLED visit is excluded from the fallback too - never a synthetic mix', () => {
    const cancelled = visit({ status: 'CANCELLED', scheduled_at: PAST(30) });
    const completed = visit({ status: 'COMPLETED', scheduled_at: PAST(10), scheduled_end: PAST(8) });
    const result = resolveJobScheduleWindow([cancelled, completed]);
    expect(result.scheduled_start).toEqual(completed.scheduled_at);
  });

  it('ties on the same scheduled_at break by created_at (earliest booking wins), mirroring resolveNextJobVisit', () => {
    const sameInstant = PAST(10);
    const bookedFirst = visit({ status: 'COMPLETED', scheduled_at: sameInstant, created_at: PAST(100) });
    const bookedSecond = visit({ status: 'COMPLETED', scheduled_at: sameInstant, created_at: PAST(50) });
    const result = resolveJobScheduleWindow([bookedSecond, bookedFirst]);
    expect(result.scheduled_end).toEqual(bookedFirst.scheduled_end);
  });
});

describe('resolveJobScheduleWindow — condition (iii): zero qualifying visits -> all three null', () => {
  it('zero visits at all', () => {
    expect(resolveJobScheduleWindow([])).toEqual({ scheduled_start: null, scheduled_end: null, is_all_day: null });
  });

  it('null/undefined visits array (a job select that never joined visits)', () => {
    expect(resolveJobScheduleWindow(null)).toEqual({ scheduled_start: null, scheduled_end: null, is_all_day: null });
    expect(resolveJobScheduleWindow(undefined)).toEqual({ scheduled_start: null, scheduled_end: null, is_all_day: null });
  });

  it('every visit CANCELLED - the "unscheduled by cancellation" case (D16 collapse)', () => {
    const cancelled = visit({ status: 'CANCELLED' });
    expect(resolveJobScheduleWindow([cancelled])).toEqual({ scheduled_start: null, scheduled_end: null, is_all_day: null });
  });

  it('a live visit that carries no scheduled_at yet never wins and never falls back to a mix', () => {
    // An untimed live visit sorts last in resolveNextJobVisit and never wins on its own; the
    // fallback filter also excludes untimed rows explicitly.
    const untimedLive = visit({ status: 'SCHEDULED', scheduled_at: null });
    expect(resolveJobScheduleWindow([untimedLive])).toEqual({ scheduled_start: null, scheduled_end: null, is_all_day: null });
  });

  it('regression guard: a mocked-Prisma-style visit missing scheduled_at entirely (undefined, not null) never throws', () => {
    // The exact shape a hand-built test fixture can produce that a real Prisma select never
    // would - found and fixed via job-reschedule-guard.test.ts crashing on this during this PR.
    const sloppy = { status: 'SCHEDULED', is_all_day: false, created_at: PAST(1) } as unknown as VisitForScheduleProjection;
    expect(() => resolveJobScheduleWindow([sloppy])).not.toThrow();
    expect(resolveJobScheduleWindow([sloppy])).toEqual({ scheduled_start: null, scheduled_end: null, is_all_day: null });
  });
});

describe('projectJobScheduleFields — the job-payload wrapper', () => {
  it('spreads the job and overwrites only the three derived keys', () => {
    const v = visit({ scheduled_at: FUTURE(2), scheduled_end: FUTURE(4), is_all_day: true });
    const job = { id: 'job-1', job_number: 'J00001', visits: [v] };
    const result = projectJobScheduleFields(job) as typeof job & JobScheduleWindow;
    expect(result.id).toBe('job-1');
    expect(result.job_number).toBe('J00001');
    expect(result.scheduled_start).toEqual(v.scheduled_at);
    expect(result.scheduled_end).toEqual(v.scheduled_end);
    expect(result.is_all_day).toBe(true);
  });

  it('a job with no visits key at all projects all three null rather than throwing', () => {
    const job = { id: 'job-2' };
    expect(projectJobScheduleFields(job)).toMatchObject({ scheduled_start: null, scheduled_end: null, is_all_day: null });
  });
});
