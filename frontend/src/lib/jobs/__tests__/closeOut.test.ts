import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  COMPLETABLE_JOB_STATUSES, isCompletableJobStatus, COMPLETED_OR_LATER_JOB_STATUSES, isCompletedOrLaterJobStatus,
  CLOSED_JOB_STATUSES, isClosedJobStatus, REOPEN_FIRST_MESSAGE,
} from '../closeOut';

// The server's close-out state machine (M7) owns the list; this one is the board's copy, kept honest by reading it.
const SERVER_SOURCE = readFileSync(resolve(__dirname, '../../../../../backend/src/lib/job-close-out.ts'), 'utf8');

describe('which job statuses a job-level Complete starts from', () => {
  it('is the list the server\'s close-out state machine declares', () => {
    const declared = /COMPLETABLE_JOB_STATUSES: readonly JobStatus\[\] = \[([^\]]*)\]/.exec(SERVER_SOURCE)?.[1];
    expect(declared, 'the server list could not be found').toBeDefined();
    const serverList = [...declared!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect([...COMPLETABLE_JOB_STATUSES].sort()).toEqual([...serverList].sort());
  });

  it.each(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'])('offers Complete job on a %s job', (status) => {
    expect(isCompletableJobStatus(status)).toBe(true);
  });

  it.each(['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'CANCELLED', '', undefined, null])('offers nothing on %s', (status) => {
    expect(isCompletableJobStatus(status as string | null | undefined)).toBe(false);
  });
});

// The server derives its set from the order its statuses are placed in (backend `lib/job-status-order.ts`): everything
// from Completed on, Cancelled aside. This copy is kept honest by reading that order and deriving the same way.
const ORDER_SOURCE = readFileSync(resolve(__dirname, '../../../../../backend/src/lib/job-status-order.ts'), 'utf8');

describe('which job statuses mean the work is done', () => {
  it('is the set the server derives from its status order', () => {
    const declared = /JOB_STATUS_ORDER: readonly JobStatus\[\] = \[([^\]]*)\]/.exec(ORDER_SOURCE)?.[1];
    expect(declared, 'the server status order could not be found').toBeDefined();
    const order = [...declared!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    const serverSet = order.slice(order.indexOf('COMPLETED')).filter((s) => s !== 'CANCELLED');
    expect([...COMPLETED_OR_LATER_JOB_STATUSES].sort()).toEqual([...serverSet].sort());
  });

  it.each(['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'])('counts a job in %s as finished', (status) => {
    expect(isCompletedOrLaterJobStatus(status)).toBe(true);
  });

  it.each(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'CANCELLED', '', undefined, null])('does not count %s as finished', (status) => {
    expect(isCompletedOrLaterJobStatus(status as string | null | undefined)).toBe(false);
  });
});

describe('which job statuses leave only through Reopen', () => {
  it('is the pair the server\'s close-out state machine refuses every door for, with its words', () => {
    const refusal = /export function statusDoorRefusal\(status: JobStatus\): string \| null \{\s*return ([^;]*);/.exec(SERVER_SOURCE)?.[1];
    expect(refusal, 'the server refusal could not be found').toBeDefined();
    const serverList = [...refusal!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect([...CLOSED_JOB_STATUSES].sort()).toEqual([...serverList].sort());
    const words = /REOPEN_FIRST_MESSAGE = '([^']*)'/.exec(SERVER_SOURCE)?.[1];
    expect(REOPEN_FIRST_MESSAGE).toBe(words);
  });

  it.each(['DONE', 'CANCELLED'])('counts a job in %s as closed', (status) => {
    expect(isClosedJobStatus(status)).toBe(true);
  });

  it.each(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', '', undefined, null])('does not count %s as closed', (status) => {
    expect(isClosedJobStatus(status as string | null | undefined)).toBe(false);
  });
});
