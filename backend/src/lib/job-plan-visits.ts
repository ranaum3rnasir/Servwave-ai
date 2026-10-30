import type { Prisma } from '@prisma/client';

/**
 * The service plan visit jobs a Jobs list leaves out when it is asked to (`exclude_plan_visits=true`): the jobs a service plan
 * books for each visit, which are managed inside the Service Plans module. The office Jobs page always asks, and so does every
 * dashboard tile whose "View all" opens that page, so the tile counts and lists what the page then shows.
 *
 * This is the one place that says what the exclusion is. The Jobs list, its stats and the dashboard tile all build on it;
 * none of them reads the plan link on its own.
 */
export const excludePlanVisitJobsWhere = { source_plan_id: null } satisfies Prisma.JobWhereInput;

/** The exclusion a request's `exclude_plan_visits` query value asks for: the clause for `'true'`, nothing for anything else. */
export function planVisitExclusionFor(queryValue: unknown): Prisma.JobWhereInput {
  return queryValue === 'true' ? excludePlanVisitJobsWhere : {};
}
