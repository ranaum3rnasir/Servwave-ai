import { JobStatus } from '@prisma/client';

/**
 * The statuses that mean "the work is done" (PRD 6: Completed, Office review, Ready to close, Done), read from the job
 * status enum - everything from Completed on, Cancelled aside - and not from the set the code under test uses, so a
 * test that compares against this can fail when that set is wrong.
 */
const ORDER = Object.values(JobStatus);
export const FINISHED_JOB_STATUSES: JobStatus[] = ORDER.slice(ORDER.indexOf('COMPLETED')).filter((s) => s !== 'CANCELLED');
