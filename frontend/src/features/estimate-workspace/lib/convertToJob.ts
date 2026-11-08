/**
 * #2048 — the ONE convertibility predicate and the ONE "Convert to job" / "Create Job" gate,
 * shared by LeadDetailPage's header button, its convert dialog, and EstimateWorkspacePage's
 * header button + Actions menu item — so the four call sites can never drift apart.
 *
 * `convertToJobState` is a PURE function, not a `use*` hook (R10): it is called from a
 * conditionally-rendered branch on the estimate page (the Actions item only exists inside the
 * open dropdown), and a hook there would violate rules-of-hooks.
 */

/** The one reason string for a deposit-blocked conversion. Must appear exactly once in
 * `frontend/src` — every other site imports it from here. */
export const CONVERT_DEPOSIT_BLOCKED_REASON = 'Deposit must be paid or waived before creating a job';

/**
 * "Convertible" = WON, with neither job pointer set: `job` is PROVENANCE (a Job already created
 * FROM this estimate), `job_id` is the ANCHOR (this estimate was written against an existing
 * job — the multi-convert path sets this without ever touching `job`, job.controller.ts:2292-2340).
 * A converted-through-either-pointer estimate is not convertible again.
 */
export function isConvertibleEstimate(e: { status: string; job?: unknown; job_id?: string | null }): boolean {
  return e.status === 'WON' && !e.job && !e.job_id;
}

export interface ConvertToJobState {
  /** Whether a "Convert to job" / "Create Job" control should render at all. */
  visible: boolean;
  /** Whether the (visible) control should render disabled. */
  disabled: boolean;
  /** The disabled reason, present only when `disabled` is true. */
  reason?: string;
}

/**
 * The estimate-page gate: hidden unless convertible AND the caller holds `create Job`; disabled
 * (with the shared reason) when an outstanding DEPOSIT invoice blocks it. The lead page's own
 * primary button does NOT consult this — the lead detail payload carries no deposit data
 * (Design §Backend / R8), so a deposit-blocked single estimate there is refused by the backend
 * itself and surfaces through the existing error toast.
 */
export function convertToJobState({
  estimate,
  depositInvoice,
  canCreateJob,
}: {
  estimate: { status: string; job?: unknown; job_id?: string | null };
  depositInvoice?: { status: string } | null;
  canCreateJob: boolean;
}): ConvertToJobState {
  if (!canCreateJob || !isConvertibleEstimate(estimate)) {
    return { visible: false, disabled: false };
  }
  const depositBlocked = !!depositInvoice && !['PAID', 'VOIDED'].includes(depositInvoice.status);
  return depositBlocked
    ? { visible: true, disabled: true, reason: CONVERT_DEPOSIT_BLOCKED_REASON }
    : { visible: true, disabled: false };
}
