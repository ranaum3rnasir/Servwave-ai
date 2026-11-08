/**
 * Multi-visit S8 (D6): the job's crew, read off its visits.
 *
 * `job_assignees` is gone - a job's crew is the UNION of the crews of its trips. Every
 * authorization check and every notification recipient list that used to read
 * `job.assignees[].user_id` now traverses one relation level deeper, so this is the ONE place
 * that flatten lives. A per-call-site `.flatMap(...)` would drift on the two questions that
 * matter (does a cancelled trip count, does a person on two trips appear twice) and both answers
 * are load-bearing: the row scope has no status filter, so neither does this, and callers ask
 * membership questions, so the result is deduped.
 */
export type JobWithVisitCrew = {
  visits?: Array<{ assignees?: Array<{ user_id: string }> | null }> | null;
} | null | undefined;

export function jobCrewIds(job: JobWithVisitCrew): string[] {
  const seen = new Set<string>();
  for (const v of job?.visits ?? []) {
    for (const a of v.assignees ?? []) seen.add(a.user_id);
  }
  return [...seen];
}

/** Is this user on any of the job's trips? The membership question, asked once. */
export function isOnJobCrew(job: JobWithVisitCrew, userId: string): boolean {
  return (job?.visits ?? []).some((v) => (v.assignees ?? []).some((a) => a.user_id === userId));
}

/**
 * Multi-visit S8 (D6): rebuild a job payload's `assignees` WIRE KEY from its visit set.
 *
 * The storage is gone but the wire contract is not - TeamCard, the board's technician lanes, the
 * jobs CSV, the copilot tools and both customer-detail pages all read `job.assignees`. Every
 * endpoint that selects `visits.assignees` for display has to run this before it responds, or the
 * key silently disappears and every reader falls through to its "Unassigned" branch: no error, no
 * typecheck failure, because the frontend declares the key optional.
 *
 * Deduped by user id, first appearance wins - a person on two trips appears ONCE, which is what
 * every reader of this key already assumes. No status filter: a technician crewed only on a
 * called-off trip still reaches the job through the row scope, which has no status filter either,
 * so hiding them here would offer a job the API then 403s, or the reverse.
 *
 * The key is written even when the job has no visit at all, as an empty array rather than omitted
 * - a reader doing `job.assignees.length` must not start throwing.
 */
export function projectJobCrewUnion<T extends Record<string, unknown>>(job: T): T {
  const visits = job.visits as Array<{ assignees?: Array<{ user?: { id: string } | null }> | null }> | null | undefined;
  const seen = new Set<string>();
  const assignees: Array<{ user: { id: string } }> = [];
  for (const v of visits ?? []) {
    for (const a of v.assignees ?? []) {
      const id = a.user?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      assignees.push(a as { user: { id: string } });
    }
  }
  return { ...job, assignees } as unknown as T;
}
