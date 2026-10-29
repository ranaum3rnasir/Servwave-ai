/**
 * #2048 — the ONE convertibility predicate and the ONE "Convert to job" / "Create Job" gate,
 * shared by LeadDetailPage's header button, its convert dialog, and EstimateWorkspacePage's
 * header button + Actions menu item — so the four call sites can never drift apart.
 *
 * `convertToJobState` is a PURE function, not a `use*` hook (R10): it is called from a
 * conditionally-rendered branch on the estimate page (the Actions item only exists inside the
 * open dropdown), and a hook there would violate rules-of-hooks.
 *
 * #2188 slice 15 — a refusal is now SAID OUT LOUD. Before, "you hold no create Job grant" and
 * "this estimate cannot be converted right now" collapsed into the identical invisible answer,
 * so a temporary block was indistinguishable from a capability the product does not have. Only
 * the permission case stays invisible (a grant someone does not hold must not advertise itself);
 * every other refusal renders a visible, disabled control carrying its reason.
 */

/**
 * The three refusals POST /api/jobs enforces on a SINGLE-estimate conversion, in the controller's
 * own order (backend/src/controllers/job.controller.ts create(), the one-estimate branch).
 * Mirrored here rather than imported: the frontend cannot import backend code — see
 * `constants/estimateStatus.ts` for the same manually-synced-mirror pattern.
 *
 * Each reason states the RULE and then the NEXT STEP, so the operator can act without asking
 * support. `backend/src/__tests__/job-create-estimate-anchor.test.ts` pins the backend half of
 * each sentence, so a reworded refusal there goes red instead of silently diverging from this.
 */
export type ConvertBlockCode = 'NOT_WON' | 'ATTACHED_TO_OTHER_JOB' | 'DEPOSIT_UNSETTLED';

/** The one reason string for a deposit-blocked conversion. Must appear exactly once in
 * `frontend/src` — every other site imports it from here. Sentence one is the backend's verbatim
 * refusal, sentence two the next step it already spells out. */
export const CONVERT_DEPOSIT_BLOCKED_REASON =
  'Deposit must be paid or waived before creating a job. Mark the deposit as received or waive it first.';

export const CONVERT_BLOCK_REASONS: Record<ConvertBlockCode, string> = {
  NOT_WON: 'Estimate must be won before it can become a job. Mark it won from the status menu first.',
  ATTACHED_TO_OTHER_JOB:
    'This estimate is already attached to another job. Open that job from Attached to, or duplicate the estimate to bill separate work.',
  DEPOSIT_UNSETTLED: CONVERT_DEPOSIT_BLOCKED_REASON,
};

/** A deposit invoice in one of these states no longer blocks: paid, waived (VOIDED), or refunded
 * AFTER payment. Mirrors `DEPOSIT_OK` in job.controller.ts — the two post-payment refund states
 * were missing here, so a refunded deposit disabled a button the backend would have accepted. */
const DEPOSIT_SETTLED = ['PAID', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

export interface EstimateConvertShape {
  status: string;
  /** PROVENANCE — a Job created FROM this estimate (Job.estimate_id points back). */
  job?: { id?: string } | unknown;
  /** ANCHOR — the job this estimate is attached to. A conversion sets it to the estimate's OWN
   * provenance job, so a set `job_id` alone does NOT mean "spoken for by someone else". */
  job_id?: string | null;
}

/** The provenance job's id, when the caller passed the relation rather than a bare truthy stub. */
function provenanceJobId(job: EstimateConvertShape['job']): string | undefined {
  return typeof job === 'object' && job !== null ? (job as { id?: string }).id : undefined;
}

/**
 * Which backend rule refuses this estimate right now, or `null` when none does.
 *
 * "Already attached" means attached to a DIFFERENT job. Re-converting an estimate to its own
 * provenance job is deliberately allowed — the backend falls through to an idempotent
 * find-or-create that answers with the existing job (200) — so flattening this into "has a
 * job_id" would break a working path. A conversion writes BOTH pointers (job.controller.ts sets
 * `Estimate.job_id = j.id` beside `Job.estimate_id`), so `job_id === job.id` is exactly the
 * shape a converted estimate carries.
 */
export function convertBlock(
  estimate: EstimateConvertShape,
  depositInvoice?: { status: string } | null,
): { code: ConvertBlockCode; reason: string } | null {
  const block = (code: ConvertBlockCode) => ({ code, reason: CONVERT_BLOCK_REASONS[code] });

  if (estimate.status !== 'WON') return block('NOT_WON');
  if (estimate.job_id != null && estimate.job_id !== provenanceJobId(estimate.job)) {
    return block('ATTACHED_TO_OTHER_JOB');
  }
  if (depositInvoice && !DEPOSIT_SETTLED.includes(depositInvoice.status)) {
    return block('DEPOSIT_UNSETTLED');
  }
  return null;
}

/**
 * "Convertible" = this estimate can start a BRAND NEW job: won, with neither job pointer set.
 * `job` is PROVENANCE (a Job already created FROM this estimate), `job_id` is the ANCHOR (this
 * estimate was written against an existing job — the multi-convert path sets this without ever
 * touching `job`, job.controller.ts:2292-2340).
 *
 * Deliberately STRICTER than `convertBlock`: it mirrors the MULTI-estimate branch's check
 * (job.controller.ts rejects any selected estimate with `job_id != null || job != null`), and
 * that is the branch LeadDetailPage and its convert dialog pick candidates for. A re-conversion
 * is a single-estimate no-op the multi path does not accept, so it is not a candidate there.
 */
export function isConvertibleEstimate(e: EstimateConvertShape): boolean {
  return e.status === 'WON' && !e.job && !e.job_id;
}

/**
 * #2188 slice 16 — an estimate as the LEAD DETAIL payload carries it: the convert shape plus the
 * status of its kind=DEPOSIT Invoice (`leadDetailSelect` in lead.controller.ts). The estimate
 * page reaches its deposit through the estimate's own `invoices`; the lead side now gets the same
 * fact, narrowed to the one field the gate needs.
 */
export interface EstimateWithDepositShape extends EstimateConvertShape {
  invoices?: Array<{ kind: string; status: string }> | null;
}

/** The SOLE deposit document, found BY `kind` rather than by position: the payload's `where`
 * already pins it, but a row that arrived without `kind` must not be taken for a deposit. */
export function depositInvoiceOf(estimate: EstimateWithDepositShape): { status: string } | null {
  return estimate.invoices?.find((inv) => inv.kind === 'DEPOSIT') ?? null;
}

/**
 * #2188 slice 16 — whether a LEAD-side control may offer this estimate, which is the same
 * question as "would `POST /api/jobs` accept it".
 *
 * Two rules in two layers, and neither subsumes the other. `isConvertibleEstimate` is the
 * selectability predicate, mirroring the multi-estimate branch's rejection of anything already
 * carrying a job. `convertBlock` is the per-estimate refusal the estimate page consumes, and it
 * is where the DEPOSIT gate lives — the gate the lead side did not consult, so an estimate whose
 * deposit was still pre-payment got offered, picked, and refused with a 400.
 *
 * Used by BOTH lead-side surfaces: the convert dialog's per-row checkbox and submit filter, and
 * LeadDetailPage's one-click header button. They must not diverge — an operator should not learn
 * different things about the same estimate depending on how many siblings the lead happens to
 * have.
 */
export function isSelectableEstimate(estimate: EstimateWithDepositShape): boolean {
  return isConvertibleEstimate(estimate) && convertBlock(estimate, depositInvoiceOf(estimate)) == null;
}

/**
 * #2188 slice 16 — the sentence a lead-side control SAYS when it refuses, or null when it does
 * not refuse. The one place the deposit branch is taken, so both lead surfaces render the
 * identical copy from the identical test.
 *
 * Only the deposit can refuse an estimate `isConvertibleEstimate` already accepted, and the other
 * two codes belong to rows the lead side states differently anyway (a status chip for NOT_WON, a
 * job link for ATTACHED_TO_OTHER_JOB) — so this branches on the CODE and stays silent otherwise,
 * rather than spraying every refusal's sentence across a list.
 */
export function leadConvertBlockedReason(estimate: EstimateWithDepositShape): string | null {
  const block = isConvertibleEstimate(estimate)
    ? convertBlock(estimate, depositInvoiceOf(estimate))
    : null;
  return block?.code === 'DEPOSIT_UNSETTLED' ? block.reason : null;
}

/**
 * What a click on the control actually DOES. A re-conversion is allowed, but it lands on the
 * idempotent find-or-create and answers with the job that already exists - so on an estimate
 * holding its own provenance job the control must stop naming an act it does not perform. Same
 * affordance, same click, honest word. Carried on the state so every surface (and slice 16's
 * lead-side dialog) reads the same answer instead of re-deriving it from the estimate shape.
 */
export type ConvertJobAction = 'create' | 'view';

/** The header button's label per action. The Actions menu keeps its own deliberately asymmetric
 * wording ("Convert to job" / "View job") - the label differs, the underlying action never does. */
export const CONVERT_JOB_LABELS: Record<ConvertJobAction, string> = {
  create: 'Create Job',
  view: 'View Job',
};

export interface ConvertToJobState {
  /** Whether a "Convert to job" / "Create Job" control should render at all. */
  visible: boolean;
  /** Whether the (visible) control should render disabled. */
  disabled: boolean;
  /** The disabled reason, present only when `disabled` is true. */
  reason?: string;
  /** WHICH rule refused, for a caller that wants to branch on it rather than render the sentence
   * (slice 16's lead-side dialog). Present exactly when `disabled` is true. */
  code?: ConvertBlockCode;
  /** Whether the control creates a job or opens the one this estimate already made. A blocked or
   * hidden control is always `create`: there is no job of its own to view. */
  action: ConvertJobAction;
}

/**
 * The single-estimate convert gate, shared by the estimate page's header button and its Actions
 * item — and usable per-estimate row from the lead side, which is why the answer is three-way.
 *
 * Hidden ONLY when the caller lacks `create Job`. Otherwise the control always renders: enabled
 * when the backend would accept the conversion, disabled with the refusing rule's reason when it
 * would not.
 *
 * Slice 16 NOTE - the "the lead detail payload carries no deposit data" premise this paragraph
 * used to rest on is no longer true. `leadDetailSelect` now carries each estimate's kind=DEPOSIT
 * invoice status, and BOTH lead-side surfaces gate on it through `isSelectableEstimate` /
 * `leadConvertBlockedReason` below: the convert dialog's rows and LeadDetailPage's one-click
 * header button. All four call sites of this module now answer from the same deposit rule.
 */
export function convertToJobState({
  estimate,
  depositInvoice,
  canCreateJob,
}: {
  estimate: EstimateConvertShape;
  depositInvoice?: { status: string } | null;
  canCreateJob: boolean;
}): ConvertToJobState {
  // A grant the requester does not hold must not advertise itself: no control, no explanation.
  if (!canCreateJob) return { visible: false, disabled: false, action: 'create' };

  const block = convertBlock(estimate, depositInvoice);
  if (block) {
    return { visible: true, disabled: true, reason: block.reason, code: block.code, action: 'create' };
  }
  // Past the gate with a provenance job already in hand: the click opens that job rather than
  // making one. `convertBlock` has already ruled out a job belonging to someone else.
  return { visible: true, disabled: false, action: estimate.job != null ? 'view' : 'create' };
}
