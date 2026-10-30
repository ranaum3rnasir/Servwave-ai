import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

/**
 * The office review of a job (Roles & Permissions, PRD 6, S06.8): the content of the banner and the right-side panel,
 * read from `GET /api/jobs/:id/review`. The server builds it from the job's own history (the review change-set, M8);
 * this file only types the answer and reads it. It is the ONLY reader of that route.
 *
 * The checks (S06.10) are written with `POST /api/jobs/:id/review/checks` (one item) and `.../checks/all` (Mark all checked).
 * Each answers with the review as it stands after the write, which goes straight into the cached review, so the panel and
 * the banner's "N checked" follow the stored checks. A check names the history entry the person saw as the item's latest;
 * when the item has moved on since, the server refuses and the review is read again.
 *
 * A customer item (a job contact entry from the contact pencil) is ticked by a decision, not a check:
 * `POST /api/jobs/:id/review/decisions` carries the entry the person saw and the choice the control showed (none for an
 * entry removed before the review). Like the checks it answers with the review as it stands after the write. The
 * decision is only recorded; the customer is changed when the review is finished.
 *
 * Finish review (S06.12) is `POST /api/jobs/:id/review/finish` with the version of the review the person loaded. The server
 * refuses a review that has changed since (code REVIEW_CHANGED, with the sentence to show) or one with an item still
 * unchecked, and otherwise moves the job to Ready to close and applies the customer decisions in one write.
 *
 * The person is offered the review by the job's own answer (`job.actions` lists `office_review`), so the query runs only
 * when the page was told to read it; the route refuses everyone else anyway.
 */
export type ReviewGroupKey = 'unusual' | 'customer' | 'lines' | 'attachments' | 'notes' | 'payments';
export type ReviewUnusualKind = 'file_deleted' | 'price_cut' | 'customer_change';

export interface ReviewChange {
  label: string;
  old: string | null;
  new: string | null;
}

export interface ReviewItem {
  key: string;
  group: Exclude<ReviewGroupKey, 'unusual'>;
  kind: string;
  title: string;
  summary: string;
  changes: ReviewChange[];
  by: string | null;
  at: string;
  checked: boolean;
  checked_by: string | null;
  checked_at: string | null;
  unusual: boolean;
  unusual_kind: ReviewUnusualKind | null;
  unusual_reason: string | null;
  /** The job history entry this item is checked against; a check names it, so a later change un-checks the item. */
  latest_entry_id: string;
  contact?: ReviewContact;
}

export type ReviewChoice = 'ADD' | 'UPDATE' | 'THIS_JOB_ONLY';

/** The decision side of a customer item: what is offered, what the control starts on, and what is stored. */
export interface ReviewContact {
  entry_id: string;
  kind: string;
  intent: string;
  removed: boolean;
  /** The choices offered, in order; empty for an entry removed before the review (it needs only a check). */
  options: ReviewChoice[];
  default_choice: ReviewChoice | null;
  /** The stored pick, if one was made. */
  decision: string | null;
  /** The choice the control shows: the stored pick while still offered, else the default. */
  choice: ReviewChoice | null;
  /** The customer's value of a changed name, shown beside the job's. */
  customer_current: string | null;
}

export interface ReviewVisit {
  seq: number;
  scheduled_at: string | null;
  outcome: 'finished' | 'cancelled' | 'open';
  finished_by: string | null;
  crew: string[];
  cancelled_by_complete: boolean;
}

export interface ReviewSummaryLine {
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  /** Present only for a person who may see costs (See financial data). */
  unit_cost?: number | null;
}

export interface ReviewSummary {
  key: 'summary';
  title: string;
  checked: boolean;
  checked_by: string | null;
  checked_at: string | null;
  latest_entry_id: string | null;
  job_number: string;
  job_type: string | null;
  customer: { name: string; company_name: string | null };
  service_address: string | null;
  visits: ReviewVisit[];
  lines: ReviewSummaryLine[];
  discount_amount: number;
  total: number;
  total_cost?: number | null;
  invoices: Array<{ invoice_number: string; status: string; total: number; amount_due: number }>;
  balance: number | null;
  file_count: number;
  note_count: number;
}

export interface ReviewGroup {
  key: ReviewGroupKey;
  label: string;
  items: ReviewItem[];
}

export interface JobReview {
  summary: ReviewSummary;
  groups: ReviewGroup[];
  totals: { items: number; checked: number; unusual: number };
  round: { id: string; state: string; started_at: string; window_start: string } | null;
  /**
   * "Since the review" (S06.20): the ordinary changes that landed after the review was finished, on a job in Ready to close;
   * null on any other job. The server decides (the browser never works it out from the status or the times).
   */
  since_review: ReviewItem[] | null;
  /** The review's version, built by the server from everything Finish review depends on; Finish review sends it back. */
  version: string;
}

export const jobReviewKey = (jobId: string) => ['job', jobId, 'review'] as const;

export function useJobReview(jobId: string | undefined, enabled: boolean) {
  return useQuery<JobReview>({
    queryKey: jobReviewKey(jobId ?? ''),
    enabled: enabled && !!jobId,
    queryFn: () => api.get(`/api/jobs/${jobId}/review`).then((r) => r.data.review as JobReview),
  });
}

/** What a check names: the item and the history entry the person saw as its latest. The job summary's key is "summary". */
export interface ReviewCheckRequest {
  item_key: string;
  entry_id: string;
}

/** What a decision names: the customer item, the entry the person saw as its latest, and the choice (absent when none is offered). */
export interface ReviewDecisionRequest {
  item_key: string;
  entry_id: string;
  choice?: ReviewChoice;
}

function useReviewWrite<V>(jobId: string | undefined, write: (jobId: string, input: V) => Promise<JobReview>, failure = "Couldn't save the check") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: V) => write(jobId ?? '', input),
    onSuccess: (review) => queryClient.setQueryData(jobReviewKey(jobId ?? ''), review),
    onError: (err: unknown) => {
      toast({ title: failure, description: extractApiError(err, 'Try again in a moment.'), variant: 'destructive' });
      // The item may have changed under the person: read the review again so they see the new version.
      void queryClient.invalidateQueries({ queryKey: jobReviewKey(jobId ?? '') });
    },
  });
}

export function useCheckReviewItem(jobId: string | undefined) {
  return useReviewWrite<ReviewCheckRequest>(jobId, (id, check) => api.post(`/api/jobs/${id}/review/checks`, check).then((r) => r.data.review as JobReview));
}

export function useMarkAllChecked(jobId: string | undefined) {
  return useReviewWrite<ReviewCheckRequest[]>(jobId, (id, items) => api.post(`/api/jobs/${id}/review/checks/all`, { items }).then((r) => r.data.review as JobReview));
}

export function useDecideCustomerItem(jobId: string | undefined) {
  return useReviewWrite<ReviewDecisionRequest>(
    jobId,
    (id, decision) => api.post(`/api/jobs/${id}/review/decisions`, decision).then((r) => r.data.review as JobReview),
    "Couldn't save the decision",
  );
}

/** The code the server puts on a finish refused because the review changed after the person loaded it. */
export const REVIEW_CHANGED = 'REVIEW_CHANGED';

export function useFinishReview(jobId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: string) =>
      api.post(`/api/jobs/${jobId}/review/finish`, { version }).then((r) => r.data as { status: string; review: JobReview }),
    // The finish stays pending (the button keeps working and the panel stays up) until the job has been read again, so the
    // page never shows the Office review banner and its old counts after the job has already moved to Ready to close.
    // The review the person finished stays on screen until then: the finish answer's own review is not drawn, because it
    // is read in the middle of the move and its counts are not the ones the person saw checked.
    onSuccess: async () => {
      // The job is now Ready to close: the job, the lists and its history read it again.
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['job-timeline', jobId] });
      toast({ title: 'Review finished', description: 'The job is ready to close.' });
      await queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    },
    // Whatever the reason, the review may have moved under the person: read it again so they see the new version.
    onError: () => void queryClient.invalidateQueries({ queryKey: jobReviewKey(jobId ?? '') }),
  });
}
