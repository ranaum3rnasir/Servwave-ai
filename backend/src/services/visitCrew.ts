import type { Prisma } from '@prisma/client';

/**
 * Replace ONE visit's crew - a job trip's or a lead walkthrough's, the same writer for both
 * parents (multi-visit S3, D3/D6: a visit is a visit; only the parent differs). The array IS the
 * visit's new crew: the current crew is read inside the transaction, the difference is applied,
 * and `{ added, removed }` (user ids) comes back for the caller's timeline events and notices.
 *
 * Rows carry `visit_id` and the organization only. S8 dropped `visit_assignees.lead_id`, so no
 * parent id is written: stamping a lead id onto a job trip would typecheck, pass every mocked test
 * and fail only against real Postgres.
 *
 * NOT tenant-filtered on its own reads and deletes - safe only because every caller has already
 * tenant-checked the job, lead or visit before reaching it. Keep it that way for a new caller.
 *
 * Moved out of walkthrough.service.ts, where it was `replaceWalkthroughPerformers` although the
 * job side had long used it too (fix pass, code review #8).
 */
export async function replaceVisitCrew(
  tx: Prisma.TransactionClient,
  opts: { visitId: string; orgId: string; userIds: readonly string[] },
): Promise<{ added: string[]; removed: string[] }> {
  const current = await tx.visitAssignee.findMany({ where: { visit_id: opts.visitId }, select: { user_id: true } });
  const currentIds = new Set(current.map((c) => c.user_id));
  const next = new Set(opts.userIds);
  const added = [...next].filter((id) => !currentIds.has(id));
  const removed = [...currentIds].filter((id) => !next.has(id));
  if (removed.length) await tx.visitAssignee.deleteMany({ where: { visit_id: opts.visitId, user_id: { in: removed } } });
  if (added.length) {
    await tx.visitAssignee.createMany({
      data: added.map((user_id) => ({ visit_id: opts.visitId, user_id, organization_id: opts.orgId })),
    });
  }
  return { added, removed };
}
