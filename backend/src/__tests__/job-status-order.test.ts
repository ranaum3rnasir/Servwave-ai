import { describe, it, expect } from 'vitest';
import { JobStatus } from '@prisma/client';
import { COMPLETED_OR_LATER_JOB_STATUSES, JOB_STATUS_ORDER, isCompletedOrLater } from '../lib/job-status-order';

describe('the job status order', () => {
  // A status added to the schema has to be placed in the order before anything that reads "at or past
  // Completed" can say where it falls.
  it('places every job status the schema has, once', () => {
    expect([...JOB_STATUS_ORDER].sort()).toEqual(Object.values(JobStatus).sort());
  });

  it('puts Completed after the live statuses and Cancelled after Completed', () => {
    const at = (s: JobStatus) => JOB_STATUS_ORDER.indexOf(s);
    expect(at('UNSCHEDULED')).toBeLessThan(at('SCHEDULED'));
    expect(at('SCHEDULED')).toBeLessThan(at('IN_PROGRESS'));
    expect(at('IN_PROGRESS')).toBeLessThan(at('COMPLETED'));
    expect(at('COMPLETED')).toBeLessThan(at('CANCELLED'));
  });

  it('places the close-out statuses between Completed and Cancelled, in the order a job moves through them', () => {
    const at = (s: JobStatus) => JOB_STATUS_ORDER.indexOf(s);
    expect(at('COMPLETED')).toBeLessThan(at('OFFICE_REVIEW'));
    expect(at('OFFICE_REVIEW')).toBeLessThan(at('READY_TO_CLOSE'));
    expect(at('READY_TO_CLOSE')).toBeLessThan(at('DONE'));
    expect(at('DONE')).toBeLessThan(at('CANCELLED'));
  });

  describe('the completed-or-later set', () => {
    it('is Completed and the three close-out statuses, and never Cancelled or a live status', () => {
      expect([...COMPLETED_OR_LATER_JOB_STATUSES].sort()).toEqual(['COMPLETED', 'DONE', 'OFFICE_REVIEW', 'READY_TO_CLOSE']);
      for (const live of ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'CANCELLED'] as const) expect(isCompletedOrLater(live)).toBe(false);
    });

    it('answers for a status that arrives as plain text, and says no to a missing or unknown one', () => {
      expect(isCompletedOrLater('OFFICE_REVIEW')).toBe(true);
      expect(isCompletedOrLater('IN_PROGRESS')).toBe(false);
      for (const missing of [undefined, null, '', 'ON_SITE']) expect(isCompletedOrLater(missing)).toBe(false);
    });

    it('answers for every status the schema has', () => {
      for (const status of Object.values(JobStatus)) {
        expect(isCompletedOrLater(status)).toBe(COMPLETED_OR_LATER_JOB_STATUSES.includes(status));
      }
    });
  });
});
