import { prisma } from './prisma';
import type { ReviewAnswer } from './job-review-reader';
import { CHOICE, type ReviewChoice } from './job-review-changeset';

/**
 * The reviewer's decisions on the customer items of an office review (Roles & Permissions, PRD 6, S06.11).
 *
 * Each live PRD 5 job contact entry is one customer item. Ticking it confirms the choice the panel showed and stores it in
 * the review's own table, against the history entry the item had at that moment; the change-set (M8) counts the item as
 * checked only while that is still the item's latest entry, so a correction to the entry un-checks it with no extra
 * write. Changing the choice after the tick writes the row again against the same entry, which keeps it ticked.
 *
 * A decision is only RECORDED here. It reaches the customer when Finish review applies it (S06.12), so `applied` stays
 * false and nothing on the customer, on PRD 5's entries or on the job's history is written by this module.
 *
 * What may be stored is decided from the review the person can read themselves: the choice must be one the change offers
 * (an added phone is never offered Update, a name is never offered Add), an entry removed before the review takes no
 * choice and is stored as NONE, and an item whose latest entry has moved on since the person looked is refused.
 */

export interface DecisionRequest {
  /** The customer item's key, "contact:<entry id>". */
  item_key: string;
  /** The history entry the person saw as the item's latest. */
  entry_id: string;
  /** The choice shown when they ticked; absent for an entry removed before the review. */
  choice?: string;
}

export type DecisionRefusal = 'not_found' | 'not_customer' | 'bad_choice' | 'stale';
export type DecisionVerdict =
  | { verdict: 'ok'; contactEntryId: string; choice: ReviewChoice }
  | { verdict: DecisionRefusal };

export function judgeDecision(review: ReviewAnswer, request: DecisionRequest): DecisionVerdict {
  const item = review.groups.flatMap((g) => g.items).find((i) => i.key === request.item_key);
  if (!item) return { verdict: 'not_found' };
  if (item.kind !== 'contact' || !item.contact) return { verdict: 'not_customer' };
  const { contact } = item;
  // An entry removed before the review takes no choice; every other entry takes exactly one it offers.
  const choice = contact.removed ? (request.choice === undefined ? CHOICE.NONE : null) : contact.options.find((o) => o === request.choice) ?? null;
  if (choice === null) return { verdict: 'bad_choice' };
  if (item.latest_entry_id !== request.entry_id) return { verdict: 'stale' };
  return { verdict: 'ok', contactEntryId: contact.entry_id, choice };
}

/** Stores the decision for the round, replacing the one already made on the same entry. */
export async function storeDecision(args: {
  orgId: string;
  reviewId: string;
  decidedById: string;
  contactEntryId: string;
  eventId: string;
  choice: ReviewChoice;
}): Promise<void> {
  const { orgId, reviewId, decidedById, contactEntryId, eventId, choice } = args;
  const now = new Date();
  await prisma.jobReviewCustomerDecision.upsert({
    where: { review_id_entry_id: { review_id: reviewId, entry_id: contactEntryId } },
    create: { organization_id: orgId, review_id: reviewId, entry_id: contactEntryId, event_id: eventId, choice, decided_by_id: decidedById, decided_at: now },
    update: { event_id: eventId, choice, decided_by_id: decidedById, decided_at: now, applied: false, applied_at: null },
  });
}
