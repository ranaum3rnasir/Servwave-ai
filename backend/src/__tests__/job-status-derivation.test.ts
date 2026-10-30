import { describe, it, expect } from 'vitest';
import { JobStatus } from '@prisma/client';
import { deriveJobStatus, deriveJobStatusFromVisits } from '../lib/job-status';
import { JOB_STATUS_ORDER } from '../lib/job-status-order';

/** A visit written on a job must never move the job into or out of a status the office set (PRD 6, S06.1). */
const worked = [{ status: 'IN_PROGRESS' as const, started_at: new Date('2026-01-05T10:00:00Z') }];
const finished = [{ status: 'COMPLETED' as const, started_at: new Date('2026-01-05T10:00:00Z') }];
const booked = [{ status: 'SCHEDULED' as const, started_at: null }];

const HUMAN_SET = JOB_STATUS_ORDER.slice(JOB_STATUS_ORDER.indexOf('COMPLETED'));

describe('the visit-driven derivation guard', () => {
  it.each(HUMAN_SET)('derives nothing for a job at %s, whatever the visits say', (status) => {
    for (const visits of [worked, finished, booked, []]) expect(deriveJobStatus(status, visits)).toBeUndefined();
    expect(deriveJobStatus(status, booked, new Date())).toBeUndefined();
  });

  it('refuses every status the schema places after Completed, Cancelled included', () => {
    expect([...HUMAN_SET].sort()).toEqual(
      Object.values(JobStatus).filter((s) => !['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'].includes(s)).sort(),
    );
  });

  it.each(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'] as const)('still derives for a live job at %s', (status) => {
    expect(deriveJobStatus(status, worked)).toBe('IN_PROGRESS');
    expect(deriveJobStatus(status, booked)).toBe('SCHEDULED');
    expect(deriveJobStatus(status, [])).toBe('UNSCHEDULED');
  });
});

describe('the unguarded derivation (job-level Arrived)', () => {
  it.each(['OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'CANCELLED'] as const)('refuses to run on a job at %s', (status) => {
    expect(deriveJobStatusFromVisits(worked, null, status)).toBeUndefined();
    expect(deriveJobStatusFromVisits(booked, null, status)).toBeUndefined();
  });

  it('still derives for a job that leaves Completed (a pre-release job) or when no status is named', () => {
    expect(deriveJobStatusFromVisits(worked, null, 'COMPLETED')).toBe('IN_PROGRESS');
    expect(deriveJobStatusFromVisits(booked, null)).toBe('SCHEDULED');
  });
});
