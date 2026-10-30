import type { JobStatus, Prisma } from '@prisma/client';

/**
 * Office review rounds (Roles & Permissions, PRD 6, M7/M8): one row per round on a job.
 *
 * The job-level complete opens a round in the same write that moves the job to Office review. A job sent back out of
 * review before the round was finished keeps that round open with its checks, so the next complete returns the job to
 * Office review on the SAME round; a finished round is history, and the next complete opens a new one whose change-set
 * starts where the finished one ended (the job's creation for the first round).
 */
export async function openReviewRound(
  tx: Pick<Prisma.TransactionClient, 'jobReview'>,
  args: { orgId: string; jobId: string; jobCreatedAt: Date },
): Promise<{ id: string; reused: boolean; windowStart: Date }> {
  const open = await tx.jobReview.findFirst({
    where: { organization_id: args.orgId, job_id: args.jobId, state: 'OPEN' },
    orderBy: { created_at: 'desc' },
    select: { id: true, window_start: true },
  });
  if (open) return { id: open.id, reused: true, windowStart: open.window_start };

  const lastFinished = await tx.jobReview.findFirst({
    where: { organization_id: args.orgId, job_id: args.jobId, state: 'FINISHED', finished_at: { not: null } },
    orderBy: { finished_at: 'desc' },
    select: { finished_at: true },
  });
  const created = await tx.jobReview.create({
    data: {
      organization_id: args.orgId,
      job_id: args.jobId,
      window_start: lastFinished?.finished_at ?? args.jobCreatedAt,
    },
    select: { id: true, window_start: true },
  });
  return { id: created.id, reused: false, windowStart: created.window_start };
}

/** The statuses that have a review to show: the job is in Office review, past it in Ready to close, or Done. */
export const REVIEWED_JOB_STATUSES: readonly JobStatus[] = ['OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'];

export function jobHasReview(status: JobStatus): boolean {
  return REVIEWED_JOB_STATUSES.includes(status);
}
