import type { Prisma, VisitStatus } from '@prisma/client';
import { LIVE_VISIT_STATUSES, isLiveVisit } from './visit-status';

/**
 * Roles & Permissions S04.17 - completing a job that still has open visits.
 *
 * A visit is "open" when it is booked, on the way, on site or started: exactly the live set the job-status
 * derivation and the board already use, so there is one meaning of "still coming". Finished and cancelled
 * visits are history and never block a complete.
 *
 * The job-level complete is the only way to Completed. When open visits remain, the server refuses unless the
 * request says to cancel them (`cancel_open_visits`), so the job page, the board's visit card and the Jobs list's
 * bulk Completed cannot go round the confirmation each of them shows first. A visit is never marked finished by the
 * complete: it is cancelled, and keeps its stamps as history.
 */

/** The machine-readable code on the refusal; the screens key their confirmation on it. */
export const JOB_COMPLETE_HAS_OPEN_VISITS = 'JOB_COMPLETE_HAS_OPEN_VISITS';

/** The reason written on a visit cancelled by the complete (the visit's own history line reads "Visit 2 cancelled: Job completed"). */
export const OPEN_VISIT_CANCEL_REASON = 'Job completed';

export type OpenVisit = {
  id: string;
  job_id: string;
  visit_seq: number;
  status: VisitStatus;
  scheduled_at: Date | null;
  scheduled_end: Date | null;
};

/** The open visits of the given jobs, in visit order, for one company. The status is checked again after the read, so a caller can never be handed a finished or cancelled visit as open. */
export async function findOpenVisits(
  client: Pick<Prisma.TransactionClient, 'visit'>,
  orgId: string,
  jobIds: string[],
): Promise<OpenVisit[]> {
  const rows = await client.visit.findMany({
    where: { organization_id: orgId, job_id: { in: jobIds }, status: { in: [...LIVE_VISIT_STATUSES] } },
    select: { id: true, job_id: true, visit_seq: true, status: true, scheduled_at: true, scheduled_end: true },
  });
  return (rows as (Omit<OpenVisit, 'job_id'> & { job_id: string | null })[])
    .filter((v): v is OpenVisit => v.job_id !== null && isLiveVisit(v))
    .sort((a, b) => a.visit_seq - b.visit_seq);
}

/** What the refusal carries for one job: enough for the confirmation to list each visit. */
export function openVisitsPayload(visits: OpenVisit[]) {
  return visits.map((v) => ({
    id: v.id,
    visit_seq: v.visit_seq,
    status: v.status,
    scheduled_at: v.scheduled_at,
    scheduled_end: v.scheduled_end,
  }));
}
