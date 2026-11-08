import { isLiveVisit, latestVisitStamp, resolveCurrentVisit, type JobVisitRow } from '@/lib/visits';

/**
 * Multi-visit S5 (D11): the bar is Job Created -> Visit 1..N -> Completed -> Invoice Sent ->
 * Payment Received. The fixed Scheduled and On Site nodes are gone: they were only ever visit
 * one's properties, read off the job row's milestone mirror.
 *
 * `scheduled` survives as a key for one thing only - the placeholder the bar draws for a job that
 * holds no visits yet, so a brand-new job can still be booked from the rail.
 */
export type StageKey =
  | 'created'
  | 'scheduled'
  | 'completed'
  | 'invoice_sent'
  | 'payment_received'
  | `visit:${string}`;

export interface Stage {
  key: StageKey;
  label: string;
  at: string | null;
  reached: boolean;
  current: boolean;
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
};

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

export function computeLifecycle(
  job: JobInput,
  financials: FinancialsInput,
  visits: JobVisitRow[] = [],
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
    visit: v,
  }));

  // Build stages in order with their raw `at` values
  const stages: Stage[] = [
    { key: 'created',           label: 'Job Created',        at: job.created_at ?? null,       reached: false, current: false },
    ...visitStages,
    { key: 'completed',         label: 'Completed',          at: job.completed_at ?? null,     reached: false, current: false },
    { key: 'invoice_sent',      label: 'Invoice Sent',       at: sentAt,                       reached: false, current: false },
    { key: 'payment_received',  label: 'Payment Received',   at: paymentAt,                    reached: false, current: false },
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

  // `current` needs a rule of its own now that D11a has removed the fill: B5 deliberately leaves a
  // live trip unreached, so the legacy "last reached stage" scan could never name one.
  //
  // The rule is resolveCurrentVisit - the SAME function useJobVisits exposes as `.current` and the
  // page hero's Next Visit tile reads - rather than a third derivation of "which visit is current".
  // That drift is exactly what #1551 was spent undoing. Its no-live-visits fallback (the most
  // recent trip that HAPPENED) is right for a hero and wrong for the rail, so liveness is asserted
  // here: a fully billed job with only finished trips should still highlight Invoice Sent.
  const isCancelled = !!job.cancelled_at;
  if (!isCancelled) {
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

  return stages;
}
