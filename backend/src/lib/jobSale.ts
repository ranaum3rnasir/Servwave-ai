import type { Prisma } from '@prisma/client';

/**
 * Does this job count as a sale for its Sold By (Roles & Permissions, PRD 3).
 *
 * No for a job booked from a service plan visit, told apart by its link to the plan; yes for every
 * other job. A service plan counts once for its seller, through the plan and its own invoice (the
 * invoice report credits that invoice to the plan's "Sold by"); the visit jobs it books carry the
 * same seller so they can open and be told about each visit, but they are not each a sale.
 *
 * This is the one place that says so. Today the only per-seller sales view is the invoice report's
 * salesperson column; any later count of sales per Sold By must be built on this predicate (or on its
 * `where` twin for a query), never on its own reading of the plan link.
 */
export function jobCountsAsSale(job: { source_plan_id: string | null }): boolean {
  return job.source_plan_id === null;
}

/** The same question as a job `where`, for a query that counts or lists the jobs that are sales. */
export const jobCountsAsSaleWhere = { source_plan_id: null } satisfies Prisma.JobWhereInput;
