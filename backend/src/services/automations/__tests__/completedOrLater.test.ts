/**
 * Roles & Permissions, PRD 6, slice S06.3 - the automation stop check and the stale-status checks read a job's
 * work as done once it is Completed, in Office review, Ready to close or Done (a job never rests at Completed
 * after PRD 6: Complete lands it in Office review). Cancelled is not finished work and keeps its own reading.
 *
 * The statuses are read from the job status enum, not from the set under test, so a status added to the enum
 * later is covered without an edit here.
 */
import { describe, it, expect } from 'vitest';
import { JobStatus } from '@prisma/client';
import { stopIfHolds } from '../stopIf';
import { terminalStaleReason } from '../terminalStale';
import type { EntityState } from '../context';

const ORDER = Object.values(JobStatus);
const FINISHED = ORDER.slice(ORDER.indexOf('COMPLETED')).filter((s) => s !== 'CANCELLED');
const LIVE = ORDER.slice(0, ORDER.indexOf('COMPLETED'));

const NOW = new Date('2026-07-14T15:00:00.000Z');
const FUTURE = new Date('2026-07-15T15:00:00.000Z');
const PAST = new Date('2026-07-14T10:00:00.000Z');

describe('the "job completed" stop check', () => {
  it.each(FINISHED)('holds for a job in %s', (status) => {
    expect(stopIfHolds('job_completed', { jobStatus: status })).toBe(true);
  });

  it.each([...LIVE, 'CANCELLED' as const])('does not hold for a job in %s', (status) => {
    expect(stopIfHolds('job_completed', { jobStatus: status })).toBe(false);
  });

  it('keeps the cancelled check on Cancelled alone', () => {
    expect(stopIfHolds('job_cancelled', { jobStatus: 'CANCELLED' })).toBe(true);
    for (const status of FINISHED) expect(stopIfHolds('job_cancelled', { jobStatus: status })).toBe(false);
  });
});

describe('stale checks treat a finished job as finished', () => {
  const finishedState = (status: string, extra: Partial<EntityState> = {}): EntityState => ({
    jobStatus: status, jobScheduledStart: FUTURE, ...extra,
  });

  describe.each(FINISHED)('a job in %s', (status) => {
    it.each(['BEFORE_JOB_START', 'JOB_SCHEDULED', 'TECH_ASSIGNED', 'JOB_RESCHEDULED'] as const)(
      'makes a %s run stale: the work it was about is already done',
      (trigger) => {
        expect(terminalStaleReason(trigger, undefined, finishedState(status), NOW)).toBe('Job was already completed');
      },
    );

    it('makes a before-the-visit date-anchored run stale, and leaves an after-the-visit one alone', () => {
      expect(terminalStaleReason('JOB_DATE_ANCHORED', FUTURE.toISOString(), finishedState(status), NOW, 'before')).toBe(
        'Job was already completed',
      );
      expect(
        terminalStaleReason('JOB_DATE_ANCHORED', PAST.toISOString(), finishedState(status, { jobScheduledStart: PAST }), NOW, 'after'),
      ).toBeNull();
    });

    it('keeps an after-job-completed follow-up alive: the job is still marked completed work', () => {
      expect(terminalStaleReason('AFTER_JOB_COMPLETED', undefined, { jobStatus: status }, NOW)).toBeNull();
    });

    it('still skips an after-job-completed run whose completion was replaced by a later one', () => {
      const state: EntityState = { jobStatus: status, jobCompletedAt: FUTURE };
      expect(terminalStaleReason('AFTER_JOB_COMPLETED', PAST.toISOString(), state, NOW)).toBe(
        'Job was re-completed — this run was replaced by an updated follow-up',
      );
    });
  });

  it.each(LIVE)('an after-job-completed follow-up is stale while the job is %s', (status) => {
    expect(terminalStaleReason('AFTER_JOB_COMPLETED', undefined, { jobStatus: status }, NOW)).toBe(
      'Job is no longer marked completed',
    );
  });

  it('an after-job-completed follow-up is stale on a cancelled job', () => {
    expect(terminalStaleReason('AFTER_JOB_COMPLETED', undefined, { jobStatus: 'CANCELLED' }, NOW)).toBe(
      'Job is no longer marked completed',
    );
  });
});
