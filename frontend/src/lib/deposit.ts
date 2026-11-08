/**
 * deposit - the shared deposit resolution + %/amount conversion model.
 *
 * `resolveDeposit` is a deliberate line-for-line MIRROR of the backend's `resolveDepositAmount`
 * (`backend/src/controllers/estimate.controller.ts`, PRD §13.7 / finding B8). Frontend can't import
 * backend code, so this is a manually-kept-in-sync duplicate, not a re-export - the same pattern
 * `constants/estimateStatus.ts` documents. **If the backend helper changes, change this one too**,
 * and vice versa: the backend one decides what the customer is actually charged, so any divergence
 * shows the user one deposit and bills another.
 *
 * That divergence was real before this file existed: `SendEstimateDialog` computed its preview from
 * the ORG defaults alone, ignoring the estimate's own `deposit_type`/`deposit_value` override (the
 * one the Receipt Card writes), which `resolveDepositAmount` prefers. An estimate overridden to 70%
 * under a 50% org default previewed half of what the send would charge.
 *
 * The percentage/amount converters below are the other half: any surface that shows a deposit as
 * BOTH a % and a dollar figure has to keep the two describing the same deposit, because both get
 * posted (`record-payment` sends `amount` and `deposit_percentage` in one body).
 */

/** Rounds to cents. The only rounding a dollar figure ever gets - floats are not money. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The dollar deposit for a percentage of a total. */
export function amountFromPercent(total: number, percent: number): number {
  if (!(total > 0)) return 0;
  return round2((total * percent) / 100);
}

/**
 * The percentage a dollar deposit represents of a total. A zero/negative total has no percentage.
 *
 * Rounded to 2dp because this value is SHOWN IN AN INPUT the user reads: carrying the full
 * quotient renders $500 of $106.63 as "468.9112" and $40 as "37.5129", which reads like a bug even
 * though it is arithmetically exact. Two decimals is a real trade, not a free one - $333.33 of
 * $1000 becomes 33.33%, which converts back to $333.30. That penny only materialises if the user
 * then edits the PERCENTAGE box (their typed dollar amount is never rewritten underneath them), and
 * the dollar amount is what is actually charged - the backend's own comment calls
 * `deposit_percentage` descriptive only. Legibility wins over a hidden digit nobody can act on.
 */
export function percentFromAmount(total: number, amount: number): number {
  if (!(total > 0)) return 0;
  return round2((amount / total) * 100);
}

export type DepositType = 'PERCENTAGE' | 'FIXED';

export interface DepositEstimateFields {
  deposit_type?: DepositType | null;
  deposit_value?: number | string | null;
  total_amount: number | string | null | undefined;
}

export interface DepositOrgFields {
  deposit_default_type?: DepositType | null;
  deposit_default_percentage?: number | string | null;
  deposit_default_fixed_amount?: number | string | null;
}

export interface ResolvedDeposit {
  type: DepositType;
  /** Dollars. FIXED is capped at the total - you cannot ask for a deposit larger than the job. */
  amount: number;
  /** The EFFECTIVE percentage, always derived from `amount`, including in FIXED mode. */
  percent: number;
}

/**
 * Resolves the deposit to charge for an estimate. Prefers the estimate's own
 * `deposit_type`/`deposit_value` override and falls back to the org's `deposit_default_*` columns
 * only when the estimate has NEITHER set - both must be present for the override to count, matching
 * the backend's `hasOverride` check exactly.
 */
export function resolveDeposit(
  estimate: DepositEstimateFields,
  org: DepositOrgFields | null | undefined,
): ResolvedDeposit {
  const total = Number(estimate.total_amount ?? 0) || 0;
  const hasOverride = estimate.deposit_type != null && estimate.deposit_value != null;

  const type: DepositType = hasOverride
    ? (estimate.deposit_type as DepositType)
    : (org?.deposit_default_type ?? 'PERCENTAGE');

  const rawValue = hasOverride
    ? Number(estimate.deposit_value)
    : type === 'FIXED'
      ? Number(org?.deposit_default_fixed_amount ?? 0)
      : Number(org?.deposit_default_percentage ?? 50);

  const value = Number.isNaN(rawValue) ? 0 : rawValue;
  const rawAmount = type === 'FIXED' ? Math.min(value, total) : (total * value) / 100;
  const amount = round2(rawAmount);

  // The percentage is derived from the ROUNDED amount, exactly as the backend does
  // (`resolveDepositAmount`, deposit-amount.ts: `depositPercent = (depositAmount / total) * 100`,
  // and `depositAmount` is already `round2`'d by then). Deriving it from the raw, unrounded amount
  // instead would show 25% of $49.38 as a clean 25% while the backend's own figure - the one a
  // resend preview (#2091) has to agree with - is 25.0101...%, off the $12.35 it actually rounded
  // to and billed.
  return { type, amount, percent: percentFromAmount(total, amount) };
}

// ─── The deposit STATE (#2031) ────────────────────────────────────────────────

/** Where the resolved figure came from. */
export type DepositBasis = 'ESTIMATE_OVERRIDE' | 'ORG_DEFAULT';

export interface DepositSendConfig {
  deposit_required?: boolean | null;
  deposit_percentage?: number | string | null;
  deposit_amount?: number | string | null;
}

export interface DepositStateEstimateFields extends DepositEstimateFields {
  /**
   * The figures the customer was actually presented. Written at the first send and re-snapshotted
   * by any later send that re-prices an UNPAID deposit invoice (#2031 slice 5) — so the held
   * figure and the payable document always describe the same deposit. A deposit with money
   * against it is never re-priced, and this never moves under one.
   */
  send_config?: DepositSendConfig | null;
  /** The kind=DEPOSIT invoice, when one has been issued. */
  invoices?: Array<{
    status?: string | null;
    total_amount?: number | string | null;
    amount_due?: number | string | null;
  }> | null;
}

export interface DepositState extends ResolvedDeposit {
  /** Which input produced `type`/`percent`: the estimate's own override, or the org defaults. */
  basis: DepositBasis;
  /** A send has frozen a configuration, so the deposit is no longer the salesperson's to move. */
  issued: boolean;
  /** A deposit invoice exists for this estimate. */
  invoiced: boolean;
  /** That invoice has been settled. */
  paid: boolean;
  /**
   * False when a frozen deposit no longer reconciles with the current total — the estimate was
   * sent at one total and edited afterwards. The deposit is HELD at the presented figure rather
   * than silently recalculated (Ran's decision), so somebody has to be told, and this is the flag
   * that tells them. Always true before a send, when there is nothing frozen to disagree with.
   */
  matchesTotal: boolean;
  /** The deposit the current total WOULD produce — what the held figure is being judged against. */
  expectedAmount: number;
  /** True while the deposit is still the salesperson's to change. */
  editable: boolean;
}

/**
 * The one answer to "what is this estimate's deposit, and is it still true?".
 *
 * Every deposit surface reads this rather than deciding for itself: the receipt card, the send
 * dialog, the public page and the record-payment dialog. The card in particular used to read the
 * frozen `send_config` unconditionally once one existed, so a deposit went on presenting itself as
 * simply due at the old amount however far the total had since moved.
 */
export function resolveDepositState(
  estimate: DepositStateEstimateFields,
  org: DepositOrgFields | null | undefined,
): DepositState {
  const total = Number(estimate.total_amount ?? 0) || 0;
  const hasOverride = estimate.deposit_type != null && estimate.deposit_value != null;
  // What the CURRENT inputs say the deposit should be. Pre-send this is the deposit; post-send it
  // is only the yardstick the held figure is measured against.
  const expected = resolveDeposit(estimate, org);

  const issued = estimate.send_config != null;
  const depositInvoice = estimate.invoices?.[0];
  const invoiced = depositInvoice != null;
  const paid = invoiced && (depositInvoice.status === 'PAID' || Number(depositInvoice.amount_due) === 0);

  if (!issued) {
    return {
      ...expected,
      basis: hasOverride ? 'ESTIMATE_OVERRIDE' : 'ORG_DEFAULT',
      issued: false,
      invoiced,
      paid,
      matchesTotal: true,
      expectedAmount: expected.amount,
      editable: true,
    };
  }

  // Held at the presented figure. `send_config` carries no mode flag — its shape is
  // percentage-plus-amount — so the amount is authoritative and the percentage is what was shown.
  // A legacy send_config written before deposit_amount existed carries none, and the deposit
  // invoice's own total is then the figure the customer was actually billed.
  const heldAmount = round2(
    Number(estimate.send_config?.deposit_amount ?? depositInvoice?.total_amount ?? 0) || 0,
  );
  return {
    type: expected.type,
    amount: heldAmount,
    percent: percentFromAmount(total, heldAmount),
    basis: hasOverride ? 'ESTIMATE_OVERRIDE' : 'ORG_DEFAULT',
    issued: true,
    invoiced,
    paid,
    // A held deposit still reconciles only while the current inputs would produce the same figure.
    // Judging it against `expected` rather than against the total alone keeps a FIXED deposit valid
    // when the total merely grows, and catches a percentage deposit the moment the total moves.
    matchesTotal: heldAmount === expected.amount,
    expectedAmount: expected.amount,
    editable: false,
  };
}

// ─── Will the NEXT send re-price this deposit? (#2091) ───────────────────────

export interface DepositInvoiceStatusFields {
  status?: string | null;
  payments?: unknown[] | null;
}

/**
 * Mirrors the backend's `repriceUnpaidDepositInvoice` unpaid predicate
 * (`estimate.controller.ts`) exactly: DRAFT/SENT and nothing paid against it. A resend or
 * mark-sent re-prices exactly this invoice to the deposit the CURRENT inputs produce, so a frozen
 * deposit display must stop showing the old billed figure the moment this returns true - showing
 * it would preview one number and bill another. A settled invoice (paid, partially paid, or any
 * kind other than DRAFT/SENT) never moves, so its frozen figure stays true.
 */
export function depositInvoiceIsUnpaid(invoice: DepositInvoiceStatusFields | null | undefined): boolean {
  if (!invoice) return false;
  const unpaidStatus = invoice.status === 'DRAFT' || invoice.status === 'SENT';
  const hasMoneyAgainstIt = (invoice.payments?.length ?? 0) > 0;
  return unpaidStatus && !hasMoneyAgainstIt;
}
