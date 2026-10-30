import type { JobReview, ReviewCheckRequest, ReviewChoice, ReviewUnusualKind } from '@/lib/api/jobReview';

/**
 * The words of the office review's banner and panel (Roles & Permissions, PRD 6, S06.8), kept in one place so the banner
 * chips and the panel header say the same thing. Pure, so a test reads them without rendering.
 */

const UNUSUAL_WORDS: Record<ReviewUnusualKind, [one: string, many: string]> = {
  file_deleted: ['file deleted', 'files deleted'],
  price_cut: ['price cut', 'price cuts'],
  customer_change: ['customer change', 'customer changes'],
};

const UNUSUAL_ORDER: ReviewUnusualKind[] = ['file_deleted', 'price_cut', 'customer_change'];

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "7 items · 3 checked": the job summary counts as one item to check. */
export function reviewCounts(totals: JobReview['totals']): string {
  return `${plural(totals.items, 'item')} · ${totals.checked} checked`;
}

/** One chip per kind of unusual item the review holds: "1 file deleted", "2 price cuts", "1 customer change". */
export function unusualChips(review: Pick<JobReview, 'groups'>): Array<{ kind: ReviewUnusualKind; text: string }> {
  const flagged = review.groups.find((g) => g.key === 'unusual')?.items ?? [];
  return UNUSUAL_ORDER.flatMap((kind) => {
    const n = flagged.filter((i) => i.unusual_kind === kind).length;
    if (n === 0) return [];
    const [one, many] = UNUSUAL_WORDS[kind];
    return [{ kind, text: `${n} ${n === 1 ? one : many}` }];
  });
}

const DATE_TIME = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const DATE_ONLY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function shortDateTime(iso: string | null | undefined): string {
  return iso ? DATE_TIME.format(new Date(iso)) : '';
}

export function shortDate(iso: string | null | undefined): string {
  return iso ? DATE_ONLY.format(new Date(iso)) : 'Not scheduled';
}

/** "Sam Office, Oct 3, 2:14 PM": who made the change and when. */
export function byAndWhen(by: string | null, at: string): string {
  return [by, shortDateTime(at)].filter(Boolean).join(', ');
}

/** The words on the customer items' choice control. "Update the customer" is the register's "Replace on the customer". */
export const CHOICE_LABEL: Record<ReviewChoice, string> = {
  ADD: 'Add to the customer',
  UPDATE: 'Update the customer',
  THIS_JOB_ONLY: 'This job only',
};

/** Said under a customer item that was taken off the job before the review: nothing reaches the customer. */
export const REMOVED_NOTHING_APPLIED = 'Taken off the job before the review. Nothing is applied to the customer; check it to confirm you have seen it.';

/** Said under a ticked customer item: the decision is recorded now and reaches the customer when the review is finished. */
export const APPLIED_AT_FINISH = 'Applied to the customer when the review is finished.';

/** Said beside Mark all checked: a customer change is never ticked by it. */
export const CUSTOMER_ONE_BY_ONE = 'Customer changes are confirmed one by one.';

/** How many names the "what is left" line spells out before it says "and N more". */
const LEFT_NAMES = 3;
const NAME_LENGTH = 32;

interface ReviewEntry {
  key: string;
  title: string;
  checked: boolean;
  kind: string;
  /** The history entry a check names. */
  entryId: string | null;
}

/** Everything to check, once each: the job summary first, then the items in the order of the groups (the unusual group lists items again). */
function reviewEntries(review: JobReview): ReviewEntry[] {
  const { summary } = review;
  return [
    { key: summary.key, title: summary.title, checked: summary.checked, kind: 'summary', entryId: summary.latest_entry_id },
    ...review.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items).map((i) => ({ key: i.key, title: i.title, checked: i.checked, kind: i.kind, entryId: i.latest_entry_id })),
  ];
}

/** How many items are still unchecked, the job summary included. Finish review waits for this to reach none. */
export const countLeft = (review: JobReview): number => reviewEntries(review).filter((e) => !e.checked).length;

const shorten = (name: string): string => (name.length > NAME_LENGTH ? `${name.slice(0, NAME_LENGTH - 1).trimEnd()}…` : name);

/**
 * The "what is left" line: how many items are unchecked and the first few by name, never a list of all of them, so it
 * stays one short sentence on a job with a hundred changes. Customer items are named like the rest.
 */
export function whatIsLeft(review: JobReview): string {
  const left = reviewEntries(review).filter((e) => !e.checked);
  if (left.length === 0) return 'Everything is checked.';
  const names = left.slice(0, LEFT_NAMES).map((e) => shorten(e.title));
  const more = left.length - names.length;
  return `${left.length} left to check: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`;
}

/**
 * What Mark all checked sends: the job summary and every item not yet checked, each with the entry the person is looking
 * at. Customer items are left out; they are confirmed one by one.
 */
export function markAllRequest(review: JobReview): ReviewCheckRequest[] {
  return reviewEntries(review)
    .filter((e) => !e.checked && e.kind !== 'contact' && e.entryId !== null)
    .map((e) => ({ item_key: e.key, entry_id: e.entryId! }));
}
