/**
 * The one deposit-figure resolver. #2031 slice 5.
 *
 * Extracted out of estimate.controller so the money DOOR (invoice.controller's public checkout)
 * and the money WRITE (estimate.controller's re-price) can share it without a controller-to-
 * controller import — estimate.controller already imports invoice.controller, so the dependency
 * cannot run the other way.
 *
 * F3 — the rounding lives HERE, at the boundary, not at each comparison. Every consumer either
 * writes this number into a Decimal(12,2) column or compares it against one that was, and
 * Postgres and `Math.round(n * 100) / 100` do not agree on a float tie: 256.025 stores as 256.03
 * and rounds to 256.02. Rounding the resolver's own output makes the value that is WRITTEN and
 * the value that is COMPARED the same value, which is the only way the "already current"
 * short-circuit can ever fire on such a total. The rounding convention is the repo's existing one
 * (invoice-totals.ts, calculateTotals) — deliberately not a third one.
 */

/** Rounds to cents. Decimal(12,2) is what every money column here stores. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface DepositEstimateInputs {
  deposit_type?: 'PERCENTAGE' | 'FIXED' | null;
  deposit_value?: unknown;
  total_amount: unknown;
}

export interface DepositOrgDefaults {
  deposit_default_type?: 'PERCENTAGE' | 'FIXED' | null;
  deposit_default_percentage?: unknown;
  deposit_default_fixed_amount?: unknown;
}

export interface ResolvedDeposit {
  dType: 'PERCENTAGE' | 'FIXED';
  /** Already at cents — this is the figure that goes on the document. */
  depositAmount: number;
  depositPercent: number;
}

/**
 * PRD §13.7 / finding B8 — resolve the deposit type + dollar amount to charge for an estimate.
 * Prefers the ESTIMATE's own `deposit_type`/`deposit_value` override (the Receipt Card's live
 * deposit selector, `EstimateReceiptCard.tsx`, persists here via `update()`) and falls back to
 * the org's `deposit_default_*` columns only when the estimate has neither set. Before this fix,
 * `send()` and `recordEstimatePayment()` each computed the deposit purely from org defaults,
 * silently ignoring whatever the Receipt Card had saved. Shared by both call sites so they can
 * never drift apart again.
 */
export function resolveDepositAmount(
  estimate: DepositEstimateInputs,
  org: DepositOrgDefaults | null,
): ResolvedDeposit {
  const total = Number(estimate.total_amount);
  const hasOverride = estimate.deposit_type != null && estimate.deposit_value != null;
  const dType: 'PERCENTAGE' | 'FIXED' = hasOverride
    ? (estimate.deposit_type as 'PERCENTAGE' | 'FIXED')
    : (org?.deposit_default_type ?? 'PERCENTAGE');
  const rawValue = hasOverride
    ? Number(estimate.deposit_value)
    : (dType === 'FIXED' ? Number(org?.deposit_default_fixed_amount ?? 0) : Number(org?.deposit_default_percentage ?? 50));
  // #2010 — BOTH branches are clamped to the estimate total, and it is the resolver's job, not
  // the writer's: this is the single arithmetic reader of `deposit_value` in the backend, so a row
  // that is already PERCENTAGE/500 — written before `update()`'s effective-pair guard existed, or
  // by any future writer — still cannot mint a deposit invoice larger than what the customer was
  // quoted. FIXED has always been `Math.min(rawValue, total)`; PERCENTAGE has its equivalent
  // ceiling. `depositPctGuard` only ever sees the REQUEST BODY, so it is not this ceiling.
  // Rounded here and nowhere else — see the file header.
  const depositAmount = round2(
    dType === 'FIXED' ? Math.min(rawValue, total) : total * (Math.min(rawValue, 100) / 100),
  );
  const depositPercent = total > 0 ? (depositAmount / total) * 100 : 0;
  return { dType, depositAmount, depositPercent };
}

/**
 * Would the next send move the figure on this deposit document?
 *
 * F4 — the single question behind three decisions that must never disagree: whether the re-price
 * writes at all (`ALREADY_CURRENT`), whether the customer's link is refused as superseded, and
 * whether an open checkout session has to be killed. A FIXED deposit under a changed total, or a
 * cosmetic edit that only renamed a discount, moves nothing — and a deposit that still asks for
 * the right money must keep taking it.
 */
export function depositFigureWouldMove(storedAmount: unknown, resolvedDepositAmount: number): boolean {
  return round2(Number(storedAmount)) !== round2(resolvedDepositAmount);
}
