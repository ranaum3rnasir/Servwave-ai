/**
 * #1634 + A1 (multi-visit S8 §4): the Jobs-list Scheduled cell (and its CSV export twin in
 * JobsPage.tsx) render the NEXT UPCOMING LIVE visit off the `visits` array the list already
 * ships, in the ORG zone - not `Job.scheduled_start`, which A1 measured stale (non-null with no
 * live visit) on thousands of staging rows, and not the viewer's browser zone.
 *
 * `nextScheduledCellVisit` is exercised directly for the selection rule; `formatJobScheduledCell`
 * for the org-zone rendering, following the same "identical regardless of the viewer's own
 * timezone" convention as schedule-tz.render.test.ts.
 *
 * The CSV export path (JobsPage.tsx `toExportRow`) is NOT re-tested separately: it calls
 * `formatJobScheduledCell(j.visits, tz, j.status)` with the identical arguments shape exercised
 * here, so testing the shared helper covers both call sites by construction.
 */
import { describe, it, expect } from 'vitest';

import { nextScheduledCellVisit, formatJobScheduledCell, type JobListVisit } from '../jobsColumns';

const NY = 'America/New_York';
const MANILA = 'Asia/Manila';

function v(over: Partial<JobListVisit> & { id: string }): JobListVisit {
  return {
    visit_seq: 1, status: 'SCHEDULED', scheduled_at: null, scheduled_end: null, is_all_day: false,
    ...over,
  };
}

describe('nextScheduledCellVisit', () => {
  it('picks the EARLIEST live visit, not the first by creation order, and never a cancelled one', () => {
    const visits: JobListVisit[] = [
      // Created first (visit_seq 1) but scheduled LATER than visit 2, and would win on array
      // order alone if the rule were "the first row".
      v({ id: 'first-created', visit_seq: 1, status: 'SCHEDULED', scheduled_at: '2026-09-10T13:00:00.000Z' }),
      // Created second, but the earlier of the two LIVE visits - this is the one that must win.
      v({ id: 'earlier-live', visit_seq: 2, status: 'SCHEDULED', scheduled_at: '2026-09-05T13:00:00.000Z' }),
      // Earliest of ALL three by clock time, but CANCELLED - must never win.
      v({ id: 'cancelled', visit_seq: 3, status: 'CANCELLED', scheduled_at: '2026-08-01T13:00:00.000Z' }),
    ];
    expect(nextScheduledCellVisit(visits, 'SCHEDULED')?.id).toBe('earlier-live');
  });

  it('falls back to the earliest NON-CANCELLED visit when no live one exists (first_visit_start semantics)', () => {
    const visits: JobListVisit[] = [
      // Earliest overall, but cancelled - excluded even though nothing is live.
      v({ id: 'cancelled', status: 'CANCELLED', scheduled_at: '2026-08-01T13:00:00.000Z' }),
      // Later, but COMPLETED (not live) and the earliest of the non-cancelled rows - wins.
      v({ id: 'completed-earlier', status: 'COMPLETED', scheduled_at: '2026-08-10T13:00:00.000Z' }),
      v({ id: 'completed-later', status: 'COMPLETED', scheduled_at: '2026-08-20T13:00:00.000Z' }),
    ];
    expect(nextScheduledCellVisit(visits, 'COMPLETED')?.id).toBe('completed-earlier');
  });

  it('returns null for no visits, and for a visit set that is entirely cancelled on a LIVE job', () => {
    expect(nextScheduledCellVisit([], 'UNSCHEDULED')).toBeNull();
    expect(
      nextScheduledCellVisit(
        [v({ id: 'a', status: 'CANCELLED', scheduled_at: '2026-08-01T13:00:00.000Z' })],
        'SCHEDULED',
      ),
    ).toBeNull();
  });

  it('ignores untimed rows entirely, on every branch', () => {
    const untimedLive = v({ id: 'untimed-live', status: 'SCHEDULED', scheduled_at: null });
    const untimedCancelled = v({ id: 'untimed-cancelled', status: 'CANCELLED', scheduled_at: null });
    expect(nextScheduledCellVisit([untimedLive, untimedCancelled], 'CANCELLED')).toBeNull();
  });

  /**
   * Ruling from the release owner, 2026-08-24 (deliberately narrow - do not widen without a
   * fresh ruling): a CANCELLED job whose visits are ALL cancelled renders its historical date
   * rather than going blank, because D19 says history is "readable, never actionable" and
   * `buildJobListWhere` (job.controller.ts:966-971) already lets a CANCELLED job MATCH a
   * date-range filter - blanking the cell here would make the list match a job on a date and
   * then render nothing for that same date. A LIVE job (SCHEDULED/IN_PROGRESS/UNSCHEDULED/...)
   * whose visits are all cancelled must stay BLANK: that blank is D16's real signal that nothing
   * is booked and a dispatcher needs to act, and showing a stale cancelled date there would hide
   * it. J00260 (staging, IN_PROGRESS, all visits cancelled) is exactly the case that must stay
   * blank; J00209/J00282 (staging, CANCELLED, all visits cancelled) are the case that must not.
   */
  it('a CANCELLED job whose only visits are cancelled renders its historical date', () => {
    const visits: JobListVisit[] = [
      v({ id: 'later', status: 'CANCELLED', scheduled_at: '2026-08-10T13:00:00.000Z' }),
      v({ id: 'earlier', status: 'CANCELLED', scheduled_at: '2026-08-01T13:00:00.000Z' }),
    ];
    expect(nextScheduledCellVisit(visits, 'CANCELLED')?.id).toBe('earlier');
  });

  it('a LIVE job whose only visits are cancelled still renders blank - the fallback does not widen for it', () => {
    const visits: JobListVisit[] = [
      v({ id: 'a', status: 'CANCELLED', scheduled_at: '2026-08-01T13:00:00.000Z' }),
    ];
    for (const jobStatus of ['SCHEDULED', 'IN_PROGRESS', 'UNSCHEDULED', 'COMPLETED']) {
      expect(nextScheduledCellVisit(visits, jobStatus)).toBeNull();
    }
  });
});

// House rule (ratified 2026-08-24, contracts/00-house-rules.md): a timezone test proves nothing
// unless its instant renders on a DIFFERENT calendar day in the two zones compared, and every
// such probe needs a CONTROL instant that legitimately renders the SAME day in both, or the test
// cannot tell a correct implementation from a broken one.
const DISCRIMINATING = '2026-08-06T01:00:00.000Z'; // Aug 5 in NY, Aug 6 in Manila - splits the day.
const CONTROL = '2026-08-06T13:00:00.000Z'; // 9:00 AM NY, 9:00 PM Manila - SAME day (Aug 6) in both.

describe('formatJobScheduledCell', () => {
  it('renders the selected visit\'s time on the ORG clock (discriminating instant: splits the calendar day)', () => {
    const visits: JobListVisit[] = [v({ id: 'v1', status: 'SCHEDULED', scheduled_at: DISCRIMINATING })];
    // Same instant as schedule-tz.render.test.ts's JOB_698675 fixture.
    expect(formatJobScheduledCell(visits, NY, 'SCHEDULED')).toBe('Aug 5, 9:00 PM');
    expect(formatJobScheduledCell(visits, MANILA, 'SCHEDULED')).toBe('Aug 6, 9:00 AM');
  });

  it('control: a non-discriminating instant renders the same calendar day in both zones', () => {
    // Proves the assertion above is actually exercising the org-zone conversion rather than
    // passing by coincidence: this instant does NOT split the day, so both zones must agree on
    // the date and differ only on the clock time.
    const visits: JobListVisit[] = [v({ id: 'v1', status: 'SCHEDULED', scheduled_at: CONTROL })];
    expect(formatJobScheduledCell(visits, NY, 'SCHEDULED')).toBe('Aug 6, 9:00 AM');
    expect(formatJobScheduledCell(visits, MANILA, 'SCHEDULED')).toBe('Aug 6, 9:00 PM');
  });

  it('renders empty string, not "Invalid Date", when nothing qualifies', () => {
    expect(formatJobScheduledCell([], NY, 'UNSCHEDULED')).toBe('');
  });

  it('a CANCELLED job with only cancelled visits renders its historical date, in the org zone', () => {
    const visits: JobListVisit[] = [v({ id: 'v1', status: 'CANCELLED', scheduled_at: DISCRIMINATING })];
    expect(formatJobScheduledCell(visits, NY, 'CANCELLED')).toBe('Aug 5, 9:00 PM');
    expect(formatJobScheduledCell(visits, MANILA, 'CANCELLED')).toBe('Aug 6, 9:00 AM');
  });

  it('a LIVE job with only cancelled visits renders blank, not the cancelled date', () => {
    const visits: JobListVisit[] = [v({ id: 'v1', status: 'CANCELLED', scheduled_at: DISCRIMINATING })];
    expect(formatJobScheduledCell(visits, NY, 'IN_PROGRESS')).toBe('');
  });
});
