import type { JobStatus } from '@prisma/client';

/**
 * SRVW-112 - parent/child integrity for org-defined job sub-statuses, shaped like
 * `milestoneClears` in job-milestones.ts: a pure `data`-fragment builder, one place to read and
 * one place to change.
 *
 * Job status is UNORDERED (Spec B1) - any verb can move a job to any status, forward or backward -
 * so any status write can invalidate a sub-status that was parented to the OLD status. Without
 * this, a COMPLETED job would keep rendering "Parts On Order".
 *
 * The invariant it leans on: the setter (job.controller.ts setSubStatus) rejects any sub-status
 * whose `parent` differs from the job's status at the time it is set. A status CHANGE is therefore
 * by itself proof that the currently-held sub-status is now invalid - which is why no caller has
 * to read `sub_status.parent`, and why no status handler's `select` had to grow.
 *
 * Returns `{}` (not `{ sub_status_id: undefined }`) when the status does not move, so Prisma sees
 * no key at all and a crew-only assign or a re-complete cannot silently drop a still-valid label.
 */
export function subStatusClears(current: JobStatus, next: JobStatus): { sub_status_id?: null } {
  return current === next ? {} : { sub_status_id: null };
}
