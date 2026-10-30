import { isLiveVisit, latestVisitStamp, resolveCurrentVisit, type JobVisitRow } from '@/lib/visits';
import { isCompletedOrLaterJobStatus } from '@/lib/jobs/closeOut';

/**
 * Multi-visit S5 (D11): the bar is Job Created -> Visit 1..N -> Completed -> Invoice Sent ->
 * Payment Received. The fixed Scheduled and On Site nodes are gone: they were only ever visit
 * one's properties, read off the job row's milestone mirror.
 *
 * Roles & Permissions, PRD 6 (S06.21, M9): the close-out adds two steps, so the bar reads Job Created ->
 * Visit 1..N -> Completed -> Office review -> Invoice Sent -> Payment Received -> Done. The marker follows the
 * job's status from Office review on, and a step the job moved past without reaching is `skipped`.
 *
 * `scheduled` survives as a key for one thing only - the placeholder the bar draws for a job that
 * holds no visits yet, so a brand-new job can still be booked from the rail.
 */
export type StageKey =
  | 'created'
  | 'scheduled'
  | 'completed'
  | 'office_review'
  | 'invoice_sent'
  | 'payment_received'
  | 'done'
  | `visit:${string}`;

export interface Stage {
  key: StageKey;
  label: string;
  at: string | null;
  reached: boolean;
  current: boolean;
  /**
   * The job moved past this step without reaching it (PRD 6, M9): a visit still live once the job was completed, or
   * an invoice or payment that never happened once the job is Done. Never true on Office review or on a cancelled job.
   */
  skipped: boolean;
  /** Present on a visit node only. The ROW, so a click can name the trip it belongs to. */
  visit?: JobVisitRow;
}

/**
 * S5: `scheduled_start` and `on_site_at` are gone from here. They were the job-row mirror this
 * slice exists to stop reading (D14 ii repoints the mirror surface by surface; the bar is the
 * first). The columns themselves stay - dropping them is S8's - but nothing on the bar reads them.
 */
type JobInput = {
  created_at?: string | null;
  completed_at?: string | null;
  status: string;
  cancelled_at?: string | null;
  /** When the job was marked Done (PRD 6, S06.13); the Done step's date. */
  closed_at?: string | null;
};

/**
 * The two facts the server sends on a Done job so the bar can tell a skipped money step from one that never
 * applied (the server's money rule is the only definition of either; the browser never works them out): money is
 * still owed on the job, and the job's total is zero. Null on a job that is not Done.
 */
export type CloseOutMoneyInput = { money_owed: boolean; zero_total: boolean } | null | undefined;

export type FinancialsInput = {
  final_invoice?: {
    sent_at?: string | null;
    paid_at?: string | null;
    status?: string;
    amount_due?: string | number;
  } | null;
  /** Multi-draw aggregates (Spec B2). Absent for a price-blind requester — treat as unknown. */
  first_sent_at?: string | null;
  total_invoiced?: number;
  total_paid?: number;
} | null | undefined;

/**
 * Whether the job is fully paid off — the exact signal `computeLifecycle` uses to decide the
 * Payment Received stage. Exported standalone (final-review fix) so a caller that needs only
 * this ONE boolean — e.g. JobDetailPage gating whether the Payment Received node stays
 * clickable — reuses this directly instead of re-deriving the hasTotals/fallback logic itself.
 */
export function isPaidOff(financials: FinancialsInput): boolean {
  const inv = financials?.final_invoice ?? null;
  const hasTotals = financials?.total_invoiced != null && financials?.total_paid != null;
  return hasTotals
    // `> 0` is load-bearing: without it an uninvoiced job satisfies 0 >= 0 and reads as PAID.
    ? Number(financials!.total_invoiced) > 0 &&
      Number(financials!.total_paid) >= Number(financials!.total_invoiced)
    // Stripped payload: amount_due is gone too, so status is the only surviving signal.
    : inv != null && (inv.status === 'PAID' || Number(inv.amount_due) === 0);
}

/**
 * D11 + D13: nodes are drawn in TIME order and LABELLED in creation order, so the two deliberately
 * disagree. `visit_seq` appears in the customer's email, so sorting by it would renumber a trip
 * they already hold a message about.
 *
 * Restated here rather than trusting the caller's array order even though backend listJobVisits
 * already returns exactly this: a pure module that silently depends on how it was handed its
 * input is a module whose contract nobody can read.
 */
function byTimeThenCreation(a: JobVisitRow, b: JobVisitRow): number {
  const at = a.scheduled_at ? new Date(a.scheduled_at).getTime() : null;
  const bt = b.scheduled_at ? new Date(b.scheduled_at).getTime() : null;
  if (at !== bt) {
    // An unscheduled trip sorts last: it has no place on the timeline yet.
    if (at === null) return 1;
    if (bt === null) return -1;
    return at - bt;
  }
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

/** The statuses in which the review is finished: Office review is reached from Ready to close on. */
const REVIEW_FINISHED_STATUSES: readonly string[] = ['READY_TO_CLOSE', 'DONE'];

export function computeLifecycle(
  job: JobInput,
  financials: FinancialsInput,
  visits: JobVisitRow[] = [],
  closeOutMoney?: CloseOutMoneyInput,
): Stage[] {
  const inv = financials?.final_invoice ?? null;

  // Spec B2 — the bar summarises the JOB, not its newest invoice. A job billed in progress draws
  // has several, and reading only the highest-numbered one made the bar flip to "not invoiced"
  // the moment a new draft was created. Prefer the job-wide aggregates; fall back to
  // final_invoice when they are absent, which is what a price-blind requester gets.
  const sentAt: string | null = financials?.first_sent_at ?? inv?.sent_at ?? null;

  const paidOff = isPaidOff(financials);

  const paymentAt: string | null = paidOff ? (inv?.paid_at ?? sentAt) : null;

  const visitStages: Stage[] = [...visits].sort(byTimeThenCreation).map((v) => ({
    key: `visit:${v.id}` as StageKey,
    label: `Visit ${v.visit_seq}`,
    // The latest thing that actually happened to this trip, falling back to the booking itself
    // for one nobody has left for yet. Shared with the Visits card so a node and its row can
    // never show two different instants for the same visit.
    at: latestVisitStamp(v) ?? v.scheduled_at,
    reached: false,
    current: false,
    skipped: false,
    visit: v,
  }));

  // Build stages in order with their raw `at` values. Office review reads "Ready to close" while the job rests there:
  // the two share the one step (PRD 6, R4-04), so the step's label says which of them it is.
  const stage = (key: StageKey, label: string, at: string | null): Stage => ({ key, label, at, reached: false, current: false, skipped: false });
  const stages: Stage[] = [
    stage('created', 'Job Created', job.created_at ?? null),
    ...visitStages,
    stage('completed', 'Completed', job.completed_at ?? null),
    stage('office_review', job.status === 'READY_TO_CLOSE' ? 'Ready to close' : 'Office review', null),
    stage('invoice_sent', 'Invoice Sent', sentAt),
    stage('payment_received', 'Payment Received', paymentAt),
    stage('done', 'Done', job.closed_at ?? null),
  ];

  // D11a: per-node truth. The forward-fill this replaces marked a stage reached whenever any
  // LATER stage carried a timestamp, so a job billed before anyone marked it complete drew a green
  // tick over a step that never happened - and with a future visit sitting after a completed one,
  // the same rule backfilled the whole rail.
  //
  // This is exactly why backend/src/lib/job-milestones.ts is still required after D11a: nothing
  // paints a node from its neighbours any more, so a node lights only while its own column holds a
  // stamp - and milestoneClears is what stops a BACKWARD move leaving completed_at set and lighting
  // Completed forever.
  for (const s of stages) {
    // A VISIT node reaches on its STATUS, never on its `at`: a booked trip's `at` falls back to
    // its scheduled_at, so `at != null` would tick a trip nobody has left for yet, and a cancelled
    // one carries a cancelled_at (D19 keeps its node, greyed, never reached).
    s.reached = s.visit ? s.visit.status === 'COMPLETED' : s.at != null;
  }
  // The two close-out steps light from the job's status, not from a stamp: the review is finished once the job rests in
  // Ready to close or later, and Done is the Done status itself.
  const byKey = (key: StageKey) => stages.find((s) => s.key === key)!;
  byKey('office_review').reached = REVIEW_FINISHED_STATUSES.includes(job.status);
  byKey('done').reached = job.status === 'DONE';

  // `current` needs a rule of its own now that D11a has removed the fill: B5 deliberately leaves a
  // live trip unreached, so the legacy "last reached stage" scan could never name one.
  //
  // The rule is resolveCurrentVisit - the SAME function useJobVisits exposes as `.current` and the
  // page hero's Next Visit tile reads - rather than a third derivation of "which visit is current".
  // That drift is exactly what #1551 was spent undoing. Its no-live-visits fallback (the most
  // recent trip that HAPPENED) is right for a hero and wrong for the rail, so liveness is asserted
  // here: a fully billed job with only finished trips should still highlight Invoice Sent.
  const isCancelled = !!job.cancelled_at;
  // From Office review on the job's status names the step, whatever a visit or an invoice is doing: Office review and
  // Ready to close share one step, and Done is its own.
  const statusStep: StageKey | null =
    job.status === 'OFFICE_REVIEW' || job.status === 'READY_TO_CLOSE' ? 'office_review' : job.status === 'DONE' ? 'done' : null;
  if (!isCancelled && statusStep) {
    byKey(statusStep).current = true;
  } else if (!isCancelled) {
    const currentVisit = resolveCurrentVisit(visits);
    const currentVisitStage = currentVisit && isLiveVisit(currentVisit)
      ? stages.find((s) => s.visit?.id === currentVisit.id)
      : undefined;

    if (currentVisitStage) {
      currentVisitStage.current = true;
    } else {
      for (let i = stages.length - 1; i >= 0; i--) {
        const s = stages[i]!;
        if (s.reached) { s.current = true; break; }
      }
    }
  }

  markSkipped(stages, job, financials, closeOutMoney, isCancelled);
  return stages;
}

/**
 * PRD 6 (M9): a step is skipped only when the job's status has moved past it without it. Office review and Completed are
 * never skipped, and a cancelled job shows no skipped step.
 *  - Once the job is Completed or later, a visit still live (not finished, not cancelled) is skipped; a cancelled visit
 *    stays grey, including the ones the complete confirmation cancelled.
 *  - Once the job is Done, Invoice sent and Payment received are skipped if not reached, and Payment received is skipped
 *    whenever money is still owed. A job whose total is zero never shows a money step as skipped.
 * The money facts come from the server (`closeOutMoney`) and from the job's financials; while either is unknown (still
 * loading, or an older answer without them) no money step is called skipped, because saying so would be a guess.
 */
function markSkipped(
  stages: Stage[],
  job: JobInput,
  financials: FinancialsInput,
  closeOutMoney: CloseOutMoneyInput,
  isCancelled: boolean,
): void {
  if (isCancelled || !isCompletedOrLaterJobStatus(job.status)) return;
  for (const s of stages) {
    if (s.visit && isLiveVisit(s.visit)) s.skipped = true;
  }
  if (job.status !== 'DONE' || !closeOutMoney || financials == null || closeOutMoney.zero_total) return;
  for (const s of stages) {
    if (s.key === 'invoice_sent' && !s.reached) s.skipped = true;
    if (s.key === 'payment_received' && (!s.reached || closeOutMoney.money_owed)) {
      s.skipped = true;
      s.reached = false;
    }
  }
}
