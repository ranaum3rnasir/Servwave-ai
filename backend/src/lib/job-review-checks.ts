import { prisma } from './prisma';
import type { ReviewAnswer } from './job-review-reader';

/**
 * The checks on an office review's items (Roles & Permissions, PRD 6, S06.10).
 *
 * A check is stored against the history entry its item had when the person checked it. The change-set (M8) counts an
 * item as checked only while that is still the item's latest entry, so a later change un-checks it with no extra write;
 * the job summary's check is tied to the job's latest history entry the same way. One row per item per round: checking
 * an item again overwrites the row.
 *
 * What may be checked is decided here from the review the person themselves can read, so an item they cannot see (the
 * money on an invoice they cannot open) is not found, and an item whose latest entry has moved on since they looked is
 * refused rather than checked. Customer items are confirmed one by one by the customer decisions (S06.11), never here.
 */

export const SUMMARY_KEY = 'summary';
export const CUSTOMER_ONE_BY_ONE = 'Customer changes are confirmed one by one.';

export interface CheckRequest {
  item_key: string;
  /** The history entry the person saw as the item's latest. */
  entry_id: string;
}

export type CheckVerdict = 'ok' | 'not_found' | 'customer' | 'stale';

/** Whether this request may be stored against the review as it stands now. */
export function judgeCheck(review: ReviewAnswer, request: CheckRequest): CheckVerdict {
  if (request.item_key === SUMMARY_KEY) {
    return review.summary.latest_entry_id === request.entry_id ? 'ok' : 'stale';
  }
  const item = review.groups.flatMap((g) => g.items).find((i) => i.key === request.item_key);
  if (!item) return 'not_found';
  if (item.kind === 'contact') return 'customer';
  return item.latest_entry_id === request.entry_id ? 'ok' : 'stale';
}

/**
 * Stores the checks that may be stored and returns how many were. An existing check on the same item is replaced, so a
 * re-check after a change moves it to the new entry. A check that loses a race with the same check made at the same
 * moment is simply not written twice.
 */
export async function storeChecks(args: { orgId: string; reviewId: string; checkedById: string; checks: CheckRequest[] }): Promise<number> {
  const { orgId, reviewId, checkedById, checks } = args;
  if (checks.length === 0) return 0;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.jobReviewItemCheck.deleteMany({
      where: { organization_id: orgId, review_id: reviewId, item_key: { in: checks.map((c) => c.item_key) } },
    });
    await tx.jobReviewItemCheck.createMany({
      data: checks.map((c) => ({
        organization_id: orgId, review_id: reviewId, item_key: c.item_key, entry_id: c.entry_id, checked_by_id: checkedById, checked_at: now,
      })),
      skipDuplicates: true,
    });
  });
  return checks.length;
}
